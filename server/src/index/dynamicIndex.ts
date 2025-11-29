import { ISymbolIndex } from './ISymbolIndex.js';
import { IndexedSymbol, IndexedFileResult, IndexedReference, ImportInfo, ReExportInfo } from '../types.js';
import { SymbolIndexer } from '../indexer/symbolIndexer.js';
import { LanguageRouter } from '../indexer/languageRouter.js';
import { fuzzyScore } from '../utils/fuzzySearch.js';
import * as crypto from 'crypto';

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
  private fileHashes: Map<string, string> = new Map(); // uri -> content hash for self-healing
  private symbolNameIndex: Map<string, Set<string>> = new Map(); // name -> Set of URIs (O(1) lookup)
  private fileToSymbolNames: Map<string, Set<string>> = new Map(); // uri -> Set of symbol names (reverse index for O(1) cleanup)
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
      // O(1) CLEANUP: Remove old symbols using reverse index before adding new ones
      const oldSymbolNames = this.fileToSymbolNames.get(uri);
      if (oldSymbolNames) {
        for (const name of oldSymbolNames) {
          const uriSet = this.symbolNameIndex.get(name);
          if (uriSet) {
            uriSet.delete(uri);
            if (uriSet.size === 0) {
              this.symbolNameIndex.delete(name);
            }
          }
        }
      }

      // Use language router if available, otherwise fall back to symbol indexer
      const indexer = this.languageRouter || this.symbolIndexer;
      const result = await indexer.indexFile(uri, content);
      this.fileSymbols.set(uri, result);

      // Update symbol name index and reverse index
      const newSymbolNames = new Set<string>();
      for (const symbol of result.symbols) {
        let uriSet = this.symbolNameIndex.get(symbol.name);
        if (!uriSet) {
          uriSet = new Set();
          this.symbolNameIndex.set(symbol.name, uriSet);
        }
        uriSet.add(uri);
        newSymbolNames.add(symbol.name);
      }
      this.fileToSymbolNames.set(uri, newSymbolNames);
      
      // Store content hash for self-healing validation
      if (content !== undefined) {
        const hash = crypto.createHash('md5').update(content).digest('hex');
        this.fileHashes.set(uri, hash);
      }
    } catch (error) {
      console.error(`[DynamicIndex] Error updating file ${uri}: ${error}`);
    }
  }

  /**
   * Remove a file from the dynamic index (e.g., when closed).
   */
  removeFile(uri: string): void {
    // O(1) CLEANUP: Remove symbols using reverse index
    const oldSymbolNames = this.fileToSymbolNames.get(uri);
    if (oldSymbolNames) {
      for (const name of oldSymbolNames) {
        const uriSet = this.symbolNameIndex.get(name);
        if (uriSet) {
          uriSet.delete(uri);
          if (uriSet.size === 0) {
            this.symbolNameIndex.delete(name);
          }
        }
      }
      this.fileToSymbolNames.delete(uri);
    }

    this.fileSymbols.delete(uri);
    this.fileHashes.delete(uri);
  }

  /**
   * Check if a file is in the dynamic index.
   */
  hasFile(uri: string): boolean {
    return this.fileSymbols.has(uri);
  }

  /**
   * Self-healing mechanism: Validate index consistency and repair if stale.
   * 
   * This is triggered on file open/change to ensure the index is always
   * consistent with the actual file content, even if file watchers missed events
   * (e.g., during rapid Git branch switching).
   * 
   * @param filePath - Absolute path to the file
   * @param content - Current file content
   * @returns true if repair was needed, false if index was already healthy
   */
  async validateAndRepair(filePath: string, content: string): Promise<boolean> {
    try {
      // Calculate hash of current content
      const currentHash = crypto.createHash('md5').update(content).digest('hex');
      const storedHash = this.fileHashes.get(filePath);

      // If hashes match, index is healthy - no repair needed
      if (storedHash === currentHash) {
        return false;
      }

      // Hash mismatch or missing - index is stale, trigger immediate re-parsing
      console.info(`[DynamicIndex] Self-healing: Hash mismatch for ${filePath}, repairing index`);

      // O(1) CLEANUP: Remove old symbols using reverse index before adding new ones
      const oldSymbolNames = this.fileToSymbolNames.get(filePath);
      if (oldSymbolNames) {
        for (const name of oldSymbolNames) {
          const uriSet = this.symbolNameIndex.get(name);
          if (uriSet) {
            uriSet.delete(filePath);
            if (uriSet.size === 0) {
              this.symbolNameIndex.delete(name);
            }
          }
        }
      }
      
      // Use the indexer directly for immediate, synchronous parsing (high priority)
      const indexer = this.languageRouter || this.symbolIndexer;
      const result = await indexer.indexFile(filePath, content);
      
      // Update the index with fresh symbols
      this.fileSymbols.set(filePath, result);
      this.fileHashes.set(filePath, currentHash);

      // Update symbol name index and reverse index
      const newSymbolNames = new Set<string>();
      for (const symbol of result.symbols) {
        let uriSet = this.symbolNameIndex.get(symbol.name);
        if (!uriSet) {
          uriSet = new Set();
          this.symbolNameIndex.set(symbol.name, uriSet);
        }
        uriSet.add(filePath);
        newSymbolNames.add(symbol.name);
      }
      this.fileToSymbolNames.set(filePath, newSymbolNames);

      console.info(`[DynamicIndex] Self-healing complete: ${result.symbols.length} symbols indexed for ${filePath}`);
      return true;
    } catch (error) {
      console.error(`[DynamicIndex] Self-healing error for ${filePath}: ${error}`);
      return false;
    }
  }

  async findDefinitions(name: string): Promise<IndexedSymbol[]> {
    const results: IndexedSymbol[] = [];
    
    // O(1) lookup using symbol name index
    const uriSet = this.symbolNameIndex.get(name);
    if (!uriSet) {
      return results;
    }

    // Only scan files that contain the symbol
    for (const uri of uriSet) {
      const fileResult = this.fileSymbols.get(uri);
      if (fileResult) {
        for (const symbol of fileResult.symbols) {
          if (symbol.name === name) {
            results.push(symbol);
          }
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
