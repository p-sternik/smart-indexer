/**
 * DefinitionHandler - Handles LSP textDocument/definition requests.
 * 
 * Responsibilities:
 * - Resolve symbol at cursor position
 * - Handle member expression chains (e.g., myStore.actions.opened)
 * - Resolve imports and re-exports
 * - TypeScript-based disambiguation for multiple candidates
 * - Deduplicate results to prevent duplicate locations in the same file
 * 
 * This handler implements the core "Go to Definition" functionality.
 */

import {
  DefinitionParams,
  Location
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import * as fsPromises from 'fs/promises';

import { IHandler, ServerServices, ServerState } from './types.js';
import { IndexedSymbol } from '../types.js';
import { findSymbolAtPosition } from '../indexer/symbolResolver.js';
import { parseMemberAccess, resolvePropertyRecursively } from '../indexer/recursiveResolver.js';
import { disambiguateSymbols } from '../utils/disambiguation.js';
import { getWordRangeAtPosition } from '../utils/textUtils.js';

/**
 * Symbol kinds that represent primary definitions (classes, functions, etc.)
 * These are prioritized over secondary kinds like decorators or constructors.
 */
const PRIMARY_DEFINITION_KINDS = new Set([
  'class',
  'interface',
  'function',
  'enum',
  'type',
  'variable',
  'constant'
]);

/**
 * Filter precision results to remove unwanted matches:
 * 1. Remove self-references (same file + overlapping cursor position)
 * 2. Remove import statements (ImportSpecifier, ImportDeclaration, ImportClause, etc.)
 * 3. Prefer exact name matches over fuzzy matches
 */
function filterPrecisionResults(
  symbols: IndexedSymbol[],
  requestUri: string,
  requestLine: number,
  requestCharacter: number,
  requestedName: string
): IndexedSymbol[] {
  return symbols.filter(symbol => {
    // FILTER 1: Remove self-reference (cursor overlaps with result)
    if (symbol.location.uri === requestUri) {
      const cursorInRange = 
        requestLine >= symbol.range.startLine &&
        requestLine <= symbol.range.endLine &&
        (requestLine !== symbol.range.startLine || requestCharacter >= symbol.range.startCharacter) &&
        (requestLine !== symbol.range.endLine || requestCharacter <= symbol.range.endCharacter);
      
      if (cursorInRange) {
        return false; // Skip self-reference
      }
    }

    // FILTER 2: Remove ALL import-related kinds (we want the definition, not the import)
    const importKinds = [
      'import',
      'ImportSpecifier',
      'ImportDeclaration',
      'ImportClause',
      'ImportDefaultSpecifier',
      'ImportNamespaceSpecifier',
      'NamedImports',
      'NamespaceImport'
    ];
    
    if (importKinds.includes(symbol.kind)) {
      return false;
    }

    // FILTER 3: Exact name match preferred (already handled by caller, but double-check)
    if (symbol.name !== requestedName) {
      return false;
    }

    return true;
  });
}

/**
 * Deduplicate definition results to ensure only one location per file.
 * 
 * When multiple symbols in the same file match (e.g., Class + Constructor, or
 * @Component decorator + class declaration), this function picks the best one:
 * 1. Prioritize class/interface/function/enum/type over constructors/methods/decorators
 * 2. If both are primary kinds and within 5 lines, pick the first (class over interface)
 * 3. If both are secondary and close, pick the one with exact name match to requested name
 * 4. Otherwise, pick the primary definition kind
 * 
 * @param symbols - Array of indexed symbols to deduplicate
 * @returns Deduplicated array with at most one symbol per file
 */
function deduplicateByFile(symbols: IndexedSymbol[]): IndexedSymbol[] {
  if (symbols.length <= 1) {
    return symbols;
  }
  
  // Group symbols by file URI
  const byFile = new Map<string, IndexedSymbol[]>();
  for (const symbol of symbols) {
    const uri = symbol.location.uri;
    const existing = byFile.get(uri);
    if (existing) {
      existing.push(symbol);
    } else {
      byFile.set(uri, [symbol]);
    }
  }
  
  // Pick the best symbol from each file
  const results: IndexedSymbol[] = [];
  for (const fileSymbols of byFile.values()) {
    if (fileSymbols.length === 1) {
      results.push(fileSymbols[0]);
      continue;
    }
    
    // Multiple symbols in the same file - pick the best one
    let best = fileSymbols[0];
    for (let i = 1; i < fileSymbols.length; i++) {
      const candidate = fileSymbols[i];
      best = pickBetterSymbol(best, candidate);
    }
    results.push(best);
  }
  
  return results;
}

/**
 * Compare two symbols and return the "better" one for Go to Definition.
 * 
 * Priority logic:
 * 1. Primary definition kinds (class, interface, function) ALWAYS win over secondary (constructor, method)
 * 2. If both are primary, prefer class > interface > function > enum > type
 * 3. If both are secondary, prefer the one at an earlier line (constructor before method)
 * 4. Special case: If one is 'class' and the other is 'constructor', always pick 'class'
 */
function pickBetterSymbol(a: IndexedSymbol, b: IndexedSymbol): IndexedSymbol {
  const aIsPrimary = PRIMARY_DEFINITION_KINDS.has(a.kind);
  const bIsPrimary = PRIMARY_DEFINITION_KINDS.has(b.kind);
  
  // Special case: Class vs Constructor -> always pick Class
  if (a.kind === 'class' && b.kind === 'constructor') {
    return a;
  }
  if (b.kind === 'class' && a.kind === 'constructor') {
    return b;
  }
  
  // Rule 1: Primary kinds ALWAYS win over secondary
  if (aIsPrimary && !bIsPrimary) {
    return a;
  }
  if (bIsPrimary && !aIsPrimary) {
    return b;
  }
  
  // Rule 2: Both are primary - use kind priority ranking
  if (aIsPrimary && bIsPrimary) {
    const kindPriority: Record<string, number> = {
      'class': 1,
      'interface': 2,
      'function': 3,
      'enum': 4,
      'type': 5,
      'variable': 6,
      'constant': 7
    };
    
    const aPriority = kindPriority[a.kind] ?? 999;
    const bPriority = kindPriority[b.kind] ?? 999;
    
    if (aPriority < bPriority) {
      return a;
    }
    if (bPriority < aPriority) {
      return b;
    }
    
    // Same priority - pick the first one (earlier in file)
    return a.location.line <= b.location.line ? a : b;
  }
  
  // Rule 3: Both are secondary - pick the earlier one
  return a.location.line <= b.location.line ? a : b;
}

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
    
    const { documents, mergedIndex, profiler, statsManager, typeScriptService, logger } = this.services;
    const { importResolver } = this.state;
    
    logger.info(`[Server] Definition request: ${uri}:${line}:${character}`);
    
    try {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        logger.info(`[Server] Definition result: document not found, 0 ms`);
        return null;
      }

      const text = document.getText();

      // Check if this is a member expression (e.g., myStore.actions.opened)
      const memberAccess = parseMemberAccess(text, line, character);
      if (memberAccess && memberAccess.propertyChain.length > 0) {
        logger.info(
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

          logger.info(
            `[Server] Found base symbol: ${baseSymbol.name} at ${baseSymbol.location.uri}:${baseSymbol.location.line}`
          );

          // Step 2: Recursively resolve the property chain
          const fileResolver = async (fileUri: string) => {
            try {
              return await fsPromises.readFile(fileUri, 'utf-8');
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
            
            logger.info(
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
            logger.info(`[Server] Recursive resolution failed, falling back to standard resolution`);
          }
        }
      }

      // Try to resolve the exact symbol at the cursor position
      const symbolAtCursor = findSymbolAtPosition(uri, text, line, character);
      
      if (symbolAtCursor) {
        logger.info(
          `[Server] Resolved symbol: name="${symbolAtCursor.name}", kind="${symbolAtCursor.kind}", ` +
          `container="${symbolAtCursor.containerName || '<none>'}", isStatic=${symbolAtCursor.isStatic}`
        );

        // Check if this symbol is an import - if so, resolve it
        if (importResolver) {
          const imports = await mergedIndex.getFileImports(uri);
          const importInfo = importResolver.findImportForSymbol(symbolAtCursor.name, imports);
          
          if (importInfo) {
            logger.info(`[Server] Symbol is imported from: ${importInfo.moduleSpecifier}`);
            
            // Resolve the module to a file path
            const resolvedPath = await importResolver.resolveImport(importInfo.moduleSpecifier, uri);
            
            if (resolvedPath) {
              logger.info(`[Server] Resolved import to: ${resolvedPath}`);
              
              // Search only in the resolved file
              let targetSymbols = await mergedIndex.getFileSymbols(resolvedPath);
              
              // CRITICAL FIX: Filter by isDefinition === true to get only the actual definition
              targetSymbols = targetSymbols.filter(sym => sym.isDefinition === true);
              
              let matchingSymbols = targetSymbols.filter(sym => sym.name === symbolAtCursor.name);
              logger.info(`[Server] Found ${matchingSymbols.length} definition symbols in ${resolvedPath}`);
              
              // If not found, check if it's a re-export (barrel file)
              if (matchingSymbols.length === 0) {
                logger.info(`[Server] Symbol not found in ${resolvedPath}, checking re-exports...`);
                const reExports = await mergedIndex.getFileReExports(resolvedPath);
                
                for (const reExport of reExports) {
                  // Check if this re-export includes our symbol
                  if (reExport.isAll || (reExport.exportedNames && reExport.exportedNames.includes(symbolAtCursor.name))) {
                    logger.info(`[Server] Found re-export for ${symbolAtCursor.name} from ${reExport.moduleSpecifier}`);
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
                // Apply precision filters
                let filteredSymbols = filterPrecisionResults(
                  matchingSymbols,
                  uri,
                  line,
                  character,
                  symbolAtCursor.name
                );

                // Deduplicate to ensure one location per file
                const deduplicated = deduplicateByFile(filteredSymbols);
                const results = deduplicated.map(sym => ({
                  uri: URI.file(sym.location.uri).toString(),
                  range: {
                    start: { line: sym.range.startLine, character: sym.range.startCharacter },
                    end: { line: sym.range.endLine, character: sym.range.endCharacter }
                  }
                }));
                
                const duration = Date.now() - start;
                profiler.record('definition', duration);
                statsManager.updateProfilingMetrics({ avgDefinitionTimeMs: profiler.getAverageMs('definition') });
                
                logger.info(`[Server] Definition result (import-resolved): ${matchingSymbols.length} → ${results.length} locations in ${duration} ms`);
                return results;
              }
            } else {
              logger.info(`[Server] Could not resolve import path for: ${importInfo.moduleSpecifier}`);
            }
          }
        }

        // Standard resolution: get all candidates by name
        const candidates = await mergedIndex.findDefinitions(symbolAtCursor.name);
        logger.info(`[Server] Found ${candidates.length} candidates by name`);
        
        // DEBUG: Log each candidate's isDefinition status
        candidates.forEach((c, idx) => {
          logger.info(`[Server] Candidate ${idx}: ${c.name} (${c.kind}) isDefinition=${c.isDefinition} in ${c.filePath?.substring(c.filePath.lastIndexOf('\\') + 1) || 'unknown'}`);
        });

        // PRECISION FILTER 1: Only return symbols marked as definitions
        let definitionCandidates = candidates.filter(candidate => candidate.isDefinition === true);
        logger.info(`[Server] Filtered to ${definitionCandidates.length} definition symbols (isDefinition=true)`);
        
        // PRECISION FILTER 2: Apply comprehensive filters (self-reference, imports)
        definitionCandidates = filterPrecisionResults(
          definitionCandidates,
          uri,
          line,
          character,
          symbolAtCursor.name
        );
        logger.info(`[Server] After precision filtering: ${definitionCandidates.length} candidates`);

        // Filter candidates to match the exact symbol
        const filtered = definitionCandidates.filter(candidate => {
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

        logger.info(`[Server] Filtered to ${filtered.length} exact matches`);

        if (filtered.length > 0) {
          // If multiple candidates remain, use TypeScript for semantic disambiguation
          let finalCandidates = filtered;
          if (filtered.length > 1) {
            logger.info(`[Server] Multiple candidates detected, attempting TypeScript disambiguation...`);
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
          
          // Deduplicate to ensure one location per file
          const deduplicated = deduplicateByFile(ranked);
          const results = deduplicated.map(sym => ({
            uri: URI.file(sym.location.uri).toString(),
            range: {
              start: { line: sym.range.startLine, character: sym.range.startCharacter },
              end: { line: sym.range.endLine, character: sym.range.endCharacter }
            }
          }));

          const duration = Date.now() - start;
          profiler.record('definition', duration);
          statsManager.updateProfilingMetrics({ avgDefinitionTimeMs: profiler.getAverageMs('definition') });
          
          logger.info(`[Server] Definition result: ${ranked.length} → ${results.length} locations (deduplicated) in ${duration} ms`);
          return results;
        }
      }

      // Fallback: use simple word-based lookup with timeout
      const offset = document.offsetAt(params.position);
      const wordRange = getWordRangeAtPosition(text, offset);
      if (!wordRange) {
        logger.info(`[Server] Definition result: no word at position, ${Date.now() - start} ms`);
        return null;
      }

      const word = text.substring(wordRange.start, wordRange.end);
      
      // OPTIMIZATION: Apply timeout to fallback search to prevent 30s+ delays
      const FALLBACK_TIMEOUT_MS = 500;
      const fallbackPromise = this.executeFallbackSearch(word, uri, line, character);
      const timeoutPromise = new Promise<Location[] | null>((resolve) => {
        setTimeout(() => {
          logger.warn(`[Server] Fallback search timed out after ${FALLBACK_TIMEOUT_MS}ms for "${word}"`);
          resolve(null);
        }, FALLBACK_TIMEOUT_MS);
      });
      
      const results = await Promise.race([fallbackPromise, timeoutPromise]);

      const duration = Date.now() - start;
      profiler.record('definition', duration);
      statsManager.updateProfilingMetrics({ avgDefinitionTimeMs: profiler.getAverageMs('definition') });
      
      logger.info(`[Server] Definition result (fallback): symbol="${word}", ${results ? results.length : 0} locations in ${duration} ms`);
      return results;
    } catch (error) {
      const duration = Date.now() - start;
      logger.error(`[Server] Definition error: ${error}, ${duration} ms`);
      return null;
    }
  }

  /**
   * Execute fallback search with optimizations to prevent extreme latency.
   * 
   * Optimizations:
   * 1. Filter by isDefinition=true to reduce noise
   * 2. Exclude cursor position to prevent self-reference
   * 3. Limit result processing for large result sets
   */
  private async executeFallbackSearch(
    word: string,
    uri: string,
    line: number,
    character: number
  ): Promise<Location[] | null> {
    const { mergedIndex, logger } = this.services;
    
    let symbols = await mergedIndex.findDefinitions(word);
    logger.info(`[Server] Fallback: Found ${symbols.length} candidates for "${word}"`);
    
    // OPTIMIZATION 1: Filter by isDefinition to get only actual definitions
    symbols = symbols.filter(sym => sym.isDefinition === true);
    logger.info(`[Server] Fallback: Filtered to ${symbols.length} definition symbols`);
    
    // OPTIMIZATION 2: Apply precision filters (self-reference, imports, exact name match)
    symbols = filterPrecisionResults(symbols, uri, line, character, word);
    logger.info(`[Server] Fallback: After precision filtering: ${symbols.length} candidates`);
    
    // OPTIMIZATION 3: Limit processing for large result sets
    const MAX_FALLBACK_RESULTS = 50;
    if (symbols.length > MAX_FALLBACK_RESULTS) {
      logger.info(`[Server] Fallback: Limiting to first ${MAX_FALLBACK_RESULTS} results (${symbols.length} total)`);
      symbols = symbols.slice(0, MAX_FALLBACK_RESULTS);
    }

    // Apply ranking heuristics
    if (symbols.length > 1) {
      symbols = disambiguateSymbols(symbols, uri);
    }
    
    // Deduplicate to ensure one location per file
    const deduplicated = deduplicateByFile(symbols);

    if (deduplicated.length === 0) {
      return null;
    }

    return deduplicated.map(sym => ({
      uri: URI.file(sym.location.uri).toString(),
      range: {
        start: { line: sym.range.startLine, character: sym.range.startCharacter },
        end: { line: sym.range.endLine, character: sym.range.endCharacter }
      }
    }));
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
    const { mergedIndex, logger } = this.services;
    const { importResolver } = this.state;
    
    if (depth >= MAX_DEPTH) {
      logger.warn(`[Server] Re-export recursion limit reached for ${symbolName}`);
      return [];
    }
    
    if (visited.has(targetModulePath)) {
      logger.warn(`[Server] Circular re-export detected: ${targetModulePath}`);
      return [];
    }
    
    visited.add(targetModulePath);
    
    // Resolve the module path to an actual file
    if (!importResolver) {
      return [];
    }
    
    const resolvedPath = await importResolver.resolveImport(targetModulePath, fromFile);
    if (!resolvedPath) {
      logger.info(`[Server] Could not resolve re-export module: ${targetModulePath}`);
      return [];
    }
    
    logger.info(`[Server] Following re-export to: ${resolvedPath} (depth ${depth})`);
    
    // Get symbols from the target file and filter by isDefinition === true
    let targetSymbols = await mergedIndex.getFileSymbols(resolvedPath);
    targetSymbols = targetSymbols.filter(sym => sym.isDefinition === true);
    const matchingSymbols = targetSymbols.filter(sym => sym.name === symbolName);
    
    if (matchingSymbols.length > 0) {
      logger.info(`[Server] Found ${matchingSymbols.length} definition symbols in re-export target`);
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
    const { typeScriptService, logger } = this.services;
    
    if (!typeScriptService.isInitialized()) {
      logger.info('[Server] TypeScript service not initialized, skipping disambiguation');
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
            logger.info('[Server] TypeScript service could not resolve symbol details');
            resolve(candidates);
            return;
          }

          logger.info(
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
            logger.info(`[Server] TypeScript disambiguation: ${candidates.length} → ${filtered.length} candidates`);
            resolve(filtered);
          } else {
            logger.info('[Server] TypeScript disambiguation filtered all candidates, keeping original set');
            resolve(candidates);
          }
        })();
      });

      const timeoutPromise = new Promise<IndexedSymbol[]>((resolve) => {
        setTimeout(() => {
          logger.warn(`[Server] TypeScript disambiguation timed out after ${timeoutMs}ms`);
          resolve(candidates);
        }, timeoutMs);
      });

      return await Promise.race([disambiguationPromise, timeoutPromise]);
    } catch (error) {
      logger.error(`[Server] Error in TypeScript disambiguation: ${error}`);
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
