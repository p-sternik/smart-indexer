import { IndexedSymbol } from '../types.js';
import { TypeScriptService } from '../typescript/typeScriptService.js';
import { findSymbolAtPosition, SymbolAtPosition } from '../indexer/symbolResolver.js';
import { ISymbolIndex } from '../index/ISymbolIndex.js';
import * as ts from 'typescript';

export interface HybridResolutionResult {
  symbols: IndexedSymbol[];
  usedFallback: boolean;
  candidateCount: number;
  filteredCount: number;
}

export interface ResolutionContext {
  fileName: string;
  content: string;
  position: { line: number; character: number };
}

/**
 * HybridResolver - Combines index-based fast path with TypeScript LanguageService fallback.
 * 
 * Resolution strategy:
 * 1. Fast path: Use index with enhanced filtering
 * 2. Fallback: Use TypeScript LanguageService for ambiguous cases
 */
export class HybridResolver {
  constructor(
    private index: ISymbolIndex,
    private tsService: TypeScriptService
  ) {}

  /**
   * Resolve definitions with hybrid strategy.
   */
  async resolveDefinitions(context: ResolutionContext): Promise<HybridResolutionResult> {
    // Step 1: Try fast path - index-based resolution
    const fastPathResult = await this.tryFastPathResolution(context);
    
    if (fastPathResult.filteredCount === 1) {
      // Exact match found in index
      return {
        symbols: fastPathResult.symbols,
        usedFallback: false,
        candidateCount: fastPathResult.candidateCount,
        filteredCount: fastPathResult.filteredCount
      };
    }

    if (fastPathResult.filteredCount === 0 || fastPathResult.filteredCount > 1) {
      // Ambiguous or no results - try TypeScript LanguageService fallback
      const fallbackResult = await this.tryTypeScriptFallback(context, 'definition');
      
      if (fallbackResult.symbols.length > 0) {
        return {
          symbols: fallbackResult.symbols,
          usedFallback: true,
          candidateCount: fastPathResult.candidateCount,
          filteredCount: fallbackResult.symbols.length
        };
      }
    }

    // Return whatever we have from fast path
    return {
      symbols: fastPathResult.symbols,
      usedFallback: false,
      candidateCount: fastPathResult.candidateCount,
      filteredCount: fastPathResult.filteredCount
    };
  }

  /**
   * Resolve references with hybrid strategy.
   */
  async resolveReferences(context: ResolutionContext): Promise<HybridResolutionResult> {
    // Step 1: Try fast path - index-based resolution
    const fastPathResult = await this.tryFastPathResolution(context);
    
    if (fastPathResult.filteredCount === 1) {
      // Exact match found - use symbol ID to find references
      const symbol = fastPathResult.symbols[0];
      const references = await this.index.findReferencesById(symbol.id);
      
      return {
        symbols: references,
        usedFallback: false,
        candidateCount: fastPathResult.candidateCount,
        filteredCount: references.length
      };
    }

    if (fastPathResult.filteredCount === 0 || fastPathResult.filteredCount > 1) {
      // Ambiguous or no results - try TypeScript LanguageService fallback
      const fallbackResult = await this.tryTypeScriptFallback(context, 'references');
      
      if (fallbackResult.symbols.length > 0) {
        return {
          symbols: fallbackResult.symbols,
          usedFallback: true,
          candidateCount: fastPathResult.candidateCount,
          filteredCount: fallbackResult.symbols.length
        };
      }
    }

    // Return whatever we have from fast path
    return {
      symbols: fastPathResult.symbols,
      usedFallback: false,
      candidateCount: fastPathResult.candidateCount,
      filteredCount: fastPathResult.filteredCount
    };
  }

  /**
   * Fast path: Use index with enhanced filtering.
   */
  private async tryFastPathResolution(
    context: ResolutionContext
  ): Promise<{ symbols: IndexedSymbol[]; candidateCount: number; filteredCount: number }> {
    // Resolve symbol at cursor using AST
    const symbolAtCursor = findSymbolAtPosition(
      context.fileName,
      context.content,
      context.position.line,
      context.position.character
    );

    if (!symbolAtCursor) {
      return { symbols: [], candidateCount: 0, filteredCount: 0 };
    }

    // Query index for candidates by name
    const candidates = await this.index.findDefinitions(symbolAtCursor.name);
    const candidateCount = candidates.length;

    // Apply enhanced filtering with priority rules
    const filtered = this.applyEnhancedFiltering(
      candidates,
      symbolAtCursor,
      context.fileName
    );

    return {
      symbols: filtered,
      candidateCount,
      filteredCount: filtered.length
    };
  }

  /**
   * Apply enhanced filtering with priority rules.
   */
  private applyEnhancedFiltering(
    candidates: IndexedSymbol[],
    symbolAtCursor: SymbolAtPosition,
    currentFile: string
  ): IndexedSymbol[] {
    if (candidates.length === 0) {
      return [];
    }

    // Score each candidate
    const scored = candidates.map(candidate => ({
      symbol: candidate,
      score: this.scoreCandidate(candidate, symbolAtCursor, currentFile)
    }));

    // Sort by score (highest first)
    scored.sort((a, b) => b.score - a.score);

    // Return candidates with top score
    const topScore = scored[0].score;
    const topCandidates = scored
      .filter(s => s.score === topScore)
      .map(s => s.symbol);

    return topCandidates;
  }

  /**
   * Score a candidate symbol based on how well it matches the context.
   */
  private scoreCandidate(
    candidate: IndexedSymbol,
    symbolAtCursor: SymbolAtPosition,
    currentFile: string
  ): number {
    let score = 0;

    // Name match (required)
    if (candidate.name !== symbolAtCursor.name) {
      return -1000; // Disqualify
    }
    score += 100;

    // Exact kind match
    if (candidate.kind === symbolAtCursor.kind) {
      score += 50;
    }
    // Compatible kind match (method/function)
    else if (
      (symbolAtCursor.kind === 'function' && candidate.kind === 'method') ||
      (symbolAtCursor.kind === 'method' && candidate.kind === 'function') ||
      (symbolAtCursor.kind === 'property' && candidate.kind === 'method')
    ) {
      score += 30;
    }

    // Container name match
    if (symbolAtCursor.containerName && candidate.containerName) {
      if (candidate.containerName === symbolAtCursor.containerName) {
        score += 100; // Exact container match is very strong
      }
    } else if (!symbolAtCursor.containerName && !candidate.containerName) {
      score += 50; // Both global
    }

    // Full container path match (if available)
    if (symbolAtCursor.containerName && candidate.fullContainerPath) {
      if (candidate.fullContainerPath.endsWith(symbolAtCursor.containerName)) {
        score += 40;
      }
    }

    // Static flag match
    if (symbolAtCursor.isStatic !== undefined && candidate.isStatic !== undefined) {
      if (candidate.isStatic === symbolAtCursor.isStatic) {
        score += 30;
      } else {
        score -= 50; // Strong penalty for static/instance mismatch
      }
    }

    // Same file priority (local members)
    if (candidate.filePath === currentFile) {
      score += 20;
    }

    return score;
  }

  /**
   * Fallback: Use TypeScript LanguageService for precise resolution.
   */
  private async tryTypeScriptFallback(
    context: ResolutionContext,
    mode: 'definition' | 'references'
  ): Promise<{ symbols: IndexedSymbol[] }> {
    if (!this.tsService.isInitialized()) {
      return { symbols: [] };
    }

    try {
      // Update file in TS service
      this.tsService.updateFile(context.fileName, context.content);

      // Calculate offset from line/character
      const offset = this.positionToOffset(context.content, context.position);

      let tsResults: readonly ts.DefinitionInfo[] | ts.ReferenceEntry[] | undefined;

      if (mode === 'definition') {
        tsResults = this.tsService.getDefinitionAtPosition(context.fileName, offset);
      } else {
        tsResults = this.tsService.getReferencesAtPosition(context.fileName, offset);
      }

      if (!tsResults || tsResults.length === 0) {
        return { symbols: [] };
      }

      // Convert TS results to IndexedSymbol format
      const symbols: IndexedSymbol[] = [];
      
      for (const tsResult of tsResults) {
        const symbol = await this.tsResultToIndexedSymbol(tsResult as ts.DefinitionInfo);
        if (symbol) {
          symbols.push(symbol);
        }
      }

      return { symbols };
    } catch (error) {
      console.error(`[HybridResolver] TypeScript fallback error: ${error}`);
      return { symbols: [] };
    }
  }

  /**
   * Convert TypeScript result to IndexedSymbol.
   */
  private async tsResultToIndexedSymbol(
    tsResult: ts.DefinitionInfo
  ): Promise<IndexedSymbol | null> {
    try {
      const fileName = tsResult.fileName;
      const span = tsResult.textSpan;
      
      // Calculate line/character from offset
      const content = this.tsService.isInitialized() 
        ? (await this.readFileContent(fileName) || '')
        : '';
      
      const start = this.offsetToPosition(content, span.start);
      const end = this.offsetToPosition(content, span.start + span.length);

      // Try to find this symbol in the index by position
      const candidatesAtLocation = await this.index.getFileSymbols(fileName);
      
      for (const candidate of candidatesAtLocation) {
        if (
          candidate.range.startLine === start.line &&
          candidate.range.startCharacter >= start.character - 5 &&
          candidate.range.startCharacter <= start.character + 5
        ) {
          // Found matching symbol in index
          return candidate;
        }
      }

      // Create minimal symbol if not in index
      return {
        id: this.generateTempSymbolId(fileName, span.start),
        name: this.extractNameFromFile(content, span.start, span.length),
        kind: 'unknown',
        location: {
          uri: fileName,
          line: start.line,
          character: start.character
        },
        range: {
          startLine: start.line,
          startCharacter: start.character,
          endLine: end.line,
          endCharacter: end.character
        },
        filePath: fileName
      };
    } catch (error) {
      console.error(`[HybridResolver] Error converting TS result: ${error}`);
      return null;
    }
  }

  /**
   * Convert line/character position to offset.
   */
  private positionToOffset(content: string, position: { line: number; character: number }): number {
    const lines = content.split('\n');
    let offset = 0;
    
    for (let i = 0; i < position.line && i < lines.length; i++) {
      offset += lines[i].length + 1; // +1 for newline
    }
    
    offset += position.character;
    return offset;
  }

  /**
   * Convert offset to line/character position.
   */
  private offsetToPosition(content: string, offset: number): { line: number; character: number } {
    const lines = content.split('\n');
    let currentOffset = 0;
    
    for (let line = 0; line < lines.length; line++) {
      const lineLength = lines[line].length + 1; // +1 for newline
      
      if (currentOffset + lineLength > offset) {
        return {
          line,
          character: offset - currentOffset
        };
      }
      
      currentOffset += lineLength;
    }
    
    return { line: lines.length - 1, character: 0 };
  }

  /**
   * Extract symbol name from file content.
   */
  private extractNameFromFile(content: string, offset: number, length: number): string {
    try {
      return content.substring(offset, offset + length);
    } catch {
      return 'unknown';
    }
  }

  /**
   * Generate temporary symbol ID for TS-resolved symbols not in index.
   */
  private generateTempSymbolId(fileName: string, offset: number): string {
    return `ts_temp_${fileName}_${offset}`;
  }

  /**
   * Read file content.
   */
  private async readFileContent(fileName: string): Promise<string | null> {
    try {
      const fs = await import('fs');
      return fs.readFileSync(fileName, 'utf-8');
    } catch {
      return null;
    }
  }
}
