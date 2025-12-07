/**
 * HoverHandler - Provides hover information for symbols.
 * 
 * Responsibilities:
 * - Show symbol signature and type information
 * - Display JSDoc documentation if available
 * - Show metadata (Angular decorators, NgRx actions, etc.)
 * - Provide file location breadcrumbs
 * 
 * This handler implements the "Hover" feature that shows rich information
 * when users hover over symbols in the editor.
 */

import {
  Hover,
  HoverParams,
  MarkupKind
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';

import { IHandler, ServerServices, ServerState } from './types.js';
import { IndexedSymbol } from '../types.js';
import { findSymbolAtPosition } from '../indexer/symbolResolver.js';

/**
 * Handler for textDocument/hover requests.
 */
export class HoverHandler implements IHandler {
  readonly name = 'HoverHandler';
  
  private services: ServerServices;

  constructor(services: ServerServices, _state: ServerState) {
    this.services = services;
  }

  register(): void {
    const { connection } = this.services;
    connection.onHover(this.handleHover.bind(this));
  }

  /**
   * Handle hover request.
   */
  private async handleHover(params: HoverParams): Promise<Hover | null> {
    const uri = URI.parse(params.textDocument.uri).fsPath;
    const { line, character } = params.position;
    
    const { documents, mergedIndex, logger } = this.services;
    
    try {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        return null;
      }

      const text = document.getText();

      // First, try to find the symbol at the cursor position
      const symbolAtCursor = findSymbolAtPosition(uri, text, line, character);
      if (!symbolAtCursor) {
        return null;
      }

      // Look up the symbol definition in the index
      const definitions = await mergedIndex.findDefinitions(symbolAtCursor.name);
      
      if (definitions.length === 0) {
        return null;
      }

      // Pick the best match (prefer symbols in the current file, then by kind)
      const symbol = this.pickBestSymbol(definitions, uri, symbolAtCursor.kind);
      
      // Build hover content
      const content = this.buildHoverContent(symbol);
      
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: content
        }
      };
    } catch (error) {
      logger.error(`[HoverHandler] Error: ${error}`);
      return null;
    }
  }

  /**
   * Pick the best symbol from multiple candidates.
   * Prefer symbols from the current file, then by kind match.
   */
  private pickBestSymbol(symbols: IndexedSymbol[], currentUri: string, targetKind?: string): IndexedSymbol {
    // First, try to find a symbol in the current file
    const localSymbol = symbols.find(s => s.location.uri === currentUri);
    if (localSymbol) {
      return localSymbol;
    }

    // If we have a target kind, prefer symbols of that kind
    if (targetKind) {
      const kindMatch = symbols.find(s => s.kind === targetKind);
      if (kindMatch) {
        return kindMatch;
      }
    }

    // Otherwise, just return the first one
    return symbols[0];
  }

  /**
   * Build Markdown hover content for a symbol.
   */
  private buildHoverContent(symbol: IndexedSymbol): string {
    const lines: string[] = [];

    // Header: Symbol signature
    lines.push('```typescript');
    lines.push(this.buildSignature(symbol));
    lines.push('```');
    lines.push(''); // Blank line

    // Metadata section (Angular, NgRx, etc.)
    const metadataContent = this.buildMetadataSection(symbol);
    if (metadataContent) {
      lines.push(metadataContent);
      lines.push(''); // Blank line
    }

    // Footer: File location
    lines.push(this.buildLocationFooter(symbol));

    return lines.join('\n');
  }

  /**
   * Build the symbol signature line.
   * Examples:
   *   (class) UserService
   *   (method) UserService.getData(): Observable<User[]>
   *   (property) UserComponent.title: string
   */
  private buildSignature(symbol: IndexedSymbol): string {
    const parts: string[] = [];

    // Kind prefix (e.g., "(class)", "(method)")
    parts.push(`(${symbol.kind})`);

    // Full path (container + name)
    if (symbol.containerName) {
      parts.push(`${symbol.containerName}.${symbol.name}`);
    } else {
      parts.push(symbol.name);
    }

    // Static modifier
    if (symbol.isStatic) {
      parts.push('[static]');
    }

    // Parameters for functions/methods
    if ((symbol.kind === 'function' || symbol.kind === 'method') && symbol.parametersCount !== undefined) {
      const params = '...'.repeat(Math.min(symbol.parametersCount, 1)); // Simplified
      parts.push(`(${params})`);
    }

    return parts.join(' ');
  }

  /**
   * Build metadata section (Angular decorators, NgRx info, etc.).
   */
  private buildMetadataSection(symbol: IndexedSymbol): string | null {
    const lines: string[] = [];

    // Angular metadata
    const angularMeta = symbol.metadata?.['angular'] as Record<string, unknown> | undefined;
    if (angularMeta) {
      if (angularMeta['isComponent']) {
        const selector = angularMeta['selector'] as string | undefined;
        if (selector) {
          lines.push(`**Angular Component:** \`${selector}\``);
        } else {
          lines.push('**Angular Component**');
        }
      } else if (angularMeta['isDirective']) {
        const selector = angularMeta['selector'] as string | undefined;
        if (selector) {
          lines.push(`**Angular Directive:** \`${selector}\``);
        } else {
          lines.push('**Angular Directive**');
        }
      } else if (angularMeta['isInjectable']) {
        lines.push('**Angular Service** (Injectable)');
      }

      // Input/Output properties
      if (angularMeta['isInput']) {
        lines.push('**@Input** property');
      }
      if (angularMeta['isOutput']) {
        lines.push('**@Output** property');
      }
    }

    // NgRx metadata
    const ngrxMeta = symbol.metadata?.['ngrx'] as Record<string, unknown> | undefined;
    if (ngrxMeta) {
      const role = ngrxMeta['role'] as string | undefined;
      const type = ngrxMeta['type'] as string | undefined;
      
      if (role === 'action' && type) {
        lines.push(`**NgRx Action:** \`${type}\``);
      } else if (role === 'effect') {
        lines.push('**NgRx Effect**');
      } else if (role === 'reducer') {
        lines.push('**NgRx Reducer**');
      }

      // Action group
      if (ngrxMeta['isGroup']) {
        lines.push('**NgRx Action Group**');
      }
    }

    return lines.length > 0 ? lines.join('\n\n') : null;
  }

  /**
   * Build the footer showing the symbol's file location.
   */
  private buildLocationFooter(symbol: IndexedSymbol): string {
    const fileName = symbol.location.uri.split(/[\\/]/).pop() || symbol.location.uri;
    const location = `${fileName}:${symbol.location.line + 1}:${symbol.location.character + 1}`;
    return `*Defined in:* \`${location}\``;
  }
}

/**
 * Factory function for creating HoverHandler.
 */
export function createHoverHandler(services: ServerServices, state: ServerState): HoverHandler {
  return new HoverHandler(services, state);
}
