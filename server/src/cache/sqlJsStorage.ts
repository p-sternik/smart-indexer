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
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          uri TEXT NOT NULL,
          line INTEGER NOT NULL,
          character INTEGER NOT NULL,
          startLine INTEGER NOT NULL,
          startCharacter INTEGER NOT NULL,
          endLine INTEGER NOT NULL,
          endCharacter INTEGER NOT NULL,
          containerName TEXT,
          containerKind TEXT,
          fullContainerPath TEXT,
          isStatic INTEGER,
          parametersCount INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
        CREATE INDEX IF NOT EXISTS idx_symbols_uri ON symbols(uri);
        CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
        CREATE INDEX IF NOT EXISTS idx_symbols_container ON symbols(containerName);
        CREATE INDEX IF NOT EXISTS idx_symbols_fullpath ON symbols(fullContainerPath);
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
      id: string;
      name: string;
      kind: string;
      uri: string;
      line: number;
      character: number;
      startLine: number;
      startCharacter: number;
      endLine: number;
      endCharacter: number;
      containerName?: string;
      containerKind?: string;
      fullContainerPath?: string;
      isStatic?: boolean;
      parametersCount?: number;
    }>
  ): Promise<void> {
    if (!this.db || symbols.length === 0) { return; }

    try {
      for (const sym of symbols) {
        this.db.run(
          `INSERT OR REPLACE INTO symbols 
           (id, name, kind, uri, line, character, startLine, startCharacter, endLine, endCharacter, 
            containerName, containerKind, fullContainerPath, isStatic, parametersCount) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sym.id,
            sym.name,
            sym.kind,
            sym.uri,
            sym.line,
            sym.character,
            sym.startLine,
            sym.startCharacter,
            sym.endLine,
            sym.endCharacter,
            sym.containerName || null,
            sym.containerKind || null,
            sym.fullContainerPath || null,
            sym.isStatic ? 1 : 0,
            sym.parametersCount || null
          ]
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
    id: string;
    name: string;
    kind: string;
    uri: string;
    line: number;
    character: number;
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    containerName: string | null;
    containerKind: string | null;
    fullContainerPath: string | null;
    isStatic: boolean | null;
    parametersCount: number | null;
  }>> {
    if (!this.db) { return []; }
    try {
      const result = this.db.exec(
        `SELECT id, name, kind, uri, line, character, startLine, startCharacter, endLine, endCharacter, 
         containerName, containerKind, fullContainerPath, isStatic, parametersCount FROM symbols WHERE name = ?`,
        [name]
      );
      if (result.length > 0) {
        return result[0].values.map((row: any[]) => ({
          id: row[0] as string,
          name: row[1] as string,
          kind: row[2] as string,
          uri: row[3] as string,
          line: row[4] as number,
          character: row[5] as number,
          startLine: row[6] as number,
          startCharacter: row[7] as number,
          endLine: row[8] as number,
          endCharacter: row[9] as number,
          containerName: row[10] as string | null,
          containerKind: row[11] as string | null,
          fullContainerPath: row[12] as string | null,
          isStatic: row[13] ? true : false,
          parametersCount: row[14] as number | null
        }));
      }
      return [];
    } catch (error) {
      console.error(`[SqlJsStorage] Error finding symbols by name ${name}: ${error}`);
      return [];
    }
  }

  async findSymbolsByPrefix(prefix: string, limit: number): Promise<Array<{
    id: string;
    name: string;
    kind: string;
    uri: string;
    line: number;
    character: number;
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    containerName: string | null;
    containerKind: string | null;
    isStatic: boolean | null;
  }>> {
    if (!this.db) { return []; }
    try {
      const result = this.db.exec(
        `SELECT id, name, kind, uri, line, character, startLine, startCharacter, endLine, endCharacter, 
         containerName, containerKind, isStatic FROM symbols WHERE name LIKE ? LIMIT ?`,
        [prefix + '%', limit]
      );
      if (result.length > 0) {
        return result[0].values.map((row: any[]) => ({
          id: row[0] as string,
          name: row[1] as string,
          kind: row[2] as string,
          uri: row[3] as string,
          line: row[4] as number,
          character: row[5] as number,
          startLine: row[6] as number,
          startCharacter: row[7] as number,
          endLine: row[8] as number,
          endCharacter: row[9] as number,
          containerName: row[10] as string | null,
          containerKind: row[11] as string | null,
          isStatic: row[12] ? true : false
        }));
      }
      return [];
    } catch (error) {
      console.error(`[SqlJsStorage] Error finding symbols by prefix ${prefix}: ${error}`);
      return [];
    }
  }

  async getAllSymbols(): Promise<Array<{
    id: string;
    name: string;
    kind: string;
    uri: string;
    line: number;
    character: number;
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    containerName: string | null;
    containerKind: string | null;
    isStatic: boolean | null;
  }>> {
    if (!this.db) { return []; }
    try {
      const result = this.db.exec(
        `SELECT id, name, kind, uri, line, character, startLine, startCharacter, endLine, endCharacter, 
         containerName, containerKind, isStatic FROM symbols`
      );
      if (result.length > 0) {
        const symbols = result[0].values.map((row: any[]) => ({
          id: row[0] as string,
          name: row[1] as string,
          kind: row[2] as string,
          uri: row[3] as string,
          line: row[4] as number,
          character: row[5] as number,
          startLine: row[6] as number,
          startCharacter: row[7] as number,
          endLine: row[8] as number,
          endCharacter: row[9] as number,
          containerName: row[10] as string | null,
          containerKind: row[11] as string | null,
          isStatic: row[12] ? true : false
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
    id: string;
    name: string;
    kind: string;
    uri: string;
    line: number;
    character: number;
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    containerName: string | null;
    containerKind: string | null;
    isStatic: boolean | null;
  }>> {
    if (!this.db) { return []; }
    try {
      const result = this.db.exec(
        `SELECT id, name, kind, uri, line, character, startLine, startCharacter, endLine, endCharacter, 
         containerName, containerKind, isStatic FROM symbols WHERE uri = ?`,
        [uri]
      );
      if (result.length > 0) {
        return result[0].values.map((row: any[]) => ({
          id: row[0] as string,
          name: row[1] as string,
          kind: row[2] as string,
          uri: row[3] as string,
          line: row[4] as number,
          character: row[5] as number,
          startLine: row[6] as number,
          startCharacter: row[7] as number,
          endLine: row[8] as number,
          endCharacter: row[9] as number,
          containerName: row[10] as string | null,
          containerKind: row[11] as string | null,
          isStatic: row[12] ? true : false
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
