import { IIndexStorage, FileIndexData, FileMetadata, StorageStats } from './IIndexStorage.js';
import initSqlJs, { Database } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SQLite-based storage implementation using sql.js (WASM).
 * 
 * This implementation replaces the fragmented file-based sharding with a single SQLite database,
 * solving file handle limit issues and improving startup performance.
 * 
 * Storage characteristics:
 * - Single SQLite database file (.smart-index/index.db)
 * - In-memory WASM database with periodic disk flushes
 * - Auto-save mechanism with debouncing (2000ms default)
 * - Per-URI mutex locks for thread safety
 * - JSON-serialized indexed data
 * - Atomic writes via temp file + rename (crash-safe)
 * - Automatic corruption recovery on startup
 * 
 * Crash Safety:
 * - Writes use atomic rename operation to prevent partial writes
 * - Detects and recovers from corrupted database files
 * - Handles zero-byte files from crashed writes
 * - Gracefully resets and triggers re-indexing on corruption
 * 
 * Schema:
 * - files table: (uri PRIMARY KEY, json_data TEXT, updated_at INTEGER)
 * - Index on uri for fast lookups
 */
export class SqlJsStorage implements IIndexStorage {
  private db: Database | null = null;
  private dbPath: string = '';
  private SQL: any = null;
  private autoSaveTimer: NodeJS.Timeout | null = null;
  private readonly autoSaveDelayMs: number;
  private isDirty: boolean = false;
  private locks: Map<string, Promise<void>> = new Map();
  private isInitialized: boolean = false;

  /**
   * Create a new SqlJsStorage instance.
   * 
   * @param autoSaveDelayMs - Delay in ms before auto-saving to disk (default: 2000)
   */
  constructor(autoSaveDelayMs: number = 2000) {
    this.autoSaveDelayMs = autoSaveDelayMs;
  }

  /**
   * Initialize the storage backend.
   */
  async init(workspaceRoot: string, cacheDirectory: string): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // Initialize sql.js WASM module
    // Note: Code is bundled by esbuild, so __dirname points to server/out (not server/out/storage)
    const wasmPath = path.join(__dirname, 'sql-wasm.wasm');
    
    // Verify WASM file exists before initialization
    if (!fs.existsSync(wasmPath)) {
      throw new Error(`WASM file not found at expected path: ${wasmPath}`);
    }

    this.SQL = await initSqlJs({
      locateFile: (file) => path.join(__dirname, file)
    });

    // Set up database path
    const cacheDir = path.join(workspaceRoot, cacheDirectory);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    this.dbPath = path.join(cacheDir, 'index.db');

    // Load existing database or create new one with corruption recovery
    if (fs.existsSync(this.dbPath)) {
      try {
        // Check for zero-byte file (crashed write)
        const stats = fs.statSync(this.dbPath);
        if (stats.size === 0) {
          console.warn(`[SqlJsStorage] Database file is empty (0 bytes), treating as corrupt: ${this.dbPath}`);
          fs.unlinkSync(this.dbPath);
          this.db = new this.SQL.Database();
        } else {
          const buffer = fs.readFileSync(this.dbPath);
          this.db = new this.SQL.Database(buffer);
        }
      } catch (error: any) {
        // Database is corrupted or unreadable - recover by creating fresh DB
        console.warn(`[SqlJsStorage] Database corrupted, resetting: ${error.message}`);
        try {
          fs.unlinkSync(this.dbPath);
        } catch (unlinkError) {
          // Ignore unlink errors - file might already be gone
        }
        this.db = new this.SQL.Database();
        // Note: Starting with empty DB will trigger re-indexing logic in BackgroundIndex
      }
    } else {
      this.db = new this.SQL.Database();
    }

    if (!this.db) {
      throw new Error('Failed to initialize SQLite database');
    }

    // Create schema
    this.db.run(`
      CREATE TABLE IF NOT EXISTS files (
        uri TEXT PRIMARY KEY,
        json_data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_uri ON files(uri)
    `);

    this.isInitialized = true;
  }

  /**
   * Store or update indexed data for a file.
   */
  async storeFile(data: FileIndexData): Promise<void> {
    await this.withLock(data.uri, async () => {
      await this.storeFileNoLock(data);
    });
  }

  /**
   * Store or update indexed data for a file WITHOUT acquiring a lock.
   */
  async storeFileNoLock(data: FileIndexData): Promise<void> {
    this.ensureInitialized();

    const jsonData = JSON.stringify(data);
    const updatedAt = Date.now();

    this.db!.run(
      'INSERT OR REPLACE INTO files (uri, json_data, updated_at) VALUES (?, ?, ?)',
      [data.uri, jsonData, updatedAt]
    );

    this.isDirty = true;
    this.scheduleAutoSave();
  }

  /**
   * Retrieve indexed data for a file.
   */
  async getFile(uri: string): Promise<FileIndexData | null> {
    return await this.withLock(uri, async () => {
      return await this.getFileNoLock(uri);
    });
  }

  /**
   * Retrieve indexed data for a file WITHOUT acquiring a lock.
   */
  async getFileNoLock(uri: string): Promise<FileIndexData | null> {
    this.ensureInitialized();

    const result = this.db!.exec(
      'SELECT json_data FROM files WHERE uri = ?',
      [uri]
    );

    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    const jsonData = result[0].values[0][0] as string;
    return JSON.parse(jsonData);
  }

  /**
   * Delete indexed data for a file.
   */
  async deleteFile(uri: string): Promise<void> {
    await this.withLock(uri, async () => {
      this.ensureInitialized();

      this.db!.run('DELETE FROM files WHERE uri = ?', [uri]);

      this.isDirty = true;
      this.scheduleAutoSave();
    });
  }

  /**
   * Check if indexed data exists for a file.
   */
  async hasFile(uri: string): Promise<boolean> {
    this.ensureInitialized();

    const result = this.db!.exec(
      'SELECT 1 FROM files WHERE uri = ? LIMIT 1',
      [uri]
    );

    return result.length > 0 && result[0].values.length > 0;
  }

  /**
   * Get metadata for a single file (lightweight operation).
   */
  async getMetadata(uri: string): Promise<FileMetadata | null> {
    this.ensureInitialized();

    const result = this.db!.exec(
      'SELECT json_data FROM files WHERE uri = ?',
      [uri]
    );

    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    const jsonData = result[0].values[0][0] as string;
    const data: FileIndexData = JSON.parse(jsonData);

    return {
      uri: data.uri,
      hash: data.hash,
      mtime: data.mtime,
      symbolCount: data.symbols.length,
      lastIndexedAt: data.lastIndexedAt
    };
  }

  /**
   * Get metadata for all indexed files.
   */
  async getAllMetadata(): Promise<FileMetadata[]> {
    this.ensureInitialized();

    const result = this.db!.exec('SELECT json_data FROM files');

    if (result.length === 0) {
      return [];
    }

    const metadata: FileMetadata[] = [];
    for (const row of result[0].values) {
      const jsonData = row[0] as string;
      const data: FileIndexData = JSON.parse(jsonData);
      
      metadata.push({
        uri: data.uri,
        hash: data.hash,
        mtime: data.mtime,
        symbolCount: data.symbols.length,
        lastIndexedAt: data.lastIndexedAt
      });
    }

    return metadata;
  }

  /**
   * Update metadata for a file (optimization for avoiding full file loads).
   * Note: In SQLite implementation, this is a no-op as metadata is derived from file data.
   */
  async updateMetadata(_metadata: FileMetadata): Promise<void> {
    // No-op for SQLite - metadata is derived from full file data
    // This method exists for interface compatibility with sharded storage
  }

  /**
   * Remove metadata for a file.
   */
  async removeMetadata(uri: string): Promise<void> {
    await this.deleteFile(uri);
  }

  /**
   * Get storage statistics.
   */
  async getStats(): Promise<StorageStats> {
    this.ensureInitialized();

    const countResult = this.db!.exec('SELECT COUNT(*) FROM files');
    const totalFiles = countResult[0].values[0][0] as number;

    const symbolResult = this.db!.exec('SELECT json_data FROM files');
    let totalSymbols = 0;

    if (symbolResult.length > 0) {
      for (const row of symbolResult[0].values) {
        const jsonData = row[0] as string;
        const data: FileIndexData = JSON.parse(jsonData);
        totalSymbols += data.symbols.length;
      }
    }

    let storageSize = 0;
    if (fs.existsSync(this.dbPath)) {
      const stats = fs.statSync(this.dbPath);
      storageSize = stats.size;
    }

    return {
      totalFiles,
      totalSymbols,
      storageSize,
      storagePath: this.dbPath
    };
  }

  /**
   * Clear all indexed data.
   */
  async clear(): Promise<void> {
    this.ensureInitialized();

    this.db!.run('DELETE FROM files');

    this.isDirty = true;
    await this.flush();
  }

  /**
   * Flush any pending writes to persistent storage.
   * Uses atomic write via temp file to prevent corruption on crash.
   */
  async flush(): Promise<void> {
    if (!this.isInitialized || !this.db || !this.isDirty) {
      return;
    }

    // Cancel auto-save timer
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }

    // Export database to buffer
    const data = this.db.export();
    const buffer = Buffer.from(data);

    // Atomic write: temp file -> rename
    const tmpPath = this.dbPath + '.tmp';
    try {
      // Write to temp file
      fs.writeFileSync(tmpPath, buffer);
      
      // Atomic rename (overwrites target)
      fs.renameSync(tmpPath, this.dbPath);
      
      this.isDirty = false;
    } catch (error: any) {
      // Clean up temp file on error
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Cleanup resources and close connections.
   */
  async dispose(): Promise<void> {
    // Flush any pending writes
    await this.flush();

    // Close database
    if (this.db) {
      this.db.close();
      this.db = null;
    }

    this.isInitialized = false;
  }

  /**
   * Execute a task with exclusive access to a file's data.
   */
  async withLock<T>(uri: string, task: () => Promise<T>): Promise<T> {
    // Wait for any existing lock
    while (this.locks.has(uri)) {
      await this.locks.get(uri);
    }

    // Create new lock
    let resolve: () => void;
    const lockPromise = new Promise<void>((res) => {
      resolve = res;
    });
    this.locks.set(uri, lockPromise);

    try {
      return await task();
    } finally {
      this.locks.delete(uri);
      resolve!();
    }
  }

  /**
   * Get the storage directory path.
   */
  getStoragePath(): string {
    return this.dbPath;
  }

  /**
   * Collect all file URIs from storage.
   */
  async collectAllFiles(): Promise<string[]> {
    this.ensureInitialized();

    const result = this.db!.exec('SELECT uri FROM files');

    if (result.length === 0) {
      return [];
    }

    return result[0].values.map((row) => row[0] as string);
  }

  /**
   * Save metadata summary to disk.
   * Note: For SQLite, this is a no-op as all data is already in the database.
   */
  async saveMetadataSummary(): Promise<void> {
    // No-op for SQLite - metadata is part of the database
    // Trigger a flush to ensure data is persisted
    await this.flush();
  }

  /**
   * Schedule an auto-save operation with debouncing.
   */
  private scheduleAutoSave(): void {
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
    }

    this.autoSaveTimer = setTimeout(async () => {
      try {
        await this.flush();
      } catch (error) {
        }
    }, this.autoSaveDelayMs);
  }

  /**
   * Ensure the storage is initialized.
   */
  private ensureInitialized(): void {
    if (!this.isInitialized || !this.db) {
      throw new Error('SqlJsStorage is not initialized. Call init() first.');
    }
  }
}
