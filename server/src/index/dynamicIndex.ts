import { ISymbolIndex } from './ISymbolIndex.js';
import { IndexedSymbol, IndexedFileResult, IndexedReference, ImportInfo, ReExportInfo } from '../types.js';
import { SymbolIndexer } from '../indexer/symbolIndexer.js';
import { LanguageRouter } from '../indexer/languageRouter.js';
import { fuzzyScore } from '../utils/fuzzySearch.js';

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
  private languageRouter: LanguageRouter | null = null;

  constructor(symbolIndexer: SymbolIndexer) {
    this.symbolIndexer = symbolIndexer;
  }

  /**
   * Set the language router for multi-language indexing
   */
  setLanguageRouter(router: LanguageRouter): void {
    this.languageRouter = router;
  }

  /**
   * Update the index for an open/changed file.
   */
  async updateFile(uri: string, content?: string): Promise<void> {
    try {
      // Use language router if available, otherwise fall back to symbol indexer
      const indexer = this.languageRouter || this.symbolIndexer;
      const result = await indexer.indexFile(uri, content);
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

  async findDefinitionById(symbolId: string): Promise<IndexedSymbol | null> {
    for (const [_, fileResult] of this.fileSymbols) {
      for (const symbol of fileResult.symbols) {
        if (symbol.id === symbolId) {
          return symbol;
        }
      }
    }
    return null;
  }

  async findReferences(name: string): Promise<IndexedSymbol[]> {
    return this.findDefinitions(name);
  }

  async findReferencesById(symbolId: string): Promise<IndexedSymbol[]> {
    // For now, return the definition itself
    // In a full implementation, this would return actual references
    const def = await this.findDefinitionById(symbolId);
    return def ? [def] : [];
  }

  async searchSymbols(query: string, limit: number): Promise<IndexedSymbol[]> {
    const results: IndexedSymbol[] = [];
    const seen = new Set<string>();

    for (const [_, fileResult] of this.fileSymbols) {
      for (const symbol of fileResult.symbols) {
        // Use fuzzy matching instead of startsWith
        const match = fuzzyScore(symbol.name, query);
        if (match) {
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
   * Find all references to a symbol by name.
   */
  async findReferencesByName(name: string): Promise<IndexedReference[]> {
    const references: IndexedReference[] = [];
    
    for (const [_, fileResult] of this.fileSymbols) {
      if (fileResult.references) {
        for (const ref of fileResult.references) {
          if (ref.symbolName === name) {
            references.push(ref);
          }
        }
      }
    }
    
    return references;
  }

  /**
   * Get import info for a file.
   */
  async getFileImports(uri: string): Promise<ImportInfo[]> {
    const fileResult = this.fileSymbols.get(uri);
    return fileResult?.imports || [];
  }

  /**
   * Get re-export info for a file (for barrel file resolution).
   */
  async getFileReExports(uri: string): Promise<ReExportInfo[]> {
    const fileResult = this.fileSymbols.get(uri);
    return fileResult?.reExports || [];
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
