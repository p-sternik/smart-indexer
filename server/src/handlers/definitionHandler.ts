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
import { shouldEnableLooseMode } from '../utils/ngrxContextDetector.js';

/**
 * Handler for textDocument/definition requests.
 */
export class DefinitionHandler implements IHandler {
  readonly name = 'DefinitionHandler';
  
  private services: ServerServices;
  private state: ServerState;
  
  // Query result cache (LRU) to eliminate redundant I/O + filtering
  private queryCache: Map<string, Location | Location[] | null> = new Map();
  private readonly QUERY_CACHE_MAX_SIZE = 500;

  constructor(services: ServerServices, state: ServerState) {
    this.services = services;
    this.state = state;
  }
  
  /**
   * Invalidate cache entries for a specific file URI.
   * Called when a file is modified to ensure cache coherence.
   */
  invalidateCacheForFile(uri: string): void {
    const keysToDelete: string[] = [];
    for (const key of this.queryCache.keys()) {
      if (key.startsWith(uri + ':')) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.queryCache.delete(key);
    }
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
    
    const { documents, mergedIndex, profiler, statsManager, typeScriptService, logger, requestTracer } = this.services;
    const { importResolver } = this.state;
    
    // OPTIMIZATION: Check query cache FIRST (0ms latency for repeated clicks)
    const cacheKey = `${uri}:${line}:${character}`;
    const cached = this.queryCache.get(cacheKey);
    if (cached !== undefined) {
      // Start trace for cache hit
      const trace = requestTracer.start('definition', '<cached>', uri, `${line}:${character}`, false);
      trace.addFilter('QueryCache');
      trace.recordCacheHit();
      const completedTrace = trace.end(Array.isArray(cached) ? cached.length : (cached ? 1 : 0));
      requestTracer.recordTrace(completedTrace);
      
      // Move to end for LRU (delete + re-add makes it most recently used)
      this.queryCache.delete(cacheKey);
      this.queryCache.set(cacheKey, cached);
      
      logger.info(`[Server] Definition cache hit: ${uri}:${line}:${character} in ${completedTrace.timings.totalMs}ms`);
      return cached;
    }
    
    logger.info(`[Server] Definition request: ${uri}:${line}:${character}`);
    
    // Start trace session
    const trace = requestTracer.start('definition', '<resolving>', uri, `${line}:${character}`, false);
    let result: Location | Location[] | null = null;
    
    try {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        logger.info(`[Server] Definition result: document not found`);
        return null;
      }

      const text = document.getText();
      
      // Update trace with resolved symbol name (will be updated later if found)
      let symbolName = '<unknown>';

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
            logger.info(
              `[Server] Recursive resolution succeeded: ${memberAccess.baseName}.${memberAccess.propertyChain.join('.')} ` +
              `-> ${resolved.location.uri}:${resolved.location.line}`
            );

            result = {
              uri: URI.file(resolved.location.uri).toString(),
              range: {
                start: { line: resolved.range.startLine, character: resolved.range.startCharacter },
                end: { line: resolved.range.endLine, character: resolved.range.endCharacter }
              }
            };
            
            trace.addFilter('RecursiveResolver');
            
            // Cache result with LRU eviction
            this.cacheResult(cacheKey, result);
            return result;
          } else {
            logger.info(`[Server] Recursive resolution failed, falling back to standard resolution`);
          }
        }
      }

      // Try to resolve the exact symbol at the cursor position
      const symbolAtCursor = findSymbolAtPosition(uri, text, line, character);
      
      if (symbolAtCursor) {
        symbolName = symbolAtCursor.name;
        logger.info(
          `[Server] Resolved symbol: name="${symbolName}", kind="${symbolAtCursor.kind}", ` +
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
                // Apply strict filtering pipeline (same 5 rules)
                logger.info(`[Server] Import-resolved: Applying strict filtering to ${matchingSymbols.length} symbols`);
                let filteredSymbols = matchingSymbols;
                
                // RULE 1: Self-reference already excluded (different file)
                // RULE 2: Code superiority
                const hasCodeDefs = filteredSymbols.some(s => s.isDefinition === true);
                if (hasCodeDefs) {
                  filteredSymbols = filteredSymbols.filter(s => s.kind !== 'text');
                }
                
                // RULE 3: Implementation over abstraction
                const byName = new Map<string, IndexedSymbol[]>();
                for (const sym of filteredSymbols) {
                  const existing = byName.get(sym.name);
                  if (existing) {
                    existing.push(sym);
                  } else {
                    byName.set(sym.name, [sym]);
                  }
                }
                
                const afterAbstraction: IndexedSymbol[] = [];
                for (const syms of byName.values()) {
                  const hasClass = syms.some(s => s.kind === 'class');
                  const hasInterface = syms.some(s => s.kind === 'interface');
                  if (hasClass && hasInterface) {
                    afterAbstraction.push(...syms.filter(s => s.kind === 'class'));
                  } else {
                    afterAbstraction.push(...syms);
                  }
                }
                filteredSymbols = afterAbstraction;
                
                // RULE 4: Import ban
                const importKinds = new Set([
                  'import', 'ImportSpecifier', 'ImportDeclaration', 'ImportClause',
                  'ImportDefaultSpecifier', 'ImportNamespaceSpecifier', 'NamedImports', 'NamespaceImport'
                ]);
                filteredSymbols = filteredSymbols.filter(s => !importKinds.has(s.kind));
                
                // RULE 5: Single winner
                if (filteredSymbols.length > 1) {
                  const kindPriority: Record<string, number> = {
                    'class': 1, 'function': 2, 'interface': 3, 'enum': 4,
                    'type': 5, 'variable': 6, 'constant': 7
                  };
                  const best = filteredSymbols.reduce((winner, current) => {
                    const winnerPri = kindPriority[winner.kind] ?? 999;
                    const currentPri = kindPriority[current.kind] ?? 999;
                    return currentPri < winnerPri ? current : winner;
                  });
                  filteredSymbols = [best];
                }

                const results = filteredSymbols.map(sym => ({
                  uri: URI.file(sym.location.uri).toString(),
                  range: {
                    start: { line: sym.range.startLine, character: sym.range.startCharacter },
                    end: { line: sym.range.endLine, character: sym.range.endCharacter }
                  }
                }));
                
                logger.info(`[Server] Definition result (import-resolved): ${matchingSymbols.length} → ${results.length} locations`);
                trace.addFilter('ImportResolved');
                
                // Cache result with LRU eviction
                this.cacheResult(cacheKey, results);
                result = results;
                return results;
              }
            } else {
              logger.info(`[Server] Could not resolve import path for: ${importInfo.moduleSpecifier}`);
            }
          }
        }

        // Standard resolution: get all candidates by name
        trace.startDbQuery();
        const candidates = await mergedIndex.findDefinitions(symbolAtCursor.name);
        trace.endDbQuery(candidates.length);
        
        logger.info(`[Server] Found ${candidates.length} candidates by name`);
        
        // DEBUG: Log each candidate's isDefinition status
        candidates.forEach((c, idx) => {
          logger.info(`[Server] Candidate ${idx}: ${c.name} (${c.kind}) isDefinition=${c.isDefinition} in ${c.filePath?.substring(c.filePath.lastIndexOf('\\') + 1) || 'unknown'}`);
        });

        // ============================================================
        // STRICT FILTERING PIPELINE FOR INSTANT JUMP (UX-FIRST)
        // ============================================================
        
        logger.info(`[Server] Starting strict filtering pipeline with ${candidates.length} candidates`);
        trace.startProcessing();
        
        let definitionCandidates = candidates;
        
        // RULE 1: Remove Self-Reference
        // If result URI == Request URI AND result Range contains Cursor Position -> DROP IT
        const beforeSelfRefFilter = definitionCandidates.length;
        definitionCandidates = definitionCandidates.filter(symbol => {
          if (symbol.location.uri === uri) {
            const cursorInRange = 
              line >= symbol.range.startLine &&
              line <= symbol.range.endLine &&
              (line !== symbol.range.startLine || character >= symbol.range.startCharacter) &&
              (line !== symbol.range.endLine || character <= symbol.range.endCharacter);
            return !cursorInRange; // Keep if cursor NOT in range
          }
          return true; // Keep if different file
        });
        if (beforeSelfRefFilter !== definitionCandidates.length) {
          logger.info(`[Server] Rule 1 (Self-Ref) - Removed ${beforeSelfRefFilter - definitionCandidates.length} self-references`);
        }
        
        // RULE 2: Code Superiority
        // If ANY result has isDefinition=true, DROP all kind='text' (Markdown/Comments)
        const hasCodeDefinitions = definitionCandidates.some(c => c.isDefinition === true);
        if (hasCodeDefinitions) {
          const beforeTextFilter = definitionCandidates.length;
          definitionCandidates = definitionCandidates.filter(c => c.kind !== 'text');
          if (beforeTextFilter !== definitionCandidates.length) {
            logger.info(`[Server] Rule 2 (Code Superiority) - Removed ${beforeTextFilter - definitionCandidates.length} text/markdown symbols`);
          }
        }
        
        // RULE 3: Implementation over Abstraction
        // If we have both Class AND Interface with same name, keep ONLY the Class
        const symbolsByName = new Map<string, IndexedSymbol[]>();
        for (const sym of definitionCandidates) {
          const existing = symbolsByName.get(sym.name);
          if (existing) {
            existing.push(sym);
          } else {
            symbolsByName.set(sym.name, [sym]);
          }
        }
        
        const beforeAbstractionFilter = definitionCandidates.length;
        const filteredByAbstraction: IndexedSymbol[] = [];
        for (const [name, symbols] of symbolsByName.entries()) {
          const hasClass = symbols.some(s => s.kind === 'class');
          const hasInterface = symbols.some(s => s.kind === 'interface');
          
          if (hasClass && hasInterface) {
            // Keep ONLY classes, drop interfaces
            filteredByAbstraction.push(...symbols.filter(s => s.kind === 'class'));
            logger.info(`[Server] Rule 3 (Implementation) - For "${name}": Kept class, dropped interface`);
          } else {
            // No conflict, keep all
            filteredByAbstraction.push(...symbols);
          }
        }
        definitionCandidates = filteredByAbstraction;
        if (beforeAbstractionFilter !== definitionCandidates.length) {
          logger.info(`[Server] Rule 3 (Implementation over Abstraction) - ${beforeAbstractionFilter} → ${definitionCandidates.length}`);
        }
        
        // RULE 4: Import Ban
        // Explicitly filter out kind='import' or ImportSpecifier variants
        // EXCEPTION: NgRx Actions - allow VariableDeclaration in loose mode
        const beforeImportFilter = definitionCandidates.length;
        const importKinds = new Set([
          'import',
          'ImportSpecifier',
          'ImportDeclaration',
          'ImportClause',
          'ImportDefaultSpecifier',
          'ImportNamespaceSpecifier',
          'NamedImports',
          'NamespaceImport'
        ]);
        
        // NgRx Context-Aware Filtering
        const lineContent = text.split('\n')[line] || '';
        const isNgRxLooseMode = shouldEnableLooseMode(text, symbolAtCursor.name, lineContent);
        
        if (isNgRxLooseMode) {
          logger.info(`[Server] NgRx Loose Mode ENABLED for symbol: ${symbolAtCursor.name}`);
          // In loose mode, allow VariableDeclaration (for const actions)
          // But still ban import statements
          definitionCandidates = definitionCandidates.filter(c => !importKinds.has(c.kind));
        } else {
          // Strict mode: ban imports AND prefer non-variable kinds
          definitionCandidates = definitionCandidates.filter(c => !importKinds.has(c.kind));
        }
        
        if (beforeImportFilter !== definitionCandidates.length) {
          logger.info(`[Server] Rule 4 (Import Ban) - Removed ${beforeImportFilter - definitionCandidates.length} import statements`);
        }
        
        // RULE 5: Single Winner (per file, then globally)
        // Within same file: pick earliest start line
        // Globally: if all exact name matches, return only 1 best result
        const beforeSingleWinner = definitionCandidates.length;
        if (definitionCandidates.length > 1) {
          // Group by file
          const byFile = new Map<string, IndexedSymbol[]>();
          for (const sym of definitionCandidates) {
            const existing = byFile.get(sym.location.uri);
            if (existing) {
              existing.push(sym);
            } else {
              byFile.set(sym.location.uri, [sym]);
            }
          }
          
          // Pick earliest in each file
          const onePerFile: IndexedSymbol[] = [];
          for (const fileSymbols of byFile.values()) {
            if (fileSymbols.length === 1) {
              onePerFile.push(fileSymbols[0]);
            } else {
              // Pick earliest start line
              const earliest = fileSymbols.reduce((best, current) => 
                current.range.startLine < best.range.startLine ? current : best
              );
              onePerFile.push(earliest);
            }
          }
          
          definitionCandidates = onePerFile;
          
          // If all have exact same name, return ONLY the best one globally
          if (definitionCandidates.length > 1) {
            const allSameName = definitionCandidates.every(s => s.name === symbolAtCursor.name);
            if (allSameName) {
              // Priority: class > function > interface > variable > others
              const kindPriority: Record<string, number> = {
                'class': 1,
                'function': 2,
                'interface': 3,
                'enum': 4,
                'type': 5,
                'variable': 6,
                'constant': 7,
                'method': 8,
                'property': 9
              };
              
              const best = definitionCandidates.reduce((winner, current) => {
                const winnerPriority = kindPriority[winner.kind] ?? 999;
                const currentPriority = kindPriority[current.kind] ?? 999;
                return currentPriority < winnerPriority ? current : winner;
              });
              
              definitionCandidates = [best];
              logger.info(`[Server] Rule 5 (Single Winner) - ${beforeSingleWinner} → 1 (best: ${best.kind} in ${best.filePath?.split(/[\\/]/).pop()})`);
            }
          }
        }
        
        logger.info(`[Server] Strict pipeline complete: ${candidates.length} → ${definitionCandidates.length} candidates`);

        logger.info(`[Server] Filtered to ${definitionCandidates.length} exact matches after strict pipeline`);

        if (definitionCandidates.length > 0) {
          // If multiple candidates remain, use TypeScript for semantic disambiguation
          let finalCandidates = definitionCandidates;
          if (definitionCandidates.length > 1) {
            logger.info(`[Server] Multiple candidates detected, attempting TypeScript disambiguation...`);
            finalCandidates = await this.disambiguateWithTypeScript(
              definitionCandidates,
              uri,
              text,
              line,
              character,
              500 // 500ms timeout (increased from 200ms for better precision)
            );
          }
          
          // Apply disambiguation heuristics as final ranking if still multiple
          let rankedCandidates = finalCandidates;
          if (finalCandidates.length > 1) {
            rankedCandidates = disambiguateSymbols(finalCandidates, uri, symbolAtCursor.containerName);
            
            // ULTRA-STRICT: Even after all filtering, return only 1 result for instant jump
            if (rankedCandidates.length > 1) {
              logger.info(`[Server] Multiple results remain, forcing single winner for instant jump`);
              rankedCandidates = [rankedCandidates[0]]; // Take the best-ranked one
            }
          }
          
          result = rankedCandidates.map(sym => ({
            uri: URI.file(sym.location.uri).toString(),
            range: {
              start: { line: sym.range.startLine, character: sym.range.startCharacter },
              end: { line: sym.range.endLine, character: sym.range.endCharacter }
            }
          }));

          trace.endProcessing();
          trace.addFilter('StrictPipeline');
          logger.info(`[Server] Definition result: ${candidates.length} → ${result.length} location(s)`);
          
          // Cache result with LRU eviction
          this.cacheResult(cacheKey, result);
          return result;
        }
      }

      // Fallback: use simple word-based lookup with timeout
      const offset = document.offsetAt(params.position);
      const wordRange = getWordRangeAtPosition(text, offset);
      if (!wordRange) {
        logger.info(`[Server] Definition result: no word at position`);
        return null;
      }

      const word = text.substring(wordRange.start, wordRange.end);
      symbolName = word;
      
      // CATASTROPHIC FALLBACK PREVENTION: Block searches for common keywords
      const COMMON_KEYWORDS = new Set([
        'path', 'fs', 'file', 'const', 'let', 'var', 'import', 'export',
        'function', 'class', 'interface', 'type', 'enum', 'namespace',
        'public', 'private', 'protected', 'static', 'readonly', 'async',
        'await', 'return', 'if', 'else', 'for', 'while', 'switch', 'case',
        'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new',
        'this', 'super', 'extends', 'implements', 'constructor', 'get', 'set',
        'true', 'false', 'null', 'undefined', 'void', 'any', 'unknown',
        'string', 'number', 'boolean', 'object', 'array', 'map', 'set',
        'promise', 'error', 'console', 'log', 'debug', 'info', 'warn'
      ]);
      
      if (COMMON_KEYWORDS.has(word.toLowerCase())) {
        logger.info(`[Server] Definition result (fallback blocked): "${word}" is a common keyword`);
        trace.addFilter('KeywordBlocked');
        return null;
      }
      
      // OPTIMIZATION: Apply timeout to fallback search to prevent 30s+ delays
      const FALLBACK_TIMEOUT_MS = 500;
      trace.addFilter('FallbackSearch');
      trace.startDbQuery();
      
      const fallbackPromise = this.executeFallbackSearch(word, uri, line, character);
      
      let timeoutId: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<Location[] | null>((resolve) => {
        timeoutId = setTimeout(() => {
          logger.warn(`[Server] Fallback search timed out after ${FALLBACK_TIMEOUT_MS}ms for "${word}"`);
          trace.logError(`Fallback timeout: ${FALLBACK_TIMEOUT_MS}ms`);
          resolve(null);
        }, FALLBACK_TIMEOUT_MS);
      });
      
      const results = await Promise.race([fallbackPromise, timeoutPromise]);
      
      // Clear timeout if search completed before timeout
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      
      trace.endDbQuery(results ? results.length : 0);
      
      logger.info(`[Server] Definition result (fallback): symbol="${word}", ${results ? results.length : 0} locations`);
      
      // Cache result with LRU eviction
      this.cacheResult(cacheKey, results);
      result = results;
      return results;
    } catch (error) {
      trace.logError(String(error));
      logger.error(`[Server] Definition error: ${error}`);
      
      // Cache null result to prevent repeated expensive failures
      this.cacheResult(cacheKey, null);
      result = null;
      return null;
    } finally {
      // CRITICAL: Ensure trace is ALWAYS recorded (cache hits, exceptions, normal flow)
      const resultCount = result ? (Array.isArray(result) ? result.length : 1) : 0;
      const completedTrace = trace.end(resultCount);
      requestTracer.recordTrace(completedTrace);
      
      profiler.record('definition', completedTrace.timings.totalMs);
      statsManager.updateProfilingMetrics({ avgDefinitionTimeMs: profiler.getAverageMs('definition') });
    }
  }
  
  /**
   * Cache a query result with LRU eviction policy.
   */
  private cacheResult(key: string, result: Location | Location[] | null): void {
    // Enforce LRU eviction before adding new entry
    if (this.queryCache.size >= this.QUERY_CACHE_MAX_SIZE) {
      // Delete oldest entry (first key in Map)
      const firstKey = this.queryCache.keys().next().value;
      if (firstKey !== undefined) {
        this.queryCache.delete(firstKey);
      }
    }
    
    this.queryCache.set(key, result);
  }

  /**
   * Execute fallback search with strict filtering for instant jumps.
   * 
   * Applies same 5-rule pipeline as main definition handler:
   * 1. Remove self-references
   * 2. Code superiority (drop text/markdown if code exists)
   * 3. Implementation over abstraction (class > interface)
   * 4. Import ban (no import statements)
   * 5. Single winner (prefer earliest, return 1 if possible)
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
    
    // STRICT FILTERING PIPELINE
    
    // RULE 1: Remove Self-Reference
    const beforeSelfRef = symbols.length;
    symbols = symbols.filter(symbol => {
      if (symbol.location.uri === uri) {
        const cursorInRange = 
          line >= symbol.range.startLine &&
          line <= symbol.range.endLine &&
          (line !== symbol.range.startLine || character >= symbol.range.startCharacter) &&
          (line !== symbol.range.endLine || character <= symbol.range.endCharacter);
        return !cursorInRange;
      }
      return true;
    });
    if (beforeSelfRef !== symbols.length) {
      logger.info(`[Server] Fallback Rule 1 - Removed ${beforeSelfRef - symbols.length} self-references`);
    }
    
    // RULE 2: Code Superiority
    const hasCodeDefinitions = symbols.some(s => s.isDefinition === true);
    if (hasCodeDefinitions) {
      const beforeText = symbols.length;
      symbols = symbols.filter(s => s.kind !== 'text');
      if (beforeText !== symbols.length) {
        logger.info(`[Server] Fallback Rule 2 - Removed ${beforeText - symbols.length} text symbols`);
      }
    }
    
    // RULE 3: Implementation over Abstraction
    const symbolsByName = new Map<string, IndexedSymbol[]>();
    for (const sym of symbols) {
      const existing = symbolsByName.get(sym.name);
      if (existing) {
        existing.push(sym);
      } else {
        symbolsByName.set(sym.name, [sym]);
      }
    }
    
    const beforeAbstraction = symbols.length;
    const filteredByAbstraction: IndexedSymbol[] = [];
    for (const [, syms] of symbolsByName.entries()) {
      const hasClass = syms.some(s => s.kind === 'class');
      const hasInterface = syms.some(s => s.kind === 'interface');
      
      if (hasClass && hasInterface) {
        filteredByAbstraction.push(...syms.filter(s => s.kind === 'class'));
      } else {
        filteredByAbstraction.push(...syms);
      }
    }
    symbols = filteredByAbstraction;
    if (beforeAbstraction !== symbols.length) {
      logger.info(`[Server] Fallback Rule 3 - ${beforeAbstraction} → ${symbols.length}`);
    }
    
    // RULE 4: Import Ban
    const beforeImport = symbols.length;
    const importKinds = new Set([
      'import', 'ImportSpecifier', 'ImportDeclaration', 'ImportClause',
      'ImportDefaultSpecifier', 'ImportNamespaceSpecifier', 'NamedImports', 'NamespaceImport'
    ]);
    symbols = symbols.filter(s => !importKinds.has(s.kind));
    if (beforeImport !== symbols.length) {
      logger.info(`[Server] Fallback Rule 4 - Removed ${beforeImport - symbols.length} imports`);
    }
    
    // RULE 5: Single Winner
    if (symbols.length > 1) {
      // Group by file, pick earliest in each
      const byFile = new Map<string, IndexedSymbol[]>();
      for (const sym of symbols) {
        const existing = byFile.get(sym.location.uri);
        if (existing) {
          existing.push(sym);
        } else {
          byFile.set(sym.location.uri, [sym]);
        }
      }
      
      const onePerFile: IndexedSymbol[] = [];
      for (const fileSymbols of byFile.values()) {
        if (fileSymbols.length === 1) {
          onePerFile.push(fileSymbols[0]);
        } else {
          const earliest = fileSymbols.reduce((best, current) => 
            current.range.startLine < best.range.startLine ? current : best
          );
          onePerFile.push(earliest);
        }
      }
      
      symbols = onePerFile;
      
      // If all same name, return best one globally
      if (symbols.length > 1) {
        const allSameName = symbols.every(s => s.name === word);
        if (allSameName) {
          const kindPriority: Record<string, number> = {
            'class': 1, 'function': 2, 'interface': 3, 'enum': 4,
            'type': 5, 'variable': 6, 'constant': 7
          };
          
          const best = symbols.reduce((winner, current) => {
            const winnerPriority = kindPriority[winner.kind] ?? 999;
            const currentPriority = kindPriority[current.kind] ?? 999;
            return currentPriority < winnerPriority ? current : winner;
          });
          
          symbols = [best];
          logger.info(`[Server] Fallback Rule 5 - Reduced to single best result: ${best.kind}`);
        }
      }
    }
    
    logger.info(`[Server] Fallback: After strict filtering: ${symbols.length} results`);

    if (symbols.length === 0) {
      return null;
    }

    return symbols.map(sym => ({
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
   * 
   * @param timeoutMs - Timeout in milliseconds (default: 500ms for better precision in large projects)
   */
  private async disambiguateWithTypeScript(
    candidates: IndexedSymbol[],
    fileName: string,
    content: string,
    line: number,
    character: number,
    timeoutMs: number = 500
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

      let timeoutId: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<IndexedSymbol[]>((resolve) => {
        timeoutId = setTimeout(() => {
          logger.warn(`[Server] TypeScript disambiguation timed out after ${timeoutMs}ms`);
          resolve(candidates);
        }, timeoutMs);
      });

      const result = await Promise.race([disambiguationPromise, timeoutPromise]);
      
      // Clear timeout if disambiguation completed before timeout
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      
      return result;
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
