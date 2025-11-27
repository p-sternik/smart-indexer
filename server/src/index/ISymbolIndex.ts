import { IndexedSymbol, ReExportInfo, IndexedReference, ImportInfo } from '../types.js';

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
   * Find a specific symbol by its unique ID.
   */
  findDefinitionById(symbolId: string): Promise<IndexedSymbol | null>;

  /**
   * Find all references to a symbol name.
   * For simplicity, this returns the same as findDefinitions.
   */
  findReferences(name: string): Promise<IndexedSymbol[]>;

  /**
   * Find all references to a specific symbol by ID.
   */
  findReferencesById(symbolId: string): Promise<IndexedSymbol[]>;

  /**
   * Search for symbols matching a query (prefix search).
   */
  searchSymbols(query: string, limit: number): Promise<IndexedSymbol[]>;

  /**
   * Get all symbols defined in a specific file.
   */
  getFileSymbols(uri: string): Promise<IndexedSymbol[]>;

  /**
   * Get all re-exports from a specific file (for barrel file resolution).
   */
  getFileReExports?(uri: string): Promise<ReExportInfo[]>;

  /**
   * Find all references by name (actual usages).
   */
  findReferencesByName?(name: string): Promise<IndexedReference[]>;

  /**
   * Get import info for a file.
   */
  getFileImports?(uri: string): Promise<ImportInfo[]>;
}
