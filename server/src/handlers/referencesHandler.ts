/**
 * ReferencesHandler - Handles LSP textDocument/references requests.
 * 
 * Responsibilities:
 * - Find all references to a symbol at cursor position
 * - Handle includeDeclaration parameter
 * - Deduplicate results
 * - Filter by container name for disambiguation
 * 
 * This handler implements the core "Find References" functionality.
 */

import {
  ReferenceParams,
  Location
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';

import { IHandler, ServerServices, ServerState } from './types.js';
import { findSymbolAtPosition } from '../indexer/symbolResolver.js';
import { getWordRangeAtPosition } from '../utils/textUtils.js';

/**
 * Handler for textDocument/references requests.
 */
export class ReferencesHandler implements IHandler {
  readonly name = 'ReferencesHandler';
  
  private services: ServerServices;
  private state: ServerState;

  constructor(services: ServerServices, state: ServerState) {
    this.services = services;
    this.state = state;
  }

  register(): void {
    const { connection } = this.services;
    connection.onReferences(this.handleReferences.bind(this));
  }

  /**
   * Handle references request.
   */
  private async handleReferences(params: ReferenceParams): Promise<Location[] | null> {
    const uri = URI.parse(params.textDocument.uri).fsPath;
    const { line, character } = params.position;
    const start = Date.now();
    
    const { connection, documents, mergedIndex, profiler, statsManager, logger } = this.services;
    
    logger.info(`[Server] References request: ${uri}:${line}:${character}`);
    
    try {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        logger.info(`[Server] References result: document not found, 0 ms`);
        return null;
      }

      const text = document.getText();

      // Try to resolve the exact symbol at the cursor position
      const symbolAtCursor = findSymbolAtPosition(uri, text, line, character);
      
      if (symbolAtCursor) {
        logger.info(
          `[Server] Resolved symbol: name="${symbolAtCursor.name}", kind="${symbolAtCursor.kind}", ` +
          `container="${symbolAtCursor.containerName || '<none>'}", isStatic=${symbolAtCursor.isStatic}`
        );

        // Query actual references (usages) instead of definitions
        const references = await mergedIndex.findReferencesByName(symbolAtCursor.name);
        logger.info(`[Server] Found ${references.length} references by name`);

        // Filter references to match the exact symbol (by container if available)
        let filtered = references;
        if (symbolAtCursor.containerName) {
          filtered = references.filter(ref => 
            ref.containerName === symbolAtCursor.containerName || !ref.containerName
          );
        }

        // Get definitions to filter out self-references (definition locations showing up as references)
        const definitions = await mergedIndex.findDefinitions(symbolAtCursor.name);
        const definitionLocations = new Set<string>();
        for (const def of definitions) {
          // Add all definition location keys to filter out
          const key = `${def.location.uri}:${def.range.startLine}:${def.range.startCharacter}`;
          definitionLocations.add(key);
        }

        // Filter out references that point to definition locations (self-references)
        filtered = filtered.filter(ref => {
          const key = `${ref.location.uri}:${ref.range.startLine}:${ref.range.startCharacter}`;
          return !definitionLocations.has(key);
        });

        logger.info(`[Server] Filtered to ${filtered.length} references (after removing definitions)`);

        // Also include the definition itself if requested
        if (params.context.includeDeclaration) {
          const matchingDef = definitions.filter(def => {
            const nameMatch = def.name === symbolAtCursor.name;
            const containerMatch = !symbolAtCursor.containerName || 
                                  def.containerName === symbolAtCursor.containerName;
            return nameMatch && containerMatch;
          });
          
          // Convert definitions to reference format and add them
          for (const def of matchingDef) {
            filtered.push({
              symbolName: def.name,
              location: def.location,
              range: def.range,
              containerName: def.containerName
            });
          }
        }

        // Deduplicate results by exact location (uri:line:char)
        const seen = new Set<string>();
        const deduplicated = filtered.filter(ref => {
          const key = `${ref.location.uri}:${ref.range.startLine}:${ref.range.startCharacter}`;
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        });

        logger.info(`[Server] Deduplicated to ${deduplicated.length} unique references`);

        const results = deduplicated.map(ref => ({
          uri: URI.file(ref.location.uri).toString(),
          range: {
            start: { line: ref.range.startLine, character: ref.range.startCharacter },
            end: { line: ref.range.endLine, character: ref.range.endCharacter }
          }
        }));

        const duration = Date.now() - start;
        profiler.record('references', duration);
        statsManager.updateProfilingMetrics({ avgReferencesTimeMs: profiler.getAverageMs('references') });

        logger.info(`[Server] References result: ${results.length} locations in ${duration} ms`);
        return results.length > 0 ? results : null;
      }

      // Fallback: use simple word-based lookup
      const offset = document.offsetAt(params.position);
      const wordRange = getWordRangeAtPosition(text, offset);
      if (!wordRange) {
        logger.info(`[Server] References result: no word at position, ${Date.now() - start} ms`);
        return null;
      }

      const word = text.substring(wordRange.start, wordRange.end);
      const references = await mergedIndex.findReferencesByName(word);

      // Deduplicate fallback results
      const seenFallback = new Set<string>();
      const dedupedRefs = references.filter(ref => {
        const key = `${ref.location.uri}:${ref.range.startLine}:${ref.range.startCharacter}`;
        if (seenFallback.has(key)) {
          return false;
        }
        seenFallback.add(key);
        return true;
      });

      const results = dedupedRefs.length === 0 ? null : dedupedRefs.map(ref => ({
        uri: URI.file(ref.location.uri).toString(),
        range: {
          start: { line: ref.range.startLine, character: ref.range.startCharacter },
          end: { line: ref.range.endLine, character: ref.range.endCharacter }
        }
      }));

      const duration = Date.now() - start;
      profiler.record('references', duration);
      statsManager.updateProfilingMetrics({ avgReferencesTimeMs: profiler.getAverageMs('references') });

      logger.info(`[Server] References result (fallback): symbol="${word}", ${dedupedRefs.length} locations in ${duration} ms`);
      return results;
    } catch (error) {
      const duration = Date.now() - start;
      logger.error(`[Server] References error: ${error}, ${duration} ms`);
      return null;
    }
  }
}

/**
 * Factory function for creating ReferencesHandler.
 * Used with HandlerRegistry.register().
 */
export function createReferencesHandler(
  services: ServerServices,
  state: ServerState
): ReferencesHandler {
  return new ReferencesHandler(services, state);
}
