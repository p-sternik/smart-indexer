import { ISymbolIndex } from './ISymbolIndex.js';
import { IndexedSymbol, IndexedFileResult, IndexedReference, ImportInfo, ReExportInfo, PendingReference, SHARD_VERSION } from '../types.js';
import { SymbolIndexer } from '../indexer/symbolIndexer.js';
import { LanguageRouter } from '../indexer/languageRouter.js';
import { fuzzyScore } from '../utils/fuzzySearch.js';
import { toCamelCase, toPascalCase, sanitizeFilePath } from '../utils/stringUtils.js';
import { WorkerPool } from '../utils/workerPool.js';
import { ConfigurationManager } from '../config/configurationManager.js';
import { ShardPersistenceManager, FileShard } from './ShardPersistenceManager.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Represents a single shard (per-file index) on disk.
 * Re-exported from ShardPersistenceManager for backward compatibility.
 */
export { FileShard } from './ShardPersistenceManager.js';

/**
 * Progress callback for indexing operations.
 */
export type ProgressCallback = (progress: {
  state: 'busy' | 'idle' | 'finalizing';
  processed: number;
  total: number;
  currentFile?: string;
}) => void;

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
  private shardManager: ShardPersistenceManager;
  private fileMetadata: Map<string, { hash: string; lastIndexedAt: number; symbolCount: number; mtime?: number }> = new Map();
  private symbolNameIndex: Map<string, Set<string>> = new Map(); // name -> Set of URIs
  private symbolIdIndex: Map<string, string> = new Map(); // symbolId -> URI
  private fileToSymbolIds: Map<string, Set<string>> = new Map(); // uri -> Set of symbolIds (reverse index for O(1) cleanup)
  private referenceMap: Map<string, Set<string>> = new Map(); // symbolName -> Set of URIs containing references
  private isInitialized: boolean = false;
  private maxConcurrentJobs: number = 4;
  private workerPool: WorkerPool | null = null;
  private progressCallback: ProgressCallback | null = null;
  private isBulkIndexing: boolean = false; // Flag to defer NgRx resolution during bulk indexing

  constructor(symbolIndexer: SymbolIndexer, maxConcurrentJobs: number = 4) {
    this.symbolIndexer = symbolIndexer;
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.shardManager = new ShardPersistenceManager(true, 100); // Enable buffering with 100ms coalescing
  }

  /**
   * Set the progress callback for indexing operations.
   */
  setProgressCallback(callback: ProgressCallback): void {
    this.progressCallback = callback;
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
    // Initialize the centralized shard persistence manager
    this.shardManager.init(workspaceRoot, cacheDirectory);

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
      const shardsDirectory = this.shardManager.getShardsDirectory();
      if (!fs.existsSync(shardsDirectory)) {
        return;
      }

      const shardFiles = this.shardManager.collectShardFiles();
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

          // Build symbol name index and reverse index for O(1) cleanup
          const symbolIds = new Set<string>();
          for (const symbol of shard.symbols) {
            let uriSet = this.symbolNameIndex.get(symbol.name);
            if (!uriSet) {
              uriSet = new Set();
              this.symbolNameIndex.set(symbol.name, uriSet);
            }
            uriSet.add(shard.uri);

            // Build symbol ID index
            this.symbolIdIndex.set(symbol.id, shard.uri);
            symbolIds.add(symbol.id);
          }
          // Store reverse mapping for O(1) cleanup
          this.fileToSymbolIds.set(shard.uri, symbolIds);

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
   * Load a shard from disk via ShardPersistenceManager.
   */
  private async loadShard(uri: string): Promise<FileShard | null> {
    return this.shardManager.loadShard(uri);
  }

  /**
   * Save a shard to disk via ShardPersistenceManager.
   */
  private async saveShard(shard: FileShard): Promise<void> {
    return this.shardManager.saveShard(shard);
  }

  /**
   * Delete a shard from disk via ShardPersistenceManager.
   */
  private async deleteShard(uri: string): Promise<void> {
    return this.shardManager.deleteShard(uri);
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

    // Remove old symbol IDs for this URI using reverse index (O(1) lookup)
    const oldSymbolIds = this.fileToSymbolIds.get(uri);
    if (oldSymbolIds) {
      for (const symbolId of oldSymbolIds) {
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

    // Add new symbols and build reverse index
    const newSymbolIds = new Set<string>();
    for (const symbol of result.symbols) {
      let uriSet = this.symbolNameIndex.get(symbol.name);
      if (!uriSet) {
        uriSet = new Set();
        this.symbolNameIndex.set(symbol.name, uriSet);
      }
      uriSet.add(uri);

      // Add to symbol ID index
      this.symbolIdIndex.set(symbol.id, uri);
      newSymbolIds.add(symbol.id);
    }
    // Update reverse index for O(1) cleanup
    this.fileToSymbolIds.set(uri, newSymbolIds);

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

    // Save shard to disk - ShardPersistenceManager handles locking internally
    await this.saveShard(shard);

    // Resolve NgRx cross-file references after indexing
    // Skip during bulk indexing - will be done in finalizeIndexing() for O(N+M) performance
    if (!this.isBulkIndexing && result.pendingReferences && result.pendingReferences.length > 0) {
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
        // Try exact match first, then camelCase, then PascalCase fallback
        const events = containerSymbol.ngrxMetadata.events;
        let matchedMember: string | null = null;
        
        if (pending.member in events) {
          matchedMember = pending.member;
        } else {
          // Fallback 1: Try camelCase version (e.g., 'Load' -> 'load')
          const camelMember = toCamelCase(pending.member);
          if (camelMember in events) {
            matchedMember = camelMember;
            console.info(`[BackgroundIndex] NgRx camelCase fallback: ${pending.member} -> ${camelMember}`);
          } else {
            // Fallback 2: Try PascalCase version (e.g., 'load' -> 'Load')
            const pascalMember = toPascalCase(pending.member);
            if (pascalMember in events) {
              matchedMember = pascalMember;
              console.info(`[BackgroundIndex] NgRx PascalCase fallback: ${pending.member} -> ${pascalMember}`);
            }
          }
        }
        
        if (!matchedMember) {
          // Debug logging when match fails
          console.log(`[BackgroundIndex] NgRx link failed: ${pending.container}.${pending.member} not found in events:`, Object.keys(events));
          continue;
        }

        // Found a match! Create a synthetic reference linking usage to the action definition
        // The member name (e.g., 'load') maps to the virtual symbol created in worker.ts
        const syntheticRef: IndexedReference = {
          symbolName: pending.member, // Use original member name for consistency
          location: pending.location,
          range: pending.range,
          containerName: pending.containerName,
          isLocal: false
        };

        // Add to referenceMap so FindReferences works (in-memory)
        let refUriSet = this.referenceMap.get(pending.member);
        if (!refUriSet) {
          refUriSet = new Set();
          this.referenceMap.set(pending.member, refUriSet);
        }
        refUriSet.add(sourceUri);

        // Persist synthetic reference to source shard (survives restart)
        // ShardPersistenceManager handles locking internally
        await this.shardManager.withLock(sourceUri, async () => {
          // CRITICAL: Use loadShardNoLock to avoid nested lock acquisition (deadlock fix)
          const sourceShard = await this.shardManager.loadShardNoLock(sourceUri);
          if (sourceShard) {
            if (!sourceShard.references) {
              sourceShard.references = [];
            }
            // Avoid duplicates
            const refKey = `${syntheticRef.symbolName}:${syntheticRef.location.line}:${syntheticRef.location.character}`;
            const exists = sourceShard.references.some(
              r => `${r.symbolName}:${r.location.line}:${r.location.character}` === refKey
            );
            if (!exists) {
              sourceShard.references.push(syntheticRef);
            }
            
            // Clear this resolved pending reference from the shard to prevent reprocessing on restart
            if (sourceShard.pendingReferences) {
              sourceShard.pendingReferences = sourceShard.pendingReferences.filter(
                pr => !(pr.container === pending.container && 
                        pr.member === pending.member &&
                        pr.location.line === pending.location.line && 
                        pr.location.character === pending.location.character)
              );
            }
            
            // CRITICAL: Use saveShardNoLock to avoid nested lock acquisition
            await this.shardManager.saveShardNoLock(sourceShard);
          }
        });

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
  async updateSingleFile(rawFilePath: string): Promise<void> {
    // Sanitize path to handle Git's quoted/escaped output
    const filePath = sanitizeFilePath(rawFilePath);
    
    try {
      // PRE-VALIDATION: Check file exists to prevent ENOENT errors
      if (!fs.existsSync(filePath)) {
        console.warn(`[BackgroundIndex] Skipping non-existent file: ${filePath}`);
        return;
      }

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

    // Remove from symbol ID index using reverse index (O(1) lookup)
    const oldSymbolIds = this.fileToSymbolIds.get(uri);
    if (oldSymbolIds) {
      for (const symbolId of oldSymbolIds) {
        this.symbolIdIndex.delete(symbolId);
      }
      this.fileToSymbolIds.delete(uri);
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

    // Remove from symbol ID index using reverse index (O(1) lookup)
    const oldSymbolIds = this.fileToSymbolIds.get(uri);
    if (oldSymbolIds) {
      for (const symbolId of oldSymbolIds) {
        this.symbolIdIndex.delete(symbolId);
      }
      this.fileToSymbolIds.delete(uri);
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
    // PRE-QUEUE VALIDATION: Sanitize paths and filter out non-existent files
    const validFiles: string[] = [];
    const skippedFiles: string[] = [];
    
    for (const rawUri of files) {
      // Sanitize path to handle Git's quoted/escaped output
      const uri = sanitizeFilePath(rawUri);
      
      if (fs.existsSync(uri)) {
        validFiles.push(uri);
      } else {
        skippedFiles.push(rawUri); // Log original for debugging
      }
    }
    
    if (skippedFiles.length > 0) {
      console.warn(
        `[BackgroundIndex] Skipping ${skippedFiles.length} non-existent files (possible path encoding issue)`
      );
      // Log first few for debugging
      for (const skipped of skippedFiles.slice(0, 5)) {
        console.warn(`[BackgroundIndex]   - ${skipped}`);
      }
      if (skippedFiles.length > 5) {
        console.warn(`[BackgroundIndex]   ... and ${skippedFiles.length - 5} more`);
      }
    }

    let processed = 0;
    const total = validFiles.length;
    const startTime = Date.now();
    let lastProgressTime = startTime;

    // Enable bulk indexing mode to defer NgRx resolution
    this.isBulkIndexing = true;

    // Emit initial busy state
    if (this.progressCallback) {
      this.progressCallback({
        state: 'busy',
        processed: 0,
        total,
        currentFile: validFiles[0]
      });
    }

    const indexFile = async (uri: string): Promise<void> => {
      console.info(`[Debug] Starting task for: ${uri}`);
      try {
        let result: IndexedFileResult;
        
        if (this.workerPool) {
          // Pass only URI to minimize data transfer between threads
          result = await this.workerPool.runTask({ uri });
        } else {
          const indexer = this.languageRouter || this.symbolIndexer;
          result = await indexer.indexFile(uri);
        }
        
        // Skip saving shard for files that failed to read
        if (result.isSkipped) {
          console.info(`[Debug] Task skipped for: ${uri} with reason: ${result.skipReason}`);
          console.warn(`[BackgroundIndex] Skipping file (${result.skipReason}): ${uri}`);
        } else {
          console.info(`[Debug] Task success for: ${uri}`);
          await this.updateFile(uri, result);
        }
      } catch (error) {
        console.error(`[Debug] Task CRASHED for: ${uri}: ${error}`);
        console.error(`[BackgroundIndex] Error indexing file ${uri}: ${error}`);
      } finally {
        // CRITICAL FIX: This MUST happen no matter what - moved to finally block
        processed++;
        console.info(`[Debug] Counter incremented: ${processed}/${total}`);
        if (onProgress) {
          onProgress(processed);
        }

        // Emit progress notification (throttled to every 500ms or every 10 files)
        const now = Date.now();
        if (this.progressCallback && (now - lastProgressTime >= 500 || processed % 10 === 0 || processed === total)) {
          lastProgressTime = now;
          this.progressCallback({
            state: 'busy',
            processed,
            total,
            currentFile: uri
          });
        }
      }
    };

    await Promise.allSettled(validFiles.map(indexFile));

    // Disable bulk indexing mode
    this.isBulkIndexing = false;

    // FIX: Update UI to show finalization phase (prevents "0 remaining" hang)
    if (this.progressCallback) {
      this.progressCallback({
        state: 'finalizing',
        processed: total,
        total
      });
    }
    console.info('[BackgroundIndex] Starting finalization phase...');

    // Finalize: batch-resolve all deferred NgRx references (O(N+M) instead of O(N*M))
    console.time('Finalize');
    await this.finalizeIndexing();
    console.timeEnd('Finalize');

    // SAFETY NET: Validate and reset worker pool counters after all tasks complete
    // This ensures the status bar reaches "Ready" even if counters got desynchronized
    if (this.workerPool) {
      this.workerPool.validateCounters();
      // If processed count matches total, force reset to ensure clean state
      if (processed === total) {
        this.workerPool.reset();
      }
    }

    // FIX: Emit idle state AFTER finalization completes - explicit "Ready" signal
    if (this.progressCallback) {
      this.progressCallback({
        state: 'idle',
        processed: total, // Always report total to ensure "Ready" state
        total
      });
    }
    console.info('[BackgroundIndex] Background indexing completed successfully.');
    
    const duration = Date.now() - startTime;
    const filesPerSecond = (total / (duration / 1000)).toFixed(2);
    
    if (this.workerPool) {
      const stats = this.workerPool.getStats();
      console.info(
        `[BackgroundIndex] Completed indexing ${total} files in ${duration}ms (${filesPerSecond} files/sec) - ` +
        `Pool stats: ${stats.totalProcessed} processed, ${stats.totalErrors} errors, active=${stats.activeTasks}`
      );
    } else {
      console.info(`[BackgroundIndex] Completed indexing ${total} files in ${duration}ms (${filesPerSecond} files/sec)`);
    }
  }

  /**
   * Finalize indexing by resolving all deferred cross-file references in batch.
   * 
   * OPTIMIZED APPROACH:
   * 1. Single pass through all files to build NgRx lookup AND collect pending refs
   * 2. Resolve all references in-memory (no I/O)
   * 3. Batch write: one load + one save per file with pending refs
   * 
   * This achieves O(N) I/O instead of O(N*M) for significant performance gains.
   */
  async finalizeIndexing(): Promise<void> {
    const startTime = Date.now();
    
    console.info('[Finalize] Starting finalization phase...');
    
    // STEP 1: Single pass to build NgRx lookup AND collect pending references
    // This combines the previous Step 1 and Step 2 into one pass
    console.info('[Finalize] Step 1: Scanning files for action groups and pending refs...');
    
    const actionGroupLookup = new Map<string, { uri: string; events: Record<string, string> }>();
    const pendingByFile = new Map<string, PendingReference[]>();
    
    const files = Array.from(this.fileMetadata.keys());
    const totalFiles = files.length;
    let symbolsScanned = 0;
    let totalPending = 0;
    
    for (let i = 0; i < files.length; i++) {
      const uri = files[i];
      if (i % 100 === 0) {
        console.info(`[Finalize] Step 1 progress: ${i}/${totalFiles} files scanned`);
      }
      
      const shard = await this.loadShard(uri);
      if (!shard) {
        continue;
      }
      
      // Collect NgRx action groups
      for (const symbol of shard.symbols) {
        symbolsScanned++;
        if (symbol.ngrxMetadata?.isGroup === true && symbol.ngrxMetadata?.events) {
          actionGroupLookup.set(symbol.name, {
            uri,
            events: symbol.ngrxMetadata.events
          });
        }
      }
      
      // Collect pending references
      if (shard.pendingReferences && shard.pendingReferences.length > 0) {
        pendingByFile.set(uri, [...shard.pendingReferences]);
        totalPending += shard.pendingReferences.length;
      }
    }
    
    console.info(
      `[Finalize] Step 1 complete: Found ${actionGroupLookup.size} action groups, ` +
      `${totalPending} pending refs in ${pendingByFile.size} files ` +
      `(scanned ${symbolsScanned} symbols in ${totalFiles} files)`
    );
    
    if (totalPending === 0) {
      console.info(`[Finalize] No pending references to resolve. Done.`);
      return;
    }
    
    // STEP 2: Resolve all references in-memory (no I/O)
    // Build a map of: uri -> { newRefs: IndexedReference[], resolvedPendingKeys: Set<string> }
    console.info('[Finalize] Step 2: Resolving references in-memory...');
    
    interface FileUpdate {
      newRefs: IndexedReference[];
      resolvedKeys: Set<string>;
      ngrxCount: number;
      fallbackCount: number;
    }
    
    const updatesByFile = new Map<string, FileUpdate>();
    let ngrxResolved = 0;
    let fallbackResolved = 0;
    
    for (const [uri, pendingRefs] of pendingByFile) {
      const update: FileUpdate = {
        newRefs: [],
        resolvedKeys: new Set(),
        ngrxCount: 0,
        fallbackCount: 0
      };
      
      for (const pending of pendingRefs) {
        const pendingKey = `${pending.container}:${pending.member}:${pending.location.line}:${pending.location.character}`;
        
        // Try NgRx resolution first
        const actionGroup = actionGroupLookup.get(pending.container);
        let resolvedAsNgRx = false;
        
        if (actionGroup) {
          // Check if the member exists in the events map
          let matchedMember: string | null = null;
          
          if (pending.member in actionGroup.events) {
            matchedMember = pending.member;
          } else {
            const camelMember = toCamelCase(pending.member);
            if (camelMember in actionGroup.events) {
              matchedMember = camelMember;
            } else {
              const pascalMember = toPascalCase(pending.member);
              if (pascalMember in actionGroup.events) {
                matchedMember = pascalMember;
              }
            }
          }
          
          if (matchedMember) {
            update.newRefs.push({
              symbolName: pending.member,
              location: pending.location,
              range: pending.range,
              containerName: pending.containerName,
              isLocal: false
            });
            update.resolvedKeys.add(pendingKey);
            update.ngrxCount++;
            resolvedAsNgRx = true;
            
            // Update in-memory referenceMap
            let refUriSet = this.referenceMap.get(pending.member);
            if (!refUriSet) {
              refUriSet = new Set();
              this.referenceMap.set(pending.member, refUriSet);
            }
            refUriSet.add(uri);
          }
        }
        
        // Fallback: Non-NgRx imported member access
        if (!resolvedAsNgRx) {
          const qualifiedName = `${pending.container}.${pending.member}`;
          update.newRefs.push({
            symbolName: qualifiedName,
            location: pending.location,
            range: pending.range,
            containerName: pending.containerName,
            isLocal: false
          });
          update.resolvedKeys.add(pendingKey);
          update.fallbackCount++;
          
          // Update in-memory referenceMap
          let refUriSet = this.referenceMap.get(qualifiedName);
          if (!refUriSet) {
            refUriSet = new Set();
            this.referenceMap.set(qualifiedName, refUriSet);
          }
          refUriSet.add(uri);
        }
      }
      
      if (update.newRefs.length > 0) {
        updatesByFile.set(uri, update);
        ngrxResolved += update.ngrxCount;
        fallbackResolved += update.fallbackCount;
      }
    }
    
    console.info(
      `[Finalize] Step 2 complete: Resolved ${ngrxResolved} NgRx + ${fallbackResolved} fallback refs in-memory`
    );
    
    // STEP 3: Batch write - single load + save per file
    // CRITICAL FIX: Use shardManager.loadShardNoLock() to avoid nested lock deadlock
    // Previously: withLock() -> loadShard() -> shardManager.loadShard() -> withLock() = DEADLOCK
    console.info('[Finalize] Step 3: Batch writing updates to disk...');
    
    let shardsModified = 0;
    const totalUpdates = updatesByFile.size;
    let processedCount = 0;
    
    for (const [uri, update] of updatesByFile) {
      processedCount++;
      
      // Verbose debug logging for every reference to identify hangs
      console.info(`[Finalize] Step 3 processing ${processedCount}/${totalUpdates}: ${uri}`);
      
      try {
        // Use Promise.race with timeout to prevent infinite hangs
        const timeoutMs = 5000;
        const result = await Promise.race([
          this.shardManager.withLock(uri, async () => {
            // CRITICAL: Use loadShardNoLock to avoid nested lock acquisition
            const shard = await this.shardManager.loadShardNoLock(uri);
            if (!shard) {
              console.warn(`[Finalize] Step 3: Shard not found for ${uri}`);
              return false;
            }
            
            // Ensure arrays exist
            shard.references = shard.references || [];
            
            // Build set of existing ref keys for deduplication
            const existingRefKeys = new Set(
              shard.references.map(r => `${r.symbolName}:${r.location.line}:${r.location.character}`)
            );
            
            // Add only new references (avoid duplicates)
            for (const newRef of update.newRefs) {
              const refKey = `${newRef.symbolName}:${newRef.location.line}:${newRef.location.character}`;
              if (!existingRefKeys.has(refKey)) {
                shard.references.push(newRef);
                existingRefKeys.add(refKey);
              }
            }
            
            // Remove resolved pending references
            if (shard.pendingReferences) {
              shard.pendingReferences = shard.pendingReferences.filter(pr => {
                const key = `${pr.container}:${pr.member}:${pr.location.line}:${pr.location.character}`;
                return !update.resolvedKeys.has(key);
              });
            }
            
            // CRITICAL: Use saveShardNoLock to avoid nested lock
            await this.shardManager.saveShardNoLock(shard);
            return true;
          }),
          new Promise<boolean>((_, reject) => 
            setTimeout(() => reject(new Error(`TIMEOUT after ${timeoutMs}ms`)), timeoutMs)
          )
        ]);
        
        if (result) {
          shardsModified++;
        }
        console.info(`[Finalize] Step 3 done ${processedCount}/${totalUpdates}: ${uri}`);
      } catch (error) {
        console.error(`[Finalize] Step 3 FAILED for ${uri}: ${error}`);
        // Continue processing other files even if one fails
      }
    }
    
    const duration = Date.now() - startTime;
    console.info(
      `[Finalize] Complete: ` +
      `NgRx=${ngrxResolved}, Fallback=${fallbackResolved}, Total=${totalPending} ` +
      `(${shardsModified} shards modified) in ${duration}ms`
    );
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
      await this.shardManager.clearAll();

      this.fileMetadata.clear();
      this.symbolNameIndex.clear();
      this.symbolIdIndex.clear();
      this.fileToSymbolIds.clear();
      this.referenceMap.clear();
    } catch (error) {
      console.error(`[BackgroundIndex] Error clearing shards: ${error}`);
      throw error;
    }
  }

  /**
   * Cleanup resources including worker pool and shard manager.
   */
  async dispose(): Promise<void> {
    if (this.workerPool) {
      await this.workerPool.terminate();
      this.workerPool = null;
    }
    await this.shardManager.dispose();
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
