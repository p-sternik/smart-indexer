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
 * Type guard to validate decoded MessagePack data is a valid CompactShard.
 * Prevents unsafe casting of arbitrary data.
 */
function isCompactShard(obj: unknown): obj is CompactShard {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  const candidate = obj as Record<string, unknown>;
  return (
    typeof candidate.u === 'string' &&
    typeof candidate.h === 'string' &&
    Array.isArray(candidate.s) &&
    Array.isArray(candidate.r) &&
    Array.isArray(candidate.i) &&
    typeof candidate.t === 'number' &&
    typeof candidate.v === 'number'
  );
}

/**
 * Type guard to validate decoded MessagePack data is a legacy FileShard.
 */
function isLegacyFileShard(obj: unknown): obj is FileShard {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  const candidate = obj as Record<string, unknown>;
  return (
    typeof candidate.uri === 'string' &&
    typeof candidate.hash === 'string' &&
    Array.isArray(candidate.symbols) &&
    Array.isArray(candidate.references) &&
    typeof candidate.lastIndexedAt === 'number'
  );
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
  private lockCounters: Map<string, number> = new Map(); // Track active lock count per URI
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
  async init(workspaceRoot: string, cacheDirectory: string): Promise<void> {
    this.shardsDirectory = path.join(workspaceRoot, cacheDirectory, 'index');
    
    try {
      await fsPromises.access(this.shardsDirectory);
    } catch {
      await fsPromises.mkdir(this.shardsDirectory, { recursive: true });
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
   * 
   * Uses reference counting to ensure lock entries are cleaned up when
   * no more tasks are waiting, preventing unbounded memory growth.
   */
  async withLock<T>(uri: string, task: () => Promise<T>): Promise<T> {
    // Periodic cleanup of stale lock entries to prevent memory growth
    this.lockCleanupCounter++;
    if (this.lockCleanupCounter >= this.lockCleanupInterval) {
      this.lockCleanupCounter = 0;
      this.cleanupStaleLocks();
    }
    
    // Increment active lock counter for this URI
    const currentCount = this.lockCounters.get(uri) || 0;
    this.lockCounters.set(uri, currentCount + 1);
    
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
      // Decrement counter and clean up if no more locks waiting
      const count = this.lockCounters.get(uri) || 1;
      if (count <= 1) {
        // Last lock released - clean up both maps
        this.lockCounters.delete(uri);
        this.shardLocks.delete(uri);
      } else {
        this.lockCounters.set(uri, count - 1);
      }
    });
    
    this.shardLocks.set(uri, newLock);
    return resultPromise;
  }

  /**
   * Cleanup stale lock entries to prevent unbounded memory growth.
   * Removes lock entries with zero active count.
   */
  private cleanupStaleLocks(): void {
    if (this.shardLocks.size <= this.maxLocks) {
      return;
    }
    
    // Log cleanup for observability
    const beforeSize = this.shardLocks.size;
    let cleaned = 0;
    
    // Clean up entries where counter is 0 or missing (should not happen, but defensive)
    for (const uri of this.shardLocks.keys()) {
      const count = this.lockCounters.get(uri) || 0;
      if (count === 0) {
        this.shardLocks.delete(uri);
        this.lockCounters.delete(uri);
        cleaned++;
      }
    }
    
    if (cleaned > 0 || beforeSize > this.maxLocks) {
      console.info(`[ShardPersistenceManager] Lock cleanup: ${beforeSize} -> ${this.shardLocks.size} entries (cleaned ${cleaned})`);
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
        const decoded = decode(buffer);
        
        // Type-safe validation before casting
        if (isCompactShard(decoded)) {
          // Compact format - hydrate to full FileShard
          return fromCompactShard(decoded);
        } else if (isLegacyFileShard(decoded)) {
          // Legacy format - return as-is but schedule migration on next save
          return decoded;
        } else {
          // Invalid shard format - treat as missing
          console.warn(`[ShardPersistenceManager] Invalid shard format for ${uri}, ignoring`);
          return null;
        }
      } catch (binError: unknown) {
        const err = binError as { code?: string };
        // File doesn't exist or read error - try JSON fallback
        if (err.code !== 'ENOENT') {
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
   * Uses async I/O to avoid blocking the event loop.
   */
  async collectShardFiles(dir?: string): Promise<string[]> {
    const searchDir = dir || this.shardsDirectory;
    const results: string[] = [];
    
    try {
      try {
        await fsPromises.access(searchDir);
      } catch {
        return results; // Directory doesn't exist
      }

      const entries = await fsPromises.readdir(searchDir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(searchDir, entry.name);
        
        if (entry.isDirectory()) {
          const subResults = await this.collectShardFiles(fullPath);
          results.push(...subResults);
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

    try {
      await fsPromises.access(this.shardsDirectory);
      await this.clearDirectory(this.shardsDirectory);
    } catch {
      // Directory doesn't exist, nothing to clear
    }
    
    this.shardLocks.clear();
    this.lockCounters.clear();
    console.info(`[ShardPersistenceManager] Cleared all shards`);
  }

  /**
   * Recursively clear directory contents.
   * Clears both MessagePack (.bin) and legacy JSON (.json) files.
   * Uses async I/O to avoid blocking the event loop.
   */
  private async clearDirectory(dir: string): Promise<void> {
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          await this.clearDirectory(fullPath);
          await fsPromises.rmdir(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith('.bin') || entry.name.endsWith('.json'))) {
          await fsPromises.unlink(fullPath);
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
    activeLockCounters: number;
    pendingWrites: number;
    bufferEnabled: boolean;
  } {
    return {
      shardsDirectory: this.shardsDirectory,
      activeLocks: this.shardLocks.size,
      activeLockCounters: this.lockCounters.size,
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
    this.lockCounters.clear();
    console.info(`[ShardPersistenceManager] Disposed`);
  }
}
