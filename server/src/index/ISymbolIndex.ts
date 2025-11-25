import { IndexedSymbol } from '../types.js';

/**
 * Core interface for symbol indices.
 * Inspired by clangd's index abstraction.
 */
export interface ISymbolIndex {
  /**
   * Find all symbols with the given name.
   */
  findDefinitions(name: string): Promise<IndexedSymbol[]>;

  /**
   * Find all references to a symbol name.
   * For simplicity, this returns the same as findDefinitions.
   */
  findReferences(name: string): Promise<IndexedSymbol[]>;

  /**
   * Search for symbols matching a query (prefix search).
   */
  searchSymbols(query: string, limit: number): Promise<IndexedSymbol[]>;

  /**
   * Get all symbols defined in a specific file.
   */
  getFileSymbols(uri: string): Promise<IndexedSymbol[]>;
}
