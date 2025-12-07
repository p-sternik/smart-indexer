import { ImportResolver } from './importResolver.js';
import { ISymbolIndex } from '../index/ISymbolIndex.js';
import { IndexedSymbol, ReExportInfo } from '../types.js';

/**
 * Resolves re-export chains (barrel files) to find original symbol definitions.
 * 
 * Example:
 * // bar.ts
 * export class Foo {}
 * 
 * // index.ts
 * export * from './bar'
 * 
 * // usage.ts
 * import { Foo } from './index'  // Should resolve to bar.ts
 */
export class ReExportResolver {
  private importResolver: ImportResolver;
  private index: ISymbolIndex;
  private maxDepth: number = 5; // Prevent infinite loops

  constructor(importResolver: ImportResolver, index: ISymbolIndex) {
    this.importResolver = importResolver;
    this.index = index;
  }

  /**
   * Resolve a symbol through re-export chains.
   * 
   * @param symbolName - Name of the symbol to resolve
   * @param fromFile - File containing the import/re-export
   * @param reExports - Re-export information from the file
   * @returns Resolved symbol definition, or null if not found
   */
  async resolveReExport(
    symbolName: string,
    fromFile: string,
    reExports: ReExportInfo[]
  ): Promise<IndexedSymbol | null> {
    return this.resolveReExportRecursive(symbolName, fromFile, reExports, 0, new Set());
  }

  private async resolveReExportRecursive(
    symbolName: string,
    fromFile: string,
    reExports: ReExportInfo[],
    depth: number,
    visited: Set<string>
  ): Promise<IndexedSymbol | null> {
    // Prevent infinite loops and excessive depth
    if (depth >= this.maxDepth || visited.has(fromFile)) {
      return null;
    }
    visited.add(fromFile);

    for (const reExport of reExports) {
      // Check if this re-export includes the symbol we're looking for
      if (reExport.exportedNames && !reExport.exportedNames.includes(symbolName)) {
        continue; // This re-export doesn't include our symbol
      }

      // Resolve the module specifier
      const resolvedModule = await this.importResolver.resolveImport(
        reExport.moduleSpecifier,
        fromFile
      );

      if (!resolvedModule) {
        continue; // Couldn't resolve module
      }

      // Get symbols from the resolved module
      const moduleSymbols = await this.index.getFileSymbols(resolvedModule);
      
      // Look for the symbol in this module
      for (const symbol of moduleSymbols) {
        if (symbol.name === symbolName) {
          return symbol; // Found it!
        }
      }

      // Symbol not found directly, check if the module has re-exports
      await this.index.getFileSymbols(resolvedModule);
      
      // Try to get re-exports from this module (would need to be stored in index)
      // For now, we'll stop here - in full implementation, we'd recursively check
      // re-exports in the target module
    }

    return null;
  }

  /**
   * Find all symbols exported by a file, following re-export chains.
   * 
   * @param fileUri - The file to analyze
   * @returns All symbols exported (directly or through re-exports)
   */
  async resolveAllExports(fileUri: string): Promise<IndexedSymbol[]> {
    const result: IndexedSymbol[] = [];
    const seen = new Set<string>();

    // Get direct symbols
    const directSymbols = await this.index.getFileSymbols(fileUri);
    for (const symbol of directSymbols) {
      const key = `${symbol.name}:${symbol.location.uri}`;
      if (!seen.has(key)) {
        result.push(symbol);
        seen.add(key);
      }
    }

    // TODO: Get re-exports and recursively resolve them
    // This would require storing re-export info in the index

    return result;
  }
}
