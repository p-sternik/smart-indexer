import { TSESTree } from '@typescript-eslint/typescript-estree';
import { IndexedSymbol, IndexedReference, SymbolLocation, SymbolRange } from '../types.js';
import { ISymbolIndex } from '../index/ISymbolIndex.js';

/**
 * Context passed to plugins during AST traversal.
 * Provides access to file URI and utilities for creating symbols/references.
 */
export interface PluginVisitorContext {
  uri: string;
  containerName?: string;
  containerKind?: string;
  containerPath: string[];
  scopeId: string;
  imports: Array<{ localName: string; moduleSpecifier: string }>;
}

/**
 * Result of plugin's visitNode - symbols and references to add.
 */
export interface PluginVisitResult {
  symbols?: IndexedSymbol[];
  references?: IndexedReference[];
  metadata?: Record<string, unknown>;
}

/**
 * Framework Plugin Interface
 * 
 * Enables framework-specific logic (Angular, NgRx, React, etc.) to be 
 * plugged into the indexer without modifying core parsing logic.
 * 
 * Follows the Open-Closed Principle: open for extension, closed for modification.
 */
export interface FrameworkPlugin {
  /**
   * Unique name identifying the plugin.
   */
  readonly name: string;

  /**
   * Called during AST traversal for each node.
   * Plugins can extract framework-specific symbols, references, or metadata.
   * 
   * @param node - The current AST node being visited
   * @param currentSymbol - The symbol currently being built (if any)
   * @param context - Visitor context with file and scope information
   * @returns Optional result with symbols/references/metadata to add
   */
  visitNode(
    node: TSESTree.Node,
    currentSymbol: IndexedSymbol | null,
    context: PluginVisitorContext
  ): PluginVisitResult | undefined;

  /**
   * Called after all symbols are indexed to resolve cross-file references.
   * Optional - implement if the plugin needs deferred resolution.
   * 
   * @param symbol - The symbol to resolve references for
   * @param index - The symbol index for lookups
   * @returns Additional references found
   */
  resolveReferences?(
    symbol: IndexedSymbol,
    index: ISymbolIndex
  ): Promise<IndexedReference[]>;

  /**
   * Determines if a symbol should be treated as an entry point
   * (protected from dead code detection).
   * 
   * @param symbol - The symbol to check
   * @returns true if this symbol is a framework entry point
   */
  isEntryPoint?(symbol: IndexedSymbol): boolean;

  /**
   * Extract metadata from a symbol for framework-specific handling.
   * Called after initial symbol creation to enrich with framework metadata.
   * 
   * @param symbol - The symbol to extract metadata from
   * @param node - The AST node that created the symbol
   * @returns Metadata to merge into symbol.metadata
   */
  extractMetadata?(
    symbol: IndexedSymbol,
    node: TSESTree.Node
  ): Record<string, unknown> | undefined;
}

/**
 * Registry for managing framework plugins.
 * Plugins are registered once and queried during indexing.
 */
export class PluginRegistry {
  private plugins: FrameworkPlugin[] = [];

  /**
   * Register a plugin with the registry.
   */
  register(plugin: FrameworkPlugin): void {
    // Avoid duplicate registrations
    if (!this.plugins.some(p => p.name === plugin.name)) {
      this.plugins.push(plugin);
    }
  }

  /**
   * Unregister a plugin by name.
   */
  unregister(name: string): void {
    this.plugins = this.plugins.filter(p => p.name !== name);
  }

  /**
   * Get all registered plugins.
   */
  getPlugins(): readonly FrameworkPlugin[] {
    return this.plugins;
  }

  /**
   * Visit a node with all plugins, collecting results.
   */
  visitNode(
    node: TSESTree.Node,
    currentSymbol: IndexedSymbol | null,
    context: PluginVisitorContext
  ): PluginVisitResult {
    const result: PluginVisitResult = {
      symbols: [],
      references: [],
      metadata: {}
    };

    for (const plugin of this.plugins) {
      const pluginResult = plugin.visitNode(node, currentSymbol, context);
      if (pluginResult) {
        if (pluginResult.symbols) {
          result.symbols!.push(...pluginResult.symbols);
        }
        if (pluginResult.references) {
          result.references!.push(...pluginResult.references);
        }
        if (pluginResult.metadata) {
          Object.assign(result.metadata!, pluginResult.metadata);
        }
      }
    }

    return result;
  }

  /**
   * Check if any plugin considers the symbol an entry point.
   */
  isEntryPoint(symbol: IndexedSymbol): boolean {
    return this.plugins.some(p => p.isEntryPoint?.(symbol) ?? false);
  }

  /**
   * Resolve references with all plugins.
   */
  async resolveReferences(
    symbol: IndexedSymbol,
    index: ISymbolIndex
  ): Promise<IndexedReference[]> {
    const allRefs: IndexedReference[] = [];
    
    for (const plugin of this.plugins) {
      if (plugin.resolveReferences) {
        const refs = await plugin.resolveReferences(symbol, index);
        allRefs.push(...refs);
      }
    }

    return allRefs;
  }

  /**
   * Clear all plugins.
   */
  clear(): void {
    this.plugins = [];
  }
}

// Global plugin registry instance
export const pluginRegistry = new PluginRegistry();
