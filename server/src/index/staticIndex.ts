import { ISymbolIndex } from './ISymbolIndex.js';
import { IndexedSymbol } from '../types.js';
import { fuzzyScore } from '../utils/fuzzySearch.js';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

/**
 * Static index loaded from pre-generated JSON snapshots.
 * Provides read-only access to symbols.
 */
export class StaticIndex implements ISymbolIndex {
  private symbols: IndexedSymbol[] = [];
  private symbolNameIndex: Map<string, IndexedSymbol[]> = new Map();
  private symbolIdIndex: Map<string, IndexedSymbol> = new Map();
  private fileIndex: Map<string, IndexedSymbol[]> = new Map();
  private isLoaded: boolean = false;

  /**
   * Load static index from a JSON file or directory
   */
  async load(indexPath: string): Promise<void> {
    try {
      let stat;
      try {
        stat = await fsPromises.stat(indexPath);
      } catch (err: any) {
        throw new Error(`Static index path not found: ${indexPath}`);
      }
      
      if (stat.isDirectory()) {
        await this.loadFromDirectory(indexPath);
      } else {
        await this.loadFromFile(indexPath);
      }

      this.buildIndices();
      this.isLoaded = true;
    } catch (error) {
      console.error(`[StaticIndex] Error loading index: ${error}`);
      throw error;
    }
  }

  private async loadFromFile(filePath: string): Promise<void> {
    const content = await fsPromises.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);

    if (Array.isArray(data.symbols)) {
      this.symbols = data.symbols;
    } else if (Array.isArray(data)) {
      this.symbols = data;
    } else {
      throw new Error('Invalid static index format: expected symbols array');
    }
  }

  private async loadFromDirectory(dirPath: string): Promise<void> {
    const files = await fsPromises.readdir(dirPath);
    
    // Process files in parallel for better performance
    const loadPromises = files
      .filter(file => file.endsWith('.json'))
      .map(async (file) => {
        const filePath = path.join(dirPath, file);
        try {
          const content = await fsPromises.readFile(filePath, 'utf-8');
          const data = JSON.parse(content);
          
          if (Array.isArray(data.symbols)) {
            return data.symbols;
          } else if (Array.isArray(data)) {
            return data;
          }
          return [];
        } catch (error) {
          console.error(`[StaticIndex] Error loading ${filePath}: ${error}`);
          return [];
        }
      });

    const results = await Promise.all(loadPromises);
    for (const symbols of results) {
      this.symbols.push(...symbols);
    }
  }

  private buildIndices(): void {
    this.symbolNameIndex.clear();
    this.symbolIdIndex.clear();
    this.fileIndex.clear();

    for (const symbol of this.symbols) {
      // Build name index
      let nameList = this.symbolNameIndex.get(symbol.name);
      if (!nameList) {
        nameList = [];
        this.symbolNameIndex.set(symbol.name, nameList);
      }
      nameList.push(symbol);

      // Build ID index
      this.symbolIdIndex.set(symbol.id, symbol);

      // Build file index
      let fileList = this.fileIndex.get(symbol.location.uri);
      if (!fileList) {
        fileList = [];
        this.fileIndex.set(symbol.location.uri, fileList);
      }
      fileList.push(symbol);
    }
  }

  async findDefinitions(name: string): Promise<IndexedSymbol[]> {
    return this.symbolNameIndex.get(name) || [];
  }

  async findDefinitionById(symbolId: string): Promise<IndexedSymbol | null> {
    return this.symbolIdIndex.get(symbolId) || null;
  }

  async findReferences(name: string): Promise<IndexedSymbol[]> {
    return this.symbolNameIndex.get(name) || [];
  }

  async findReferencesById(symbolId: string): Promise<IndexedSymbol[]> {
    const def = this.symbolIdIndex.get(symbolId);
    return def ? [def] : [];
  }

  async searchSymbols(query: string, limit: number): Promise<IndexedSymbol[]> {
    const results: IndexedSymbol[] = [];
    const seen = new Set<string>();

    // Use fuzzy matching for consistent behavior across all indices
    for (const [name, symbols] of this.symbolNameIndex.entries()) {
      if (fuzzyScore(name, query)) {
        for (const symbol of symbols) {
          const key = `${symbol.name}:${symbol.location.uri}:${symbol.location.line}:${symbol.location.character}`;
          if (!seen.has(key)) {
            results.push(symbol);
            seen.add(key);
            if (results.length >= limit) {
              return results;
            }
          }
        }
      }
    }

    return results;
  }

  async getFileSymbols(uri: string): Promise<IndexedSymbol[]> {
    return this.fileIndex.get(uri) || [];
  }

  getStats(): { files: number; symbols: number } {
    return {
      files: this.fileIndex.size,
      symbols: this.symbols.length
    };
  }

  isIndexLoaded(): boolean {
    return this.isLoaded;
  }
}
