/**
 * CompletionHandler - Handles LSP textDocument/completion requests.
 * 
 * Responsibilities:
 * - Provide completion items based on partial symbol names
 * - Resolve completion items with additional documentation (resolve phase)
 * - Deduplicate results
 * - Map symbol kinds to completion item kinds
 * 
 * This handler implements a two-phase completion protocol:
 * 1. getCompletionItems: Fast initial list (minimal data)
 * 2. resolveCompletionItem: Full details on demand (documentation, etc.)
 */

import {
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  MarkupKind
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';

import { IHandler, ServerServices, ServerState } from './types.js';
import { IndexedSymbol } from '../types.js';

/**
 * Custom data attached to completion items for resolution phase.
 */
interface CompletionItemData {
  /** Symbol ID for lookup */
  symbolId: string;
  /** Symbol name */
  name: string;
  /** Symbol kind */
  kind: string;
  /** File path where symbol is defined */
  filePath: string;
  /** Container name if any */
  containerName?: string;
  /** Line number for documentation */
  line: number;
  /** Character position */
  character: number;
}

/**
 * Handler for textDocument/completion requests.
 */
export class CompletionHandler implements IHandler {
  readonly name = 'CompletionHandler';
  
  private services: ServerServices;
  private state: ServerState;

  constructor(services: ServerServices, state: ServerState) {
    this.services = services;
    this.state = state;
  }

  register(): void {
    const { connection } = this.services;
    connection.onCompletion(this.getCompletionItems.bind(this));
    connection.onCompletionResolve(this.resolveCompletionItem.bind(this));
  }

  /**
   * Phase 1: Get completion items (fast, minimal data).
   * Called when the user triggers autocomplete.
   */
  async getCompletionItems(params: TextDocumentPositionParams): Promise<CompletionItem[]> {
    const uri = URI.parse(params.textDocument.uri).fsPath;
    const { line, character } = params.position;
    const start = Date.now();
    
    const { connection, documents, mergedIndex } = this.services;
    
    connection.console.log(`[Server] Completion request: ${uri}:${line}:${character}`);
    
    try {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        connection.console.log(`[Server] Completion result: document not found, 0 items, 0 ms`);
        return [];
      }

      const offset = document.offsetAt(params.position);
      const text = document.getText();
      const wordRange = this.getWordRangeAtPosition(text, offset);
      
      // Extract prefix (what the user has typed so far)
      let prefix = '';
      if (wordRange) {
        prefix = text.substring(wordRange.start, offset);
      }

      // Search for matching symbols using fuzzy search
      const symbols = await mergedIndex.searchSymbols(prefix, 50);

      // Deduplicate by name and build completion items
      const seen = new Set<string>();
      const items: CompletionItem[] = [];

      for (const sym of symbols) {
        if (!seen.has(sym.name)) {
          seen.add(sym.name);
          
          // Attach minimal data for the resolve phase
          const itemData: CompletionItemData = {
            symbolId: sym.id,
            name: sym.name,
            kind: sym.kind,
            filePath: sym.filePath,
            containerName: sym.containerName,
            line: sym.location.line,
            character: sym.location.character
          };
          
          items.push({
            label: sym.name,
            kind: this.mapCompletionItemKind(sym.kind),
            detail: this.formatDetail(sym),
            // Store data for resolve phase
            data: itemData
          });
        }
      }

      const duration = Date.now() - start;
      connection.console.log(`[Server] Completion result: prefix="${prefix}", ${items.length} items in ${duration} ms`);
      return items;
    } catch (error) {
      const duration = Date.now() - start;
      connection.console.error(`[Server] Completion error: ${error}, ${duration} ms`);
      return [];
    }
  }

  /**
   * Phase 2: Resolve completion item (full details on demand).
   * Called when the user hovers over or selects a completion item.
   * This is where we add expensive documentation.
   */
  async resolveCompletionItem(item: CompletionItem): Promise<CompletionItem> {
    const { connection, mergedIndex } = this.services;
    const start = Date.now();
    
    try {
      const data = item.data as CompletionItemData | undefined;
      if (!data) {
        return item;
      }

      connection.console.log(`[Server] Completion resolve: ${data.name}`);

      // Build documentation
      const documentation = this.buildDocumentation(data);
      if (documentation) {
        item.documentation = {
          kind: MarkupKind.Markdown,
          value: documentation
        };
      }

      // Add sort text to prioritize certain items
      item.sortText = this.calculateSortText(data);

      // Add filter text for better fuzzy matching
      item.filterText = data.name;

      const duration = Date.now() - start;
      connection.console.log(`[Server] Completion resolve complete: ${data.name} in ${duration} ms`);
      
      return item;
    } catch (error) {
      connection.console.error(`[Server] Completion resolve error: ${error}`);
      return item;
    }
  }

  /**
   * Format the detail string shown next to the completion item.
   */
  private formatDetail(sym: IndexedSymbol): string {
    if (sym.containerName) {
      return `${sym.kind} (${sym.containerName})`;
    }
    return sym.kind;
  }

  /**
   * Build Markdown documentation for a completion item.
   * This is the expensive operation deferred to the resolve phase.
   */
  private buildDocumentation(data: CompletionItemData): string | undefined {
    const parts: string[] = [];

    // Symbol signature
    let signature = `**${data.name}**`;
    if (data.containerName) {
      signature = `**${data.containerName}.${data.name}**`;
    }
    parts.push(signature);

    // Kind badge
    parts.push(`\n\n*${data.kind}*`);

    // Location info
    const relativePath = this.getRelativePath(data.filePath);
    parts.push(`\n\nDefined in \`${relativePath}\` at line ${data.line + 1}`);

    return parts.join('');
  }

  /**
   * Calculate sort text for ordering completion items.
   * Lower values appear first.
   */
  private calculateSortText(data: CompletionItemData): string {
    // Prioritize by kind:
    // 1. Functions/Methods (most likely what user wants)
    // 2. Classes/Interfaces
    // 3. Variables/Constants
    // 4. Others
    let priority = '5';
    
    switch (data.kind) {
      case 'function':
      case 'method':
        priority = '1';
        break;
      case 'class':
      case 'interface':
        priority = '2';
        break;
      case 'variable':
      case 'constant':
        priority = '3';
        break;
      case 'type':
      case 'enum':
        priority = '4';
        break;
    }

    // Append name for alphabetical sorting within priority
    return `${priority}${data.name.toLowerCase()}`;
  }

  /**
   * Get a relative path from the workspace root.
   */
  private getRelativePath(filePath: string): string {
    const workspaceRoot = this.state.workspaceRoot;
    if (workspaceRoot && filePath.startsWith(workspaceRoot)) {
      return filePath.substring(workspaceRoot.length + 1).replace(/\\/g, '/');
    }
    return filePath.replace(/\\/g, '/');
  }

  /**
   * Get word range at a given offset in text.
   */
  private getWordRangeAtPosition(
    text: string,
    offset: number
  ): { start: number; end: number } | null {
    const wordPattern = /[a-zA-Z_][a-zA-Z0-9_]*/g;
    let match;

    while ((match = wordPattern.exec(text)) !== null) {
      if (match.index <= offset && offset <= match.index + match[0].length) {
        return {
          start: match.index,
          end: match.index + match[0].length
        };
      }
    }

    return null;
  }

  /**
   * Map symbol kind to VS Code CompletionItemKind.
   */
  private mapCompletionItemKind(kind: string): CompletionItemKind {
    switch (kind) {
      case 'function':
        return CompletionItemKind.Function;
      case 'class':
        return CompletionItemKind.Class;
      case 'interface':
        return CompletionItemKind.Interface;
      case 'type':
        return CompletionItemKind.TypeParameter;
      case 'enum':
        return CompletionItemKind.Enum;
      case 'variable':
        return CompletionItemKind.Variable;
      case 'constant':
        return CompletionItemKind.Constant;
      case 'method':
        return CompletionItemKind.Method;
      case 'property':
        return CompletionItemKind.Property;
      default:
        return CompletionItemKind.Text;
    }
  }
}

/**
 * Factory function for creating CompletionHandler.
 * Used with HandlerRegistry.register().
 */
export function createCompletionHandler(
  services: ServerServices,
  state: ServerState
): CompletionHandler {
  return new CompletionHandler(services, state);
}
