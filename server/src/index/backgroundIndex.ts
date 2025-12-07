import { ISymbolIndex } from './ISymbolIndex.js';
import { IndexedSymbol, IndexedFileResult, IndexedReference, ImportInfo, ReExportInfo, PendingReference, SHARD_VERSION } from '../types.js';
import { SymbolIndexer } from '../indexer/symbolIndexer.js';
import { LanguageRouter } from '../indexer/languageRouter.js';
import { fuzzyScore } from '../utils/fuzzySearch.js';
import { sanitizeFilePath, toCamelCase, toPascalCase } from '../utils/stringUtils.js';
import { IWorkerPool } from '../utils/workerPool.js';
import { ConfigurationManager } from '../config/configurationManager.js';
import { IIndexStorage, FileIndexData, FileMetadata } from '../storage/IIndexStorage.js';
import { NgRxLinkResolver } from './resolvers/NgRxLinkResolver.js';
import { IndexScheduler, ProgressCallback } from './IndexScheduler.js';
import { STORAGE_CONFIG, INDEXING_STATE, LOG_PREFIX } from '../constants.js';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

/**
 * Represents a single file's indexed data.
 * Type alias for FileIndexData for backward compatibility.
 */
export type FileShard = FileIndexData;

/**
 * Re-export ProgressCallback for backward compatibility.
 */
export { ProgressCallback } from './IndexScheduler.js';

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
  private storage: IIndexStorage;
  private fileMetadata: Map<string, { hash: string; lastIndexedAt: number; symbolCount: number; mtime?: number }> = new Map();
  private symbolNameIndex: Map<string, Set<string>> = new Map(); // name -> Set of URIs
  private symbolIdIndex: Map<string, string> = new Map(); // symbolId -> URI
  private fileToSymbolIds: Map<string, Set<string>> = new Map(); // uri -> Set of symbolIds (reverse index for O(1) cleanup)
  private fileToSymbolNames: Map<string, Set<string>> = new Map(); // uri -> Set of symbol names (reverse index for O(1) cleanup)
  private fileToReferenceNames: Map<string, Set<string>> = new Map(); // uri -> Set of referenced symbol names (reverse index for O(1) cleanup)
  private referenceMap: Map<string, Set<string>> = new Map(); // symbolName -> Set of URIs containing references
  private isInitialized: boolean = false;
  private scheduler: IndexScheduler;
  
  // LRU shard cache to reduce disk I/O
  private shardCache: Map<string, FileShard> = new Map();

  // Specialized resolver for NgRx action group references
  private ngrxResolver: NgRxLinkResolver;

  /**
   * Create a BackgroundIndex with injected dependencies.
   * 
   * @param symbolIndexer - Symbol indexer for parsing
   * @param storage - Storage backend for index persistence
   * @param workerPool - Worker pool for parallel indexing (managed by IndexScheduler)
   * @param ngrxResolver - Resolver for NgRx action group references
   */
  constructor(
    symbolIndexer: SymbolIndexer,
    storage: IIndexStorage,
    workerPool: IWorkerPool,
    ngrxResolver: NgRxLinkResolver
  ) {
    this.symbolIndexer = symbolIndexer;
    this.storage = storage;
    this.ngrxResolver = ngrxResolver;
    this.scheduler = new IndexScheduler(workerPool);
  }

  /**
   * Set the progress callback for indexing operations.
   */
  setProgressCallback(callback: ProgressCallback): void {
    this.scheduler.setProgressCallback(callback);
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
   * @deprecated This is now managed by IndexScheduler/WorkerPool
   */
  setMaxConcurrentJobs(max: number): void {
    console.warn(`${LOG_PREFIX.BACKGROUND_INDEX} setMaxConcurrentJobs is deprecated - worker pool manages concurrency`);
  }

  /**
   * Initialize the background index.
   * Validates shard version and clears incompatible cache.
   */
  async init(workspaceRoot: string, cacheDirectory: string): Promise<void> {
    // Initialize the storage backend
    await this.storage.init(workspaceRoot, cacheDirectory);
    
    // MIGRATION SAFETY: Validate shard version compatibility
    const isCompatible = await this.validateShardVersion();
    if (!isCompatible) {
      console.warn(`${LOG_PREFIX.BACKGROUND_INDEX} Shard version mismatch detected. Current version: ${SHARD_VERSION}. Clearing incompatible cache...`);
      await this.clearAllShards();
      console.info(`${LOG_PREFIX.BACKGROUND_INDEX} Cache cleared. Full re-indexing will be triggered.`);
    }
    
    console.info(`${LOG_PREFIX.BACKGROUND_INDEX} Initialized (concurrency managed by IndexScheduler)`);

    await this.loadShardMetadata();
    this.isInitialized = true;
  }

  /**
   * Validate that existing shards match the current SHARD_VERSION.
   * Returns false if any shard has a mismatched version, triggering a full re-index.
   */
  private async validateShardVersion(): Promise<boolean> {
    try {
      // Load a sample of shards to check version
      const summaryEntries = await this.storage.getAllMetadata();
      
      if (!summaryEntries || summaryEntries.length === 0) {
        // No existing shards - fresh start
        return true;
      }
      
      // Check the first shard's version
      const firstEntry = summaryEntries[0];
      const shard = await this.storage.getFile(firstEntry.uri);
      
      if (!shard) {
        // Couldn't load shard - assume incompatible
        return false;
      }
      
      // Compare shard version
      const shardVersion = shard.shardVersion || 0;
      if (shardVersion !== SHARD_VERSION) {
        console.warn(`${LOG_PREFIX.BACKGROUND_INDEX} Version mismatch: shard has ${shardVersion}, expected ${SHARD_VERSION}`);
        return false;
      }
      
      return true;
    } catch (error) {
      console.error(`${LOG_PREFIX.BACKGROUND_INDEX} Error validating shard version: ${error}`);
      // On error, assume incompatible to be safe
      return false;
    }
  }

  /**
   * Clear all shards from disk (for migration/version mismatch).
   */
  private async clearAllShards(): Promise<void> {
    try {
      // Clear in-memory structures
      this.fileMetadata.clear();
      this.symbolNameIndex.clear();
      this.symbolIdIndex.clear();
      this.fileToSymbolIds.clear();
      this.fileToSymbolNames.clear();
      this.fileToReferenceNames.clear();
      this.referenceMap.clear();
      this.shardCache.clear();
      
      // Clear disk storage
      await this.storage.clear();
      
      console.info(`${LOG_PREFIX.BACKGROUND_INDEX} All shards cleared successfully`);
    } catch (error) {
      console.error(`${LOG_PREFIX.BACKGROUND_INDEX} Error clearing shards: ${error}`);
      throw error;
    }
  }

  /**
   * Load lightweight metadata from all shards.
   * Optimized O(1) startup: reads metadata.json summary if available,
   * falls back to O(N) shard scanning if missing/corrupt.
   */
  private async loadShardMetadata(): Promise<void> {
    try {
      // OPTIMIZATION: Try loading metadata summary first (O(1) startup)
      const summaryEntries = await this.storage.getAllMetadata();
      
      if (summaryEntries && summaryEntries.length > 0) {
        // Fast path: use cached metadata summary
        await this.loadFromMetadataSummary(summaryEntries);
        return;
      }
      
      // Fallback: scan all shards (O(N) startup)
      await this.loadFromShardScan();
    } catch (error) {
      console.error(`${LOG_PREFIX.BACKGROUND_INDEX} Error loading shard metadata: ${error}`);
    }
  }

  /**
   * Load index data from metadata summary entries.
   * This is the fast O(1) startup path.
   */
  private async loadFromMetadataSummary(entries: FileMetadata[]): Promise<void> {
    const startTime = Date.now();
    let loadedShards = 0;
    
    // Process entries in batches to avoid blocking event loop
    const BATCH_SIZE = 100;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async (entry) => {
        try {
          // Store lightweight metadata
          this.fileMetadata.set(entry.uri, {
            hash: entry.hash,
            lastIndexedAt: entry.lastIndexedAt,
            symbolCount: entry.symbolCount,
            mtime: entry.mtime
          });
          
          // Load full shard to build symbol indexes
          const shard = await this.storage.getFile(entry.uri);
          if (!shard) {
            return;
          }
          
          // Build symbol name index and reverse indexes for O(1) cleanup
          const symbolIds = new Set<string>();
          const symbolNames = new Set<string>();
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
            symbolNames.add(symbol.name);
          }
          // Store reverse mappings for O(1) cleanup
          this.fileToSymbolIds.set(shard.uri, symbolIds);
          this.fileToSymbolNames.set(shard.uri, symbolNames);

          // Build reference map and reverse index
          if (shard.references) {
            const referenceNames = new Set<string>();
            for (const ref of shard.references) {
              let refUriSet = this.referenceMap.get(ref.symbolName);
              if (!refUriSet) {
                refUriSet = new Set();
                this.referenceMap.set(ref.symbolName, refUriSet);
              }
              refUriSet.add(shard.uri);
              referenceNames.add(ref.symbolName);
            }
            this.fileToReferenceNames.set(shard.uri, referenceNames);
          }

          loadedShards++;
        } catch (error) {
          console.error(`${LOG_PREFIX.BACKGROUND_INDEX} Error loading shard for ${entry.uri}: ${error}`);
        }
      }));
      
      // Yield to event loop after each batch
      if (i + BATCH_SIZE < entries.length) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    
    const duration = Date.now() - startTime;
    console.info(`${LOG_PREFIX.BACKGROUND_INDEX} Loaded ${loadedShards} shards from metadata summary in ${duration}ms`);
  }

  /**
   * Load index data by scanning all shard files.
   * This is the fallback O(N) startup path when metadata.json is missing.
   */
  private async loadFromShardScan(): Promise<void> {
    const storageDirectory = this.storage.getStoragePath();
    try {
      await fsPromises.access(storageDirectory);
    } catch {
      return; // Directory doesn't exist yet
    }

    const fileUris = await this.storage.collectAllFiles();
    let loadedShards = 0;

    // Process shards in batches to avoid blocking event loop
    const BATCH_SIZE = 100;
    for (let i = 0; i < fileUris.length; i += BATCH_SIZE) {
      const batch = fileUris.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async (uri) => {
        try {
          // Load via storage backend
          const shard = await this.storage.getFile(uri);
          if (!shard) {
            return;
          }

          this.fileMetadata.set(shard.uri, {
            hash: shard.hash,
            lastIndexedAt: shard.lastIndexedAt,
            symbolCount: shard.symbols.length,
            mtime: shard.mtime
          });
          
          // Update metadata cache for next startup
          await this.storage.updateMetadata({
            uri: shard.uri,
            hash: shard.hash,
            mtime: shard.mtime,
            symbolCount: shard.symbols.length,
            lastIndexedAt: shard.lastIndexedAt
          });

          // Build symbol name index and reverse indexes for O(1) cleanup
          const symbolIds = new Set<string>();
          const symbolNames = new Set<string>();
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
            symbolNames.add(symbol.name);
          }
          // Store reverse mappings for O(1) cleanup
          this.fileToSymbolIds.set(shard.uri, symbolIds);
          this.fileToSymbolNames.set(shard.uri, symbolNames);

          // Build reference map and reverse index
          if (shard.references) {
            const referenceNames = new Set<string>();
            for (const ref of shard.references) {
              let refUriSet = this.referenceMap.get(ref.symbolName);
              if (!refUriSet) {
                refUriSet = new Set();
                this.referenceMap.set(ref.symbolName, refUriSet);
              }
              refUriSet.add(shard.uri);
              referenceNames.add(ref.symbolName);
            }
            this.fileToReferenceNames.set(shard.uri, referenceNames);
          }

          loadedShards++;
        } catch (error) {
          console.error(`${LOG_PREFIX.BACKGROUND_INDEX} Error loading shard ${uri}: ${error}`);
        }
      }));
      
      // Yield to event loop after each batch
      if (i + BATCH_SIZE < fileUris.length) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    // Save metadata summary for fast startup next time
    await this.storage.saveMetadataSummary();
    
    console.info(`${LOG_PREFIX.BACKGROUND_INDEX} Loaded metadata from ${loadedShards} shards (scanned)`);
  }

  /**
   * Load a shard from disk via ShardPersistenceManager with LRU caching.
   * Uses an in-memory cache to reduce disk I/O for frequently accessed shards.
   */
  private async loadShard(uri: string): Promise<FileShard | null> {
    // Check cache first (O(1) lookup)
    const cached = this.shardCache.get(uri);
    if (cached) {
      // Move to end for LRU (delete + re-add makes it most recently used)
      this.shardCache.delete(uri);
      this.shardCache.set(uri, cached);
      return cached;
    }

    // Cache miss: load from storage
    const shard = await this.storage.getFile(uri);
    if (shard) {
      // Enforce LRU eviction before adding new entry
      if (this.shardCache.size >= STORAGE_CONFIG.MAX_LRU_CACHE_SIZE) {
        // Delete oldest entry (first key in Map iteration order)
        const oldestKey = this.shardCache.keys().next().value;
        if (oldestKey) {
          this.shardCache.delete(oldestKey);
        }
      }
      this.shardCache.set(uri, shard);
    }

    return shard;
  }

  /**
   * Save a shard to storage.
   */
  private async saveShard(shard: FileShard): Promise<void> {
    return this.storage.storeFile(shard);
  }

  /**
   * Delete a shard from storage.
   */
  private async deleteShard(uri: string): Promise<void> {
    return this.storage.deleteFile(uri);
  }

  /**
   * Update/add a file to the background index.
   * 
   * THREAD-SAFE: Uses mutex locking to prevent race conditions when
   * concurrent updates occur (e.g., from file watcher + didChange events).
   * 
   * OPTIMIZED: Uses O(1) reverse indexes for cleanup instead of O(N) scans.
   */
  async updateFile(uri: string, result: IndexedFileResult): Promise<void> {
    // Capture pending references before the lock to avoid race conditions
    // where file state changes between update and resolution
    const pendingRefs = result.pendingReferences && result.pendingReferences.length > 0
      ? [...result.pendingReferences] // Copy to prevent mutation during async operations
      : null;

    // Wrap entire operation in lock to prevent race conditions
    await this.storage.withLock(uri, async () => {
      // CRITICAL: Invalidate cache INSIDE lock to prevent stale cache repopulation
      this.shardCache.delete(uri);
      
      // Get current mtime (async)
      let mtime: number | undefined;
      try {
        const stats = await fsPromises.stat(uri);
        mtime = stats.mtimeMs;
      } catch (error) {
        console.warn(`${LOG_PREFIX.BACKGROUND_INDEX} Could not get mtime for ${uri}: ${error}`);
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

      // O(1) CLEANUP: Remove old symbol names using reverse index
      const oldSymbolNames = this.fileToSymbolNames.get(uri);
      if (oldSymbolNames) {
        for (const name of oldSymbolNames) {
          const uriSet = this.symbolNameIndex.get(name);
          if (uriSet) {
            uriSet.delete(uri);
            if (uriSet.size === 0) {
              this.symbolNameIndex.delete(name);
            }
          }
        }
      }

      // O(1) CLEANUP: Remove old symbol IDs using reverse index
      const oldSymbolIds = this.fileToSymbolIds.get(uri);
      if (oldSymbolIds) {
        for (const symbolId of oldSymbolIds) {
          this.symbolIdIndex.delete(symbolId);
        }
      }

      // O(1) CLEANUP: Remove old references using reverse index
      const oldReferenceNames = this.fileToReferenceNames.get(uri);
      if (oldReferenceNames) {
        for (const symbolName of oldReferenceNames) {
          const uriSet = this.referenceMap.get(symbolName);
          if (uriSet) {
            uriSet.delete(uri);
            if (uriSet.size === 0) {
              this.referenceMap.delete(symbolName);
            }
          }
        }
      }

      // Add new symbols and build reverse indexes
      const newSymbolIds = new Set<string>();
      const newSymbolNames = new Set<string>();
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
        newSymbolNames.add(symbol.name);
      }
      // Update reverse indexes for O(1) cleanup
      this.fileToSymbolIds.set(uri, newSymbolIds);
      this.fileToSymbolNames.set(uri, newSymbolNames);

      // Add new references and build reverse index
      const newReferenceNames = new Set<string>();
      if (result.references) {
        for (const ref of result.references) {
          let refUriSet = this.referenceMap.get(ref.symbolName);
          if (!refUriSet) {
            refUriSet = new Set();
            this.referenceMap.set(ref.symbolName, refUriSet);
          }
          refUriSet.add(uri);
          newReferenceNames.add(ref.symbolName);
        }
      }
      this.fileToReferenceNames.set(uri, newReferenceNames);

      // Save shard to disk - use NoLock variant since we already hold the lock
      await this.storage.storeFileNoLock(shard);
      
      // Update metadata cache for fast startup
      await this.storage.updateMetadata({
        uri: shard.uri,
        hash: shard.hash,
        mtime: shard.mtime,
        symbolCount: result.symbols.length,
        lastIndexedAt: shard.lastIndexedAt
      });
    });

    // Resolve NgRx cross-file references after indexing (outside the lock to avoid deadlock)
    // Uses captured pendingRefs snapshot to prevent TOCTOU issues
    // Skip during bulk indexing - will be done in finalizeIndexing() for O(N+M) performance
    if (!this.scheduler.isBulkIndexing() && pendingRefs) {
      await this.resolveNgRxReferences(uri, pendingRefs);
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
              console.info(`${LOG_PREFIX.BACKGROUND_INDEX} NgRx PascalCase fallback: ${pending.member} -> ${pascalMember}`);
            }
          }
        }
        
        if (!matchedMember) {
          // Debug logging when match fails
          console.log(`${LOG_PREFIX.BACKGROUND_INDEX} NgRx link failed: ${pending.container}.${pending.member} not found in events:`, Object.keys(events));
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
        // Storage layer handles locking internally
        await this.storage.withLock(sourceUri, async () => {
          // CRITICAL: Use getFileNoLock to avoid nested lock acquisition (deadlock fix)
          const sourceShard = await this.storage.getFileNoLock(sourceUri);
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
            
            // CRITICAL: Use storeFileNoLock to avoid nested lock acquisition
            await this.storage.storeFileNoLock(sourceShard);
          }
        });

        resolvedCount++;
        break; // Found a match, no need to check other containers
      }
    }

    if (resolvedCount > 0) {
      console.info(`${LOG_PREFIX.BACKGROUND_INDEX} Resolved ${resolvedCount} NgRx cross-file references from ${sourceUri}`);
    }
  }

  /**
   * Update a single file in the background index (for live synchronization).
   * Delegates to IndexScheduler for orchestration.
   * 
   * @param filePath - Absolute path to the file to re-index
   */
  async updateSingleFile(rawFilePath: string): Promise<void> {
    const filePath = sanitizeFilePath(rawFilePath);
    
    // Cleanup old entries first
    const hadExistingEntry = this.fileMetadata.has(filePath);
    if (hadExistingEntry) {
      this.cleanupFileFromIndexes(filePath);
    }
    
    // Delegate to scheduler
    await this.scheduler.scheduleSingle(filePath, async (uri, result) => {
      await this.updateFile(uri, result);
    });
  }

  /**
   * Clean up a file's entries from in-memory indexes without deleting the shard.
   * This is used by updateSingleFile to prevent ghost references.
   * 
   * OPTIMIZED: Uses O(1) reverse indexes instead of O(N) scans.
   */
  private cleanupFileFromIndexes(uri: string): void {
    // Remove from file metadata
    this.fileMetadata.delete(uri);

    // O(1) CLEANUP: Remove from symbol name index using reverse index
    const oldSymbolNames = this.fileToSymbolNames.get(uri);
    if (oldSymbolNames) {
      for (const name of oldSymbolNames) {
        const uriSet = this.symbolNameIndex.get(name);
        if (uriSet) {
          uriSet.delete(uri);
          if (uriSet.size === 0) {
            this.symbolNameIndex.delete(name);
          }
        }
      }
      this.fileToSymbolNames.delete(uri);
    }

    // O(1) CLEANUP: Remove from symbol ID index using reverse index
    const oldSymbolIds = this.fileToSymbolIds.get(uri);
    if (oldSymbolIds) {
      for (const symbolId of oldSymbolIds) {
        this.symbolIdIndex.delete(symbolId);
      }
      this.fileToSymbolIds.delete(uri);
    }

    // O(1) CLEANUP: Remove from reference map using reverse index
    const oldReferenceNames = this.fileToReferenceNames.get(uri);
    if (oldReferenceNames) {
      for (const symbolName of oldReferenceNames) {
        const uriSet = this.referenceMap.get(symbolName);
        if (uriSet) {
          uriSet.delete(uri);
          if (uriSet.size === 0) {
            this.referenceMap.delete(symbolName);
          }
        }
      }
      this.fileToReferenceNames.delete(uri);
    }
  }

  /**
   * Remove a file from the background index.
   * 
   * OPTIMIZED: Uses O(1) reverse indexes instead of O(N) scans.
   */
  async removeFile(uri: string): Promise<void> {
    // CRITICAL: Invalidate cache to prevent stale reads
    this.shardCache.delete(uri);
    
    this.fileMetadata.delete(uri);

    // O(1) CLEANUP: Remove from symbol name index using reverse index
    const oldSymbolNames = this.fileToSymbolNames.get(uri);
    if (oldSymbolNames) {
      for (const name of oldSymbolNames) {
        const uriSet = this.symbolNameIndex.get(name);
        if (uriSet) {
          uriSet.delete(uri);
          if (uriSet.size === 0) {
            this.symbolNameIndex.delete(name);
          }
        }
      }
      this.fileToSymbolNames.delete(uri);
    }

    // O(1) CLEANUP: Remove from symbol ID index using reverse index
    const oldSymbolIds = this.fileToSymbolIds.get(uri);
    if (oldSymbolIds) {
      for (const symbolId of oldSymbolIds) {
        this.symbolIdIndex.delete(symbolId);
      }
      this.fileToSymbolIds.delete(uri);
    }

    // O(1) CLEANUP: Remove from reference map using reverse index
    const oldReferenceNames = this.fileToReferenceNames.get(uri);
    if (oldReferenceNames) {
      for (const symbolName of oldReferenceNames) {
        const uriSet = this.referenceMap.get(symbolName);
        if (uriSet) {
          uriSet.delete(uri);
          if (uriSet.size === 0) {
            this.referenceMap.delete(symbolName);
          }
        }
      }
      this.fileToReferenceNames.delete(uri);
    }

    await this.deleteShard(uri);
    
    // Update metadata cache
    await this.storage.removeMetadata(uri);
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
   * 
   * ASYNC: Uses fsPromises.stat to avoid blocking the event loop.
   */
  private async needsReindexing(uri: string): Promise<boolean> {
    const metadata = this.fileMetadata.get(uri);
    if (!metadata) {
      return true; // No cache entry
    }

    // If no mtime stored, fall back to hash-based check
    if (!metadata.mtime) {
      return true;
    }

    try {
      const stats = await fsPromises.stat(uri);
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
    // Get actual reference locations using findReferencesByName
    const references = await this.findReferencesByName(name);
    
    if (references.length === 0) {
      return [];
    }
    
    // Collect unique URIs that contain references
    const urisWithReferences = new Set<string>();
    for (const ref of references) {
      urisWithReferences.add(ref.location.uri);
    }
    
    // Load symbols from files that contain references
    // This returns the symbols defined in those files (context for the references)
    const results: IndexedSymbol[] = [];
    const seen = new Set<string>();
    
    for (const uri of urisWithReferences) {
      const shard = await this.loadShard(uri);
      if (shard) {
        for (const symbol of shard.symbols) {
          // Return symbols that match the referenced name
          if (symbol.name === name) {
            const key = `${symbol.id}`;
            if (!seen.has(key)) {
              results.push(symbol);
              seen.add(key);
            }
          }
        }
      }
    }
    
    return results;
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
   * Delegates orchestration to IndexScheduler.
   */
  async ensureUpToDate(
    allFiles: string[],
    computeHash: (uri: string) => Promise<string>,
    onProgress?: (current: number, total: number) => void
  ): Promise<void> {
    let excluded = 0;

    // Apply exclusion filters
    const filteredFiles = allFiles.filter(uri => {
      if (this.configManager && this.configManager.shouldExcludePath(uri)) {
        excluded++;
        return false;
      }
      return true;
    });

    if (excluded > 0) {
      console.info(`${LOG_PREFIX.BACKGROUND_INDEX} Excluded ${excluded} files from indexing (build artifacts, node_modules, etc.)`);
    }

    // Remove stale shards (files that no longer exist)
    const currentFileSet = new Set(allFiles);
    const staleFiles = this.getAllFileUris().filter(uri => !currentFileSet.has(uri));
    for (const uri of staleFiles) {
      await this.removeFile(uri);
    }

    // Clean up previously indexed excluded files
    await this.purgeExcludedFiles();

    // Delegate to scheduler for bulk indexing
    await this.scheduler.scheduleBulk(
      filteredFiles,
      (uri) => this.needsReindexing(uri),
      (uri, result) => this.updateFile(uri, result),
      onProgress
    );

    // Finalization phase
    this.scheduler.emitProgress(INDEXING_STATE.FINALIZING, filteredFiles.length, filteredFiles.length);
    console.info(`${LOG_PREFIX.BACKGROUND_INDEX} Starting finalization phase...`);

    console.time('Finalize');
    await this.finalizeIndexing();
    console.timeEnd('Finalize');

    // Validate worker pool counters
    this.scheduler.validateCounters();
    this.scheduler.reset();

    // Emit idle state
    this.scheduler.emitProgress(INDEXING_STATE.IDLE, filteredFiles.length, filteredFiles.length);
    console.info(`${LOG_PREFIX.BACKGROUND_INDEX} Background indexing completed successfully.`);

    // Save metadata and compact
    await this.storage.saveMetadataSummary();
    this.compact();
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
      console.info(`${LOG_PREFIX.BACKGROUND_INDEX} Purging ${filesToPurge.length} excluded files from cache`);
      for (const uri of filesToPurge) {
        await this.removeFile(uri);
      }
    }
  }

  /**
   * Finalize indexing by resolving all deferred cross-file references in batch.
   * Delegates to NgRxLinkResolver for NgRx action group resolution.
   */
  async finalizeIndexing(): Promise<void> {
    console.info(`${LOG_PREFIX.FINALIZE} Starting finalization phase...`);
    
    const files = Array.from(this.fileMetadata.keys());
    
    // Delegate NgRx resolution to specialized resolver
    await this.ngrxResolver.resolveAll(
      files,
      (uri: string) => this.loadShard(uri),
      this.referenceMap
    );
    
    console.info(`${LOG_PREFIX.FINALIZE} Complete. ${this.ngrxResolver.getStats()}`);
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
      await this.storage.clear();

      this.fileMetadata.clear();
      this.symbolNameIndex.clear();
      this.symbolIdIndex.clear();
      this.fileToSymbolIds.clear();
      this.fileToSymbolNames.clear();
      this.fileToReferenceNames.clear();
      this.referenceMap.clear();
      this.shardCache.clear(); // Clear LRU cache
      
      // Compact maps to reclaim memory from deleted entries
      this.compact();
    } catch (error) {
      console.error(`${LOG_PREFIX.BACKGROUND_INDEX} Error clearing shards: ${error}`);
      throw error;
    }
  }

  /**
   * Compact all in-memory maps by creating fresh Map instances.
   * 
   * JavaScript Maps retain memory for deleted entries until the Map is replaced.
   * This method creates new Map instances copying only active data, allowing
   * the old Maps (with their "tombstoned" entries) to be garbage collected.
   * 
   * Call this after significant deletion events (e.g., clear(), bulk remove).
   */
  compact(): void {
    const startTime = Date.now();
    const beforeSizes = {
      fileMetadata: this.fileMetadata.size,
      symbolNameIndex: this.symbolNameIndex.size,
      symbolIdIndex: this.symbolIdIndex.size,
      referenceMap: this.referenceMap.size
    };

    // Create fresh Map instances, copying only active entries
    this.fileMetadata = new Map(this.fileMetadata);
    this.symbolNameIndex = new Map(this.symbolNameIndex);
    this.symbolIdIndex = new Map(this.symbolIdIndex);
    this.fileToSymbolIds = new Map(this.fileToSymbolIds);
    this.fileToSymbolNames = new Map(this.fileToSymbolNames);
    this.fileToReferenceNames = new Map(this.fileToReferenceNames);
    this.referenceMap = new Map(this.referenceMap);
    this.shardCache = new Map(this.shardCache);

    const duration = Date.now() - startTime;
    console.info(
      `${LOG_PREFIX.BACKGROUND_INDEX} Compacted maps in ${duration}ms: ` +
      `files=${beforeSizes.fileMetadata}, symbols=${beforeSizes.symbolIdIndex}, ` +
      `names=${beforeSizes.symbolNameIndex}, refs=${beforeSizes.referenceMap}`
    );
  }

  /**
   * Cleanup resources including worker pool and storage.
   */
  async dispose(): Promise<void> {
    await this.storage.dispose();
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
