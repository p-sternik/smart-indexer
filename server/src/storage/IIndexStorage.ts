import { IndexedSymbol, IndexedReference, ImportInfo, ReExportInfo, PendingReference } from '../types.js';

/**
 * Represents indexed data for a single file.
 */
export interface FileIndexData {
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
 * Metadata entry for a single file.
 */
export interface FileMetadata {
  uri: string;
  hash: string;
  mtime?: number;
  symbolCount: number;
  lastIndexedAt: number;
}

/**
 * Storage statistics.
 */
export interface StorageStats {
  totalFiles: number;
  totalSymbols: number;
  storageSize?: number;
  storagePath?: string;
}

/**
 * Generic storage interface for the index persistence layer.
 * 
 * This abstraction allows swapping between different storage backends
 * (file-based sharding, SQLite, etc.) without changing consumer code.
 * 
 * Design principles:
 * - High-level operations (not low-level file I/O)
 * - Async-first API for non-blocking operations
 * - Thread-safe implementations required
 * - No assumptions about underlying storage mechanism
 */
export interface IIndexStorage {
  /**
   * Initialize the storage backend.
   * 
   * @param workspaceRoot - Workspace root directory
   * @param cacheDirectory - Cache directory name (e.g., '.smart-index')
   */
  init(workspaceRoot: string, cacheDirectory: string): Promise<void>;

  /**
   * Store or update indexed data for a file.
   * 
   * @param data - Complete indexed data for the file
   */
  storeFile(data: FileIndexData): Promise<void>;

  /**
   * Retrieve indexed data for a file.
   * 
   * @param uri - File URI
   * @returns Indexed data or null if not found
   */
  getFile(uri: string): Promise<FileIndexData | null>;

  /**
   * Retrieve indexed data for a file WITHOUT acquiring a lock.
   * Use ONLY when already holding a lock (inside withLock callback).
   * 
   * @param uri - File URI
   * @returns Indexed data or null if not found
   */
  getFileNoLock(uri: string): Promise<FileIndexData | null>;

  /**
   * Store or update indexed data for a file WITHOUT acquiring a lock.
   * Use ONLY when already holding a lock (inside withLock callback).
   * 
   * @param data - Complete indexed data for the file
   */
  storeFileNoLock(data: FileIndexData): Promise<void>;

  /**
   * Delete indexed data for a file.
   * 
   * @param uri - File URI
   */
  deleteFile(uri: string): Promise<void>;

  /**
   * Check if indexed data exists for a file.
   * 
   * @param uri - File URI
   * @returns True if data exists
   */
  hasFile(uri: string): Promise<boolean>;

  /**
   * Get metadata for a single file (lightweight operation).
   * 
   * @param uri - File URI
   * @returns Metadata or null if not found
   */
  getMetadata(uri: string): Promise<FileMetadata | null>;

  /**
   * Get metadata for all indexed files (for startup optimization).
   * 
   * @returns Array of metadata entries
   */
  getAllMetadata(): Promise<FileMetadata[]>;

  /**
   * Update metadata for a file (optimization for avoiding full file loads).
   * 
   * @param metadata - File metadata
   */
  updateMetadata(metadata: FileMetadata): Promise<void>;

  /**
   * Remove metadata for a file.
   * 
   * @param uri - File URI
   */
  removeMetadata(uri: string): Promise<void>;

  /**
   * Get storage statistics.
   * 
   * @returns Storage statistics
   */
  getStats(): Promise<StorageStats>;

  /**
   * Clear all indexed data.
   */
  clear(): Promise<void>;

  /**
   * Flush any pending writes to persistent storage.
   */
  flush(): Promise<void>;

  /**
   * Cleanup resources and close connections.
   */
  dispose(): Promise<void>;

  /**
   * Execute a task with exclusive access to a file's data.
   * Prevents race conditions during load-modify-save operations.
   * 
   * @param uri - File URI
   * @param task - Task to execute with exclusive access
   */
  withLock<T>(uri: string, task: () => Promise<T>): Promise<T>;

  /**
   * Get the storage directory path (for diagnostics/debugging).
   * 
   * @returns Storage directory path
   */
  getStoragePath(): string;

  /**
   * Collect all file URIs from storage (for migration/scanning).
   * 
   * @returns Array of file URIs
   */
  collectAllFiles(): Promise<string[]>;

  /**
   * Save metadata summary to disk (optimization for fast startup).
   * Called after bulk indexing operations.
   */
  saveMetadataSummary(): Promise<void>;
}
