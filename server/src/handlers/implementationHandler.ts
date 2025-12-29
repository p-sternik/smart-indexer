import {
  Location,
  TextDocumentPositionParams
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';

import { IHandler, ServerServices, ServerState } from './types.js';
import { IndexedSymbol } from '../types.js';
import { getWordRangeAtPosition } from '../utils/textUtils.js';

/**
 * Handler for textDocument/implementation requests.
 */
export class ImplementationHandler implements IHandler {
  readonly name = 'ImplementationHandler';
  
  private services: ServerServices;

  constructor(services: ServerServices, _state: ServerState) {
    this.services = services;
  }

  register(): void {
    const { connection } = this.services;
    connection.onImplementation(this.handleImplementation.bind(this));
  }

  /**
   * Handle textDocument/implementation request.
   */
  async handleImplementation(params: TextDocumentPositionParams): Promise<Location[] | null> {
    const { documents, mergedIndex, logger } = this.services;
    
    try {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        return null;
      }

      const offset = document.offsetAt(params.position);
      const text = document.getText();
      const wordRange = getWordRangeAtPosition(text, offset);
      
      if (!wordRange) {
        return null;
      }

      const word = text.substring(wordRange.start, wordRange.end);
      logger.info(`[ImplementationHandler] Finding implementations for: ${word}`);

      const implementations: Location[] = [];
      
      // Strategy:
      // 1. Find all references to the 'word' (symbol name)
      // 2. Identify the container of each reference
      // 3. Check if the container matches the criteria (is a class that implements/extends 'word')
      const references = await mergedIndex.findReferences(word);
      const seenUris = new Set<string>();
      
      // Optimization: Cache symbol lookups
      const symbolCache = new Map<string, IndexedSymbol | null>();

      for (const ref of references) {
        if (ref.containerName) {
           // Check if we already processed this container
           if (symbolCache.has(ref.containerName)) {
             const cached = symbolCache.get(ref.containerName);
             if (cached) {
               this.checkAndAddImplementation(cached, word, implementations, seenUris);
             }
             continue;
           }

           // Look up the container symbol
           const containerSymbols = await mergedIndex.searchSymbols(ref.containerName, 5); // Limit to 5 candidates
           let found = false;
           
           for (const sym of containerSymbols) {
             if (sym.name === ref.containerName && (sym.kind === 'class' || sym.kind === 'interface')) {
               symbolCache.set(ref.containerName, sym);
               this.checkAndAddImplementation(sym, word, implementations, seenUris);
               found = true;
               break; // Assume first exact match is correct
             }
           }
           
           if (!found) {
             symbolCache.set(ref.containerName, null);
           }
        }
      }
      
      logger.info(`[ImplementationHandler] Found ${implementations.length} implementations for ${word}`);
      return implementations;

    } catch (error) {
      logger.error(`[ImplementationHandler] Error: ${error}`);
      return null;
    }
  }

  private checkAndAddImplementation(
    sym: IndexedSymbol, 
    targetName: string, 
    implementations: Location[], 
    seenUris: Set<string>
  ): void {
    if (sym.implements?.includes(targetName) || sym.extends === targetName) {
      const key = `${sym.location.uri}:${sym.location.line}`;
      if (!seenUris.has(key)) {
        seenUris.add(key);
        implementations.push(Location.create(
          URI.file(sym.location.uri).toString(),
          {
            start: { line: sym.location.line, character: sym.location.character },
            end: { line: sym.range.endLine, character: sym.range.endCharacter }
          }
        ));
      }
    }
  }
}

/**
 * Factory function for creating ImplementationHandler.
 */
export function createImplementationHandler(
  services: ServerServices,
  state: ServerState
): ImplementationHandler {
  return new ImplementationHandler(services, state);
}
