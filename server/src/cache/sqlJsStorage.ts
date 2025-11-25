import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';

export class SqlJsStorage {
  private db: SqlJsDatabase | null = null;
  private isClosed: boolean = false;
  private dbPath: string = '';
  private saveTimer: NodeJS.Timeout | null = null;
  private isDirty: boolean = false;

  async init(dbPath: string): Promise<void> {
    try {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        console.info(`[SqlJsStorage] Creating cache directory: ${dir}`);
        fs.mkdirSync(dir, { recursive: true });
      }

      this.dbPath = dbPath;
      console.info(`[SqlJsStorage] Initializing sql.js storage at: ${dbPath}`);

      // Find the sql.js WASM file - try multiple possible locations
      const possibleWasmPaths = [
        // When running from compiled server output
        path.join(__dirname, '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
        // When running from VS Code extension
        path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
        // Fallback to require.resolve
        require.resolve('sql.js/dist/sql-wasm.wasm')
      ];

      let wasmPath: string | undefined;
      for (const testPath of possibleWasmPaths) {
        try {
          if (fs.existsSync(testPath)) {
            wasmPath = testPath;
            console.info(`[SqlJsStorage] Found WASM file at: ${wasmPath}`);
            break;
          }
        } catch {
          // Continue trying other paths
        }
      }

      if (!wasmPath) {
        throw new Error('[SqlJsStorage] Could not locate sql-wasm.wasm file');
      }
      
      const SQL = await initSqlJs({
        locateFile: (file: string) => {
          if (file.endsWith('.wasm')) {
            return wasmPath!;
          }
          return file;
        }
      });

      if (fs.existsSync(dbPath)) {
        try {
          const buffer = fs.readFileSync(dbPath);
          this.db = new SQL.Database(buffer);
          console.info('[SqlJsStorage] Database loaded from disk');
        } catch (error) {
          console.warn(`[SqlJsStorage] Could not load existing database, creating new one: ${error}`);
          this.db = new SQL.Database();
        }
      } else {
        this.db = new SQL.Database();
        console.info('[SqlJsStorage] Created new database');
      }

      this.isClosed = false;
      console.info('[SqlJsStorage] Creating tables if needed...');
      this.createTables();
      console.info('[SqlJsStorage] Database initialization complete');
    } catch (error) {
      console.error(`[SqlJsStorage] Error initializing database: ${error}`);
      throw error;
    }
  }

  private createTables(): void {
    if (!this.db) { return; }

    try {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT
        );

        CREATE TABLE IF NOT EXISTS files (
          uri TEXT PRIMARY KEY,
          hash TEXT NOT NULL,
          lastIndexedAt INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS symbols (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          uri TEXT NOT NULL,
          line INTEGER NOT NULL,
          character INTEGER NOT NULL,
          containerName TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
        CREATE INDEX IF NOT EXISTS idx_symbols_uri ON symbols(uri);
        CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
      `);
      console.info('[SqlJsStorage] Database tables created/verified');
    } catch (error) {
      console.error(`[SqlJsStorage] Error creating database tables: ${error}`);
      throw error;
    }
  }

  async getMetadata(key: string): Promise<string | undefined> {
    if (!this.db) { return undefined; }
    try {
      const result = this.db.exec('SELECT value FROM metadata WHERE key = ?', [key]);
      if (result.length > 0 && result[0].values.length > 0) {
        return result[0].values[0][0] as string;
      }
      return undefined;
    } catch (error) {
      console.error(`[SqlJsStorage] Error getting metadata for key ${key}: ${error}`);
      return undefined;
    }
  }

  async setMetadata(key: string, value: string): Promise<void> {
    if (!this.db) { return; }
    try {
      this.db.run('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [key, value]);
      this.markDirty();
    } catch (error) {
      console.error(`[SqlJsStorage] Error setting metadata for key ${key}: ${error}`);
    }
  }

  async getFileInfo(uri: string): Promise<{ uri: string; hash: string; lastIndexedAt: number } | undefined> {
    if (!this.db) { return undefined; }
    try {
      const result = this.db.exec('SELECT uri, hash, lastIndexedAt FROM files WHERE uri = ?', [uri]);
      if (result.length > 0 && result[0].values.length > 0) {
        const row = result[0].values[0];
        return {
          uri: row[0] as string,
          hash: row[1] as string,
          lastIndexedAt: row[2] as number
        };
      }
      return undefined;
    } catch (error) {
      console.error(`[SqlJsStorage] Error getting file info for ${uri}: ${error}`);
      return undefined;
    }
  }

  async getAllFiles(): Promise<{ uri: string; hash: string; lastIndexedAt: number }[]> {
    if (!this.db) { return []; }
    try {
      const result = this.db.exec('SELECT uri, hash, lastIndexedAt FROM files');
      if (result.length > 0) {
        const files = result[0].values.map((row: any[]) => ({
          uri: row[0] as string,
          hash: row[1] as string,
          lastIndexedAt: row[2] as number
        }));
        console.info(`[SqlJsStorage] getAllFiles() called - returning ${files.length} files`);
        return files;
      }
      return [];
    } catch (error) {
      console.error(`[SqlJsStorage] Error getting all files: ${error}`);
      return [];
    }
  }

  async upsertFile(uri: string, hash: string, lastIndexedAt: number): Promise<void> {
    if (!this.db) { return; }
    try {
      this.db.run(
        'INSERT OR REPLACE INTO files (uri, hash, lastIndexedAt) VALUES (?, ?, ?)',
        [uri, hash, lastIndexedAt]
      );
      
      const countResult = this.db.exec('SELECT COUNT(*) as count FROM files');
      const totalFiles = countResult[0]?.values[0]?.[0] as number || 0;
      console.info(`[SqlJsStorage] File upserted: ${uri} | Total files in DB: ${totalFiles}`);
      
      this.markDirty();
    } catch (error) {
      console.error(`[SqlJsStorage] Error upserting file ${uri}: ${error}`);
      throw error;
    }
  }

  async deleteFile(uri: string): Promise<void> {
    if (!this.db) { return; }
    try {
      // Delete symbols first (cascade)
      this.db.run('DELETE FROM symbols WHERE uri = ?', [uri]);
      this.db.run('DELETE FROM files WHERE uri = ?', [uri]);
      this.markDirty();
    } catch (error) {
      console.error(`[SqlJsStorage] Error deleting file ${uri}: ${error}`);
    }
  }

  async insertSymbols(
    symbols: Array<{
      name: string;
      kind: string;
      uri: string;
      line: number;
      character: number;
      containerName?: string;
    }>
  ): Promise<void> {
    if (!this.db || symbols.length === 0) { return; }

    try {
      for (const sym of symbols) {
        this.db.run(
          'INSERT INTO symbols (name, kind, uri, line, character, containerName) VALUES (?, ?, ?, ?, ?, ?)',
          [sym.name, sym.kind, sym.uri, sym.line, sym.character, sym.containerName || null]
        );
      }

      const countResult = this.db.exec('SELECT COUNT(*) as count FROM symbols');
      const totalSymbols = countResult[0]?.values[0]?.[0] as number || 0;
      console.info(`[SqlJsStorage] Inserted ${symbols.length} symbols | Total symbols in DB: ${totalSymbols}`);
      
      this.markDirty();
    } catch (error) {
      console.error(`[SqlJsStorage] Error inserting symbols: ${error}`);
      throw error;
    }
  }

  async deleteSymbolsByUri(uri: string): Promise<void> {
    if (!this.db) { return; }
    try {
      this.db.run('DELETE FROM symbols WHERE uri = ?', [uri]);
      this.markDirty();
    } catch (error) {
      console.error(`[SqlJsStorage] Error deleting symbols for ${uri}: ${error}`);
    }
  }

  async findSymbolsByName(name: string): Promise<Array<{
    name: string;
    kind: string;
    uri: string;
    line: number;
    character: number;
    containerName: string | null;
  }>> {
    if (!this.db) { return []; }
    try {
      const result = this.db.exec(
        'SELECT name, kind, uri, line, character, containerName FROM symbols WHERE name = ?',
        [name]
      );
      if (result.length > 0) {
        return result[0].values.map((row: any[]) => ({
          name: row[0] as string,
          kind: row[1] as string,
          uri: row[2] as string,
          line: row[3] as number,
          character: row[4] as number,
          containerName: row[5] as string | null
        }));
      }
      return [];
    } catch (error) {
      console.error(`[SqlJsStorage] Error finding symbols by name ${name}: ${error}`);
      return [];
    }
  }

  async findSymbolsByPrefix(prefix: string, limit: number): Promise<Array<{
    name: string;
    kind: string;
    uri: string;
    line: number;
    character: number;
    containerName: string | null;
  }>> {
    if (!this.db) { return []; }
    try {
      const result = this.db.exec(
        'SELECT name, kind, uri, line, character, containerName FROM symbols WHERE name LIKE ? LIMIT ?',
        [prefix + '%', limit]
      );
      if (result.length > 0) {
        return result[0].values.map((row: any[]) => ({
          name: row[0] as string,
          kind: row[1] as string,
          uri: row[2] as string,
          line: row[3] as number,
          character: row[4] as number,
          containerName: row[5] as string | null
        }));
      }
      return [];
    } catch (error) {
      console.error(`[SqlJsStorage] Error finding symbols by prefix ${prefix}: ${error}`);
      return [];
    }
  }

  async getAllSymbols(): Promise<Array<{
    name: string;
    kind: string;
    uri: string;
    line: number;
    character: number;
    containerName: string | null;
  }>> {
    if (!this.db) { return []; }
    try {
      const result = this.db.exec('SELECT name, kind, uri, line, character, containerName FROM symbols');
      if (result.length > 0) {
        const symbols = result[0].values.map((row: any[]) => ({
          name: row[0] as string,
          kind: row[1] as string,
          uri: row[2] as string,
          line: row[3] as number,
          character: row[4] as number,
          containerName: row[5] as string | null
        }));
        console.info(`[SqlJsStorage] getAllSymbols() called - returning ${symbols.length} symbols`);
        return symbols;
      }
      return [];
    } catch (error) {
      console.error(`[SqlJsStorage] Error getting all symbols: ${error}`);
      return [];
    }
  }

  async getSymbolsByUri(uri: string): Promise<Array<{
    name: string;
    kind: string;
    uri: string;
    line: number;
    character: number;
    containerName: string | null;
  }>> {
    if (!this.db) { return []; }
    try {
      const result = this.db.exec(
        'SELECT name, kind, uri, line, character, containerName FROM symbols WHERE uri = ?',
        [uri]
      );
      if (result.length > 0) {
        return result[0].values.map((row: any[]) => ({
          name: row[0] as string,
          kind: row[1] as string,
          uri: row[2] as string,
          line: row[3] as number,
          character: row[4] as number,
          containerName: row[5] as string | null
        }));
      }
      return [];
    } catch (error) {
      console.error(`[SqlJsStorage] Error getting symbols for ${uri}: ${error}`);
      return [];
    }
  }

  private markDirty(): void {
    this.isDirty = true;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      return;
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk().catch(err => {
        console.error(`[SqlJsStorage] Error in scheduled save: ${err}`);
      });
    }, 2000); // Save after 2 seconds of inactivity
  }

  async saveToDisk(): Promise<void> {
    if (!this.db || !this.isDirty) {
      return;
    }

    try {
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, data);
      this.isDirty = false;
      console.info('[SqlJsStorage] Database saved to disk');
    } catch (error) {
      console.error(`[SqlJsStorage] Error saving database to disk: ${error}`);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      console.warn('[SqlJsStorage] Database already closed');
      return;
    }

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    // Save any pending changes
    await this.saveToDisk();

    if (this.db) {
      try {
        this.db.close();
        this.db = null;
        this.isClosed = true;
        console.info('[SqlJsStorage] Database closed successfully');
      } catch (error) {
        console.error(`[SqlJsStorage] Error closing database: ${error}`);
      }
    }
  }
}
