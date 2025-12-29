import { IndexedSymbol } from '../types.js';
import { findSymbolAtPosition, SymbolAtPosition } from '../indexer/symbolResolver.js';
import { ISymbolIndex } from '../index/ISymbolIndex.js';

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
    private index: ISymbolIndex
  ) {}

  /**
   * Resolve definitions with hybrid strategy.
   */
  async resolveDefinitions(context: ResolutionContext): Promise<HybridResolutionResult> {
    // Step 1: Try fast path - index-based resolution
    const fastPathResult = await this.tryFastPathResolution(context);
    
    // STRICT MODE: No fallback to internal TypeScript service.
    // If we are ambiguous or found nothing, we return what we have (or nothing).
    // The client (VS Code) already has a native TypeScript service running.
    // If we return nothing, the native service will provide the result.
    // If we return a result, it will be merged with the native service result.
    // Falling back here would cause duplicates because we would return the same symbol 
    // that the native service is also returning.

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

    // STRICT MODE: No fallback to internal TypeScript service.
    // See resolveDefinitions for reasoning.

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
}
