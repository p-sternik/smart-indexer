import { IIndexStorage, FileIndexData, FileMetadata, StorageStats } from './IIndexStorage.js';
import { IndexedSymbol, IndexedReference } from '../types.js';
import { ShardPersistenceManager, FileShard, ShardMetadataEntry } from '../index/ShardPersistenceManager.js';

/**
 * File-based storage implementation using the existing ShardPersistenceManager.
 * 
 * This adapter wraps ShardPersistenceManager to implement the IIndexStorage interface,
 * maintaining backward compatibility with the existing file-based sharding system.
 * 
 * Storage characteristics:
 * - One MessagePack (.bin) file per indexed source file
 * - Nested directory structure for filesystem performance (hash-based)
 * - Write buffering/coalescing (100ms window)
 * - Per-URI mutex locks for thread safety
 * - Metadata summary for O(1) startup
 */
export class FileBasedStorage implements IIndexStorage {
  private shardManager: ShardPersistenceManager;

  /**
   * Create a new FileBasedStorage instance.
   * 
   * @param bufferEnabled - Whether to enable write buffering (default: true)
   * @param bufferDelayMs - Delay in ms before flushing buffered writes (default: 100)
   */
  constructor(bufferEnabled: boolean = true, bufferDelayMs: number = 100) {
    this.shardManager = new ShardPersistenceManager(bufferEnabled, bufferDelayMs);
  }

  /**
   * Initialize the storage backend.
   */
  async init(workspaceRoot: string, cacheDirectory: string): Promise<void> {
    await this.shardManager.init(workspaceRoot, cacheDirectory);
  }

  /**
   * Store or update indexed data for a file.
   */
  async storeFile(data: FileIndexData): Promise<void> {
    const shard: FileShard = {
      uri: data.uri,
      hash: data.hash,
      symbols: data.symbols,
      references: data.references,
      imports: data.imports,
      reExports: data.reExports,
      pendingReferences: data.pendingReferences,
      lastIndexedAt: data.lastIndexedAt,
      shardVersion: data.shardVersion,
      mtime: data.mtime
    };

    await this.shardManager.saveShard(shard);
  }

  /**
   * Retrieve indexed data for a file.
   */
  async getFile(uri: string): Promise<FileIndexData | null> {
    const shard = await this.shardManager.loadShard(uri);
    
    if (!shard) {
      return null;
    }

    return {
      uri: shard.uri,
      hash: shard.hash,
      symbols: shard.symbols,
      references: shard.references,
      imports: shard.imports,
      reExports: shard.reExports,
      pendingReferences: shard.pendingReferences,
      lastIndexedAt: shard.lastIndexedAt,
      shardVersion: shard.shardVersion,
      mtime: shard.mtime
    };
  }

  /**
   * Retrieve indexed data for multiple files in a single batch.
   * 
   * Note: FileBasedStorage doesn't benefit from batching like SQLite does,
   * but we implement it for interface compatibility.
   */
  async batchGetFiles(uris: string[]): Promise<FileIndexData[]> {
    const results: FileIndexData[] = [];
    
    // For file-based storage, we just iterate (no batch optimization possible)
    for (const uri of uris) {
      const data = await this.getFile(uri);
      if (data) {
        results.push(data);
      }
    }
    
    return results;
  }

  /**
   * Retrieve indexed data for a file WITHOUT acquiring a lock.
   * Use ONLY when already holding a lock (inside withLock callback).
   */
  async getFileNoLock(uri: string): Promise<FileIndexData | null> {
    const shard = await this.shardManager.loadShardNoLock(uri);
    
    if (!shard) {
      return null;
    }

    return {
      uri: shard.uri,
      hash: shard.hash,
      symbols: shard.symbols,
      references: shard.references,
      imports: shard.imports,
      reExports: shard.reExports,
      pendingReferences: shard.pendingReferences,
      lastIndexedAt: shard.lastIndexedAt,
      shardVersion: shard.shardVersion,
      mtime: shard.mtime
    };
  }

  /**
   * Store or update indexed data for a file WITHOUT acquiring a lock.
   * Use ONLY when already holding a lock (inside withLock callback).
   */
  async storeFileNoLock(data: FileIndexData): Promise<void> {
    const shard: FileShard = {
      uri: data.uri,
      hash: data.hash,
      symbols: data.symbols,
      references: data.references,
      imports: data.imports,
      reExports: data.reExports,
      pendingReferences: data.pendingReferences,
      lastIndexedAt: data.lastIndexedAt,
      shardVersion: data.shardVersion,
      mtime: data.mtime
    };

    await this.shardManager.saveShardNoLock(shard);
  }

  /**
   * Delete indexed data for a file.
   */
  async deleteFile(uri: string): Promise<void> {
    await this.shardManager.deleteShard(uri);
  }

  /**
   * Check if indexed data exists for a file.
   */
  async hasFile(uri: string): Promise<boolean> {
    return this.shardManager.shardExists(uri);
  }

  /**
   * Get metadata for a single file (lightweight operation).
   */
  async getMetadata(uri: string): Promise<FileMetadata | null> {
    const entry = this.shardManager.getMetadataEntry(uri);
    
    if (!entry) {
      return null;
    }

    return {
      uri: entry.uri,
      hash: entry.hash,
      mtime: entry.mtime,
      symbolCount: entry.symbolCount,
      lastIndexedAt: entry.lastIndexedAt
    };
  }

  /**
   * Get metadata for all indexed files (for startup optimization).
   */
  async getAllMetadata(): Promise<FileMetadata[]> {
    const summaryEntries = await this.shardManager.loadMetadataSummary();
    
    if (!summaryEntries) {
      // Fall back to scanning shards if metadata summary doesn't exist
      return this.buildMetadataFromScan();
    }

    return summaryEntries.map(entry => ({
      uri: entry.uri,
      hash: entry.hash,
      mtime: entry.mtime,
      symbolCount: entry.symbolCount,
      lastIndexedAt: entry.lastIndexedAt
    }));
  }

  /**
   * Build metadata by scanning all shard files (fallback when metadata.json missing).
   */
  private async buildMetadataFromScan(): Promise<FileMetadata[]> {
    const shardFiles = await this.shardManager.collectShardFiles();
    const metadata: FileMetadata[] = [];

    for (const shardPath of shardFiles) {
      // Extract URI from shard file by loading it
      // This is expensive but only happens on first startup or after metadata corruption
      const shard = await this.loadShardByPath(shardPath);
      if (shard) {
        metadata.push({
          uri: shard.uri,
          hash: shard.hash,
          mtime: shard.mtime,
          symbolCount: shard.symbols.length,
          lastIndexedAt: shard.lastIndexedAt
        });
      }
    }

    return metadata;
  }

  /**
   * Load a shard by file path (helper for metadata scanning).
   */
  private async loadShardByPath(shardPath: string): Promise<FileShard | null> {
    // We need to derive the URI from the shard content
    // ShardPersistenceManager doesn't expose this, so we use a workaround
    // by loading the shard file directly (it contains the URI)
    try {
      const shard = await this.shardManager.loadShardNoLock(shardPath);
      return shard;
    } catch {
      return null;
    }
  }

  /**
   * Update metadata for a file (optimization for avoiding full file loads).
   */
  async updateMetadata(metadata: FileMetadata): Promise<void> {
    const entry: ShardMetadataEntry = {
      uri: metadata.uri,
      hash: metadata.hash,
      mtime: metadata.mtime,
      symbolCount: metadata.symbolCount,
      lastIndexedAt: metadata.lastIndexedAt
    };

    this.shardManager.updateMetadataEntry(entry);
  }

  /**
   * Remove metadata for a file.
   */
  async removeMetadata(uri: string): Promise<void> {
    this.shardManager.removeMetadataEntry(uri);
  }

  /**
   * Get storage statistics.
   */
  async getStats(): Promise<StorageStats> {
    const allMetadata = this.shardManager.getAllMetadataEntries();
    const internalStats = this.shardManager.getStats();

    const totalSymbols = allMetadata.reduce((sum, entry) => sum + entry.symbolCount, 0);

    return {
      totalFiles: allMetadata.length,
      totalSymbols,
      storagePath: internalStats.shardsDirectory
    };
  }

  /**
   * Clear all indexed data.
   */
  async clear(): Promise<void> {
    await this.shardManager.clearAll();
  }

  /**
   * Flush any pending writes to persistent storage.
   */
  async flush(): Promise<void> {
    await this.shardManager.flush();
  }

  /**
   * Cleanup resources and close connections.
   */
  async dispose(): Promise<void> {
    await this.shardManager.dispose();
  }

  /**
   * Save metadata summary to disk (optimization for fast startup).
   * Called after bulk indexing operations.
   */
  async saveMetadataSummary(): Promise<void> {
    await this.shardManager.saveMetadataSummary();
  }

  /**
   * Search symbols using full-text search.
   * Note: File-based storage does not support FTS - falls back to exact matching.
   * 
   * @param query - Search query
   * @param mode - Search mode (ignored for file-based storage)
   * @param limit - Maximum number of results
   * @returns Array of matching symbols with their file URIs
   */
  async searchSymbols(
    _query: string, 
    _mode: 'exact' | 'fuzzy' | 'fulltext' = 'exact', 
    _limit: number = 100
  ): Promise<Array<{ uri: string; symbol: any; rank?: number }>> {
    // File-based storage doesn't support FTS
    // This is a placeholder - full implementation would require scanning all shards
    console.warn('[FileBasedStorage] FTS not supported, use SqlJsStorage for full-text search');
    return [];
  }

  /**
   * Execute a task with exclusive access to a file's data.
   * Prevents race conditions during load-modify-save operations.
   */
  async withLock<T>(uri: string, task: () => Promise<T>): Promise<T> {
    return this.shardManager.withLock(uri, task);
  }

  /**
   * Get the storage directory path (for diagnostics/debugging).
   */
  getStoragePath(): string {
    return this.shardManager.getShardsDirectory();
  }

  /**
   * Collect all file URIs from storage (for migration/scanning).
   */
  async collectAllFiles(): Promise<string[]> {
    const shardFiles = await this.shardManager.collectShardFiles();
    const uris: string[] = [];

    // Load each shard to extract its URI
    for (const shardPath of shardFiles) {
      const shard = await this.loadShardByPath(shardPath);
      if (shard) {
        uris.push(shard.uri);
      }
    }

    return uris;
  }

  /**
   * Find definitions for a symbol name (fallback for non-SQL storage).
   */
  async findDefinitionsInSql(name: string): Promise<IndexedSymbol[]> {
    const symbols: IndexedSymbol[] = [];
    const allFiles = await this.getAllMetadata();
    
    for (const meta of allFiles) {
      const shard = await this.getFile(meta.uri);
      if (shard) {
        for (const sym of shard.symbols) {
          if (sym.name === name && sym.isDefinition) {
            symbols.push(sym);
          }
        }
      }
    }
    return symbols;
  }

  /**
   * Find references for a symbol name (fallback for non-SQL storage).
   */
  async findReferencesInSql(name: string): Promise<IndexedReference[]> {
    const refs: IndexedReference[] = [];
    const allFiles = await this.getAllMetadata();
    
    for (const meta of allFiles) {
      const shard = await this.getFile(meta.uri);
      if (shard) {
        for (const ref of shard.references) {
          if (ref.symbolName === name) {
            refs.push(ref);
          }
        }
      }
    }
    return refs;
  }

  /**
   * Find all NgRx action groups in the workspace.
   */
  async findNgRxActionGroups(): Promise<Array<{ uri: string; symbol: IndexedSymbol }>> {
    const results: Array<{ uri: string; symbol: IndexedSymbol }> = [];
    const allFiles = await this.getAllMetadata();
    
    for (const meta of allFiles) {
      const shard = await this.getFile(meta.uri);
      if (shard) {
        for (const sym of shard.symbols) {
          if (sym.ngrxMetadata?.isGroup) {
            results.push({ uri: shard.uri, symbol: sym });
          }
        }
      }
    }
    return results;
  }

  /**
   * Find all files that have pending references.
   */
  async findFilesWithPendingRefs(): Promise<string[]> {
    const uris: string[] = [];
    const allFiles = await this.getAllMetadata();
    
    for (const meta of allFiles) {
      const shard = await this.getFile(meta.uri);
      if (shard && shard.pendingReferences && shard.pendingReferences.length > 0) {
        uris.push(shard.uri);
      }
    }
    return uris;
  }

  /**
   * Get the underlying shard manager (for backward compatibility).
   * 
   * @deprecated This method exposes internal implementation details.
   * Use IIndexStorage methods instead. Will be removed in future versions.
   */
  getShardManager(): ShardPersistenceManager {
    return this.shardManager;
  }
}
