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
 * - Schema versioning with automatic migrations
 * - FTS5 full-text search for symbol discovery
 * 
 * Crash Safety:
 * - Writes use atomic rename operation to prevent partial writes
 * - Detects and recovers from corrupted database files
 * - Handles zero-byte files from crashed writes
 * - Gracefully resets and triggers re-indexing on corruption
 * 
 * Schema (v2):
 * - meta table: (key TEXT PRIMARY KEY, value TEXT) - Schema version tracking
 * - files table: (uri PRIMARY KEY, json_data TEXT, updated_at INTEGER)
 * - symbols_fts table: FTS5 virtual table for full-text search
 * - Index on uri for fast lookups
 * - Triggers to sync symbols_fts with symbol changes
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
  
  // Schema version for migration system
  private static readonly SCHEMA_VERSION = 2;

  /**
   * Create a new SqlJsStorage instance.
   * 
   * @param autoSaveDelayMs - Delay in ms before auto-saving to disk (default: 2000)
   */
  constructor(autoSaveDelayMs: number = 2000) {
    this.autoSaveDelayMs = autoSaveDelayMs;
  }

  /**
   * Normalize URI to prevent duplicates from inconsistent path formats.
   * - Converts backslashes to forward slashes
   * - Lowercases drive letter on Windows (C: vs c:)
   * - Ensures consistent format for database keys
   */
  private normalizeUri(uri: string): string {
    let normalized = uri.replace(/\\/g, '/');
    
    // Normalize Windows drive letter to lowercase
    if (/^[A-Z]:/.test(normalized)) {
      normalized = normalized.charAt(0).toLowerCase() + normalized.slice(1);
    }
    
    return normalized;
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

    // Initialize schema with migration support
    await this.initializeSchema();

    this.isInitialized = true;
  }

  /**
   * Initialize or migrate database schema.
   * Implements versioned migration system with self-healing on failure.
   */
  private async initializeSchema(): Promise<void> {
    try {
      // Create meta table for schema versioning
      this.db!.run(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);

      // Check current schema version
      const currentVersion = await this.getCurrentSchemaVersion();
      console.info(`[SqlJsStorage] Current schema version: ${currentVersion}, target: ${SqlJsStorage.SCHEMA_VERSION}`);

      if (currentVersion === 0) {
        // Fresh database - create initial schema (v1)
        await this.createSchemaV1();
        await this.setSchemaVersion(1);
        console.info('[SqlJsStorage] Created fresh database with schema v1');
      }

      // Run migrations sequentially
      if (currentVersion < SqlJsStorage.SCHEMA_VERSION) {
        await this.migrateSchema(currentVersion, SqlJsStorage.SCHEMA_VERSION);
      } else if (currentVersion > SqlJsStorage.SCHEMA_VERSION) {
        // Database is from a newer version
        throw new Error(
          `Database schema version ${currentVersion} is newer than supported ${SqlJsStorage.SCHEMA_VERSION}. ` +
          `Please upgrade Smart Indexer to the latest version.`
        );
      }

      // Configure SQLite for optimal performance
      await this.configureSQLite();

    } catch (error: any) {
      console.error(`[SqlJsStorage] Schema initialization failed: ${error.message}`);
      console.warn('[SqlJsStorage] Attempting self-healing: dropping database and recreating...');
      
      // Self-healing: drop all tables and start fresh
      await this.selfHeal();
    }
  }

  /**
   * Get current schema version from meta table.
   */
  private async getCurrentSchemaVersion(): Promise<number> {
    try {
      const result = this.db!.exec(`SELECT value FROM meta WHERE key = 'schema_version'`);
      if (result.length > 0 && result[0].values.length > 0) {
        return parseInt(result[0].values[0][0] as string, 10);
      }
    } catch {
      // Table doesn't exist or query failed
    }
    return 0;
  }

  /**
   * Set schema version in meta table.
   */
  private async setSchemaVersion(version: number): Promise<void> {
    this.db!.run(
      `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`,
      [version.toString()]
    );
  }

  /**
   * Create initial schema (v1).
   */
  private async createSchemaV1(): Promise<void> {
    // Files table
    this.db!.run(`
      CREATE TABLE IF NOT EXISTS files (
        uri TEXT PRIMARY KEY,
        json_data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Index on uri for fast lookups
    this.db!.run(`CREATE INDEX IF NOT EXISTS idx_uri ON files(uri)`);
  }

  /**
   * Migrate schema from one version to another.
   */
  private async migrateSchema(fromVersion: number, toVersion: number): Promise<void> {
    console.warn(`[SqlJsStorage] Migrating schema from v${fromVersion} to v${toVersion}`);
    
    let currentVersion = fromVersion;

    // Migration v1 -> v2: Add FTS5 full-text search
    if (currentVersion === 1 && toVersion >= 2) {
      console.info('[SqlJsStorage] Applying migration v1 -> v2 (FTS5 support)');
      await this.migrateToV2();
      currentVersion = 2;
      await this.setSchemaVersion(currentVersion);
    }

    // Future migrations go here:
    // if (currentVersion === 2 && toVersion >= 3) {
    //   await this.migrateToV3();
    //   currentVersion = 3;
    //   await this.setSchemaVersion(currentVersion);
    // }

    console.info(`[SqlJsStorage] Migration completed successfully to v${currentVersion}`);
  }

  /**
   * Migration v1 -> v2: Add FTS5 virtual table for full-text search.
   */
  private async migrateToV2(): Promise<void> {
    try {
      // Create FTS5 virtual table for symbol search
      this.db!.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
          uri,
          symbol_name,
          container_name,
          kind,
          file_path,
          content='',
          tokenize='porter'
        )
      `);

      // Populate FTS table with existing symbols
      console.info('[SqlJsStorage] Populating FTS index from existing data...');
      const result = this.db!.exec('SELECT uri, json_data FROM files');
      
      if (result.length > 0 && result[0].values.length > 0) {
        let symbolCount = 0;
        for (const row of result[0].values) {
          const uri = row[0] as string;
          const jsonData = row[1] as string;
          
          try {
            const data: FileIndexData = JSON.parse(jsonData);
            
            // Insert each symbol into FTS table
            for (const symbol of data.symbols) {
              if (symbol.isDefinition) {
                this.db!.run(
                  `INSERT INTO symbols_fts (uri, symbol_name, container_name, kind, file_path) VALUES (?, ?, ?, ?, ?)`,
                  [
                    uri,
                    symbol.name,
                    symbol.containerName || '',
                    symbol.kind,
                    symbol.filePath
                  ]
                );
                symbolCount++;
              }
            }
          } catch (parseError) {
            console.warn(`[SqlJsStorage] Skipping corrupt file data for ${uri}`);
          }
        }
        console.info(`[SqlJsStorage] Populated FTS index with ${symbolCount} symbols`);
      }

    } catch (error: any) {
      console.error(`[SqlJsStorage] FTS5 migration failed: ${error.message}`);
      // Note: sql.js might not support FTS5 - this is acceptable, search will degrade gracefully
      console.warn('[SqlJsStorage] FTS5 not supported, full-text search will be unavailable');
    }
  }

  /**
   * Configure SQLite for optimal performance.
   */
  private async configureSQLite(): Promise<void> {
    try {
      // Try to enable WAL mode (may not work in sql.js WASM)
      this.db!.run('PRAGMA journal_mode = WAL');
      this.db!.run('PRAGMA synchronous = NORMAL');
      this.db!.run('PRAGMA cache_size = -64000'); // 64MB cache
      this.db!.run('PRAGMA temp_store = MEMORY');
      console.info('[SqlJsStorage] Configured SQLite with WAL mode');
    } catch (error) {
      // WAL mode might not be supported in sql.js WASM
      console.warn('[SqlJsStorage] Could not enable WAL mode (sql.js limitation)');
    }
  }

  /**
   * Self-healing: Drop all tables and recreate from scratch.
   * Triggers re-indexing by BackgroundIndex.
   */
  private async selfHeal(): Promise<void> {
    try {
      // Drop all tables
      const tables = ['symbols_fts', 'files', 'meta'];
      for (const table of tables) {
        try {
          this.db!.run(`DROP TABLE IF EXISTS ${table}`);
        } catch {
          // Ignore errors - table might not exist
        }
      }

      // Recreate meta table
      this.db!.run(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);

      // Create v1 schema
      await this.createSchemaV1();
      await this.setSchemaVersion(1);

      // Migrate to current version
      await this.migrateSchema(1, SqlJsStorage.SCHEMA_VERSION);

      console.info('[SqlJsStorage] Self-healing completed - database recreated');
    } catch (healError: any) {
      console.error(`[SqlJsStorage] Self-healing failed: ${healError.message}`);
      throw new Error('Database is unrecoverable. Please delete .smart-index directory and restart.');
    }
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

    // CRITICAL: Normalize URI to prevent duplicates from inconsistent path formats
    // - Lowercase drive letter (C: vs c:)
    // - Consistent separators (forward slashes)
    const normalizedUri = this.normalizeUri(data.uri);
    const normalizedData = { ...data, uri: normalizedUri };

    const jsonData = JSON.stringify(normalizedData);
    const updatedAt = Date.now();

    // Use transaction for atomicity (DELETE + INSERT)
    this.db!.run('BEGIN TRANSACTION');
    
    try {
      // Delete old entry before inserting new one
      this.db!.run('DELETE FROM files WHERE uri = ?', [normalizedUri]);
      
      // Insert new entry
      this.db!.run(
        'INSERT INTO files (uri, json_data, updated_at) VALUES (?, ?, ?)',
        [normalizedUri, jsonData, updatedAt]
      );

      // Update FTS index (if FTS5 is available)
      await this.updateFTSIndex(normalizedData);
      
      this.db!.run('COMMIT');
    } catch (error) {
      this.db!.run('ROLLBACK');
      throw error;
    }

    this.isDirty = true;
    this.scheduleAutoSave();
  }

  /**
   * Update FTS5 index for a file's symbols.
   */
  private async updateFTSIndex(data: FileIndexData): Promise<void> {
    try {
      // Check if FTS table exists
      const tableCheck = this.db!.exec(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='symbols_fts'`
      );
      
      if (tableCheck.length === 0 || tableCheck[0].values.length === 0) {
        return; // FTS not available
      }

      // Delete existing entries for this file
      this.db!.run('DELETE FROM symbols_fts WHERE uri = ?', [data.uri]);

      // Insert new symbol entries (definitions only)
      for (const symbol of data.symbols) {
        if (symbol.isDefinition) {
          this.db!.run(
            `INSERT INTO symbols_fts (uri, symbol_name, container_name, kind, file_path) VALUES (?, ?, ?, ?, ?)`,
            [
              data.uri,
              symbol.name,
              symbol.containerName || '',
              symbol.kind,
              symbol.filePath
            ]
          );
        }
      }
    } catch (error) {
      // Silently fail - FTS is optional
    }
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

    const normalizedUri = this.normalizeUri(uri);
    
    const result = this.db!.exec(
      'SELECT json_data FROM files WHERE uri = ?',
      [normalizedUri]
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

      const normalizedUri = this.normalizeUri(uri);

      // Delete from files table
      this.db!.run('DELETE FROM files WHERE uri = ?', [normalizedUri]);

      // Delete from FTS index (if available)
      try {
        this.db!.run('DELETE FROM symbols_fts WHERE uri = ?', [normalizedUri]);
      } catch {
        // FTS table doesn't exist or query failed - ignore
      }

      this.isDirty = true;
      this.scheduleAutoSave();
    });
  }

  /**
   * Check if indexed data exists for a file.
   */
  async hasFile(uri: string): Promise<boolean> {
    this.ensureInitialized();

    const normalizedUri = this.normalizeUri(uri);

    const result = this.db!.exec(
      'SELECT 1 FROM files WHERE uri = ? LIMIT 1',
      [normalizedUri]
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
   * Search symbols using full-text search (FTS5).
   * Falls back to simple name matching if FTS is not available.
   * 
   * @param query - Search query (supports FTS5 syntax if available)
   * @param mode - Search mode: 'exact' (default), 'fuzzy', or 'fulltext'
   * @param limit - Maximum number of results (default: 100)
   * @returns Array of matching symbols with their file URIs
   */
  async searchSymbols(
    query: string, 
    mode: 'exact' | 'fuzzy' | 'fulltext' = 'exact', 
    limit: number = 100
  ): Promise<Array<{ uri: string; symbol: any; rank?: number }>> {
    this.ensureInitialized();

    if (mode === 'fulltext') {
      return this.searchFTS(query, limit);
    } else if (mode === 'fuzzy') {
      return this.searchFuzzy(query, limit);
    } else {
      return this.searchExact(query, limit);
    }
  }

  /**
   * Full-text search using FTS5.
   */
  private async searchFTS(query: string, limit: number): Promise<Array<{ uri: string; symbol: any; rank?: number }>> {
    try {
      // Check if FTS table exists
      const tableCheck = this.db!.exec(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='symbols_fts'`
      );
      
      if (tableCheck.length === 0 || tableCheck[0].values.length === 0) {
        console.warn('[SqlJsStorage] FTS5 table not available, falling back to exact search');
        return this.searchExact(query, limit);
      }

      // Execute FTS5 query
      const ftsQuery = query.includes('*') ? query : `${query}*`; // Prefix matching
      const result = this.db!.exec(
        `SELECT uri, symbol_name, container_name, kind, file_path, rank 
         FROM symbols_fts 
         WHERE symbols_fts MATCH ? 
         ORDER BY rank 
         LIMIT ?`,
        [ftsQuery, limit]
      );

      if (result.length === 0 || result[0].values.length === 0) {
        return [];
      }

      // Convert FTS results to symbol objects
      const results: Array<{ uri: string; symbol: any; rank?: number }> = [];
      for (const row of result[0].values) {
        const uri = row[0] as string;
        const name = row[1] as string;
        const containerName = row[2] as string;
        const kind = row[3] as string;
        const filePath = row[4] as string;
        const rank = row[5] as number;

        results.push({
          uri,
          symbol: {
            name,
            kind,
            containerName: containerName || undefined,
            filePath,
            // Note: Location details would require loading full file data
          },
          rank
        });
      }

      return results;
    } catch (error: any) {
      console.warn(`[SqlJsStorage] FTS search failed: ${error.message}, falling back to exact search`);
      return this.searchExact(query, limit);
    }
  }

  /**
   * Fuzzy search (partial matching on symbol names).
   */
  private async searchFuzzy(query: string, limit: number): Promise<Array<{ uri: string; symbol: any }>> {
    const results: Array<{ uri: string; symbol: any }> = [];
    const lowerQuery = query.toLowerCase();

    // Get all files
    const filesResult = this.db!.exec('SELECT uri, json_data FROM files');
    
    if (filesResult.length === 0 || filesResult[0].values.length === 0) {
      return [];
    }

    // Search through all symbols
    for (const row of filesResult[0].values) {
      const uri = row[0] as string;
      const jsonData = row[1] as string;
      
      try {
        const data: FileIndexData = JSON.parse(jsonData);
        
        for (const symbol of data.symbols) {
          if (symbol.isDefinition && symbol.name.toLowerCase().includes(lowerQuery)) {
            results.push({ uri, symbol });
            
            if (results.length >= limit) {
              return results;
            }
          }
        }
      } catch {
        // Skip corrupt data
      }
    }

    return results;
  }

  /**
   * Exact name matching.
   */
  private async searchExact(query: string, limit: number): Promise<Array<{ uri: string; symbol: any }>> {
    const results: Array<{ uri: string; symbol: any }> = [];

    // Get all files
    const filesResult = this.db!.exec('SELECT uri, json_data FROM files');
    
    if (filesResult.length === 0 || filesResult[0].values.length === 0) {
      return [];
    }

    // Search through all symbols
    for (const row of filesResult[0].values) {
      const uri = row[0] as string;
      const jsonData = row[1] as string;
      
      try {
        const data: FileIndexData = JSON.parse(jsonData);
        
        for (const symbol of data.symbols) {
          if (symbol.isDefinition && symbol.name === query) {
            results.push({ uri, symbol });
            
            if (results.length >= limit) {
              return results;
            }
          }
        }
      } catch {
        // Skip corrupt data
      }
    }

    return results;
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
