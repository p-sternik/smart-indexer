import { ISymbolIndex } from './ISymbolIndex.js';
import { IndexedSymbol, IndexedFileResult, IndexedReference, ImportInfo, ReExportInfo, PendingReference, SHARD_VERSION } from '../types.js';
import { SymbolIndexer } from '../indexer/symbolIndexer.js';
import { LanguageRouter } from '../indexer/languageRouter.js';
import { fuzzyScore } from '../utils/fuzzySearch.js';
import { WorkerPool } from '../utils/workerPool.js';
import { ConfigurationManager } from '../config/configurationManager.js';
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
  pendingReferences?: PendingReference[];
  lastIndexedAt: number;
  shardVersion?: number;
  mtime?: number; // File modification time in milliseconds
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
  private configManager: ConfigurationManager | null = null;
  private shardsDirectory: string = '';
  private fileMetadata: Map<string, { hash: string; lastIndexedAt: number; symbolCount: number; mtime?: number }> = new Map();
  private symbolNameIndex: Map<string, Set<string>> = new Map(); // name -> Set of URIs
  private symbolIdIndex: Map<string, string> = new Map(); // symbolId -> URI
  private referenceMap: Map<string, Set<string>> = new Map(); // symbolName -> Set of URIs containing references
  private isInitialized: boolean = false;
  private maxConcurrentJobs: number = 4;
  private workerPool: WorkerPool | null = null;

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
   * Set the configuration manager for exclusion filtering
   */
  setConfigurationManager(configManager: ConfigurationManager): void {
    this.configManager = configManager;
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

    const workerScriptPath = path.join(__dirname, 'indexer', 'worker.js');
    this.workerPool = new WorkerPool(workerScriptPath, this.maxConcurrentJobs);
    
    console.info(`[BackgroundIndex] Initialized worker pool with ${this.maxConcurrentJobs} workers`);

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
            symbolCount: shard.symbols.length,
            mtime: shard.mtime
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
    // Get current mtime
    let mtime: number | undefined;
    try {
      const stats = fs.statSync(uri);
      mtime = stats.mtimeMs;
    } catch (error) {
      console.warn(`[BackgroundIndex] Could not get mtime for ${uri}: ${error}`);
    }

    const shard: FileShard = {
      uri: result.uri,
      hash: result.hash,
      symbols: result.symbols,
      references: result.references || [],
      imports: result.imports || [],
      reExports: result.reExports || [],
      pendingReferences: result.pendingReferences,
      lastIndexedAt: Date.now(),
      shardVersion: SHARD_VERSION,
      mtime
    };

    // Update in-memory metadata
    this.fileMetadata.set(uri, {
      hash: result.hash,
      lastIndexedAt: shard.lastIndexedAt,
      symbolCount: result.symbols.length,
      mtime
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

    // Resolve NgRx cross-file references after indexing
    if (result.pendingReferences && result.pendingReferences.length > 0) {
      await this.resolveNgRxReferences(uri, result.pendingReferences);
    }
  }

  /**
   * Resolve NgRx cross-file references using the global index.
   * 
   * This method resolves pending references like `PageActions.load()` by:
   * 1. Looking up the container symbol (e.g., `PageActions`) in the global index
   * 2. Checking if it's an NgRx action group with `ngrxMetadata.isGroup`
   * 3. If the member (e.g., `load`) exists in the events map, creating a synthetic reference
   * 
   * @param sourceUri - The file containing the pending references
   * @param pendingRefs - Array of pending references to resolve
   */
  private async resolveNgRxReferences(sourceUri: string, pendingRefs: PendingReference[]): Promise<void> {
    let resolvedCount = 0;

    for (const pending of pendingRefs) {
      // Look up the container symbol in the global index
      const containerUris = this.symbolNameIndex.get(pending.container);
      if (!containerUris || containerUris.size === 0) {
        continue;
      }

      // Check each potential container symbol
      for (const containerUri of containerUris) {
        const shard = await this.loadShard(containerUri);
        if (!shard) {
          continue;
        }

        // Find the container symbol with NgRx action group metadata
        const containerSymbol = shard.symbols.find(
          s => s.name === pending.container && 
               s.ngrxMetadata?.isGroup === true &&
               s.ngrxMetadata?.events
        );

        if (!containerSymbol || !containerSymbol.ngrxMetadata?.events) {
          continue;
        }

        // Check if the member exists in the events map
        const events = containerSymbol.ngrxMetadata.events;
        if (!(pending.member in events)) {
          continue;
        }

        // Found a match! Create a synthetic reference linking usage to the action definition
        // The member name (e.g., 'load') maps to the virtual symbol created in worker.ts
        const syntheticRef: IndexedReference = {
          symbolName: pending.member,
          location: pending.location,
          range: pending.range,
          containerName: pending.containerName,
          isLocal: false
        };

        // Add to referenceMap so FindReferences works
        let refUriSet = this.referenceMap.get(pending.member);
        if (!refUriSet) {
          refUriSet = new Set();
          this.referenceMap.set(pending.member, refUriSet);
        }
        refUriSet.add(sourceUri);

        resolvedCount++;
        break; // Found a match, no need to check other containers
      }
    }

    if (resolvedCount > 0) {
      console.info(`[BackgroundIndex] Resolved ${resolvedCount} NgRx cross-file references from ${sourceUri}`);
    }
  }

  /**
   * Update a single file in the background index (for live synchronization).
   * 
   * This method:
   * 1. Removes all existing entries for the file (cleanup)
   * 2. Re-indexes the file using the worker pool
   * 3. Merges the new results into the index
   * 4. Persists the updated shard to disk
   * 
   * @param filePath - Absolute path to the file to re-index
   */
  async updateSingleFile(filePath: string): Promise<void> {
    try {
      // STEP A: Cleanup - remove existing entries
      // This is already handled by updateFile(), but we call removeFile first
      // to ensure a clean slate and prevent "ghost" references
      const hadExistingEntry = this.fileMetadata.has(filePath);
      
      if (hadExistingEntry) {
        // Clean up old entries from in-memory indexes
        // (but don't delete the shard yet - we'll overwrite it)
        this.cleanupFileFromIndexes(filePath);
      }

      // STEP B: Process - index the file
      let result: IndexedFileResult;
      
      if (this.workerPool) {
        // Use worker pool for parallel processing
        result = await this.workerPool.runTask({ uri: filePath });
      } else {
        // Fallback to synchronous indexing
        const indexer = this.languageRouter || this.symbolIndexer;
        result = await indexer.indexFile(filePath);
      }

      // STEP C & D: Merge and Persist - handled by updateFile()
      await this.updateFile(filePath, result);
      
    } catch (error) {
      console.error(`[BackgroundIndex] Error updating single file ${filePath}: ${error}`);
      throw error;
    }
  }

  /**
   * Clean up a file's entries from in-memory indexes without deleting the shard.
   * This is used by updateSingleFile to prevent ghost references.
   */
  private cleanupFileFromIndexes(uri: string): void {
    // Remove from file metadata
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
   * Check if file needs reindexing based on mtime.
   * Returns true if file should be indexed (cache miss or stale).
   */
  private needsReindexing(uri: string): boolean {
    const metadata = this.fileMetadata.get(uri);
    if (!metadata) {
      return true; // No cache entry
    }

    // If no mtime stored, fall back to hash-based check
    if (!metadata.mtime) {
      return true;
    }

    try {
      const stats = fs.statSync(uri);
      const currentMtime = stats.mtimeMs;
      
      // If mtime matches, file is unchanged
      if (currentMtime === metadata.mtime) {
        return false;
      }
      
      return true;
    } catch (error) {
      // File might not exist anymore
      return true;
    }
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
    let excluded = 0;

    // Check which files need indexing
    for (const uri of allFiles) {
      try {
        // STEP 1: Apply exclusion filters BEFORE any processing
        if (this.configManager && this.configManager.shouldExcludePath(uri)) {
          excluded++;
          checked++;
          if (onProgress) {
            onProgress(checked, allFiles.length);
          }
          continue;
        }

        // STEP 2: Check mtime-based cache (fast path)
        if (!this.needsReindexing(uri)) {
          // File is unchanged based on mtime - skip indexing
          checked++;
          if (onProgress) {
            onProgress(checked, allFiles.length);
          }
          continue;
        }

        // STEP 3: File needs indexing (mtime changed or no cache)
        filesToIndex.push(uri);

        checked++;
        if (onProgress) {
          onProgress(checked, allFiles.length);
        }
      } catch (error) {
        console.error(`[BackgroundIndex] Error checking file ${uri}: ${error}`);
      }
    }

    if (excluded > 0) {
      console.info(`[BackgroundIndex] Excluded ${excluded} files from indexing (build artifacts, node_modules, etc.)`);
    }

    // Remove stale shards (files that no longer exist)
    const currentFileSet = new Set(allFiles);
    const staleFiles = this.getAllFileUris().filter(uri => !currentFileSet.has(uri));
    for (const uri of staleFiles) {
      await this.removeFile(uri);
    }

    // Clean up previously indexed excluded files (purge .angular, dist, etc.)
    await this.purgeExcludedFiles();

    // Index files in parallel using worker pool
    if (filesToIndex.length > 0) {
      console.info(`[BackgroundIndex] Indexing ${filesToIndex.length} files with ${this.maxConcurrentJobs} concurrent jobs`);
      await this.indexFilesParallel(filesToIndex, onProgress ? 
        (current) => onProgress(checked - filesToIndex.length + current, allFiles.length) : 
        undefined
      );
    } else {
      console.info(`[BackgroundIndex] All files up to date (mtime-based check)`);
    }
  }

  /**
   * Purge previously indexed files that should now be excluded.
   * Removes shards for files in .angular, .nx, dist, coverage, etc.
   */
  private async purgeExcludedFiles(): Promise<void> {
    if (!this.configManager) {
      return;
    }

    const filesToPurge: string[] = [];
    
    for (const uri of this.fileMetadata.keys()) {
      if (this.configManager.shouldExcludePath(uri)) {
        filesToPurge.push(uri);
      }
    }

    if (filesToPurge.length > 0) {
      console.info(`[BackgroundIndex] Purging ${filesToPurge.length} excluded files from cache`);
      for (const uri of filesToPurge) {
        await this.removeFile(uri);
      }
    }
  }

  /**
   * Index multiple files in parallel using a worker pool.
   * Uses Promise.allSettled to process all files concurrently without artificial batching,
   * maximizing worker pool utilization.
   */
  private async indexFilesParallel(
    files: string[],
    onProgress?: (current: number) => void
  ): Promise<void> {
    let processed = 0;
    const total = files.length;
    const startTime = Date.now();

    const indexFile = async (uri: string): Promise<void> => {
      try {
        let result: IndexedFileResult;
        
        if (this.workerPool) {
          // Pass only URI to minimize data transfer between threads
          result = await this.workerPool.runTask({ uri });
        } else {
          const indexer = this.languageRouter || this.symbolIndexer;
          result = await indexer.indexFile(uri);
        }
        
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
    };

    await Promise.allSettled(files.map(indexFile));
    
    const duration = Date.now() - startTime;
    const filesPerSecond = (total / (duration / 1000)).toFixed(2);
    
    if (this.workerPool) {
      const stats = this.workerPool.getStats();
      console.info(
        `[BackgroundIndex] Completed indexing ${total} files in ${duration}ms (${filesPerSecond} files/sec) - ` +
        `Pool stats: ${stats.totalProcessed} processed, ${stats.totalErrors} errors`
      );
    } else {
      console.info(`[BackgroundIndex] Completed indexing ${total} files in ${duration}ms (${filesPerSecond} files/sec)`);
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
   * Cleanup resources including worker pool.
   */
  async dispose(): Promise<void> {
    if (this.workerPool) {
      await this.workerPool.terminate();
      this.workerPool = null;
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
