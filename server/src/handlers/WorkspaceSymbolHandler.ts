/**
 * WorkspaceSymbolHandler - Provides workspace-wide symbol search via FTS5.
 * 
 * Responsibilities:
 * - Handle workspace/symbol LSP requests (Ctrl+T in VS Code)
 * - Use SQLite FTS5 for fast full-text search on symbol names
 * - Apply intelligent search mode selection based on query length
 * - Rank results by FTS relevance and context (open files, current file)
 * - Map storage results to LSP WorkspaceSymbol format
 * 
 * Search Strategy:
 * - Short queries (< 3 chars): Use 'prefix' mode to avoid noise
 * - Longer queries (>= 3 chars): Use 'fulltext' mode for FTS5 ranking
 * 
 * Performance:
 * - FTS5 queries typically complete in < 10ms even on large codebases
 * - Results are limited to 200 to avoid overwhelming the UI
 * - No explicit debouncing needed (VS Code handles this)
 */

import {
  WorkspaceSymbol,
  WorkspaceSymbolParams,
  SymbolKind
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';

import { IHandler, ServerServices, ServerState } from './types.js';
import { RankingContext } from '../utils/fuzzySearch.js';

/**
 * Handler for workspace/symbol requests.
 */
export class WorkspaceSymbolHandler implements IHandler {
  readonly name = 'WorkspaceSymbolHandler';
  
  private services: ServerServices;
  private state: ServerState;

  constructor(services: ServerServices, state: ServerState) {
    this.services = services;
    this.state = state;
  }

  register(): void {
    const { connection } = this.services;
    connection.onWorkspaceSymbol(this.handleWorkspaceSymbol.bind(this));
  }

  /**
   * Handle workspace/symbol request with FTS5-powered search.
   */
  private async handleWorkspaceSymbol(params: WorkspaceSymbolParams): Promise<WorkspaceSymbol[]> {
    const start = Date.now();
    const query = params.query;
    
    const { logger } = this.services;
    logger.info(`[WorkspaceSymbol] Request: query="${query}"`);
    
    try {
      // Empty query returns no results
      if (!query || query.trim().length === 0) {
        logger.info(`[WorkspaceSymbol] Empty query, 0 results, ${Date.now() - start} ms`);
        return [];
      }

      // Build ranking context with open files and current file
      const openFiles = new Set<string>();
      const { documents } = this.services;
      for (const doc of documents.all()) {
        const uri = URI.parse(doc.uri).fsPath;
        openFiles.add(uri);
      }

      const context: RankingContext = {
        openFiles,
        currentFileUri: this.state.currentActiveDocumentUri
      };

      // Use fuzzy search with ranking (MergedIndex handles the coordination)
      const { mergedIndex } = this.services;
      const symbols = await mergedIndex.searchSymbols(query, 200, context);

      // Map to LSP WorkspaceSymbol format
      const results = symbols.map(sym => ({
        name: sym.name,
        kind: this.mapSymbolKind(sym.kind),
        location: {
          uri: URI.file(sym.location.uri).toString(),
          range: {
            start: { line: sym.location.line, character: sym.location.character },
            end: { line: sym.location.line, character: sym.location.character + sym.name.length }
          }
        },
        containerName: sym.containerName
      }));

      logger.info(`[WorkspaceSymbol] Result: query="${query}", ${results.length} symbols in ${Date.now() - start} ms`);
      return results;
    } catch (error) {
      logger.error(`[WorkspaceSymbol] Error: ${error}, ${Date.now() - start} ms`);
      return [];
    }
  }

  /**
   * Map internal symbol kind to LSP SymbolKind.
   */
  private mapSymbolKind(kind: string): SymbolKind {
    switch (kind.toLowerCase()) {
      case 'file': return SymbolKind.File;
      case 'module': return SymbolKind.Module;
      case 'namespace': return SymbolKind.Namespace;
      case 'package': return SymbolKind.Package;
      case 'class': return SymbolKind.Class;
      case 'method': return SymbolKind.Method;
      case 'property': return SymbolKind.Property;
      case 'field': return SymbolKind.Field;
      case 'constructor': return SymbolKind.Constructor;
      case 'enum': return SymbolKind.Enum;
      case 'interface': return SymbolKind.Interface;
      case 'function': return SymbolKind.Function;
      case 'variable': return SymbolKind.Variable;
      case 'constant': return SymbolKind.Constant;
      case 'string': return SymbolKind.String;
      case 'number': return SymbolKind.Number;
      case 'boolean': return SymbolKind.Boolean;
      case 'array': return SymbolKind.Array;
      case 'object': return SymbolKind.Object;
      case 'key': return SymbolKind.Key;
      case 'null': return SymbolKind.Null;
      case 'enummember': return SymbolKind.EnumMember;
      case 'struct': return SymbolKind.Struct;
      case 'event': return SymbolKind.Event;
      case 'operator': return SymbolKind.Operator;
      case 'typeparameter': return SymbolKind.TypeParameter;
      default: return SymbolKind.Variable;
    }
  }
}

/**
 * Factory function for creating WorkspaceSymbolHandler.
 */
export function createWorkspaceSymbolHandler(
  services: ServerServices,
  state: ServerState
): WorkspaceSymbolHandler {
  return new WorkspaceSymbolHandler(services, state);
}
