/**
 * MockIndex - Test double for ISymbolIndex/MergedIndex.
 * 
 * Provides a simple in-memory implementation that can be populated
 * with test data for unit testing LSP handlers.
 */

import { ISymbolIndex } from '../../index/ISymbolIndex.js';
import { IndexedSymbol, IndexedReference, ImportInfo, ReExportInfo } from '../../types.js';

export class MockIndex implements ISymbolIndex {
  private symbols: Map<string, IndexedSymbol[]> = new Map();
  private symbolsById: Map<string, IndexedSymbol> = new Map();
  private references: Map<string, IndexedReference[]> = new Map();
  private fileSymbols: Map<string, IndexedSymbol[]> = new Map();
  private fileImports: Map<string, ImportInfo[]> = new Map();
  private fileReExports: Map<string, ReExportInfo[]> = new Map();

  /**
   * Add a symbol to the mock index.
   */
  addSymbol(symbol: IndexedSymbol): void {
    // Add to name-based lookup
    const existing = this.symbols.get(symbol.name);
    if (existing) {
      existing.push(symbol);
    } else {
      this.symbols.set(symbol.name, [symbol]);
    }

    // Add to ID-based lookup
    this.symbolsById.set(symbol.id, symbol);

    // Add to file-based lookup
    const fileSyms = this.fileSymbols.get(symbol.location.uri);
    if (fileSyms) {
      fileSyms.push(symbol);
    } else {
      this.fileSymbols.set(symbol.location.uri, [symbol]);
    }
  }

  /**
   * Add a reference to the mock index.
   */
  addReference(symbolName: string, reference: IndexedReference): void {
    const existing = this.references.get(symbolName);
    if (existing) {
      existing.push(reference);
    } else {
      this.references.set(symbolName, [reference]);
    }
  }

  /**
   * Add imports for a file.
   */
  addFileImports(uri: string, imports: ImportInfo[]): void {
    this.fileImports.set(uri, imports);
  }

  /**
   * Add re-exports for a file.
   */
  addFileReExports(uri: string, reExports: ReExportInfo[]): void {
    this.fileReExports.set(uri, reExports);
  }

  // ISymbolIndex implementation

  async findDefinitions(name: string): Promise<IndexedSymbol[]> {
    return this.symbols.get(name) || [];
  }

  async findDefinitionById(symbolId: string): Promise<IndexedSymbol | null> {
    return this.symbolsById.get(symbolId) || null;
  }

  async findReferences(name: string): Promise<IndexedSymbol[]> {
    // For simplicity, return definitions (real implementation is more complex)
    return this.symbols.get(name) || [];
  }

  async findReferencesById(symbolId: string): Promise<IndexedSymbol[]> {
    const symbol = this.symbolsById.get(symbolId);
    return symbol ? [symbol] : [];
  }

  async searchSymbols(query: string, limit: number): Promise<IndexedSymbol[]> {
    const results: IndexedSymbol[] = [];
    for (const [name, syms] of this.symbols) {
      if (name.toLowerCase().includes(query.toLowerCase())) {
        results.push(...syms);
        if (results.length >= limit) {
          break;
        }
      }
    }
    return results.slice(0, limit);
  }

  async getFileSymbols(uri: string): Promise<IndexedSymbol[]> {
    return this.fileSymbols.get(uri) || [];
  }

  async findReferencesByName(
    name: string,
    options?: { excludeLocal?: boolean; scopeId?: string }
  ): Promise<IndexedReference[]> {
    const refs = this.references.get(name) || [];
    if (!options) {
      return refs;
    }

    return refs.filter(ref => {
      if (options.excludeLocal && ref.isLocal) {
        return false;
      }
      if (options.scopeId && ref.scopeId !== options.scopeId) {
        return false;
      }
      return true;
    });
  }

  async getFileImports(uri: string): Promise<ImportInfo[]> {
    return this.fileImports.get(uri) || [];
  }

  async getFileReExports(uri: string): Promise<ReExportInfo[]> {
    return this.fileReExports.get(uri) || [];
  }

  /**
   * Clear all data from the mock index.
   */
  clear(): void {
    this.symbols.clear();
    this.symbolsById.clear();
    this.references.clear();
    this.fileSymbols.clear();
    this.fileImports.clear();
    this.fileReExports.clear();
  }
}

/**
 * Helper to create a test symbol with sensible defaults.
 */
export function createTestSymbol(overrides: Partial<IndexedSymbol>): IndexedSymbol {
  const defaults: IndexedSymbol = {
    id: `test-symbol-${Math.random()}`,
    name: 'testSymbol',
    kind: 'function',
    location: {
      uri: '/test/file.ts',
      line: 0,
      character: 0
    },
    range: {
      startLine: 0,
      startCharacter: 0,
      endLine: 0,
      endCharacter: 10
    },
    isDefinition: true
  };

  return { ...defaults, ...overrides };
}

/**
 * Helper to create a test reference with sensible defaults.
 */
export function createTestReference(overrides: Partial<IndexedReference>): IndexedReference {
  const defaults: IndexedReference = {
    symbolName: 'testSymbol',
    location: {
      uri: '/test/file.ts',
      line: 0,
      character: 0
    },
    range: {
      startLine: 0,
      startCharacter: 0,
      endLine: 0,
      endCharacter: 10
    },
    isLocal: false
  };

  return { ...defaults, ...overrides };
}
