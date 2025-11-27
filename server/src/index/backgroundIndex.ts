import { ISymbolIndex } from './ISymbolIndex.js';
import { IndexedSymbol, IndexedFileResult, IndexedReference, ImportInfo, ReExportInfo, SHARD_VERSION } from '../types.js';
import { SymbolIndexer } from '../indexer/symbolIndexer.js';
import { LanguageRouter } from '../indexer/languageRouter.js';
import { fuzzyScore } from '../utils/fuzzySearch.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Represents a single shard (per-file index) on disk.
 */
interface FileShard {
  uri: string;
  hash: string;
  symbols: IndexedSymbol[];
  references: IndexedReference[];
  imports: ImportInfo[];
  reExports?: ReExportInfo[];
  lastIndexedAt: number;
  shardVersion?: number;
}

/**
 * BackgroundIndex - Persistent sharded index for the entire workspace.
 * Inspired by clangd's background index.
 * 
 * This index:
 * - Stores one shard per file in .smart-index/index/
 * - Maintains a lightweight in-memory summary (uri -> hash)
 * - Lazily loads shards from disk when needed
 * - Performs incremental updates (only re-indexes changed files)
 * - Supports parallel indexing with a worker pool
 */
export class BackgroundIndex implements ISymbolIndex {
  private symbolIndexer: SymbolIndexer;
  private languageRouter: LanguageRouter | null = null;
  private shardsDirectory: string = '';
  private fileMetadata: Map<string, { hash: string; lastIndexedAt: number; symbolCount: number }> = new Map();
  private symbolNameIndex: Map<string, Set<string>> = new Map(); // name -> Set of URIs
  private symbolIdIndex: Map<string, string> = new Map(); // symbolId -> URI
  private referenceMap: Map<string, Set<string>> = new Map(); // symbolName -> Set of URIs containing references
  private isInitialized: boolean = false;
  private maxConcurrentJobs: number = 4;

  constructor(symbolIndexer: SymbolIndexer, maxConcurrentJobs: number = 4) {
    this.symbolIndexer = symbolIndexer;
    this.maxConcurrentJobs = maxConcurrentJobs;
  }

  /**
   * Set the language router for multi-language indexing
   */
  setLanguageRouter(router: LanguageRouter): void {
    this.languageRouter = router;
  }

  /**
   * Update the maximum number of concurrent indexing jobs.
   */
  setMaxConcurrentJobs(max: number): void {
    this.maxConcurrentJobs = Math.max(1, Math.min(16, max));
  }

  /**
   * Initialize the background index.
   */
  async init(workspaceRoot: string, cacheDirectory: string): Promise<void> {
    this.shardsDirectory = path.join(workspaceRoot, cacheDirectory, 'index');
    
    if (!fs.existsSync(this.shardsDirectory)) {
      fs.mkdirSync(this.shardsDirectory, { recursive: true });
    }

    await this.loadShardMetadata();
    this.isInitialized = true;
  }

  /**
   * Load lightweight metadata from all shards.
   */
  private async loadShardMetadata(): Promise<void> {
    try {
      if (!fs.existsSync(this.shardsDirectory)) {
        return;
      }

      const shardFiles = this.collectShardFiles(this.shardsDirectory);
      let loadedShards = 0;

      for (const shardFile of shardFiles) {
        try {
          const content = fs.readFileSync(shardFile, 'utf-8');
          const shard: FileShard = JSON.parse(content);

          this.fileMetadata.set(shard.uri, {
            hash: shard.hash,
            lastIndexedAt: shard.lastIndexedAt,
            symbolCount: shard.symbols.length
          });

          // Build symbol name index
          for (const symbol of shard.symbols) {
            let uriSet = this.symbolNameIndex.get(symbol.name);
            if (!uriSet) {
              uriSet = new Set();
              this.symbolNameIndex.set(symbol.name, uriSet);
            }
            uriSet.add(shard.uri);

            // Build symbol ID index
            this.symbolIdIndex.set(symbol.id, shard.uri);
          }

          // Build reference map
          if (shard.references) {
            for (const ref of shard.references) {
              let refUriSet = this.referenceMap.get(ref.symbolName);
              if (!refUriSet) {
                refUriSet = new Set();
                this.referenceMap.set(ref.symbolName, refUriSet);
              }
              refUriSet.add(shard.uri);
            }
          }

          loadedShards++;
        } catch (error) {
          console.error(`[BackgroundIndex] Error loading shard ${shardFile}: ${error}`);
        }
      }

      console.info(`[BackgroundIndex] Loaded metadata from ${loadedShards} shards`);
    } catch (error) {
      console.error(`[BackgroundIndex] Error loading shard metadata: ${error}`);
    }
  }

  /**
   * Recursively collect all shard files from nested directory structure.
   */
  private collectShardFiles(dir: string): string[] {
    const results: string[] = [];
    
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          results.push(...this.collectShardFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          results.push(fullPath);
        }
      }
    } catch (error) {
      console.error(`[BackgroundIndex] Error reading directory ${dir}: ${error}`);
    }
    
    return results;
  }

  /**
   * Get shard file path for a given URI.
   * Uses hashed directory structure for filesystem performance:
   * .smart-index/index/<prefix1>/<prefix2>/<hash>.json
   */
  private getShardPath(uri: string): string {
    const hash = crypto.createHash('sha256').update(uri).digest('hex');
    const prefix1 = hash.substring(0, 2);
    const prefix2 = hash.substring(2, 4);
    return path.join(this.shardsDirectory, prefix1, prefix2, `${hash}.json`);
  }

  /**
   * Load a shard from disk.
   */
  private async loadShard(uri: string): Promise<FileShard | null> {
    try {
      const shardPath = this.getShardPath(uri);
      if (!fs.existsSync(shardPath)) {
        return null;
      }

      const content = fs.readFileSync(shardPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error(`[BackgroundIndex] Error loading shard for ${uri}: ${error}`);
      return null;
    }
  }

  /**
   * Save a shard to disk.
   */
  private async saveShard(shard: FileShard): Promise<void> {
    try {
      const shardPath = this.getShardPath(shard.uri);
      const shardDir = path.dirname(shardPath);
      
      // Ensure directory exists (nested structure)
      if (!fs.existsSync(shardDir)) {
        fs.mkdirSync(shardDir, { recursive: true });
      }
      
      const content = JSON.stringify(shard, null, 2);
      fs.writeFileSync(shardPath, content, 'utf-8');
    } catch (error) {
      console.error(`[BackgroundIndex] Error saving shard for ${shard.uri}: ${error}`);
      throw error;
    }
  }

  /**
   * Delete a shard from disk.
   */
  private async deleteShard(uri: string): Promise<void> {
    try {
      const shardPath = this.getShardPath(uri);
      if (fs.existsSync(shardPath)) {
        fs.unlinkSync(shardPath);
      }
    } catch (error) {
      console.error(`[BackgroundIndex] Error deleting shard for ${uri}: ${error}`);
    }
  }

  /**
   * Update/add a file to the background index.
   */
  async updateFile(uri: string, result: IndexedFileResult): Promise<void> {
    const shard: FileShard = {
      uri: result.uri,
      hash: result.hash,
      symbols: result.symbols,
      references: result.references || [],
      imports: result.imports || [],
      reExports: result.reExports || [],
      lastIndexedAt: Date.now()
    };

    // Update in-memory metadata
    this.fileMetadata.set(uri, {
      hash: result.hash,
      lastIndexedAt: shard.lastIndexedAt,
      symbolCount: result.symbols.length
    });

    // Update symbol name index
    // First, remove old symbols for this URI
    for (const [name, uriSet] of this.symbolNameIndex) {
      uriSet.delete(uri);
      if (uriSet.size === 0) {
        this.symbolNameIndex.delete(name);
      }
    }

    // Remove old symbol IDs for this URI
    for (const [symbolId, storedUri] of this.symbolIdIndex) {
      if (storedUri === uri) {
        this.symbolIdIndex.delete(symbolId);
      }
    }

    // Remove old references for this URI
    for (const [symbolName, uriSet] of this.referenceMap) {
      uriSet.delete(uri);
      if (uriSet.size === 0) {
        this.referenceMap.delete(symbolName);
      }
    }

    // Add new symbols
    for (const symbol of result.symbols) {
      let uriSet = this.symbolNameIndex.get(symbol.name);
      if (!uriSet) {
        uriSet = new Set();
        this.symbolNameIndex.set(symbol.name, uriSet);
      }
      uriSet.add(uri);

      // Add to symbol ID index
      this.symbolIdIndex.set(symbol.id, uri);
    }

    // Add new references
    if (result.references) {
      for (const ref of result.references) {
        let refUriSet = this.referenceMap.get(ref.symbolName);
        if (!refUriSet) {
          refUriSet = new Set();
          this.referenceMap.set(ref.symbolName, refUriSet);
        }
        refUriSet.add(uri);
      }
    }

    // Save shard to disk
    await this.saveShard(shard);
  }

  /**
   * Remove a file from the background index.
   */
  async removeFile(uri: string): Promise<void> {
    this.fileMetadata.delete(uri);

    // Remove from symbol name index
    for (const [name, uriSet] of this.symbolNameIndex) {
      uriSet.delete(uri);
      if (uriSet.size === 0) {
        this.symbolNameIndex.delete(name);
      }
    }

    // Remove from symbol ID index
    for (const [symbolId, storedUri] of this.symbolIdIndex) {
      if (storedUri === uri) {
        this.symbolIdIndex.delete(symbolId);
      }
    }

    // Remove from reference map
    for (const [symbolName, uriSet] of this.referenceMap) {
      uriSet.delete(uri);
      if (uriSet.size === 0) {
        this.referenceMap.delete(symbolName);
      }
    }

    await this.deleteShard(uri);
  }

  /**
   * Check if we have a shard for this URI with the given hash.
   */
  async hasUpToDateShard(uri: string, hash: string): Promise<boolean> {
    const metadata = this.fileMetadata.get(uri);
    return metadata !== undefined && metadata.hash === hash;
  }

  /**
   * Get file info for a URI.
   */
  getFileInfo(uri: string): { uri: string; hash: string; lastIndexedAt: number } | undefined {
    const metadata = this.fileMetadata.get(uri);
    if (!metadata) {
      return undefined;
    }
    return {
      uri,
      hash: metadata.hash,
      lastIndexedAt: metadata.lastIndexedAt
    };
  }

  /**
   * Get all indexed file URIs.
   */
  getAllFileUris(): string[] {
    return Array.from(this.fileMetadata.keys());
  }

  async findDefinitions(name: string): Promise<IndexedSymbol[]> {
    const results: IndexedSymbol[] = [];
    const uriSet = this.symbolNameIndex.get(name);

    if (!uriSet) {
      return results;
    }

    // Load shards lazily
    for (const uri of uriSet) {
      const shard = await this.loadShard(uri);
      if (shard) {
        for (const symbol of shard.symbols) {
          if (symbol.name === name) {
            results.push(symbol);
          }
        }
      }
    }

    return results;
  }

  async findDefinitionById(symbolId: string): Promise<IndexedSymbol | null> {
    const uri = this.symbolIdIndex.get(symbolId);
    if (!uri) {
      return null;
    }

    const shard = await this.loadShard(uri);
    if (!shard) {
      return null;
    }

    for (const symbol of shard.symbols) {
      if (symbol.id === symbolId) {
        return symbol;
      }
    }

    return null;
  }

  async findReferences(name: string): Promise<IndexedSymbol[]> {
    return this.findDefinitions(name);
  }

  async findReferencesById(symbolId: string): Promise<IndexedSymbol[]> {
    // For now, return the definition itself
    const def = await this.findDefinitionById(symbolId);
    return def ? [def] : [];
  }

  async searchSymbols(query: string, limit: number): Promise<IndexedSymbol[]> {
    const results: IndexedSymbol[] = [];
    const seen = new Set<string>();
    const candidateUris = new Set<string>();

    // Find all symbol names that fuzzy match the query
    for (const [name, uriSet] of this.symbolNameIndex) {
      if (fuzzyScore(name, query)) {
        for (const uri of uriSet) {
          candidateUris.add(uri);
        }
      }
    }

    // Load shards and collect matching symbols
    for (const uri of candidateUris) {
      if (results.length >= limit) {
        break;
      }

      const shard = await this.loadShard(uri);
      if (shard) {
        for (const symbol of shard.symbols) {
          if (fuzzyScore(symbol.name, query)) {
            const key = `${symbol.name}:${symbol.location.uri}:${symbol.location.line}:${symbol.location.character}`;
            if (!seen.has(key)) {
              results.push(symbol);
              seen.add(key);
              if (results.length >= limit) {
                break;
              }
            }
          }
        }
      }
    }

    return results;
  }

  async getFileSymbols(uri: string): Promise<IndexedSymbol[]> {
    const shard = await this.loadShard(uri);
    return shard ? shard.symbols : [];
  }

  /**
   * Find all references to a symbol by name.
   * Returns locations where the symbol is used (not just defined).
   * 
   * @param name Symbol name to search for
   * @param options Filtering options
   */
  async findReferencesByName(
    name: string,
    options?: { excludeLocal?: boolean; scopeId?: string }
  ): Promise<IndexedReference[]> {
    const references: IndexedReference[] = [];
    
    // Use inverted index to find only files that contain references to this symbol
    const candidateUris = this.referenceMap.get(name);
    
    if (!candidateUris || candidateUris.size === 0) {
      return references; // Fast path: no references found
    }
    
    // Load shards and collect matching references (only for files with references)
    for (const uri of candidateUris) {
      const shard = await this.loadShard(uri);
      if (shard && shard.references) {
        for (const ref of shard.references) {
          if (ref.symbolName === name) {
            // Apply scope-based filtering
            if (options?.excludeLocal && ref.isLocal) {
              continue;
            }
            if (options?.scopeId && ref.scopeId !== options.scopeId) {
              continue;
            }
            references.push(ref);
          }
        }
      }
    }
    
    return references;
  }

  /**
   * Get import info for a file (for import resolution).
   */
  async getFileImports(uri: string): Promise<ImportInfo[]> {
    const shard = await this.loadShard(uri);
    return shard?.imports || [];
  }

  /**
   * Get re-export info for a file (for barrel file resolution).
   */
  async getFileReExports(uri: string): Promise<ReExportInfo[]> {
    const shard = await this.loadShard(uri);
    return shard?.reExports || [];
  }

  /**
   * Ensure all files are up to date.
   * This is the main entry point for incremental background indexing.
   */
  async ensureUpToDate(
    allFiles: string[],
    computeHash: (uri: string) => Promise<string>,
    onProgress?: (current: number, total: number) => void
  ): Promise<void> {
    const filesToIndex: string[] = [];
    let checked = 0;

    // Check which files need indexing
    for (const uri of allFiles) {
      try {
        const currentHash = await computeHash(uri);
        const isUpToDate = await this.hasUpToDateShard(uri, currentHash);

        if (!isUpToDate) {
          filesToIndex.push(uri);
        }

        checked++;
        if (onProgress) {
          onProgress(checked, allFiles.length);
        }
      } catch (error) {
        console.error(`[BackgroundIndex] Error checking file ${uri}: ${error}`);
      }
    }

    // Remove stale shards (files that no longer exist)
    const currentFileSet = new Set(allFiles);
    const staleFiles = this.getAllFileUris().filter(uri => !currentFileSet.has(uri));
    for (const uri of staleFiles) {
      await this.removeFile(uri);
    }

    // Index files in parallel using worker pool
    if (filesToIndex.length > 0) {
      console.info(`[BackgroundIndex] Indexing ${filesToIndex.length} files with ${this.maxConcurrentJobs} concurrent jobs`);
      await this.indexFilesParallel(filesToIndex, onProgress ? 
        (current) => onProgress(checked - filesToIndex.length + current, allFiles.length) : 
        undefined
      );
    }
  }

  /**
   * Index multiple files in parallel using a worker pool.
   */
  private async indexFilesParallel(
    files: string[],
    onProgress?: (current: number) => void
  ): Promise<void> {
    let processed = 0;
    const total = files.length;

    // Process in batches
    for (let i = 0; i < files.length; i += this.maxConcurrentJobs) {
      const batch = files.slice(i, i + this.maxConcurrentJobs);
      const promises = batch.map(async (uri) => {
        try {
          // Use language router if available, otherwise fall back to symbol indexer
          const indexer = this.languageRouter || this.symbolIndexer;
          const result = await indexer.indexFile(uri);
          await this.updateFile(uri, result);
          processed++;
          if (onProgress) {
            onProgress(processed);
          }
        } catch (error) {
          console.error(`[BackgroundIndex] Error indexing file ${uri}: ${error}`);
          processed++;
          if (onProgress) {
            onProgress(processed);
          }
        }
      });

      await Promise.all(promises);
    }
  }

  /**
   * Get statistics about the background index.
   */
  getStats(): { files: number; symbols: number; shards: number } {
    let totalSymbols = 0;
    
    // Sum symbol counts from all files
    for (const metadata of this.fileMetadata.values()) {
      totalSymbols += metadata.symbolCount;
    }

    return {
      files: this.fileMetadata.size,
      symbols: totalSymbols,
      shards: this.fileMetadata.size
    };
  }

  /**
   * Clear all shards.
   */
  async clear(): Promise<void> {
    try {
      if (fs.existsSync(this.shardsDirectory)) {
        this.clearDirectory(this.shardsDirectory);
      }

      this.fileMetadata.clear();
      this.symbolNameIndex.clear();
      this.symbolIdIndex.clear();
      this.referenceMap.clear();
    } catch (error) {
      console.error(`[BackgroundIndex] Error clearing shards: ${error}`);
      throw error;
    }
  }

  /**
   * Recursively clear directory contents.
   */
  private clearDirectory(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          this.clearDirectory(fullPath);
          fs.rmdirSync(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          fs.unlinkSync(fullPath);
        }
      }
    } catch (error) {
      console.error(`[BackgroundIndex] Error clearing directory ${dir}: ${error}`);
    }
  }

  /**
   * Get all indexed file URIs.
   */
  async getAllFiles(): Promise<string[]> {
    return this.getAllFileUris();
  }

  /**
   * Get the complete file result (symbols, references, imports) for a URI.
   */
  async getFileResult(uri: string): Promise<IndexedFileResult | null> {
    const shard = await this.loadShard(uri);
    if (!shard) {
      return null;
    }

    return {
      uri: shard.uri,
      hash: shard.hash,
      symbols: shard.symbols,
      references: shard.references,
      imports: shard.imports,
      reExports: shard.reExports
    };
  }
}
