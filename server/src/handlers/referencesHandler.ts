/**
 * ReferencesHandler - Handles LSP textDocument/references requests.
 * 
 * Responsibilities:
 * - Find all references to a symbol at cursor position
 * - Handle includeDeclaration parameter
 * - Support renamed imports (import { User as Admin })
 * - Support CommonJS require() patterns
 * - Deduplicate results
 * - Filter by container name for disambiguation
 * - Optimize for large codebases (avoid event loop blocking)
 * 
 * Strategy:
 * Phase 1: SQL-based candidate retrieval (fast filter)
 * Phase 2: Import-aware resolution (detective logic)
 * Phase 3: Content verification & ranking
 */

import {
  ReferenceParams,
  Location
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import * as path from 'path';

import { IHandler, ServerServices, ServerState } from './types.js';
import { findSymbolAtPosition } from '../indexer/symbolResolver.js';
import { getWordRangeAtPosition } from '../utils/textUtils.js';
import { ImportInfo, IndexedReference } from '../types.js';
import { FileIndexData } from '../storage/IIndexStorage.js';
import { 
  shouldEnableLooseMode, 
  extractActionTypeString,
  isNgRxReducerOrEffect 
} from '../utils/ngrxContextDetector.js';
import { RequestTracer } from '../utils/RequestTracer.js';

interface ReferenceCandidateMatch {
  uri: string;
  references: IndexedReference[];
  confidence: 'exact' | 'import' | 'loose' | 'ngrx-high' | 'ngrx-medium';
}

/**
 * Handler for textDocument/references requests.
 */
export class ReferencesHandler implements IHandler {
  readonly name = 'ReferencesHandler';
  
  private services: ServerServices;
  private requestTracer: RequestTracer;

  constructor(services: ServerServices, _state: ServerState) {
    this.services = services;
    this.requestTracer = new RequestTracer(services.logger);
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
    
    const { documents, mergedIndex, backgroundIndex, profiler, statsManager, logger, infrastructure } = this.services;
    
    // Forensic tracing: Capture start state
    const startMemoryMB = this.requestTracer.captureMemory();
    const ioTracker = this.requestTracer.createIOTracker();
    
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

        // Use enhanced import-aware reference finding
        const references = await this.findReferencesWithImportTracking(
          symbolAtCursor.name,
          uri,
          params.context.includeDeclaration,
          backgroundIndex
        );

        logger.info(`[Server] Found ${references.length} references with import tracking`);

        const results = references.map(ref => ({
          uri: URI.file(ref.location.uri).toString(),
          range: {
            start: { line: ref.range.startLine, character: ref.range.startCharacter },
            end: { line: ref.range.endLine, character: ref.range.endCharacter }
          }
        }));

        const duration = Date.now() - start;
        profiler.record('references', duration);
        statsManager.updateProfilingMetrics({ avgReferencesTimeMs: profiler.getAverageMs('references') });

        // Forensic tracing: Log complete trace
        const endMemoryMB = this.requestTracer.captureMemory();
        const workerPoolStats = (infrastructure as any).workerPool?.getStats?.();
        this.requestTracer.logTrace(
          'references',
          uri,
          `${line}:${character}`,
          startMemoryMB,
          endMemoryMB,
          ioTracker,
          duration,
          results.length,
          workerPoolStats
        );

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

      // Forensic tracing: Log fallback path trace
      const endMemoryMB = this.requestTracer.captureMemory();
      const workerPoolStats = (infrastructure as any).workerPool?.getStats?.();
      this.requestTracer.logTrace(
        'references',
        uri,
        `${line}:${character}`,
        startMemoryMB,
        endMemoryMB,
        ioTracker,
        duration,
        dedupedRefs.length,
        workerPoolStats
      );

      logger.info(`[Server] References result (fallback): symbol="${word}", ${dedupedRefs.length} locations in ${duration} ms`);
      return results;
    } catch (error) {
      const duration = Date.now() - start;
      logger.error(`[Server] References error: ${error}, ${duration} ms`);
      return null;
    }
  }

  /**
   * Find references with import-aware tracking.
   * Handles renamed imports: import { User as Admin } -> finds usages of "Admin"
   * NgRx-aware: Supports loose mode for actions/effects/reducers
   */
  private async findReferencesWithImportTracking(
    symbolName: string,
    definitionUri: string,
    includeDeclaration: boolean,
    backgroundIndex: any
  ): Promise<IndexedReference[]> {
    const { mergedIndex, logger, documents } = this.services;
    
    // Step 1: Get traditional references from merged index (fast path)
    const baseReferences = await mergedIndex.findReferencesByName(symbolName);
    
    // Step 2: Check if NgRx loose mode should be enabled
    const defDocument = documents.get(URI.file(definitionUri).toString());
    const defContent = defDocument?.getText() || '';
    const defLineContent = defContent.split('\n')[0] || ''; // Simplified - would need actual line
    const isNgRxMode = shouldEnableLooseMode(defContent, symbolName, defLineContent);
    
    if (isNgRxMode) {
      logger.info(`[References] NgRx Loose Mode ENABLED for: ${symbolName}`);
      
      // Extract action type string for string literal matching
      const actionTypeString = extractActionTypeString(defContent);
      if (actionTypeString) {
        logger.info(`[References] NgRx action type: "${actionTypeString}"`);
        
        // Find string literal matches in reducers/effects
        const stringMatches = await this.findNgRxStringMatches(
          actionTypeString,
          symbolName,
          definitionUri,
          backgroundIndex
        );
        
        logger.info(`[References] Found ${stringMatches.length} NgRx string matches`);
        baseReferences.push(...stringMatches);
      }
    }
    
    // Step 3: Find candidates that might import from definition file
    const targetFileBasename = this.extractBasename(definitionUri);
    const storage = (backgroundIndex as any).storage;
    
    const candidates = await storage?.findReferenceCandidates?.(
      symbolName,
      targetFileBasename,
      2000
    );
    
    if (!candidates || candidates.length === 0) {
      logger.info(`[References] No import candidates found, using base references only`);
      return this.deduplicateReferences(baseReferences);
    }
    
    logger.info(`[References] Analyzing ${candidates.length} import candidates`);
    
    // Step 4: Detective logic - find files that import the symbol (possibly renamed)
    const matches: ReferenceCandidateMatch[] = [];
    const normalizedDefUri = this.normalizeUri(definitionUri);
    
    for (const { uri, data } of candidates) {
      // Skip the definition file itself
      if (this.normalizeUri(uri) === normalizedDefUri) {
        continue;
      }
      
      const match = this.analyzeImportedReferences(
        data,
        symbolName,
        definitionUri,
        targetFileBasename,
        isNgRxMode
      );
      
      if (match) {
        matches.push(match);
      }
    }
    
    // Step 5: Combine and rank results
    const allReferences: IndexedReference[] = [...baseReferences];
    
    for (const match of matches) {
      allReferences.push(...match.references);
    }
    
    // Step 6: Add definitions if requested
    if (includeDeclaration) {
      const definitions = await mergedIndex.findDefinitions(symbolName);
      for (const def of definitions) {
        allReferences.push({
          symbolName: def.name,
          location: def.location,
          range: def.range,
          containerName: def.containerName
        });
      }
    }
    
    return this.deduplicateReferences(allReferences);
  }

  /**
   * Analyze a file to find references considering imports and aliasing.
   * NgRx-aware: supports loose mode with wildcard imports
   */
  private analyzeImportedReferences(
    fileData: FileIndexData,
    originalSymbolName: string,
    definitionUri: string,
    targetBasename: string,
    isNgRxLooseMode: boolean = false
  ): ReferenceCandidateMatch | null {
    const { imports, references } = fileData;
    
    // NgRx Loose Mode: Bypass import guard for wildcard imports
    if (isNgRxLooseMode && imports && imports.length > 0) {
      // Check for wildcard imports: import * as Actions from '...'
      const hasWildcardImport = imports.some(imp => imp.isNamespace);
      
      if (hasWildcardImport) {
        // Accept references even without explicit import
        const matchingRefs = references.filter(ref => ref.symbolName === originalSymbolName);
        
        if (matchingRefs.length > 0) {
          return {
            uri: fileData.uri,
            references: matchingRefs,
            confidence: 'ngrx-medium' // Wildcard import = medium confidence
          };
        }
      }
    }
    
    if (!imports || imports.length === 0) {
      return null;
    }
    
    // Find imports from the target file
    const relevantImports = this.findRelevantImports(
      imports,
      definitionUri,
      targetBasename
    );
    
    if (relevantImports.length === 0) {
      return null;
    }
    
    // Determine what token(s) this file uses for the symbol
    const localTokens = this.resolveLocalTokens(relevantImports, originalSymbolName);
    
    if (localTokens.length === 0) {
      return null;
    }
    
    // Find references using the local token(s)
    const matchingRefs: IndexedReference[] = [];
    for (const token of localTokens) {
      const refs = references.filter(ref => ref.symbolName === token);
      matchingRefs.push(...refs);
    }
    
    if (matchingRefs.length === 0) {
      return null;
    }
    
    return {
      uri: fileData.uri,
      references: matchingRefs,
      confidence: localTokens.includes(originalSymbolName) ? 'exact' : 'import'
    };
  }

  /**
   * Find imports that reference the target file.
   */
  private findRelevantImports(
    imports: ImportInfo[],
    definitionUri: string,
    targetBasename: string
  ): ImportInfo[] {
    const relevant: ImportInfo[] = [];
    
    for (const imp of imports) {
      // Check if module specifier could resolve to definition file
      if (this.isMatchingImport(imp.moduleSpecifier, definitionUri, targetBasename)) {
        relevant.push(imp);
      }
    }
    
    return relevant;
  }

  /**
   * Check if an import path could resolve to the target file.
   * Uses string heuristics only (no disk I/O).
   */
  private isMatchingImport(
    moduleSpecifier: string,
    definitionUri: string,
    targetBasename: string
  ): boolean {
    // Normalize: remove .ts/.js/.tsx/.jsx extensions
    const normalized = moduleSpecifier.replace(/\.(tsx?|jsx?)$/, '');
    
    // Check if path ends with target basename
    if (normalized.endsWith(targetBasename) || normalized.endsWith(`/${targetBasename}`)) {
      return true;
    }
    
    // Check for index imports
    if (targetBasename === 'index' && normalized.endsWith('/index')) {
      return true;
    }
    
    // Check absolute path matching (normalize separators)
    const defNormalized = this.normalizeUri(definitionUri).replace(/\.(tsx?|jsx?)$/, '');
    const specNormalized = moduleSpecifier.replace(/\\/g, '/');
    
    if (defNormalized.includes(specNormalized) || specNormalized.includes(targetBasename)) {
      return true;
    }
    
    return false;
  }

  /**
   * Resolve what local token(s) are used in the file for the symbol.
   * Handles: import { User } -> ["User"]
   *          import { User as Admin } -> ["Admin"]
   *          import * as NS -> ["NS"]
   */
  private resolveLocalTokens(imports: ImportInfo[], originalSymbol: string): string[] {
    const tokens: string[] = [];
    
    for (const imp of imports) {
      if (imp.isNamespace) {
        // import * as NS from './user' -> references will be NS.User
        tokens.push(imp.localName);
      } else if (imp.isDefault) {
        // import User from './user' -> if symbol matches, use localName
        if (imp.localName === originalSymbol || imp.exportedName === originalSymbol) {
          tokens.push(imp.localName);
        }
      } else {
        // Named import
        if (imp.exportedName) {
          // import { User as Admin } -> original is "User", local is "Admin"
          if (imp.exportedName === originalSymbol) {
            tokens.push(imp.localName);
          }
        } else {
          // import { User } -> original and local are same
          if (imp.localName === originalSymbol) {
            tokens.push(imp.localName);
          }
        }
      }
    }
    
    return tokens;
  }

  /**
   * Extract basename from file path (without extension).
   */
  private extractBasename(uri: string): string {
    const base = path.basename(uri, path.extname(uri));
    return base;
  }

  /**
   * Find NgRx string literal matches in reducers/effects.
   * Example: '[User] Load' appears in on() or ofType() calls
   */
  private async findNgRxStringMatches(
    actionTypeString: string,
    symbolName: string,
    definitionUri: string,
    backgroundIndex: any
  ): Promise<IndexedReference[]> {
    const { logger } = this.services;
    const storage = (backgroundIndex as any).storage;
    
    // Query for files containing the action type string
    const candidates = await storage?.findReferenceCandidates?.(
      actionTypeString,
      undefined, // No filename filter
      1000 // Limit for performance
    );
    
    if (!candidates || candidates.length === 0) {
      return [];
    }
    
    logger.info(`[NgRx] Found ${candidates.length} files containing "${actionTypeString}"`);
    
    const stringMatches: IndexedReference[] = [];
    
    for (const { uri } of candidates) {
      // Skip the definition file itself
      if (this.normalizeUri(uri) === this.normalizeUri(definitionUri)) {
        continue;
      }
      
      // Only check files that look like reducers or effects
      try {
        const fs = await import('fs/promises');
        const content = await fs.readFile(uri, 'utf-8');
        
        if (!isNgRxReducerOrEffect(content)) {
          continue;
        }
        
        // Find string literal occurrences
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          
          // Check if line contains the action type string
          if (line.includes(actionTypeString)) {
            // Check if it's in an on() or ofType() call
            if (line.includes('on(') || line.includes('ofType(')) {
              const column = line.indexOf(actionTypeString);
              
              stringMatches.push({
                symbolName,
                location: {
                  uri,
                  line: i,
                  character: column
                },
                range: {
                  startLine: i,
                  startCharacter: column,
                  endLine: i,
                  endCharacter: column + actionTypeString.length
                }
              });
            }
          }
        }
      } catch (error) {
        // Skip files with read errors
        continue;
      }
    }
    
    logger.info(`[NgRx] String matching found ${stringMatches.length} references`);
    return stringMatches;
  }

  /**
   * Normalize URI for comparison.
   */
  private normalizeUri(uri: string): string {
    return uri.replace(/\\/g, '/').toLowerCase();
  }

  /**
   * Deduplicate references by location.
   */
  private deduplicateReferences(refs: IndexedReference[]): IndexedReference[] {
    const seen = new Set<string>();
    return refs.filter((ref: IndexedReference) => {
      const key = `${ref.location.uri}:${ref.range.startLine}:${ref.range.startCharacter}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
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
