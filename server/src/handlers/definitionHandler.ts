/**
 * DefinitionHandler - Handles LSP textDocument/definition requests.
 * 
 * Responsibilities:
 * - Resolve symbol at cursor position
 * - Handle member expression chains (e.g., myStore.actions.opened)
 * - Resolve imports and re-exports
 * - TypeScript-based disambiguation for multiple candidates
 * 
 * This handler implements the core "Go to Definition" functionality.
 */

import {
  DefinitionParams,
  Location
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import * as fs from 'fs';

import { IHandler, ServerServices, ServerState } from './types.js';
import { IndexedSymbol } from '../types.js';
import { findSymbolAtPosition } from '../indexer/symbolResolver.js';
import { parseMemberAccess, resolvePropertyRecursively } from '../indexer/recursiveResolver.js';
import { disambiguateSymbols } from '../utils/disambiguation.js';
import { getWordRangeAtPosition } from '../utils/textUtils.js';

/**
 * Handler for textDocument/definition requests.
 */
export class DefinitionHandler implements IHandler {
  readonly name = 'DefinitionHandler';
  
  private services: ServerServices;
  private state: ServerState;

  constructor(services: ServerServices, state: ServerState) {
    this.services = services;
    this.state = state;
  }

  register(): void {
    const { connection } = this.services;
    connection.onDefinition(this.handleDefinition.bind(this));
  }

  /**
   * Handle definition request.
   */
  private async handleDefinition(params: DefinitionParams): Promise<Location | Location[] | null> {
    const uri = URI.parse(params.textDocument.uri).fsPath;
    const { line, character } = params.position;
    const start = Date.now();
    
    const { connection, documents, mergedIndex, profiler, statsManager, typeScriptService } = this.services;
    const { importResolver } = this.state;
    
    connection.console.log(`[Server] Definition request: ${uri}:${line}:${character}`);
    
    try {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        connection.console.log(`[Server] Definition result: document not found, 0 ms`);
        return null;
      }

      const text = document.getText();

      // Check if this is a member expression (e.g., myStore.actions.opened)
      const memberAccess = parseMemberAccess(text, line, character);
      if (memberAccess && memberAccess.propertyChain.length > 0) {
        connection.console.log(
          `[Server] Detected member expression: ${memberAccess.baseName}.${memberAccess.propertyChain.join('.')}`
        );

        // Step 1: Find the base object definition
        const baseCandidates = await mergedIndex.findDefinitions(memberAccess.baseName);
        
        if (baseCandidates.length > 0) {
          // Use the first candidate (or disambiguate if needed)
          let baseSymbol = baseCandidates[0];
          if (baseCandidates.length > 1) {
            const ranked = disambiguateSymbols(baseCandidates, uri);
            baseSymbol = ranked[0];
          }

          connection.console.log(
            `[Server] Found base symbol: ${baseSymbol.name} at ${baseSymbol.location.uri}:${baseSymbol.location.line}`
          );

          // Step 2: Recursively resolve the property chain
          const fileResolver = async (fileUri: string) => {
            try {
              return fs.readFileSync(fileUri, 'utf-8');
            } catch {
              return '';
            }
          };

          const symbolFinder = async (name: string, fileUri?: string) => {
            if (fileUri) {
              const fileSymbols = await mergedIndex.getFileSymbols(fileUri);
              return fileSymbols.filter(sym => sym.name === name);
            }
            return await mergedIndex.findDefinitions(name);
          };

          const resolved = await resolvePropertyRecursively(
            baseSymbol,
            memberAccess.propertyChain,
            fileResolver,
            symbolFinder,
            typeScriptService.isInitialized() ? typeScriptService : undefined
          );

          if (resolved) {
            const duration = Date.now() - start;
            profiler.record('definition', duration);
            statsManager.updateProfilingMetrics({ avgDefinitionTimeMs: profiler.getAverageMs('definition') });
            
            connection.console.log(
              `[Server] Recursive resolution succeeded: ${memberAccess.baseName}.${memberAccess.propertyChain.join('.')} ` +
              `-> ${resolved.location.uri}:${resolved.location.line} in ${duration} ms`
            );

            return {
              uri: URI.file(resolved.location.uri).toString(),
              range: {
                start: { line: resolved.range.startLine, character: resolved.range.startCharacter },
                end: { line: resolved.range.endLine, character: resolved.range.endCharacter }
              }
            };
          } else {
            connection.console.log(`[Server] Recursive resolution failed, falling back to standard resolution`);
          }
        }
      }

      // Try to resolve the exact symbol at the cursor position
      const symbolAtCursor = findSymbolAtPosition(uri, text, line, character);
      
      if (symbolAtCursor) {
        connection.console.log(
          `[Server] Resolved symbol: name="${symbolAtCursor.name}", kind="${symbolAtCursor.kind}", ` +
          `container="${symbolAtCursor.containerName || '<none>'}", isStatic=${symbolAtCursor.isStatic}`
        );

        // Check if this symbol is an import - if so, resolve it
        if (importResolver) {
          const imports = await mergedIndex.getFileImports(uri);
          const importInfo = importResolver.findImportForSymbol(symbolAtCursor.name, imports);
          
          if (importInfo) {
            connection.console.log(`[Server] Symbol is imported from: ${importInfo.moduleSpecifier}`);
            
            // Resolve the module to a file path
            const resolvedPath = importResolver.resolveImport(importInfo.moduleSpecifier, uri);
            
            if (resolvedPath) {
              connection.console.log(`[Server] Resolved import to: ${resolvedPath}`);
              
              // Search only in the resolved file
              let targetSymbols = await mergedIndex.getFileSymbols(resolvedPath);
              let matchingSymbols = targetSymbols.filter(sym => sym.name === symbolAtCursor.name);
              
              // If not found, check if it's a re-export (barrel file)
              if (matchingSymbols.length === 0) {
                connection.console.log(`[Server] Symbol not found in ${resolvedPath}, checking re-exports...`);
                const reExports = await mergedIndex.getFileReExports(resolvedPath);
                
                for (const reExport of reExports) {
                  // Check if this re-export includes our symbol
                  if (reExport.isAll || (reExport.exportedNames && reExport.exportedNames.includes(symbolAtCursor.name))) {
                    connection.console.log(`[Server] Found re-export for ${symbolAtCursor.name} from ${reExport.moduleSpecifier}`);
                    const reExportResults = await this.resolveReExport(
                      symbolAtCursor.name,
                      reExport.moduleSpecifier,
                      resolvedPath
                    );
                    if (reExportResults.length > 0) {
                      matchingSymbols = reExportResults;
                      break;
                    }
                  }
                }
              }
              
              if (matchingSymbols.length > 0) {
                const results = matchingSymbols.map(sym => ({
                  uri: URI.file(sym.location.uri).toString(),
                  range: {
                    start: { line: sym.range.startLine, character: sym.range.startCharacter },
                    end: { line: sym.range.endLine, character: sym.range.endCharacter }
                  }
                }));
                
                const duration = Date.now() - start;
                profiler.record('definition', duration);
                statsManager.updateProfilingMetrics({ avgDefinitionTimeMs: profiler.getAverageMs('definition') });
                
                connection.console.log(`[Server] Definition result (import-resolved): ${results.length} locations in ${duration} ms`);
                return results;
              }
            } else {
              connection.console.log(`[Server] Could not resolve import path for: ${importInfo.moduleSpecifier}`);
            }
          }
        }

        // Standard resolution: get all candidates by name
        const candidates = await mergedIndex.findDefinitions(symbolAtCursor.name);
        connection.console.log(`[Server] Found ${candidates.length} candidates by name`);

        // Filter candidates to match the exact symbol
        const filtered = candidates.filter(candidate => {
          const nameMatch = candidate.name === symbolAtCursor.name;
          const kindMatch = candidate.kind === symbolAtCursor.kind || 
                           (symbolAtCursor.kind === 'function' && candidate.kind === 'method') ||
                           (symbolAtCursor.kind === 'property' && candidate.kind === 'method');
          const containerMatch = !symbolAtCursor.containerName || 
                                candidate.containerName === symbolAtCursor.containerName;
          const staticMatch = symbolAtCursor.isStatic === undefined || 
                             candidate.isStatic === symbolAtCursor.isStatic;
          
          return nameMatch && kindMatch && containerMatch && staticMatch;
        });

        connection.console.log(`[Server] Filtered to ${filtered.length} exact matches`);

        if (filtered.length > 0) {
          // If multiple candidates remain, use TypeScript for semantic disambiguation
          let finalCandidates = filtered;
          if (filtered.length > 1) {
            connection.console.log(`[Server] Multiple candidates detected, attempting TypeScript disambiguation...`);
            finalCandidates = await this.disambiguateWithTypeScript(
              filtered,
              uri,
              text,
              line,
              character,
              200 // 200ms timeout
            );
          }
          
          // Apply disambiguation heuristics as final ranking
          const ranked = disambiguateSymbols(finalCandidates, uri, symbolAtCursor.containerName);
          
          const results = ranked.map(sym => ({
            uri: URI.file(sym.location.uri).toString(),
            range: {
              start: { line: sym.range.startLine, character: sym.range.startCharacter },
              end: { line: sym.range.endLine, character: sym.range.endCharacter }
            }
          }));

          const duration = Date.now() - start;
          profiler.record('definition', duration);
          statsManager.updateProfilingMetrics({ avgDefinitionTimeMs: profiler.getAverageMs('definition') });
          
          connection.console.log(`[Server] Definition result: ${results.length} locations (ranked) in ${duration} ms`);
          return results;
        }
      }

      // Fallback: use simple word-based lookup
      const offset = document.offsetAt(params.position);
      const wordRange = getWordRangeAtPosition(text, offset);
      if (!wordRange) {
        connection.console.log(`[Server] Definition result: no word at position, ${Date.now() - start} ms`);
        return null;
      }

      const word = text.substring(wordRange.start, wordRange.end);
      let symbols = await mergedIndex.findDefinitions(word);

      // Apply ranking heuristics even for fallback
      if (symbols.length > 1) {
        symbols = disambiguateSymbols(symbols, uri);
      }

      const results = symbols.length === 0 ? null : symbols.map(sym => ({
        uri: URI.file(sym.location.uri).toString(),
        range: {
          start: { line: sym.range.startLine, character: sym.range.startCharacter },
          end: { line: sym.range.endLine, character: sym.range.endCharacter }
        }
      }));

      const duration = Date.now() - start;
      profiler.record('definition', duration);
      statsManager.updateProfilingMetrics({ avgDefinitionTimeMs: profiler.getAverageMs('definition') });
      
      connection.console.log(`[Server] Definition result (fallback): symbol="${word}", ${symbols.length} locations in ${duration} ms`);
      return results;
    } catch (error) {
      const duration = Date.now() - start;
      connection.console.error(`[Server] Definition error: ${error}, ${duration} ms`);
      return null;
    }
  }

  /**
   * Recursively resolve re-exports to find the actual symbol definition.
   * Implements a depth-limited search to prevent infinite loops.
   */
  private async resolveReExport(
    symbolName: string,
    targetModulePath: string,
    fromFile: string,
    depth: number = 0,
    visited: Set<string> = new Set()
  ): Promise<IndexedSymbol[]> {
    const MAX_DEPTH = 5;
    const { connection, mergedIndex } = this.services;
    const { importResolver } = this.state;
    
    if (depth >= MAX_DEPTH) {
      connection.console.warn(`[Server] Re-export recursion limit reached for ${symbolName}`);
      return [];
    }
    
    if (visited.has(targetModulePath)) {
      connection.console.warn(`[Server] Circular re-export detected: ${targetModulePath}`);
      return [];
    }
    
    visited.add(targetModulePath);
    
    // Resolve the module path to an actual file
    if (!importResolver) {
      return [];
    }
    
    const resolvedPath = importResolver.resolveImport(targetModulePath, fromFile);
    if (!resolvedPath) {
      connection.console.log(`[Server] Could not resolve re-export module: ${targetModulePath}`);
      return [];
    }
    
    connection.console.log(`[Server] Following re-export to: ${resolvedPath} (depth ${depth})`);
    
    // Get symbols from the target file
    const targetSymbols = await mergedIndex.getFileSymbols(resolvedPath);
    const matchingSymbols = targetSymbols.filter(sym => sym.name === symbolName);
    
    if (matchingSymbols.length > 0) {
      connection.console.log(`[Server] Found ${matchingSymbols.length} symbols in re-export target`);
      return matchingSymbols;
    }
    
    // If not found, check if the target file also re-exports the symbol
    const targetReExports = await mergedIndex.getFileReExports(resolvedPath);
    for (const reExport of targetReExports) {
      if (reExport.isAll || (reExport.exportedNames && reExport.exportedNames.includes(symbolName))) {
        const nestedResults = await this.resolveReExport(
          symbolName,
          reExport.moduleSpecifier,
          resolvedPath,
          depth + 1,
          visited
        );
        if (nestedResults.length > 0) {
          return nestedResults;
        }
      }
    }
    
    return [];
  }

  /**
   * Use TypeScript service to disambiguate when multiple candidates exist.
   * Returns filtered candidates based on semantic analysis.
   */
  private async disambiguateWithTypeScript(
    candidates: IndexedSymbol[],
    fileName: string,
    content: string,
    line: number,
    character: number,
    timeoutMs: number = 200
  ): Promise<IndexedSymbol[]> {
    const { connection, typeScriptService } = this.services;
    
    if (!typeScriptService.isInitialized()) {
      connection.console.log('[Server] TypeScript service not initialized, skipping disambiguation');
      return candidates;
    }

    try {
      // Calculate offset from line/character
      const lines = content.split('\n');
      let offset = 0;
      for (let i = 0; i < line && i < lines.length; i++) {
        offset += lines[i].length + 1; // +1 for newline
      }
      offset += character;

      // Race the TS service call against a timeout
      const disambiguationPromise = new Promise<IndexedSymbol[]>((resolve) => {
        (async () => {
          // Get semantic details from TypeScript
          const symbolDetails = typeScriptService.getSymbolDetails(fileName, offset);
          
          if (!symbolDetails) {
            connection.console.log('[Server] TypeScript service could not resolve symbol details');
            resolve(candidates);
            return;
          }

          connection.console.log(
            `[Server] TS symbol details: name="${symbolDetails.name}", kind="${symbolDetails.kind}", ` +
            `container="${symbolDetails.containerName || '<none>'}", containerKind="${symbolDetails.containerKind || '<none>'}"`
          );

          // Filter candidates based on semantic information
          const filtered = candidates.filter(candidate => {
            // Name must match
            if (candidate.name !== symbolDetails.name) {
              return false;
            }

            // If TS found a container, filter by it
            if (symbolDetails.containerName) {
              // Exact container match
              if (candidate.containerName === symbolDetails.containerName) {
                return true;
              }
              // Check if full container path matches
              if (candidate.fullContainerPath && 
                  candidate.fullContainerPath.endsWith(symbolDetails.containerName)) {
                return true;
              }
              // No container match
              return false;
            }

            // If no container from TS, prefer candidates without container (global scope)
            if (!symbolDetails.containerName && !candidate.containerName) {
              return true;
            }

            // Kind matching as secondary filter
            if (candidate.kind === symbolDetails.kind) {
              return true;
            }

            return false;
          });

          if (filtered.length > 0) {
            connection.console.log(`[Server] TypeScript disambiguation: ${candidates.length} → ${filtered.length} candidates`);
            resolve(filtered);
          } else {
            connection.console.log('[Server] TypeScript disambiguation filtered all candidates, keeping original set');
            resolve(candidates);
          }
        })();
      });

      const timeoutPromise = new Promise<IndexedSymbol[]>((resolve) => {
        setTimeout(() => {
          connection.console.warn(`[Server] TypeScript disambiguation timed out after ${timeoutMs}ms`);
          resolve(candidates);
        }, timeoutMs);
      });

      return await Promise.race([disambiguationPromise, timeoutPromise]);
    } catch (error) {
      connection.console.error(`[Server] Error in TypeScript disambiguation: ${error}`);
      return candidates;
    }
  }
}

/**
 * Factory function for creating DefinitionHandler.
 * Used with HandlerRegistry.register().
 */
export function createDefinitionHandler(
  services: ServerServices,
  state: ServerState
): DefinitionHandler {
  return new DefinitionHandler(services, state);
}
