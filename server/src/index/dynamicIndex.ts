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
  private symbolIdIndex: Map<string, IndexedSymbol> = new Map(); // symbolId -> IndexedSymbol (O(1) lookup by ID)
  private fileToSymbolIds: Map<string, Set<string>> = new Map(); // uri -> Set of symbolIds (reverse index for O(1) cleanup)
  
  // Reference tracking for O(1) findReferencesByName (mirrors BackgroundIndex)
  private referenceMap: Map<string, Set<string>> = new Map(); // symbolName -> Set of URIs containing references
  private fileToReferenceNames: Map<string, Set<string>> = new Map(); // uri -> Set of referenced symbol names (reverse index for O(1) cleanup)
  
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
      
      // O(1) CLEANUP: Remove old symbol IDs using reverse index
      const oldSymbolIds = this.fileToSymbolIds.get(uri);
      if (oldSymbolIds) {
        for (const id of oldSymbolIds) {
          this.symbolIdIndex.delete(id);
        }
      }

      // O(1) CLEANUP: Remove old references using reverse index
      const oldReferenceNames = this.fileToReferenceNames.get(uri);
      if (oldReferenceNames) {
        for (const symbolName of oldReferenceNames) {
          const uriSet = this.referenceMap.get(symbolName);
          if (uriSet) {
            uriSet.delete(uri);
            if (uriSet.size === 0) {
              this.referenceMap.delete(symbolName);
            }
          }
        }
      }

      // Use language router if available, otherwise fall back to symbol indexer
      const indexer = this.languageRouter || this.symbolIndexer;
      const result = await indexer.indexFile(uri, content);
      this.fileSymbols.set(uri, result);

      // Update symbol name index, ID index, and reverse indexes
      const newSymbolNames = new Set<string>();
      const newSymbolIds = new Set<string>();
      for (const symbol of result.symbols) {
        // Update name index
        let uriSet = this.symbolNameIndex.get(symbol.name);
        if (!uriSet) {
          uriSet = new Set();
          this.symbolNameIndex.set(symbol.name, uriSet);
        }
        uriSet.add(uri);
        newSymbolNames.add(symbol.name);
        
        // Update ID index for O(1) findDefinitionById
        this.symbolIdIndex.set(symbol.id, symbol);
        newSymbolIds.add(symbol.id);
      }
      this.fileToSymbolNames.set(uri, newSymbolNames);
      this.fileToSymbolIds.set(uri, newSymbolIds);
      
      // Update reference map and reverse index for O(1) findReferencesByName
      const newReferenceNames = new Set<string>();
      if (result.references) {
        for (const ref of result.references) {
          let refUriSet = this.referenceMap.get(ref.symbolName);
          if (!refUriSet) {
            refUriSet = new Set();
            this.referenceMap.set(ref.symbolName, refUriSet);
          }
          refUriSet.add(uri);
          newReferenceNames.add(ref.symbolName);
        }
      }
      this.fileToReferenceNames.set(uri, newReferenceNames);
      
      // Store content hash for self-healing validation
      if (content !== undefined) {
        const hash = crypto.createHash('md5').update(content).digest('hex');
        this.fileHashes.set(uri, hash);
      }
    } catch (error) {
      // Silent fail for dynamic index updates
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
    
    // O(1) CLEANUP: Remove symbol IDs using reverse index
    const oldSymbolIds = this.fileToSymbolIds.get(uri);
    if (oldSymbolIds) {
      for (const id of oldSymbolIds) {
        this.symbolIdIndex.delete(id);
      }
      this.fileToSymbolIds.delete(uri);
    }

    // O(1) CLEANUP: Remove references using reverse index
    const oldReferenceNames = this.fileToReferenceNames.get(uri);
    if (oldReferenceNames) {
      for (const symbolName of oldReferenceNames) {
        const uriSet = this.referenceMap.get(symbolName);
        if (uriSet) {
          uriSet.delete(uri);
          if (uriSet.size === 0) {
            this.referenceMap.delete(symbolName);
          }
        }
      }
      this.fileToReferenceNames.delete(uri);
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
      
      // O(1) CLEANUP: Remove old symbol IDs using reverse index
      const oldSymbolIds = this.fileToSymbolIds.get(filePath);
      if (oldSymbolIds) {
        for (const id of oldSymbolIds) {
          this.symbolIdIndex.delete(id);
        }
      }

      // O(1) CLEANUP: Remove old references using reverse index
      const oldReferenceNames = this.fileToReferenceNames.get(filePath);
      if (oldReferenceNames) {
        for (const symbolName of oldReferenceNames) {
          const uriSet = this.referenceMap.get(symbolName);
          if (uriSet) {
            uriSet.delete(filePath);
            if (uriSet.size === 0) {
              this.referenceMap.delete(symbolName);
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

      // Update symbol name index, ID index, and reverse indexes
      const newSymbolNames = new Set<string>();
      const newSymbolIds = new Set<string>();
      for (const symbol of result.symbols) {
        // Update name index
        let uriSet = this.symbolNameIndex.get(symbol.name);
        if (!uriSet) {
          uriSet = new Set();
          this.symbolNameIndex.set(symbol.name, uriSet);
        }
        uriSet.add(filePath);
        newSymbolNames.add(symbol.name);
        
        // Update ID index for O(1) findDefinitionById
        this.symbolIdIndex.set(symbol.id, symbol);
        newSymbolIds.add(symbol.id);
      }
      this.fileToSymbolNames.set(filePath, newSymbolNames);
      this.fileToSymbolIds.set(filePath, newSymbolIds);

      // Update reference map and reverse index for O(1) findReferencesByName
      const newReferenceNames = new Set<string>();
      if (result.references) {
        for (const ref of result.references) {
          let refUriSet = this.referenceMap.get(ref.symbolName);
          if (!refUriSet) {
            refUriSet = new Set();
            this.referenceMap.set(ref.symbolName, refUriSet);
          }
          refUriSet.add(filePath);
          newReferenceNames.add(ref.symbolName);
        }
      }
      this.fileToReferenceNames.set(filePath, newReferenceNames);

      console.info(`[DynamicIndex] Self-healing complete: ${result.symbols.length} symbols indexed for ${filePath}`);
      return true;
    } catch (error) {
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
    // O(1) lookup using symbol ID index (was O(N*M) scanning all files)
    return this.symbolIdIndex.get(symbolId) || null;
  }

  async findReferences(name: string): Promise<IndexedSymbol[]> {
    // Get actual reference locations using findReferencesByName
    const references = await this.findReferencesByName(name);
    
    if (references.length === 0) {
      return [];
    }
    
    // Collect unique URIs that contain references
    const urisWithReferences = new Set<string>();
    for (const ref of references) {
      urisWithReferences.add(ref.location.uri);
    }
    
    // Load symbols from files that contain references
    const results: IndexedSymbol[] = [];
    const seen = new Set<string>();
    
    for (const uri of urisWithReferences) {
      const fileResult = this.fileSymbols.get(uri);
      if (fileResult) {
        for (const symbol of fileResult.symbols) {
          // Return symbols that match the referenced name
          if (symbol.name === name) {
            const key = `${symbol.id}`;
            if (!seen.has(key)) {
              results.push(symbol);
              seen.add(key);
            }
          }
        }
      }
    }
    
    return results;
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

    // OPTIMIZATION: Use symbolNameIndex to filter candidate names first (O(K) where K = unique names)
    // instead of iterating over all symbols in all files (O(N*M))
    const candidateUris = new Set<string>();
    
    for (const [name, uriSet] of this.symbolNameIndex) {
      // Fast fuzzy filter on name only
      if (fuzzyScore(name, query)) {
        for (const uri of uriSet) {
          candidateUris.add(uri);
        }
      }
    }

    // Only scan candidate files for actual symbol objects
    for (const uri of candidateUris) {
      if (results.length >= limit) {
        break;
      }
      
      const fileResult = this.fileSymbols.get(uri);
      if (fileResult) {
        for (const symbol of fileResult.symbols) {
          // Use fuzzy matching on actual symbol
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
    }

    return results;
  }

  async getFileSymbols(uri: string): Promise<IndexedSymbol[]> {
    const fileResult = this.fileSymbols.get(uri);
    return fileResult ? fileResult.symbols : [];
  }

  /**
   * Find all references to a symbol by name.
   * OPTIMIZED: Uses referenceMap for O(1) lookup of candidate files instead of O(N) scan.
   */
  async findReferencesByName(name: string): Promise<IndexedReference[]> {
    const references: IndexedReference[] = [];
    
    // Use inverted index to find only files that contain references to this symbol
    const candidateUris = this.referenceMap.get(name);
    
    if (!candidateUris || candidateUris.size === 0) {
      return references; // Fast path: no references found
    }
    
    // Only load and scan files that are known to have references to this symbol
    for (const uri of candidateUris) {
      const fileResult = this.fileSymbols.get(uri);
      if (fileResult && fileResult.references) {
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
