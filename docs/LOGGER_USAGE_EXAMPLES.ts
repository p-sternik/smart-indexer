// Example: How to instrument SqlJsStorage with the new logger

// Add to SqlJsStorage.ts imports:
import { getLogger } from '../utils/Logger.js';

// In the class, add:
private logger = getLogger(); // Will use global logger instance

// Example 1: Measure FTS5 query performance
async findSymbols(query: string, limit: number): Promise<string[]> {
  this.ensureInitialized();

  return this.logger.measure(
    'SqlJsStorage',
    'FTS5: findSymbols',
    async () => {
      const results = this.db!.exec(
        `SELECT DISTINCT file_uri FROM symbols_fts 
         WHERE name MATCH ? 
         LIMIT ?`,
        [query, limit]
      );
      return results.length > 0 
        ? results[0].values.map(row => row[0] as string) 
        : [];
    },
    { query, limit }
  );
}

// Example 2: Log ENOENT/EBUSY errors with context
async clear(): Promise<void> {
  // ... existing close logic ...

  const filesToDelete = [
    this.dbPath,
    this.dbPath + '.tmp',
    this.dbPath + '-wal',
    this.dbPath + '-shm'
  ];

  for (const filePath of filesToDelete) {
    try {
      await fs.promises.unlink(filePath);
      this.logger.debug('SqlJsStorage', `Deleted: ${path.basename(filePath)}`);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist - this is OK
        this.logger.debug('SqlJsStorage', `File already gone: ${path.basename(filePath)}`);
      } else if (error.code === 'EBUSY') {
        // Windows file lock - this is the ENOENT we were debugging!
        this.logger.error(
          `[SqlJsStorage] File busy (Windows lock): ${path.basename(filePath)}`,
          { code: error.code, path: filePath },
          error
        );
      } else {
        // Other error - log but continue
        this.logger.warn(
          `[SqlJsStorage] Could not delete ${path.basename(filePath)}`,
          { code: error.code },
          error
        );
      }
    }
  }
}

// Example 3: Measure database operations
async saveFileData(uri: string, data: FileIndexData): Promise<void> {
  return this.logger.measure(
    'SqlJsStorage',
    'DB: saveFileData',
    async () => {
      const normalizedUri = this.normalizeUri(uri);
      const jsonData = JSON.stringify(data);
      const updatedAt = Date.now();

      this.db!.run(
        `INSERT OR REPLACE INTO files (uri, json_data, updated_at) 
         VALUES (?, ?, ?)`,
        [normalizedUri, jsonData, updatedAt]
      );

      this.isDirty = true;
      this.scheduledAutoSave();
    },
    { 
      uri: normalizedUri, 
      symbols: data.symbols.length,
      size: new Blob([JSON.stringify(data)]).size 
    }
  );
}

// Output in VS Code console:
// [18:06:01] [PERF ] [SqlJsStorage] FTS5: findSymbols (12.45ms)

// Output in .smart-index/logs/server-2025-12-09.log:
// {"timestamp":"2025-12-09T18:06:01.234Z","level":"PERF","message":"[SqlJsStorage] FTS5: findSymbols","duration":12.45,"metadata":{"query":"User*","limit":100}}
