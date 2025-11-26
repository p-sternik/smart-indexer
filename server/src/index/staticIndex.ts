import { ISymbolIndex } from './ISymbolIndex.js';
import { IndexedSymbol } from '../types.js';
import * as fs from 'fs';
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
      if (!fs.existsSync(indexPath)) {
        throw new Error(`Static index path not found: ${indexPath}`);
      }

      const stat = fs.statSync(indexPath);
      
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
    const content = fs.readFileSync(filePath, 'utf-8');
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
    const files = fs.readdirSync(dirPath);
    
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      
      const filePath = path.join(dirPath, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content);
        
        if (Array.isArray(data.symbols)) {
          this.symbols.push(...data.symbols);
        } else if (Array.isArray(data)) {
          this.symbols.push(...data);
        }
      } catch (error) {
        console.error(`[StaticIndex] Error loading ${filePath}: ${error}`);
      }
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
    const queryLower = query.toLowerCase();

    for (const [name, symbols] of this.symbolNameIndex.entries()) {
      if (name.toLowerCase().includes(queryLower)) {
        results.push(...symbols);
        if (results.length >= limit) {
          return results.slice(0, limit);
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
