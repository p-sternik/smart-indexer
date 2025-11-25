import { ISymbolIndex } from './ISymbolIndex.js';
import { IndexedSymbol } from '../types.js';

/**
 * MergedIndex - Combines multiple indices with prioritization.
 * Inspired by clangd's MergeIndex.
 * 
 * This index:
 * - Queries dynamic index first (open files have priority)
 * - Falls back to background index for other files
 * - Deduplicates results across indices
 * - Provides a unified view to LSP handlers
 */
export class MergedIndex implements ISymbolIndex {
  private dynamicIndex: ISymbolIndex;
  private backgroundIndex: ISymbolIndex;

  constructor(dynamicIndex: ISymbolIndex, backgroundIndex: ISymbolIndex) {
    this.dynamicIndex = dynamicIndex;
    this.backgroundIndex = backgroundIndex;
  }

  async findDefinitions(name: string): Promise<IndexedSymbol[]> {
    const dynamicResults = await this.dynamicIndex.findDefinitions(name);
    const backgroundResults = await this.backgroundIndex.findDefinitions(name);

    return this.mergeResults(dynamicResults, backgroundResults);
  }

  async findReferences(name: string): Promise<IndexedSymbol[]> {
    const dynamicResults = await this.dynamicIndex.findReferences(name);
    const backgroundResults = await this.backgroundIndex.findReferences(name);

    return this.mergeResults(dynamicResults, backgroundResults);
  }

  async searchSymbols(query: string, limit: number): Promise<IndexedSymbol[]> {
    // Get from both indices, dynamic has priority
    const dynamicResults = await this.dynamicIndex.searchSymbols(query, limit);
    const remainingLimit = limit - dynamicResults.length;

    if (remainingLimit <= 0) {
      return dynamicResults;
    }

    const backgroundResults = await this.backgroundIndex.searchSymbols(query, remainingLimit);
    return this.mergeResults(dynamicResults, backgroundResults);
  }

  async getFileSymbols(uri: string): Promise<IndexedSymbol[]> {
    // Check dynamic index first (open files)
    const dynamicSymbols = await this.dynamicIndex.getFileSymbols(uri);
    if (dynamicSymbols.length > 0) {
      return dynamicSymbols;
    }

    // Fall back to background index
    return this.backgroundIndex.getFileSymbols(uri);
  }

  /**
   * Merge and deduplicate symbol results.
   * Dynamic index results take priority over background index.
   */
  private mergeResults(dynamicResults: IndexedSymbol[], backgroundResults: IndexedSymbol[]): IndexedSymbol[] {
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

    return results;
  }

  /**
   * Create a unique key for a symbol to detect duplicates.
   */
  private makeSymbolKey(symbol: IndexedSymbol): string {
    return `${symbol.name}:${symbol.location.uri}:${symbol.location.line}:${symbol.location.character}`;
  }
}
