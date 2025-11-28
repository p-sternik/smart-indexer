import { ISymbolIndex } from './ISymbolIndex.js';
import { IndexedSymbol, IndexedReference, ImportInfo, ReExportInfo } from '../types.js';
import { DynamicIndex } from './dynamicIndex.js';
import { BackgroundIndex } from './backgroundIndex.js';
import { rankSymbols, RankingContext } from '../utils/fuzzySearch.js';

/**
 * MergedIndex - Combines multiple indices with prioritization.
 * Inspired by clangd's MergeIndex.
 * 
 * This index:
 * - Queries dynamic index first (open files have priority)
 * - Falls back to background index for other files
 * - Falls back to static index for pre-indexed symbols
 * - Deduplicates results across indices
 * - Provides a unified view to LSP handlers
 */
export class MergedIndex implements ISymbolIndex {
  private dynamicIndex: DynamicIndex;
  private backgroundIndex: BackgroundIndex;
  private staticIndex?: ISymbolIndex;

  constructor(dynamicIndex: DynamicIndex, backgroundIndex: BackgroundIndex, staticIndex?: ISymbolIndex) {
    this.dynamicIndex = dynamicIndex;
    this.backgroundIndex = backgroundIndex;
    this.staticIndex = staticIndex;
  }

  setStaticIndex(staticIndex: ISymbolIndex | undefined): void {
    this.staticIndex = staticIndex;
  }

  async findDefinitions(name: string): Promise<IndexedSymbol[]> {
    const dynamicResults = await this.dynamicIndex.findDefinitions(name);
    const backgroundResults = await this.backgroundIndex.findDefinitions(name);
    const staticResults = this.staticIndex ? await this.staticIndex.findDefinitions(name) : [];

    return this.mergeResults(dynamicResults, backgroundResults, staticResults);
  }

  async findDefinitionById(symbolId: string): Promise<IndexedSymbol | null> {
    // Check dynamic index first
    const dynamicResult = await this.dynamicIndex.findDefinitionById(symbolId);
    if (dynamicResult) {
      return dynamicResult;
    }

    // Fall back to background index
    const backgroundResult = await this.backgroundIndex.findDefinitionById(symbolId);
    if (backgroundResult) {
      return backgroundResult;
    }

    // Finally check static index
    if (this.staticIndex) {
      return this.staticIndex.findDefinitionById(symbolId);
    }

    return null;
  }

  async findReferences(name: string): Promise<IndexedSymbol[]> {
    const dynamicResults = await this.dynamicIndex.findReferences(name);
    const backgroundResults = await this.backgroundIndex.findReferences(name);
    const staticResults = this.staticIndex ? await this.staticIndex.findReferences(name) : [];

    return this.mergeResults(dynamicResults, backgroundResults, staticResults);
  }

  async findReferencesById(symbolId: string): Promise<IndexedSymbol[]> {
    const dynamicResults = await this.dynamicIndex.findReferencesById(symbolId);
    const backgroundResults = await this.backgroundIndex.findReferencesById(symbolId);
    const staticResults = this.staticIndex ? await this.staticIndex.findReferencesById(symbolId) : [];

    return this.mergeResults(dynamicResults, backgroundResults, staticResults);
  }

  async searchSymbols(query: string, limit: number, context?: RankingContext): Promise<IndexedSymbol[]> {
    // Get from all indices without limit initially
    // For performance, we'll process in batches to avoid blocking event loop
    const allResults: IndexedSymbol[] = [];
    
    // Collect results from all indices
    const [dynamicResults, backgroundResults, staticResults] = await Promise.all([
      this.dynamicIndex.searchSymbols(query, Number.MAX_SAFE_INTEGER),
      this.backgroundIndex.searchSymbols(query, Number.MAX_SAFE_INTEGER),
      this.staticIndex 
        ? this.staticIndex.searchSymbols(query, Number.MAX_SAFE_INTEGER)
        : Promise.resolve([])
    ]);

    // Merge all results (deduplicate)
    const merged = this.mergeResults(dynamicResults, backgroundResults, staticResults);

    // Apply fuzzy ranking with batching for large result sets
    const ranked = await this.rankSymbolsWithBatching(merged, query, context, limit);

    // Return top N results
    return ranked.slice(0, limit).map(r => r.symbol);
  }

  /**
   * Rank symbols in batches to avoid blocking the event loop for large result sets.
   * Yields control between batches using setImmediate.
   */
  private async rankSymbolsWithBatching(
    symbols: IndexedSymbol[],
    query: string,
    context: RankingContext | undefined,
    limit: number
  ): Promise<Array<{ symbol: IndexedSymbol; score: number; matches: number[] }>> {
    const BATCH_SIZE = 1000;
    
    // For small result sets, use synchronous ranking
    if (symbols.length <= BATCH_SIZE) {
      return rankSymbols(symbols, query, context);
    }

    // For large result sets, process in batches
    const allRanked: Array<{ symbol: IndexedSymbol; score: number; matches: number[] }> = [];
    
    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
      const batch = symbols.slice(i, i + BATCH_SIZE);
      const rankedBatch = rankSymbols(batch, query, context);
      allRanked.push(...rankedBatch);
      
      // Yield to event loop after each batch (except the last one)
      if (i + BATCH_SIZE < symbols.length) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    // Sort all results by score
    allRanked.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.symbol.name.localeCompare(b.symbol.name);
    });

    return allRanked;
  }

  async getFileSymbols(uri: string): Promise<IndexedSymbol[]> {
    // Check dynamic index first (open files)
    const dynamicSymbols = await this.dynamicIndex.getFileSymbols(uri);
    if (dynamicSymbols.length > 0) {
      return dynamicSymbols;
    }

    // Fall back to background index
    const backgroundSymbols = await this.backgroundIndex.getFileSymbols(uri);
    if (backgroundSymbols.length > 0) {
      return backgroundSymbols;
    }

    // Finally check static index
    if (this.staticIndex) {
      return this.staticIndex.getFileSymbols(uri);
    }

    return [];
  }

  /**
   * Find all references to a symbol by name (actual usages).
   * Optionally filters out the definition location to avoid showing the declaration as a reference.
   */
  async findReferencesByName(name: string, definitionLocations?: Array<{ uri: string; line: number; character: number }>): Promise<IndexedReference[]> {
    const dynamicRefs = await this.dynamicIndex.findReferencesByName(name);
    const backgroundRefs = await this.backgroundIndex.findReferencesByName(name);
    
    let merged = this.mergeReferences(dynamicRefs, backgroundRefs);
    
    // Filter out definition locations if provided (prevents self-references)
    if (definitionLocations && definitionLocations.length > 0) {
      const defLocationKeys = new Set(
        definitionLocations.map(loc => `${loc.uri}:${loc.line}:${loc.character}`)
      );
      merged = merged.filter(ref => {
        const refKey = `${ref.location.uri}:${ref.location.line}:${ref.location.character}`;
        return !defLocationKeys.has(refKey);
      });
    }
    
    return merged;
  }

  /**
   * Get import info for a file (for import resolution).
   */
  async getFileImports(uri: string): Promise<ImportInfo[]> {
    // Check dynamic index first (open files)
    const dynamicImports = await this.dynamicIndex.getFileImports(uri);
    if (dynamicImports.length > 0) {
      return dynamicImports;
    }

    // Fall back to background index
    return this.backgroundIndex.getFileImports(uri);
  }

  /**
   * Get re-export info for a file (for barrel file resolution).
   */
  async getFileReExports(uri: string): Promise<ReExportInfo[]> {
    // Check dynamic index first (open files)
    const dynamicReExports = await this.dynamicIndex.getFileReExports(uri);
    if (dynamicReExports.length > 0) {
      return dynamicReExports;
    }

    // Fall back to background index
    return this.backgroundIndex.getFileReExports(uri);
  }

  /**
   * Merge and deduplicate symbol results from multiple indices.
   * Dynamic index results take priority over background, which takes priority over static.
   */
  private mergeResults(dynamicResults: IndexedSymbol[], backgroundResults: IndexedSymbol[], staticResults: IndexedSymbol[] = []): IndexedSymbol[] {
    const results: IndexedSymbol[] = [...dynamicResults];
    const seen = new Set<string>();

    // Add dynamic results to seen set
    for (const symbol of dynamicResults) {
      const key = this.makeSymbolKey(symbol);
      seen.add(key);
    }

    // Add background results that aren't already in dynamic index
    for (const symbol of backgroundResults) {
      const key = this.makeSymbolKey(symbol);
      if (!seen.has(key)) {
        results.push(symbol);
        seen.add(key);
      }
    }

    // Add static results that aren't already in dynamic or background index
    for (const symbol of staticResults) {
      const key = this.makeSymbolKey(symbol);
      if (!seen.has(key)) {
        results.push(symbol);
        seen.add(key);
      }
    }

    return results;
  }

  /**
   * Merge and deduplicate reference results.
   */
  private mergeReferences(dynamicRefs: IndexedReference[], backgroundRefs: IndexedReference[]): IndexedReference[] {
    const results: IndexedReference[] = [...dynamicRefs];
    const seen = new Set<string>();

    for (const ref of dynamicRefs) {
      const key = `${ref.symbolName}:${ref.location.uri}:${ref.location.line}:${ref.location.character}`;
      seen.add(key);
    }

    for (const ref of backgroundRefs) {
      const key = `${ref.symbolName}:${ref.location.uri}:${ref.location.line}:${ref.location.character}`;
      if (!seen.has(key)) {
        results.push(ref);
        seen.add(key);
      }
    }

    return results;
  }

  /**
   * Create a unique key for a symbol to detect duplicates.
   */
  private makeSymbolKey(symbol: IndexedSymbol): string {
    return `${symbol.name}:${symbol.location.uri}:${symbol.location.line}:${symbol.location.character}`;
  }
}
