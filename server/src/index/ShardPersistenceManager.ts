import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { encode, decode } from '@msgpack/msgpack';
import {
  IndexedSymbol,
  IndexedReference,
  PendingReference,
  ImportInfo,
  ReExportInfo,
  CompactShard,
  compactSymbol,
  compactReference,
  compactPendingRef,
  hydrateSymbol,
  hydrateReference,
  hydratePendingRef,
  SHARD_VERSION
} from '../types.js';

/**
 * Represents a single shard (per-file index) in memory (hydrated format).
 */
export interface FileShard {
  uri: string;
  hash: string;
  symbols: IndexedSymbol[];
  references: IndexedReference[];
  imports: ImportInfo[];
  reExports?: ReExportInfo[];
  pendingReferences?: PendingReference[];
  lastIndexedAt: number;
  shardVersion?: number;
  mtime?: number;
}

/**
 * Pending write operation for buffering/coalescing.
 */
interface PendingWrite {
  shard: FileShard;
  timer: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Convert a FileShard to compact storage format.
 * This significantly reduces storage size by:
 * - Removing redundant uri from each symbol/reference
 * - Using short field names
 * - Using numeric scope indices instead of repeated strings
 */
function toCompactShard(shard: FileShard): CompactShard {
  // Build scope table for reference deduplication
  const scopeTable = new Map<string, number>();
  
  const compactRefs = shard.references.map(ref => compactReference(ref, scopeTable));
  
  // Convert scope table map to array (index -> scope string)
  const scopeArray: string[] = new Array(scopeTable.size);
  for (const [scope, idx] of scopeTable) {
    scopeArray[idx] = scope;
  }
  
  const compact: CompactShard = {
    u: shard.uri,
    h: shard.hash,
    s: shard.symbols.map(compactSymbol),
    r: compactRefs,
    i: shard.imports,
    t: shard.lastIndexedAt,
    v: shard.shardVersion || SHARD_VERSION
  };
  
  if (shard.reExports && shard.reExports.length > 0) {
    compact.re = shard.reExports;
  }
  if (shard.pendingReferences && shard.pendingReferences.length > 0) {
    compact.pr = shard.pendingReferences.map(compactPendingRef);
  }
  if (scopeArray.length > 0) {
    compact.sc = scopeArray;
  }
  if (shard.mtime !== undefined) {
    compact.m = shard.mtime;
  }
  
  return compact;
}

/**
 * Hydrate a compact shard from storage to full FileShard format.
 */
function fromCompactShard(compact: CompactShard): FileShard {
  const uri = compact.u;
  const scopeTable = compact.sc || [];
  
  return {
    uri,
    hash: compact.h,
    symbols: compact.s.map(s => hydrateSymbol(s, uri)),
    references: compact.r.map(r => hydrateReference(r, uri, scopeTable)),
    imports: compact.i,
    reExports: compact.re,
    pendingReferences: compact.pr?.map(pr => hydratePendingRef(pr, uri)),
    lastIndexedAt: compact.t,
    shardVersion: compact.v,
    mtime: compact.m
  };
}

/**
 * ShardPersistenceManager - Centralized I/O manager for shard files.
 * 
 * This class is the single source of truth for all shard disk operations:
 * - Provides atomic load/save/delete operations with mutex locks
 * - Optional write buffering to coalesce rapid saves (100ms window)
 * - Thread-safe access via per-URI locks
 * 
 * Architecture Benefits:
 * - Eliminates race conditions between concurrent shard operations
 * - Reduces disk I/O by coalescing rapid successive writes
 * - Centralizes error handling and logging for I/O operations
 */
export class ShardPersistenceManager {
  private shardsDirectory: string = '';
  private shardLocks: Map<string, Promise<void>> = new Map();
  private pendingWrites: Map<string, PendingWrite> = new Map();
  private bufferEnabled: boolean;
  private bufferDelayMs: number;
  
  // Memory management limits
  private readonly maxLocks: number = 10000;
  private readonly maxPendingWrites: number = 100;
  private lockCleanupCounter: number = 0;
  private readonly lockCleanupInterval: number = 1000; // Cleanup every 1000 operations

  /**
   * Create a new ShardPersistenceManager.
   * 
   * @param bufferEnabled - Whether to enable write buffering (default: true)
   * @param bufferDelayMs - Delay in ms before flushing buffered writes (default: 100)
   */
  constructor(bufferEnabled: boolean = true, bufferDelayMs: number = 100) {
    this.bufferEnabled = bufferEnabled;
    this.bufferDelayMs = bufferDelayMs;
  }

  /**
   * Initialize the persistence manager.
   * 
   * @param workspaceRoot - Workspace root directory
   * @param cacheDirectory - Cache directory name (e.g., '.smart-index')
   */
  init(workspaceRoot: string, cacheDirectory: string): void {
    this.shardsDirectory = path.join(workspaceRoot, cacheDirectory, 'index');
    
    if (!fs.existsSync(this.shardsDirectory)) {
      fs.mkdirSync(this.shardsDirectory, { recursive: true });
    }
    
    console.info(`[ShardPersistenceManager] Initialized at ${this.shardsDirectory}`);
  }

  /**
   * Get the shards directory path.
   */
  getShardsDirectory(): string {
    return this.shardsDirectory;
  }

  /**
   * Get shard file path for a given URI.
   * Uses hashed directory structure for filesystem performance:
   * .smart-index/index/<prefix1>/<prefix2>/<hash>.bin
   * 
   * @param uri - The file URI
   * @param extension - File extension ('bin' for msgpack, 'json' for legacy)
   */
  getShardPath(uri: string, extension: 'bin' | 'json' = 'bin'): string {
    const hash = crypto.createHash('sha256').update(uri).digest('hex');
    const prefix1 = hash.substring(0, 2);
    const prefix2 = hash.substring(2, 4);
    return path.join(this.shardsDirectory, prefix1, prefix2, `${hash}.${extension}`);
  }

  /**
   * Execute a task with exclusive access to a shard file.
   * Prevents race conditions between concurrent load-modify-save operations.
   */
  async withLock<T>(uri: string, task: () => Promise<T>): Promise<T> {
    // Periodic cleanup of stale lock entries to prevent memory growth
    this.lockCleanupCounter++;
    if (this.lockCleanupCounter >= this.lockCleanupInterval) {
      this.lockCleanupCounter = 0;
      this.cleanupStaleLocks();
    }
    
    const currentLock = this.shardLocks.get(uri) || Promise.resolve();
    
    let resolveResult: (value: T) => void;
    let rejectResult: (error: unknown) => void;
    const resultPromise = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    
    const newLock = currentLock.then(async () => {
      try {
        const result = await task();
        resolveResult!(result);
      } catch (error) {
        rejectResult!(error);
      }
    }).finally(() => {
      // Clean up lock entry if this is still the current lock
      if (this.shardLocks.get(uri) === newLock) {
        this.shardLocks.delete(uri);
      }
    });
    
    this.shardLocks.set(uri, newLock);
    return resultPromise;
  }

  /**
   * Cleanup stale lock entries to prevent unbounded memory growth.
   * Removes lock entries that are already resolved (Promise settled).
   */
  private cleanupStaleLocks(): void {
    if (this.shardLocks.size <= this.maxLocks) {
      return;
    }
    
    // Log cleanup for observability
    const beforeSize = this.shardLocks.size;
    
    // Create a list of URIs to check
    const urisToCheck = Array.from(this.shardLocks.keys());
    let cleaned = 0;
    
    for (const uri of urisToCheck) {
      const lock = this.shardLocks.get(uri);
      if (lock) {
        // Check if the promise is settled by racing with an immediately resolved promise
        // If the lock wins, it's still pending; if our check wins, it's settled
        Promise.race([
          lock.then(() => 'settled'),
          Promise.resolve('check')
        ]).then(result => {
          if (result === 'settled') {
            // Lock promise is settled, safe to remove if still the same
            if (this.shardLocks.get(uri) === lock) {
              this.shardLocks.delete(uri);
              cleaned++;
            }
          }
        });
      }
    }
    
    if (cleaned > 0 || beforeSize > this.maxLocks) {
      console.info(`[ShardPersistenceManager] Lock cleanup: ${beforeSize} -> ${this.shardLocks.size} entries`);
    }
  }

  /**
   * Load a shard from disk.
   * Supports automatic migration from JSON/legacy formats to compact MessagePack.
   * 
   * @param uri - The file URI to load the shard for
   * @returns The shard data or null if not found
   */
  async loadShard(uri: string): Promise<FileShard | null> {
    return this.withLock(uri, async () => {
      return this.loadShardNoLock(uri);
    });
  }

  /**
   * Load a shard from disk WITHOUT acquiring a lock.
   * Use this ONLY when already holding a lock on the URI (e.g., inside withLock callback).
   * 
   * Uses async I/O to avoid blocking the event loop.
   * 
   * @param uri - The file URI to load the shard for
   * @returns The shard data or null if not found
   */
  async loadShardNoLock(uri: string): Promise<FileShard | null> {
    try {
      const binPath = this.getShardPath(uri, 'bin');
      
      // Try MessagePack format first (preferred) - use async I/O
      try {
        const buffer = await fsPromises.readFile(binPath);
        const decoded = decode(buffer) as any;
        
        // Check if this is compact format (has 'u' field) or legacy format (has 'uri' field)
        if ('u' in decoded) {
          // Compact format - hydrate to full FileShard
          return fromCompactShard(decoded as CompactShard);
        } else {
          // Legacy format - return as-is but schedule migration on next save
          return decoded as FileShard;
        }
      } catch (binError: any) {
        // File doesn't exist or read error - try JSON fallback
        if (binError.code !== 'ENOENT') {
          throw binError;
        }
      }
      
      // Migration path: try legacy JSON format
      const jsonPath = this.getShardPath(uri, 'json');
      try {
        const content = await fsPromises.readFile(jsonPath, 'utf-8');
        const shard = JSON.parse(content) as FileShard;
        
        // Migrate to compact MessagePack format (async)
        const shardDir = path.dirname(binPath);
        await fsPromises.mkdir(shardDir, { recursive: true });
        const compact = toCompactShard(shard);
        const encoded = encode(compact);
        await fsPromises.writeFile(binPath, encoded);
        
        // Remove legacy JSON file
        await fsPromises.unlink(jsonPath);
        console.info(`[ShardPersistenceManager] Migrated shard to compact format: ${uri}`);
        
        return shard;
      } catch (jsonError: any) {
        // JSON file doesn't exist either
        if (jsonError.code === 'ENOENT') {
          return null;
        }
        throw jsonError;
      }
    } catch (error) {
      console.error(`[ShardPersistenceManager] Error loading shard for ${uri}: ${error}`);
      return null;
    }
  }

  /**
   * Save a shard to disk.
   * 
   * If buffering is enabled, multiple saves within the buffer window are
   * coalesced into a single write (last-write-wins).
   * 
   * @param shard - The shard data to save
   */
  async saveShard(shard: FileShard): Promise<void> {
    if (this.bufferEnabled) {
      return this.saveShardBuffered(shard);
    }
    return this.saveShardImmediate(shard);
  }

  /**
   * Immediately save a shard to disk (bypasses buffering).
   * Uses compact MessagePack format for optimal storage size.
   */
  private async saveShardImmediate(shard: FileShard): Promise<void> {
    return this.withLock(shard.uri, async () => {
      await this.saveShardNoLock(shard);
    });
  }

  /**
   * Save a shard to disk WITHOUT acquiring a lock.
   * Use this ONLY when already holding a lock on the URI (e.g., inside withLock callback).
   * 
   * Uses async I/O to avoid blocking the event loop.
   * 
   * @param shard - The shard data to save
   */
  async saveShardNoLock(shard: FileShard): Promise<void> {
    try {
      const shardPath = this.getShardPath(shard.uri, 'bin');
      const shardDir = path.dirname(shardPath);
      
      // Ensure directory exists (nested structure) - async
      await fsPromises.mkdir(shardDir, { recursive: true });
      
      // Convert to compact format before saving
      const compact = toCompactShard(shard);
      const encoded = encode(compact);
      await fsPromises.writeFile(shardPath, encoded);
    } catch (error) {
      console.error(`[ShardPersistenceManager] Error saving shard for ${shard.uri}: ${error}`);
      throw error;
    }
  }

  /**
   * Save a shard with buffering/coalescing.
   * Multiple saves within the buffer window are merged (last-write-wins).
   * Applies backpressure when too many pending writes accumulate.
   */
  private async saveShardBuffered(shard: FileShard): Promise<void> {
    const uri = shard.uri;
    
    // BACKPRESSURE: If too many pending writes, flush immediately to prevent memory growth
    if (this.pendingWrites.size >= this.maxPendingWrites) {
      console.warn(`[ShardPersistenceManager] Backpressure: ${this.pendingWrites.size} pending writes, flushing...`);
      await this.flush();
    }
    
    return new Promise<void>((resolve, reject) => {
      // Check if there's already a pending write for this URI
      const existing = this.pendingWrites.get(uri);
      if (existing) {
        // Cancel the existing timer and update the shard data
        clearTimeout(existing.timer);
        existing.shard = shard;
        
        // Chain the new promise to resolve when the coalesced write completes
        const originalResolve = existing.resolve;
        const originalReject = existing.reject;
        existing.resolve = () => { originalResolve(); resolve(); };
        existing.reject = (err) => { originalReject(err); reject(err); };
      } else {
        // Create a new pending write entry
        const pending: PendingWrite = {
          shard,
          timer: null as unknown as NodeJS.Timeout,
          resolve,
          reject
        };
        this.pendingWrites.set(uri, pending);
      }

      // Set (or reset) the flush timer
      const pending = this.pendingWrites.get(uri)!;
      pending.timer = setTimeout(async () => {
        this.pendingWrites.delete(uri);
        try {
          await this.saveShardImmediate(pending.shard);
          pending.resolve();
        } catch (error) {
          pending.reject(error as Error);
        }
      }, this.bufferDelayMs);
    });
  }

  /**
   * Delete a shard from disk.
   * Removes both MessagePack and legacy JSON formats if they exist.
   * 
   * @param uri - The file URI to delete the shard for
   */
  async deleteShard(uri: string): Promise<void> {
    // Cancel any pending buffered write for this URI
    const pending = this.pendingWrites.get(uri);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingWrites.delete(uri);
      pending.reject(new Error('Shard deleted before write completed'));
    }

    return this.withLock(uri, async () => {
      try {
        // Delete MessagePack format (async)
        const binPath = this.getShardPath(uri, 'bin');
        try {
          await fsPromises.unlink(binPath);
        } catch (err: any) {
          if (err.code !== 'ENOENT') {
            throw err;
          }
        }
        
        // Also delete legacy JSON format if it exists (async)
        const jsonPath = this.getShardPath(uri, 'json');
        try {
          await fsPromises.unlink(jsonPath);
        } catch (err: any) {
          if (err.code !== 'ENOENT') {
            throw err;
          }
        }
      } catch (error) {
        console.error(`[ShardPersistenceManager] Error deleting shard for ${uri}: ${error}`);
      }
    });
  }

  /**
   * Check if a shard exists on disk.
   * Checks for both MessagePack and legacy JSON formats.
   * Uses async I/O to avoid blocking.
   * 
   * @param uri - The file URI to check
   * @returns True if the shard file exists
   */
  async shardExists(uri: string): Promise<boolean> {
    const binPath = this.getShardPath(uri, 'bin');
    try {
      await fsPromises.access(binPath);
      return true;
    } catch {
      // Check legacy JSON format
      const jsonPath = this.getShardPath(uri, 'json');
      try {
        await fsPromises.access(jsonPath);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Flush all pending buffered writes immediately.
   * Call this before shutdown or when you need guaranteed persistence.
   */
  async flush(): Promise<void> {
    const flushPromises: Promise<void>[] = [];

    for (const [uri, pending] of this.pendingWrites) {
      clearTimeout(pending.timer);
      this.pendingWrites.delete(uri);
      
      flushPromises.push(
        this.saveShardImmediate(pending.shard)
          .then(() => pending.resolve())
          .catch((error) => pending.reject(error))
      );
    }

    await Promise.allSettled(flushPromises);
  }

  /**
   * Recursively collect all shard files from nested directory structure.
   * Collects both MessagePack (.bin) and legacy JSON (.json) files.
   */
  collectShardFiles(dir?: string): string[] {
    const searchDir = dir || this.shardsDirectory;
    const results: string[] = [];
    
    try {
      if (!fs.existsSync(searchDir)) {
        return results;
      }

      const entries = fs.readdirSync(searchDir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(searchDir, entry.name);
        
        if (entry.isDirectory()) {
          results.push(...this.collectShardFiles(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith('.bin') || entry.name.endsWith('.json'))) {
          results.push(fullPath);
        }
      }
    } catch (error) {
      console.error(`[ShardPersistenceManager] Error reading directory ${searchDir}: ${error}`);
    }
    
    return results;
  }

  /**
   * Clear all shards from the index directory.
   */
  async clearAll(): Promise<void> {
    // Flush pending writes first
    await this.flush();

    if (fs.existsSync(this.shardsDirectory)) {
      this.clearDirectory(this.shardsDirectory);
    }
    
    this.shardLocks.clear();
    console.info(`[ShardPersistenceManager] Cleared all shards`);
  }

  /**
   * Recursively clear directory contents.
   * Clears both MessagePack (.bin) and legacy JSON (.json) files.
   */
  private clearDirectory(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          this.clearDirectory(fullPath);
          fs.rmdirSync(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith('.bin') || entry.name.endsWith('.json'))) {
          fs.unlinkSync(fullPath);
        }
      }
    } catch (error) {
      console.error(`[ShardPersistenceManager] Error clearing directory ${dir}: ${error}`);
    }
  }

  /**
   * Get statistics about the persistence manager.
   */
  getStats(): { 
    shardsDirectory: string;
    activeLocks: number;
    pendingWrites: number;
    bufferEnabled: boolean;
  } {
    return {
      shardsDirectory: this.shardsDirectory,
      activeLocks: this.shardLocks.size,
      pendingWrites: this.pendingWrites.size,
      bufferEnabled: this.bufferEnabled
    };
  }

  /**
   * Cleanup resources.
   */
  async dispose(): Promise<void> {
    await this.flush();
    this.shardLocks.clear();
    console.info(`[ShardPersistenceManager] Disposed`);
  }
}
