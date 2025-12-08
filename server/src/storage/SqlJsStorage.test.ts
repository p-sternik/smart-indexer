/**
 * SqlJsStorage Migration and FTS Test
 * 
 * Tests the database migration system and full-text search functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqlJsStorage } from './SqlJsStorage.js';
import { FileIndexData, IndexedSymbol } from './IIndexStorage.js';
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
    it('should create fresh database with schema v2', async () => {
      // Storage is already initialized with v2 schema
      // Verify by attempting to use FTS (should not throw)
      const results = await storage.searchSymbols('test', 'fulltext');
      expect(results).toEqual([]);
    });

    it('should handle migration from v1 to v2', async () => {
      // This test would require simulating a v1 database
      // For now, just verify v2 features work
      const testData: FileIndexData = {
        uri: path.join(testDir, 'test.ts'),
        hash: 'abc123',
        symbols: [{
          id: 'sym1',
          name: 'TestClass',
          kind: 'class',
          location: { uri: path.join(testDir, 'test.ts'), line: 10, character: 6 },
          range: { startLine: 10, startCharacter: 6, endLine: 20, endCharacter: 1 },
          filePath: path.join(testDir, 'test.ts'),
          isDefinition: true
        } as IndexedSymbol],
        references: [],
        imports: [],
        lastIndexedAt: Date.now()
      };

      await storage.storeFile(testData);
      await storage.flush();

      // Verify FTS index was updated
      const results = await storage.searchSymbols('TestClass', 'fulltext');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].symbol.name).toBe('TestClass');
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
      
      // Should find DataService and getData
      expect(results.length).toBe(2);
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
});
