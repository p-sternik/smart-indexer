/**
 * RenameHandler - Provides symbol rename support.
 * 
 * Responsibilities:
 * - Validate rename requests (prepareRename)
 * - Find all references to the symbol
 * - Generate WorkspaceEdit with text replacements
 * - Handle special cases (NgRx action groups, Angular selectors)
 * 
 * This handler implements the "Rename Symbol" feature (F2 in VS Code).
 */

import {
  PrepareRenameParams,
  RenameParams,
  WorkspaceEdit,
  TextEdit,
  Range,
  ResponseError,
  ErrorCodes
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';

import { IHandler, ServerServices, ServerState } from './types.js';
import { IndexedSymbol, IndexedReference } from '../types.js';
import { findSymbolAtPosition } from '../indexer/symbolResolver.js';

/**
 * Result of prepareRename - the range to rename and optional placeholder.
 */
interface PrepareRenameResult {
  range: Range;
  placeholder: string;
}

/**
 * Handler for textDocument/rename requests.
 */
export class RenameHandler implements IHandler {
  readonly name = 'RenameHandler';
  
  private services: ServerServices;
  private state: ServerState;

  constructor(services: ServerServices, state: ServerState) {
    this.services = services;
    this.state = state;
  }

  register(): void {
    const { connection } = this.services;
    connection.onPrepareRename(this.handlePrepareRename.bind(this));
    connection.onRenameRequest(this.handleRename.bind(this));
  }

  /**
   * Handle prepareRename request.
   * Validates that the position is renameable and returns the range.
   */
  private async handlePrepareRename(
    params: PrepareRenameParams
  ): Promise<PrepareRenameResult | Range | null | ResponseError<void>> {
    const uri = URI.parse(params.textDocument.uri).fsPath;
    const { line, character } = params.position;
    
    const { connection, documents, mergedIndex } = this.services;
    
    try {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        return null;
      }

      const text = document.getText();

      // Find the symbol at the cursor position
      const symbolAtCursor = findSymbolAtPosition(uri, text, line, character);
      if (!symbolAtCursor) {
        return new ResponseError(
          ErrorCodes.InvalidRequest,
          'No symbol found at this position'
        );
      }

      // Look up the symbol in the index
      const definitions = await mergedIndex.findDefinitions(symbolAtCursor.name);
      
      if (definitions.length === 0) {
        return new ResponseError(
          ErrorCodes.InvalidRequest,
          'Symbol not found in index'
        );
      }

      // Check if the symbol is renameable (not a built-in or external library symbol)
      const symbol = definitions[0];
      if (this.isExternalSymbol(symbol)) {
        return new ResponseError(
          ErrorCodes.InvalidRequest,
          'Cannot rename symbols from external libraries'
        );
      }

      // Return the range and placeholder
      const range = Range.create(
        symbolAtCursor.range.startLine,
        symbolAtCursor.range.startCharacter,
        symbolAtCursor.range.endLine,
        symbolAtCursor.range.endCharacter
      );

      return {
        range,
        placeholder: symbolAtCursor.name
      };
    } catch (error) {
      connection.console.error(`[RenameHandler] Error in prepareRename: ${error}`);
      return new ResponseError(
        ErrorCodes.InternalError,
        `Failed to prepare rename: ${error}`
      );
    }
  }

  /**
   * Handle rename request.
   * Finds all references and generates a WorkspaceEdit.
   */
  private async handleRename(params: RenameParams): Promise<WorkspaceEdit | null> {
    const uri = URI.parse(params.textDocument.uri).fsPath;
    const { line, character } = params.position;
    const newName = params.newName;
    
    const { connection, documents, mergedIndex } = this.services;
    
    connection.console.log(`[RenameHandler] Rename request: ${uri}:${line}:${character} -> "${newName}"`);
    
    try {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        return null;
      }

      const text = document.getText();

      // Find the symbol at the cursor position
      const symbolAtCursor = findSymbolAtPosition(uri, text, line, character);
      if (!symbolAtCursor) {
        connection.console.log('[RenameHandler] No symbol found at cursor');
        return null;
      }

      // Look up the symbol definition
      const definitions = await mergedIndex.findDefinitions(symbolAtCursor.name);
      if (definitions.length === 0) {
        connection.console.log('[RenameHandler] Symbol not found in index');
        return null;
      }

      const symbol = definitions[0];

      // Find all references to the symbol
      const references = await mergedIndex.findReferencesByName(symbolAtCursor.name);
      
      connection.console.log(
        `[RenameHandler] Found ${references.length} references to "${symbolAtCursor.name}"`
      );

      // Build WorkspaceEdit
      const workspaceEdit = this.buildWorkspaceEdit(symbol, references, newName);

      return workspaceEdit;
    } catch (error) {
      connection.console.error(`[RenameHandler] Error: ${error}`);
      return null;
    }
  }

  /**
   * Check if a symbol is from an external library (node_modules).
   */
  private isExternalSymbol(symbol: IndexedSymbol): boolean {
    return symbol.location.uri.includes('node_modules');
  }

  /**
   * Build a WorkspaceEdit with text replacements for all references.
   */
  private buildWorkspaceEdit(
    symbol: IndexedSymbol,
    references: IndexedReference[],
    newName: string
  ): WorkspaceEdit {
    const changes: { [uri: string]: TextEdit[] } = {};

    // Add the definition itself
    const definitionUri = URI.file(symbol.location.uri).toString();
    if (!changes[definitionUri]) {
      changes[definitionUri] = [];
    }
    changes[definitionUri].push(
      TextEdit.replace(
        Range.create(
          symbol.range.startLine,
          symbol.range.startCharacter,
          symbol.range.endLine,
          symbol.range.endCharacter
        ),
        newName
      )
    );

    // Add all references
    for (const ref of references) {
      const refUri = URI.file(ref.location.uri).toString();
      if (!changes[refUri]) {
        changes[refUri] = [];
      }
      changes[refUri].push(
        TextEdit.replace(
          Range.create(
            ref.range.startLine,
            ref.range.startCharacter,
            ref.range.endLine,
            ref.range.endCharacter
          ),
          newName
        )
      );
    }

    // Sort edits by position (bottom to top) to avoid offset issues
    for (const uri in changes) {
      changes[uri].sort((a, b) => {
        if (a.range.start.line !== b.range.start.line) {
          return b.range.start.line - a.range.start.line; // Descending
        }
        return b.range.start.character - a.range.start.character; // Descending
      });
    }

    return { changes };
  }
}

/**
 * Factory function for creating RenameHandler.
 */
export function createRenameHandler(services: ServerServices, state: ServerState): RenameHandler {
  return new RenameHandler(services, state);
}
