import { ShardPersistenceManager, FileShard } from './ShardPersistenceManager.js';

/**
 * ShardStore - Manages shard storage and LRU caching.
 * Extracted from BackgroundIndex for single-responsibility.
 * 
 * Responsibilities:
 * - Load/save shards via ShardPersistenceManager
 * - Maintain an LRU cache to reduce disk I/O
 * - Handle shard deletion
 */
export class ShardStore {
  private shardManager: ShardPersistenceManager;
  private shardCache: Map<string, FileShard> = new Map();
  private readonly maxCacheSize: number;

  constructor(maxCacheSize: number = 50, enableBuffering: boolean = true, bufferDelayMs: number = 100) {
    this.maxCacheSize = maxCacheSize;
    this.shardManager = new ShardPersistenceManager(enableBuffering, bufferDelayMs);
  }

  /**
   * Initialize the shard store.
   */
  async init(workspaceRoot: string, cacheDirectory: string): Promise<void> {
    await this.shardManager.init(workspaceRoot, cacheDirectory);
  }

  /**
   * Get the underlying ShardPersistenceManager (for advanced operations).
   */
  getShardManager(): ShardPersistenceManager {
    return this.shardManager;
  }

  /**
   * Get the shards directory path.
   */
  getShardsDirectory(): string {
    return this.shardManager.getShardsDirectory();
  }

  /**
   * Collect all shard files from disk.
   */
  async collectShardFiles(): Promise<string[]> {
    return this.shardManager.collectShardFiles();
  }

  /**
   * Load a shard with LRU caching.
   * @param uri - File URI to load shard for
   * @returns FileShard or null if not found
   */
  async loadShard(uri: string): Promise<FileShard | null> {
    // Check cache first (O(1) lookup)
    const cached = this.shardCache.get(uri);
    if (cached) {
      // Move to end for LRU (delete + re-add makes it most recently used)
      this.shardCache.delete(uri);
      this.shardCache.set(uri, cached);
      return cached;
    }

    // Cache miss: load from disk
    const shard = await this.shardManager.loadShard(uri);
    if (shard) {
      this.addToCache(uri, shard);
    }

    return shard;
  }

  /**
   * Load a shard without acquiring a lock (for use within existing lock).
   */
  async loadShardNoLock(uri: string): Promise<FileShard | null> {
    return this.shardManager.loadShardNoLock(uri);
  }

  /**
   * Save a shard to disk.
   */
  async saveShard(shard: FileShard): Promise<void> {
    // Update cache
    this.addToCache(shard.uri, shard);
    return this.shardManager.saveShard(shard);
  }

  /**
   * Save a shard without acquiring a lock (for use within existing lock).
   */
  async saveShardNoLock(shard: FileShard): Promise<void> {
    // Update cache
    this.addToCache(shard.uri, shard);
    return this.shardManager.saveShardNoLock(shard);
  }

  /**
   * Delete a shard from disk and cache.
   */
  async deleteShard(uri: string): Promise<void> {
    this.shardCache.delete(uri);
    return this.shardManager.deleteShard(uri);
  }

  /**
   * Invalidate cache for a URI.
   */
  invalidateCache(uri: string): void {
    this.shardCache.delete(uri);
  }

  /**
   * Clear the entire cache.
   */
  clearCache(): void {
    this.shardCache.clear();
  }

  /**
   * Clear all shards from disk and cache.
   */
  async clearAll(): Promise<void> {
    this.shardCache.clear();
    await this.shardManager.clearAll();
  }

  /**
   * Execute a function with a lock on a URI.
   */
  async withLock<T>(uri: string, fn: () => Promise<T>): Promise<T> {
    return this.shardManager.withLock(uri, fn);
  }

  /**
   * Dispose resources.
   */
  async dispose(): Promise<void> {
    this.shardCache.clear();
    await this.shardManager.dispose();
  }

  /**
   * Add shard to cache with LRU eviction.
   */
  private addToCache(uri: string, shard: FileShard): void {
    // Remove existing entry if present (to update position)
    this.shardCache.delete(uri);

    // Enforce LRU eviction before adding new entry
    if (this.shardCache.size >= this.maxCacheSize) {
      // Delete oldest entry (first key in Map iteration order)
      const oldestKey = this.shardCache.keys().next().value;
      if (oldestKey) {
        this.shardCache.delete(oldestKey);
      }
    }

    this.shardCache.set(uri, shard);
  }

  /**
   * Get cache statistics for debugging.
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.shardCache.size,
      maxSize: this.maxCacheSize
    };
  }
}
