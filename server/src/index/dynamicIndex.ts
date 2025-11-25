import { ISymbolIndex } from './ISymbolIndex.js';
import { IndexedSymbol, IndexedFileResult } from '../types.js';
import { SymbolIndexer } from '../indexer/symbolIndexer.js';

/**
 * DynamicIndex - In-memory index for currently open/edited files.
 * Inspired by clangd's dynamic index.
 * 
 * This index:
 * - Maintains symbols for all open files in memory
 * - Updates immediately on file changes
 * - Has priority over background index (open files are always fresh)
 */
export class DynamicIndex implements ISymbolIndex {
  private fileSymbols: Map<string, IndexedFileResult> = new Map();
  private symbolIndexer: SymbolIndexer;

  constructor(symbolIndexer: SymbolIndexer) {
    this.symbolIndexer = symbolIndexer;
  }

  /**
   * Update the index for an open/changed file.
   */
  async updateFile(uri: string, content?: string): Promise<void> {
    try {
      const result = await this.symbolIndexer.indexFile(uri, content);
      this.fileSymbols.set(uri, result);
    } catch (error) {
      console.error(`[DynamicIndex] Error updating file ${uri}: ${error}`);
    }
  }

  /**
   * Remove a file from the dynamic index (e.g., when closed).
   */
  removeFile(uri: string): void {
    this.fileSymbols.delete(uri);
  }

  /**
   * Check if a file is in the dynamic index.
   */
  hasFile(uri: string): boolean {
    return this.fileSymbols.has(uri);
  }

  async findDefinitions(name: string): Promise<IndexedSymbol[]> {
    const results: IndexedSymbol[] = [];

    for (const [_, fileResult] of this.fileSymbols) {
      for (const symbol of fileResult.symbols) {
        if (symbol.name === name) {
          results.push(symbol);
        }
      }
    }

    return results;
  }

  async findReferences(name: string): Promise<IndexedSymbol[]> {
    return this.findDefinitions(name);
  }

  async searchSymbols(query: string, limit: number): Promise<IndexedSymbol[]> {
    const results: IndexedSymbol[] = [];
    const seen = new Set<string>();

    for (const [_, fileResult] of this.fileSymbols) {
      for (const symbol of fileResult.symbols) {
        if (symbol.name.startsWith(query)) {
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
    const fileResult = this.fileSymbols.get(uri);
    return fileResult ? fileResult.symbols : [];
  }

  /**
   * Get all URIs currently in the dynamic index.
   */
  getIndexedFiles(): string[] {
    return Array.from(this.fileSymbols.keys());
  }

  /**
   * Get current size statistics.
   */
  getStats(): { files: number; symbols: number } {
    let totalSymbols = 0;
    for (const [_, fileResult] of this.fileSymbols) {
      totalSymbols += fileResult.symbols.length;
    }
    return {
      files: this.fileSymbols.size,
      symbols: totalSymbols
    };
  }
}
