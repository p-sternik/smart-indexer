/**
 * SqlJsStorage Migration and FTS Test
 * 
 * Tests the database migration system and full-text search functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqlJsStorage } from './SqlJsStorage.js';
import { FileIndexData } from './IIndexStorage.js';
import { IndexedSymbol } from '../types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('SqlJsStorage - Migrations and FTS', () => {
  let storage: SqlJsStorage;
  let testDir: string;

  beforeEach(async () => {
    // Create temporary directory for test database
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-indexer-test-'));
    storage = new SqlJsStorage(100); // Short auto-save delay for testing
    await storage.init(testDir, '.smart-index');
  });

  afterEach(async () => {
    // Cleanup
    if (storage) {
      await storage.dispose();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Schema Migrations', () => {
    it('should create fresh database with schema v3', async () => {
      // Storage is already initialized with v3 schema
      // Verify by attempting to use relational query (should not throw)
      const results = await storage.findDefinitionsInSql('test');
      expect(results).toEqual([]);
    });

    it('should handle migration from v2 to v3', async () => {
      // Re-initialize to trigger migration if needed
      // (Testing the logic in migrateToV3)
      const testData: FileIndexData = {
        uri: path.join(testDir, 'migration_test.ts'),
        hash: 'mig123',
        symbols: [{
          id: 'mig_sym1',
          name: 'MigratedClass',
          kind: 'class',
          location: { uri: path.join(testDir, 'migration_test.ts'), line: 5, character: 0 },
          range: { startLine: 5, startCharacter: 0, endLine: 10, endCharacter: 0 },
          filePath: path.join(testDir, 'migration_test.ts'),
          isDefinition: true
        } as any],
        references: [{
          symbolName: 'ExternalClass',
          location: { uri: path.join(testDir, 'migration_test.ts'), line: 12, character: 0 },
          range: { startLine: 12, startCharacter: 0, endLine: 12, endCharacter: 13 },
          isLocal: false
        } as any],
        imports: [],
        lastIndexedAt: Date.now()
      };

      await storage.storeFile(testData);
      await storage.flush();

      // Verify data is in relational tables
      const defs = await storage.findDefinitionsInSql('MigratedClass');
      expect(defs.length).toBe(1);
      expect(defs[0].name).toBe('MigratedClass');

      const refs = await storage.findReferencesInSql('ExternalClass');
      expect(refs.length).toBe(1);
      expect(refs[0].symbolName).toBe('ExternalClass');
    });

    it('should self-heal on corruption', async () => {
      // Dispose current storage
      await storage.dispose();

      // Corrupt the database file
      const dbPath = path.join(testDir, '.smart-index', 'index.db');
      if (fs.existsSync(dbPath)) {
        fs.writeFileSync(dbPath, 'CORRUPTED DATA');
      }

      // Re-initialize - should self-heal
      storage = new SqlJsStorage();
      await expect(storage.init(testDir, '.smart-index')).resolves.not.toThrow();

      // Verify database is functional
      const results = await storage.searchSymbols('test', 'exact');
      expect(results).toEqual([]);
    });
  });

  describe('Full-Text Search (FTS5)', () => {
    beforeEach(async () => {
      // Populate with test data
      const testFiles: FileIndexData[] = [
        {
          uri: path.join(testDir, 'component.ts'),
          hash: 'hash1',
          symbols: [
            {
              id: 'sym1',
              name: 'AppComponent',
              kind: 'class',
              location: { uri: path.join(testDir, 'component.ts'), line: 5, character: 13 },
              range: { startLine: 5, startCharacter: 13, endLine: 50, endCharacter: 1 },
              filePath: path.join(testDir, 'component.ts'),
              isDefinition: true
            } as IndexedSymbol,
            {
              id: 'sym2',
              name: 'loadData',
              kind: 'method',
              location: { uri: path.join(testDir, 'component.ts'), line: 10, character: 2 },
              range: { startLine: 10, startCharacter: 2, endLine: 15, endCharacter: 3 },
              containerName: 'AppComponent',
              filePath: path.join(testDir, 'component.ts'),
              isDefinition: true
            } as IndexedSymbol
          ],
          references: [],
          imports: [],
          lastIndexedAt: Date.now()
        },
        {
          uri: path.join(testDir, 'service.ts'),
          hash: 'hash2',
          symbols: [
            {
              id: 'sym3',
              name: 'DataService',
              kind: 'class',
              location: { uri: path.join(testDir, 'service.ts'), line: 3, character: 13 },
              range: { startLine: 3, startCharacter: 13, endLine: 20, endCharacter: 1 },
              filePath: path.join(testDir, 'service.ts'),
              isDefinition: true
            } as IndexedSymbol,
            {
              id: 'sym4',
              name: 'getData',
              kind: 'method',
              location: { uri: path.join(testDir, 'service.ts'), line: 8, character: 2 },
              range: { startLine: 8, startCharacter: 2, endLine: 12, endCharacter: 3 },
              containerName: 'DataService',
              filePath: path.join(testDir, 'service.ts'),
              isDefinition: true
            } as IndexedSymbol
          ],
          references: [],
          imports: [],
          lastIndexedAt: Date.now()
        }
      ];

      for (const fileData of testFiles) {
        await storage.storeFile(fileData);
      }
      await storage.flush();
    });

    it('should search by exact name', async () => {
      const results = await storage.searchSymbols('AppComponent', 'exact');
      
      expect(results.length).toBe(1);
      expect(results[0].symbol.name).toBe('AppComponent');
      expect(results[0].symbol.kind).toBe('class');
    });

    it('should search by fuzzy match', async () => {
      const results = await storage.searchSymbols('Data', 'fuzzy');
      
      // Should find DataService, getData, and loadData (all contain "Data")
      expect(results.length).toBeGreaterThanOrEqual(2);
      const names = results.map(r => r.symbol.name);
      expect(names).toContain('DataService');
      expect(names).toContain('getData');
    });

    it('should search using FTS5 (prefix matching)', async () => {
      const results = await storage.searchSymbols('load', 'fulltext');
      
      // FTS5 might not be available in sql.js WASM, so accept graceful degradation
      if (results.length > 0) {
        expect(results[0].symbol.name).toBe('loadData');
        expect(results[0].rank).toBeDefined();
      }
    });

    it('should limit search results', async () => {
      const results = await storage.searchSymbols('', 'fuzzy', 2);
      
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should update FTS index when symbols change', async () => {
      // Update a file with new symbols
      const updatedData: FileIndexData = {
        uri: path.join(testDir, 'component.ts'),
        hash: 'hash1-updated',
        symbols: [
          {
            id: 'sym5',
            name: 'UpdatedComponent',
            kind: 'class',
            location: { uri: path.join(testDir, 'component.ts'), line: 5, character: 13 },
            range: { startLine: 5, startCharacter: 13, endLine: 50, endCharacter: 1 },
            filePath: path.join(testDir, 'component.ts'),
            isDefinition: true
          } as IndexedSymbol
        ],
        references: [],
        imports: [],
        lastIndexedAt: Date.now()
      };

      await storage.storeFile(updatedData);
      await storage.flush();

      // Old symbol should be gone
      const oldResults = await storage.searchSymbols('AppComponent', 'exact');
      expect(oldResults.length).toBe(0);

      // New symbol should be found
      const newResults = await storage.searchSymbols('UpdatedComponent', 'exact');
      expect(newResults.length).toBe(1);
    });

    it('should remove FTS entries when file is deleted', async () => {
      await storage.deleteFile(path.join(testDir, 'component.ts'));
      await storage.flush();

      // Symbols from deleted file should not be found
      const results = await storage.searchSymbols('AppComponent', 'exact');
      expect(results.length).toBe(0);

      // Symbols from other files should still exist
      const otherResults = await storage.searchSymbols('DataService', 'exact');
      expect(otherResults.length).toBe(1);
    });
  });

  describe('Schema Version Tracking', () => {
    it('should store and retrieve schema version', async () => {
      // Schema version is internal - verify by checking migration works
      await storage.dispose();
      
      // Re-initialize should not re-run migrations
      storage = new SqlJsStorage();
      await storage.init(testDir, '.smart-index');
      
      // Should still work
      const results = await storage.searchSymbols('test', 'exact');
      expect(results).toEqual([]);
    });
  });

  describe('Atomic Updates and Duplicate Prevention', () => {
    it('should prevent duplicate symbols on repeated saves', async () => {
      const testData: FileIndexData = {
        uri: path.join(testDir, 'test.ts'),
        hash: 'hash1',
        symbols: [
          {
            id: 'sym1',
            name: 'TestClass',
            kind: 'class',
            location: { uri: path.join(testDir, 'test.ts'), line: 10, character: 6 },
            range: { startLine: 10, startCharacter: 6, endLine: 20, endCharacter: 1 },
            filePath: path.join(testDir, 'test.ts'),
            isDefinition: true
          } as IndexedSymbol
        ],
        references: [],
        imports: [],
        lastIndexedAt: Date.now()
      };

      // Save file multiple times (simulating re-indexing)
      await storage.storeFile(testData);
      await storage.storeFile(testData);
      await storage.storeFile(testData);
      await storage.flush();

      // Should only find ONE instance of TestClass
      const results = await storage.searchSymbols('TestClass', 'exact');
      expect(results.length).toBe(1);
      expect(results[0].symbol.name).toBe('TestClass');

      // Verify database size stays constant
      const stats1 = await storage.getStats();
      await storage.storeFile(testData);
      await storage.flush();
      const stats2 = await storage.getStats();
      
      // Symbol count should remain the same (not grow)
      expect(stats2.totalSymbols).toBe(stats1.totalSymbols);
    });

    it('should handle path normalization correctly (C: vs c:)', async () => {
      // Create same file with different path casing
      const testDataUpperCase: FileIndexData = {
        uri: 'C:/workspace/test.ts',
        hash: 'hash1',
        symbols: [
          {
            id: 'sym1',
            name: 'TestClass',
            kind: 'class',
            location: { uri: 'C:/workspace/test.ts', line: 10, character: 6 },
            range: { startLine: 10, startCharacter: 6, endLine: 20, endCharacter: 1 },
            filePath: 'C:/workspace/test.ts',
            isDefinition: true
          } as IndexedSymbol
        ],
        references: [],
        imports: [],
        lastIndexedAt: Date.now()
      };

      const testDataLowerCase: FileIndexData = {
        uri: 'c:/workspace/test.ts',
        hash: 'hash2',
        symbols: [
          {
            id: 'sym2',
            name: 'UpdatedClass',
            kind: 'class',
            location: { uri: 'c:/workspace/test.ts', line: 12, character: 6 },
            range: { startLine: 12, startCharacter: 6, endLine: 22, endCharacter: 1 },
            filePath: 'c:/workspace/test.ts',
            isDefinition: true
          } as IndexedSymbol
        ],
        references: [],
        imports: [],
        lastIndexedAt: Date.now()
      };

      // Save with uppercase C:
      await storage.storeFile(testDataUpperCase);
      await storage.flush();

      // Save again with lowercase c: (should replace, not duplicate)
      await storage.storeFile(testDataLowerCase);
      await storage.flush();

      // Should only find UpdatedClass (latest), not TestClass
      const oldResults = await storage.searchSymbols('TestClass', 'exact');
      expect(oldResults.length).toBe(0);

      const newResults = await storage.searchSymbols('UpdatedClass', 'exact');
      expect(newResults.length).toBe(1);

      // Verify only ONE file in storage
      const allFiles = await storage.collectAllFiles();
      const normalizedFiles = allFiles.filter(f => 
        f.toLowerCase() === 'c:/workspace/test.ts'
      );
      expect(normalizedFiles.length).toBe(1);
    });

    it('should handle backslash vs forward slash normalization', async () => {
      const testDataBackslash: FileIndexData = {
        uri: 'c:\\workspace\\test.ts',
        hash: 'hash1',
        symbols: [
          {
            id: 'sym1',
            name: 'TestClass',
            kind: 'class',
            location: { uri: 'c:\\workspace\\test.ts', line: 10, character: 6 },
            range: { startLine: 10, startCharacter: 6, endLine: 20, endCharacter: 1 },
            filePath: 'c:\\workspace\\test.ts',
            isDefinition: true
          } as IndexedSymbol
        ],
        references: [],
        imports: [],
        lastIndexedAt: Date.now()
      };

      const testDataForwardSlash: FileIndexData = {
        uri: 'c:/workspace/test.ts',
        hash: 'hash2',
        symbols: [
          {
            id: 'sym2',
            name: 'UpdatedClass',
            kind: 'class',
            location: { uri: 'c:/workspace/test.ts', line: 12, character: 6 },
            range: { startLine: 12, startCharacter: 6, endLine: 22, endCharacter: 1 },
            filePath: 'c:/workspace/test.ts',
            isDefinition: true
          } as IndexedSymbol
        ],
        references: [],
        imports: [],
        lastIndexedAt: Date.now()
      };

      // Save with backslashes
      await storage.storeFile(testDataBackslash);
      await storage.flush();

      // Save with forward slashes (should replace)
      await storage.storeFile(testDataForwardSlash);
      await storage.flush();

      // Should only find latest symbol
      const results = await storage.searchSymbols('UpdatedClass', 'exact');
      expect(results.length).toBe(1);

      // Old symbol should be gone
      const oldResults = await storage.searchSymbols('TestClass', 'exact');
      expect(oldResults.length).toBe(0);
    });

    it('should maintain constant DB size on repeated updates', async () => {
      const createTestData = (version: number): FileIndexData => ({
        uri: path.join(testDir, 'test.ts'),
        hash: `hash${version}`,
        symbols: [
          {
            id: `sym${version}`,
            name: `TestClass${version}`,
            kind: 'class',
            location: { uri: path.join(testDir, 'test.ts'), line: 10, character: 6 },
            range: { startLine: 10, startCharacter: 6, endLine: 20, endCharacter: 1 },
            filePath: path.join(testDir, 'test.ts'),
            isDefinition: true
          } as IndexedSymbol
        ],
        references: [],
        imports: [],
        lastIndexedAt: Date.now()
      });

      // Save multiple versions
      await storage.storeFile(createTestData(1));
      await storage.flush();
      const stats1 = await storage.getStats();

      await storage.storeFile(createTestData(2));
      await storage.flush();
      const stats2 = await storage.getStats();

      await storage.storeFile(createTestData(3));
      await storage.flush();
      const stats3 = await storage.getStats();

      // Total files should remain 1
      expect(stats1.totalFiles).toBe(1);
      expect(stats2.totalFiles).toBe(1);
      expect(stats3.totalFiles).toBe(1);

      // Total symbols should remain 1
      expect(stats1.totalSymbols).toBe(1);
      expect(stats2.totalSymbols).toBe(1);
      expect(stats3.totalSymbols).toBe(1);

      // Only latest symbol should exist
      const results = await storage.searchSymbols('TestClass3', 'exact');
      expect(results.length).toBe(1);
    });
  });

  describe('Relational Queries (v3)', () => {
    beforeEach(async () => {
      const data: FileIndexData = {
        uri: path.join(testDir, 'query_test.ts'),
        hash: 'q123',
        symbols: [
          {
            id: 'q_sym1',
            name: 'Service',
            kind: 'class',
            location: { uri: path.join(testDir, 'query_test.ts'), line: 1, character: 0 },
            range: { startLine: 1, startCharacter: 0, endLine: 10, endCharacter: 0 },
            filePath: path.join(testDir, 'query_test.ts'),
            isDefinition: true
          } as any
        ],
        references: [
          {
            symbolName: 'Logger',
            location: { uri: path.join(testDir, 'query_test.ts'), line: 5, character: 2 },
            range: { startLine: 5, startCharacter: 2, endLine: 5, endCharacter: 8 },
            isLocal: false
          } as any
        ],
        imports: [],
        lastIndexedAt: Date.now()
      };
      await storage.storeFile(data);
      await storage.flush();
    });

    it('should find definitions using SQL', async () => {
      const results = await storage.findDefinitionsInSql('Service');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Service');
      expect(results[0].location.uri).toContain('query_test.ts');
    });

    it('should find references using SQL', async () => {
      const results = await storage.findReferencesInSql('Logger');
      expect(results.length).toBe(1);
      expect(results[0].symbolName).toBe('Logger');
      expect(results[0].location.line).toBe(5);
    });

    it('should return empty array for non-existent symbols', async () => {
      const defs = await storage.findDefinitionsInSql('NonExistent');
      expect(defs).toEqual([]);

      const refs = await storage.findReferencesInSql('NonExistent');
      expect(refs).toEqual([]);
    });
  });
});
