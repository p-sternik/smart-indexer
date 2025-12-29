import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { 
  IIndexStorage, 
  FileIndexData, 
  FileMetadata, 
  StorageStats
} from './IIndexStorage';
import { IndexedSymbol, IndexedReference } from '../types';

export class NativeSqliteStorage implements IIndexStorage {
  private db: Database.Database | null = null;
  private dbPath: string = '';
  private isInitialized = false;
  private static readonly SCHEMA_VERSION = 7;
  
  // Statement Cache
  private statements: Map<string, Database.Statement> = new Map();

  constructor(dbPath?: string) {
    if (dbPath) {
      this.dbPath = dbPath;
    }
  }

  private ensureInitialized() {
    if (!this.isInitialized || !this.db) {
      throw new Error('NativeSqliteStorage not initialized');
    }
  }

  async init(workspaceRoot: string, cacheDirectory: string): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    if (!this.dbPath) {
      this.dbPath = path.join(workspaceRoot, cacheDirectory, 'index.db');
    }

    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.db = new Database(this.dbPath);
      
      // Performance pragmas
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('cache_size = -10000'); // 10MB cache (increased for Level 4)
      this.db.pragma('temp_store = MEMORY');
      this.db.pragma('foreign_keys = ON');

      this.migrateSchema();
      this.prepareStatements();
      this.isInitialized = true;
      console.info(`[NativeSqliteStorage] Initialized at ${this.dbPath}`);
      
      // Initial maintenance
      this.maintenance();
    } catch (error: any) {
      console.error(`[NativeSqliteStorage] Failed to initialize: ${error.message}`);
      throw error;
    }
  }

  private prepareStatements() {
    if (!this.db) {
      return;
    }
    
    // Files
    this.statements.set('insertFile', this.db.prepare(`
      INSERT OR REPLACE INTO files (uri, hash, last_indexed, has_pending, symbols_count, refs_count, mtime, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `));
    this.statements.set('getFileData', this.db.prepare('SELECT data FROM files WHERE uri = ?'));
    this.statements.set('deleteFile', this.db.prepare('DELETE FROM files WHERE uri = ?'));
    this.statements.set('hasFile', this.db.prepare('SELECT 1 FROM files WHERE uri = ?'));
    this.statements.set('getFileMetadata', this.db.prepare('SELECT uri, hash, last_indexed, symbols_count, mtime FROM files WHERE uri = ?'));
    this.statements.set('getAllMetadata', this.db.prepare('SELECT uri, hash, last_indexed, symbols_count, mtime FROM files'));
    this.statements.set('updateMetadata', this.db.prepare(`
      UPDATE files 
      SET hash = ?, last_indexed = ?, symbols_count = ?, mtime = ?
      WHERE uri = ?
    `));

    // Symbols
    this.statements.set('deleteSymbolsByUri', this.db.prepare('DELETE FROM symbols WHERE uri = ?'));
    this.statements.set('insertSymbol', this.db.prepare(`
      INSERT INTO symbols (id, uri, name, kind, container_name, range_start_line, range_start_character, range_end_line, range_end_character, is_definition, is_exported, full_container_path, ngrx_metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `));
    this.statements.set('getSymbolsByUri', this.db.prepare('SELECT * FROM symbols WHERE uri = ?'));
    this.statements.set('findDefinitions', this.db.prepare('SELECT * FROM symbols WHERE name = ? AND is_definition = 1'));

    // References
    this.statements.set('deleteRefsByUri', this.db.prepare('DELETE FROM references WHERE uri = ?'));
    this.statements.set('insertRef', this.db.prepare(`
      INSERT INTO references (uri, symbol_name, line, character, range_start_line, range_start_character, range_end_line, range_end_character, container_name, is_local)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `));
    this.statements.set('getRefsByUri', this.db.prepare('SELECT * FROM references WHERE uri = ?'));
    this.statements.set('findRefsByName', this.db.prepare('SELECT * FROM references WHERE symbol_name = ?'));

    // FTS
    this.statements.set('deleteFtsByUri', this.db.prepare('DELETE FROM symbols_fts WHERE uri = ?'));
    this.statements.set('insertFts', this.db.prepare(`
      INSERT INTO symbols_fts (id, uri, symbol_name, container_name, kind, file_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `));
    
    // Meta & Utils
    this.statements.set('getPendingFiles', this.db.prepare('SELECT uri FROM files WHERE has_pending = 1'));
    this.statements.set('getAllUris', this.db.prepare('SELECT uri FROM files'));
  }

  private maintenance() {
    if (!this.db) {
      return;
    }
    try {
      console.info('[NativeSqliteStorage] Running maintenance...');
      this.db.pragma('optimize');
      this.db.exec('ANALYZE');
    } catch (error: any) {
      console.warn(`[NativeSqliteStorage] Maintenance failed: ${error.message}`);
    }
  }

  private migrateSchema() {
    const currentVersion = this.getSchemaVersion();
    if (currentVersion < NativeSqliteStorage.SCHEMA_VERSION) {
      this.db!.transaction(() => {
        if (currentVersion === 0) {
          this.createTables();
        } else {
          if (currentVersion < 6) {
            this.recreateEverything();
          }
          if (currentVersion < 7) {
            this.migrateToV7();
          }
        }
        this.setSchemaVersion(NativeSqliteStorage.SCHEMA_VERSION);
      })();
    }
  }

  private migrateToV7() {
    try {
      this.db!.exec(`
        ALTER TABLE files ADD COLUMN symbol_hash TEXT;
        ALTER TABLE files ADD COLUMN refs_hash TEXT;
      `);
    } catch (error: any) {
      // It might already exist if created by createTables() in a previous version
      if (!error.message.includes('duplicate column name')) {
        throw error;
      }
    }
  }

  private recreateEverything() {
    this.db!.exec('DROP TABLE IF EXISTS symbols_fts');
    this.db!.exec('DROP TABLE IF EXISTS references');
    this.db!.exec('DROP TABLE IF EXISTS symbols');
    this.db!.exec('DROP TABLE IF EXISTS files');
    this.db!.exec('DROP TABLE IF EXISTS meta');
    this.createTables();
  }

  private createTables() {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS files (
        uri TEXT PRIMARY KEY,
        hash TEXT,
        symbol_hash TEXT,
        refs_hash TEXT,
        last_indexed INTEGER,
        has_pending INTEGER DEFAULT 0,
        symbols_count INTEGER DEFAULT 0,
        refs_count INTEGER DEFAULT 0,
        mtime INTEGER,
        data BLOB
      )
    `);

    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        id TEXT PRIMARY KEY,
        uri TEXT,
        name TEXT,
        kind TEXT,
        container_name TEXT,
        range_start_line INTEGER,
        range_start_character INTEGER,
        range_end_line INTEGER,
        range_end_character INTEGER,
        is_definition INTEGER,
        is_exported INTEGER,
        full_container_path TEXT,
        ngrx_metadata TEXT,
        FOREIGN KEY(uri) REFERENCES files(uri) ON DELETE CASCADE
      )
    `);

    this.db!.exec('CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)');
    this.db!.exec('CREATE INDEX IF NOT EXISTS idx_symbols_uri ON symbols(uri)');

    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS references (
        uri TEXT,
        symbol_name TEXT,
        line INTEGER,
        character INTEGER,
        range_start_line INTEGER,
        range_start_character INTEGER,
        range_end_line INTEGER,
        range_end_character INTEGER,
        container_name TEXT,
        is_local INTEGER,
        FOREIGN KEY(uri) REFERENCES files(uri) ON DELETE CASCADE
      )
    `);

    this.db!.exec('CREATE INDEX IF NOT EXISTS idx_refs_name ON references(symbol_name)');
    this.db!.exec('CREATE INDEX IF NOT EXISTS idx_refs_uri ON references(uri)');

    this.db!.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
        id UNINDEXED,
        uri,
        symbol_name,
        container_name,
        kind,
        file_path,
        content='',
        tokenize='porter'
      )
    `);

    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
  }

  private getSchemaVersion(): number {
    try {
      const row = this.db!.prepare('SELECT value FROM meta WHERE key = "version"').get() as { value: string };
      if (row) {
        return parseInt(row.value, 10);
      }
      return 0;
    } catch {
      return 0;
    }
  }

  private setSchemaVersion(version: number) {
    this.db!.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES ("version", ?)').run(version.toString());
  }

  async storeFile(data: FileIndexData): Promise<void> {
    this.ensureInitialized();
    await this.storeFileNoLock(data);
  }

  private computeHash(obj: any): string {
    return Buffer.from(JSON.stringify(obj)).toString('base64');
  }

  async storeFileNoLock(data: FileIndexData): Promise<void> {
    const symbolHash = this.computeHash(data.symbols);
    const refsHash = this.computeHash(data.references);

    const existing = this.db!.prepare('SELECT symbol_hash, refs_hash FROM files WHERE uri = ?').get(data.uri) as any;

    const transaction = this.db!.transaction((fileData: FileIndexData) => {
      const symbolsChanged = !existing || existing.symbol_hash !== symbolHash;
      const refsChanged = !existing || existing.refs_hash !== refsHash;

      if (symbolsChanged) {
        this.statements.get('deleteSymbolsByUri')!.run(fileData.uri);
        this.statements.get('deleteFtsByUri')!.run(fileData.uri);
      }

      if (refsChanged) {
        this.statements.get('deleteRefsByUri')!.run(fileData.uri);
      }

      this.db!.prepare(`
        INSERT OR REPLACE INTO files (uri, hash, symbol_hash, refs_hash, last_indexed, has_pending, symbols_count, refs_count, mtime, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fileData.uri,
        fileData.hash,
        symbolHash,
        refsHash,
        fileData.lastIndexedAt,
        fileData.pendingReferences && fileData.pendingReferences.length > 0 ? 1 : 0,
        fileData.symbols.length,
        fileData.references.length,
        fileData.mtime || 0,
        Buffer.from(JSON.stringify({ ...fileData, symbols: [], references: [] }))
      );

      if (symbolsChanged) {
        const insertSymbol = this.statements.get('insertSymbol')!;
        const insertFts = this.statements.get('insertFts')!;

        for (const s of fileData.symbols) {
          insertSymbol.run(
            s.id, fileData.uri, s.name, s.kind, s.containerName || '',
            s.range.startLine, s.range.startCharacter, s.range.endLine, s.range.endCharacter,
            s.isDefinition ? 1 : 0, s.isExported ? 1 : 0, s.fullContainerPath || '',
            s.ngrxMetadata ? JSON.stringify(s.ngrxMetadata) : null
          );
          insertFts.run(s.id, fileData.uri, s.name, s.containerName || '', s.kind, s.filePath || '');
        }
      }

      if (refsChanged) {
        const insertRef = this.statements.get('insertRef')!;
        for (const r of fileData.references) {
          insertRef.run(
            fileData.uri, r.symbolName, r.location.line, r.location.character,
            r.range.startLine, r.range.startCharacter, r.range.endLine, r.range.endCharacter,
            r.containerName || '', r.isLocal ? 1 : 0
          );
        }
      }
    });

    transaction(data);
  }

  async getFile(uri: string): Promise<FileIndexData | null> {
    this.ensureInitialized();
    return this.getFileNoLock(uri);
  }

  async getFileNoLock(uri: string): Promise<FileIndexData | null> {
    const row = this.statements.get('getFileData')!.get(uri) as { data: Buffer };
    if (!row) {
      return null;
    }

    const base = JSON.parse(row.data.toString());
    const symbols = await this.getFileSymbols(uri);
    const references = await this.getFileReferences(uri);

    return { ...base, symbols, references };
  }

  async batchGetFiles(uris: string[]): Promise<FileIndexData[]> {
    this.ensureInitialized();
    const results: FileIndexData[] = [];
    for (const uri of uris) {
      const file = await this.getFile(uri);
      if (file) {
        results.push(file);
      }
    }
    return results;
  }

  private async getFileSymbols(uri: string): Promise<IndexedSymbol[]> {
    const rows = this.statements.get('getSymbolsByUri')!.all(uri) as any[];
    return rows.map(r => this.mapSymbol(r));
  }

  private async getFileReferences(uri: string): Promise<IndexedReference[]> {
    const rows = this.statements.get('getRefsByUri')!.all(uri) as any[];
    return rows.map(r => ({
      symbolName: r.symbol_name,
      location: { uri: r.uri, line: r.line, character: r.character },
      range: {
        startLine: r.range_start_line,
        startCharacter: r.range_start_character,
        endLine: r.range_end_line,
        endCharacter: r.range_end_character
      },
      containerName: r.container_name,
      isLocal: !!r.is_local
    }));
  }

  async deleteFile(uri: string): Promise<void> {
    this.ensureInitialized();
    this.statements.get('deleteFile')!.run(uri);
  }

  async hasFile(uri: string): Promise<boolean> {
    this.ensureInitialized();
    const row = this.statements.get('hasFile')!.get(uri);
    return !!row;
  }

  async getMetadata(uri: string): Promise<FileMetadata | null> {
    this.ensureInitialized();
    const row = this.statements.get('getFileMetadata')!.get(uri) as any;
    if (!row) {
      return null;
    }
    return {
      uri: row.uri,
      hash: row.hash,
      lastIndexedAt: row.last_indexed,
      symbolCount: row.symbols_count,
      mtime: row.mtime
    };
  }

  async getAllMetadata(): Promise<FileMetadata[]> {
    this.ensureInitialized();
    const rows = this.statements.get('getAllMetadata')!.all() as any[];
    return rows.map(r => ({
      uri: r.uri,
      hash: r.hash,
      lastIndexedAt: r.last_indexed,
      symbolCount: r.symbols_count,
      mtime: r.mtime
    }));
  }

  async updateMetadata(metadata: FileMetadata): Promise<void> {
    this.ensureInitialized();
    this.statements.get('updateMetadata')!.run(metadata.hash, metadata.lastIndexedAt, metadata.symbolCount, metadata.mtime || 0, metadata.uri);
  }

  async removeMetadata(uri: string): Promise<void> {
    await this.deleteFile(uri);
  }

  async getStats(): Promise<StorageStats> {
    this.ensureInitialized();
    const fileCount = this.db!.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number };
    const symbolCount = this.db!.prepare('SELECT COUNT(*) as count FROM symbols').get() as { count: number };
    return {
      totalFiles: fileCount.count,
      totalSymbols: symbolCount.count,
      storagePath: this.dbPath
    };
  }

  async dispose(): Promise<void> {
    if (this.db) {
      // Final maintenance
      this.maintenance();
      this.db.close();
      this.db = null;
    }
    this.statements.clear();
  }

  async withLock<T>(_uri: string, task: () => Promise<T>): Promise<T> {
    // Implicit locking via worker message queue + better-sqlite3 sync nature
    return task();
  }

  getStoragePath(): string {
    return this.dbPath;
  }

  async collectAllFiles(): Promise<string[]> {
    this.ensureInitialized();
    const rows = this.statements.get('getAllUris')!.all() as any[];
    return rows.map(r => r.uri);
  }

  async saveMetadataSummary(): Promise<void> {
    // No-op
  }

  async searchSymbols(query: string, _mode: 'exact' | 'fuzzy' | 'fulltext' = 'exact', limit: number = 100): Promise<any[]> {
    this.ensureInitialized();
    try {
      const sql = `
        SELECT 
          s.*,
          (CASE WHEN s.name = ? THEN 100.0 ELSE 1.0 END) * 
          (CASE WHEN s.is_definition = 1 THEN 2.0 ELSE 1.0 END) *
          (CASE WHEN s.is_exported = 1 THEN 1.5 ELSE 1.0 END) as relevance
        FROM symbols_fts f
        JOIN symbols s ON f.id = s.id
        WHERE symbols_fts MATCH ?
        ORDER BY relevance DESC, s.name ASC
        LIMIT ?
      `;
      const rows = this.db!.prepare(sql).all(query, query, limit) as any[];
      return rows.map(r => ({
        uri: r.uri,
        symbol: this.mapSymbol(r),
        rank: r.relevance
      }));
    } catch {
      // Fallback
      const rows = this.db!.prepare('SELECT * FROM symbols WHERE name LIKE ? LIMIT ?').all(`%${query}%`, limit) as any[];
      return rows.map(r => ({
        uri: r.uri,
        symbol: this.mapSymbol(r)
      }));
    }
  }

  private mapSymbol(r: any): IndexedSymbol {
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      containerName: r.container_name,
      location: { uri: r.uri, line: r.range_start_line, character: r.range_start_character },
      range: {
        startLine: r.range_start_line,
        startCharacter: r.range_start_character,
        endLine: r.range_end_line,
        endCharacter: r.range_end_character
      },
      isDefinition: !!r.is_definition,
      isExported: !!r.is_exported,
      fullContainerPath: r.full_container_path,
      filePath: r.uri,
      ngrxMetadata: r.ngrx_metadata ? JSON.parse(r.ngrx_metadata) : undefined
    };
  }

  async findDefinitionsInSql(name: string): Promise<IndexedSymbol[]> {
    this.ensureInitialized();
    const rows = this.statements.get('findDefinitions')!.all(name) as any[];
    return rows.map(r => this.mapSymbol(r));
  }

  async findReferencesInSql(name: string): Promise<IndexedReference[]> {
    this.ensureInitialized();
    const rows = this.statements.get('findRefsByName')!.all(name) as any[];
    return rows.map(r => ({
      symbolName: r.symbol_name,
      location: { uri: r.uri, line: r.line, character: r.character },
      range: {
        startLine: r.range_start_line,
        startCharacter: r.range_start_character,
        endLine: r.range_end_line,
        endCharacter: r.range_end_character
      },
      containerName: r.container_name,
      isLocal: !!r.is_local
    }));
  }

  async findFilesWithPendingRefs(): Promise<string[]> {
    this.ensureInitialized();
    const rows = this.statements.get('getPendingFiles')!.all() as any[];
    return rows.map(r => r.uri);
  }

  /**
   * Impact Analysis: Find all files that depend on symbols from the given file,
   * either directly or indirectly.
   */
  async getImpactedFiles(uri: string, maxDepth: number = 3): Promise<string[]> {
    this.ensureInitialized();
    
    // Recursive query to find all files that reference symbols defined in 'uri'
    // or defined in files that reference symbols defined in 'uri', etc.
    const sql = `
      WITH RECURSIVE impact(target_uri, depth) AS (
        -- Base case: files referencing symbols in the starting uri
        SELECT DISTINCT r.uri, 1
        FROM references r
        JOIN symbols s ON r.symbol_name = s.name
        WHERE s.uri = ? AND s.is_definition = 1
        
        UNION
        
        -- Recursive step: files referencing symbols in already impacted files
        SELECT DISTINCT r.uri, i.depth + 1
        FROM references r
        JOIN symbols s ON r.symbol_name = s.name
        JOIN impact i ON s.uri = i.target_uri
        WHERE s.is_definition = 1 AND i.depth < ?
      )
      SELECT DISTINCT target_uri FROM impact WHERE target_uri != ?
    `;
    
    try {
      const rows = this.db!.prepare(sql).all(uri, maxDepth, uri) as any[];
      return rows.map(r => r.target_uri);
    } catch (error: any) {
      console.error(`[NativeSqliteStorage] Impact analysis failed: ${error.message}`);
      return [];
    }
  }

  async findNgRxActionGroups(): Promise<Array<{ uri: string; symbol: IndexedSymbol }>> {
    this.ensureInitialized();
    const rows = this.db!.prepare(`
      SELECT * 
      FROM symbols 
      WHERE ngrx_metadata IS NOT NULL 
        AND (ngrx_metadata LIKE '%"type":"actionGroup"%' OR ngrx_metadata LIKE '%"type":"action"%')
    `).all() as any[];
    
    return rows.map(r => ({
      uri: r.uri,
      symbol: this.mapSymbol(r)
    }));
  }

  async clear(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    if (fs.existsSync(this.dbPath)) {
      fs.unlinkSync(this.dbPath);
    }
    const wal = `${this.dbPath}-wal`;
    const shm = `${this.dbPath}-shm`;
    if (fs.existsSync(wal)) {
      fs.unlinkSync(wal);
    }
    if (fs.existsSync(shm)) {
      fs.unlinkSync(shm);
    }
    
    this.isInitialized = false;
  }

  async flush(): Promise<void> {
    if (this.db) {
       this.db.pragma('wal_checkpoint(TRUNCATE)');
    }
  }

  async setAutoSaveDelay(_delay: number): Promise<void> {
    // No-op
  }

  async selfHeal(): Promise<void> {
    await this.clear();
  }
}
