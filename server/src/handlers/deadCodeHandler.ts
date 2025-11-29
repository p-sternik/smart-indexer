/**
 * DeadCodeHandler - Handles dead code detection and diagnostic publishing.
 * 
 * Responsibilities:
 * - Analyze files for unused exports on didOpen and didSave
 * - Publish diagnostics for unused exports (Information severity with fade effect)
 * - Debounce analysis to avoid excessive processing
 * - Handle entry point whitelisting (main.ts, index.ts, test files, etc.)
 * 
 * Performance:
 * - Only analyzes the currently active file (not workspace-wide)
 * - Uses O(1) reverse index from MergedIndex for fast reference lookups
 * - Target: < 50ms per file analysis
 */

import {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  CancellationToken
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';

import { IHandler, ServerServices, ServerState } from './types.js';
import { IndexedSymbol } from '../types.js';
import { DeadCodeDetector, DeadCodeCandidate, DeadCodeAnalysisResult } from '../features/deadCode.js';
import { CancellationError } from '../utils/asyncUtils.js';

/**
 * Dead code diagnostic configuration.
 */
interface DeadCodeDiagnosticConfig {
  /** Debounce delay in milliseconds */
  debounceMs: number;
  /** Entry point patterns to ignore */
  entryPoints: string[];
  /** Additional exclusion patterns */
  excludePatterns: string[];
  /** Whether to check barrier files (re-exports) */
  checkBarrierFiles: boolean;
}

/**
 * Handler for dead code detection and diagnostics.
 */
export class DeadCodeHandler implements IHandler {
  readonly name = 'DeadCodeHandler';
  
  private services: ServerServices;
  private state: ServerState;
  
  // Diagnostic state
  private diagnosticsCache: Map<string, Diagnostic[]> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(services: ServerServices, state: ServerState) {
    this.services = services;
    this.state = state;
  }

  register(): void {
    // This handler doesn't register LSP methods directly.
    // Instead, it provides methods to be called from document lifecycle events.
    // The registration is done by the server calling analyzeFile on didOpen/didSave.
    const { connection } = this.services;
    connection.console.log('[DeadCodeHandler] Registered');
  }

  /**
   * Analyze a file for dead code (unused exports) and publish diagnostics.
   * 
   * This method is debounced to avoid excessive analysis during rapid edits.
   * Call this from didOpen and didSave events.
   * 
   * @param uri - File path to analyze (not URI format)
   */
  async analyzeFile(uri: string): Promise<void> {
    const { connection, configManager } = this.services;
    const { deadCodeDetector } = this.state;
    
    // Check if dead code detection is enabled
    if (!deadCodeDetector || !configManager.isDeadCodeEnabled()) {
      return;
    }

    try {
      // Clear existing timer for this file
      const existingTimer = this.debounceTimers.get(uri);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const config = this.getConfig();
      
      // Debounce the analysis
      const timer = setTimeout(async () => {
        try {
          const startTime = Date.now();
          connection.console.log(`[DeadCodeHandler] Analyzing ${uri}`);
          
          // Run the analysis
          const candidates = await deadCodeDetector.analyzeFile(uri, {
            entryPoints: config.entryPoints,
            excludePatterns: config.excludePatterns,
            checkBarrierFiles: config.checkBarrierFiles
          });

          // Convert candidates to diagnostics
          const diagnostics = this.candidatesToDiagnostics(candidates);

          // Cache diagnostics
          this.diagnosticsCache.set(uri, diagnostics);

          // Publish to client
          connection.sendDiagnostics({
            uri: URI.file(uri).toString(),
            diagnostics
          });

          const duration = Date.now() - startTime;
          if (candidates.length > 0) {
            connection.console.log(
              `[DeadCodeHandler] Found ${candidates.length} unused exports in ${uri} (${duration}ms)`
            );
          } else {
            connection.console.log(`[DeadCodeHandler] No unused exports in ${uri} (${duration}ms)`);
          }
        } catch (error) {
          connection.console.error(`[DeadCodeHandler] Error analyzing ${uri}: ${error}`);
        } finally {
          this.debounceTimers.delete(uri);
        }
      }, config.debounceMs);

      this.debounceTimers.set(uri, timer);
    } catch (error) {
      connection.console.error(`[DeadCodeHandler] Error setting up analysis for ${uri}: ${error}`);
    }
  }

  /**
   * Clear diagnostics for a file.
   * Call this when a file is closed.
   * 
   * @param uri - File path to clear diagnostics for
   */
  clearDiagnostics(uri: string): void {
    const { connection } = this.services;
    
    // Cancel pending analysis
    const timer = this.debounceTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(uri);
    }

    // Clear cached diagnostics
    this.diagnosticsCache.delete(uri);

    // Send empty diagnostics to client
    connection.sendDiagnostics({
      uri: URI.file(uri).toString(),
      diagnostics: []
    });
  }

  /**
   * Get cached diagnostics for a file.
   */
  getCachedDiagnostics(uri: string): Diagnostic[] {
    return this.diagnosticsCache.get(uri) || [];
  }

  /**
   * Dispose of resources.
   */
  async dispose(): Promise<void> {
    // Cancel all pending timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.diagnosticsCache.clear();
  }

  /**
   * Run workspace-wide dead code analysis with progress reporting.
   * 
   * This method creates a visible progress bar in VS Code and supports cancellation.
   * Use this for "Find Dead Code" commands that analyze the entire workspace.
   * 
   * @param token - LSP cancellation token for aborting the operation
   * @param options - Analysis options (excludePatterns, includeTests, etc.)
   * @returns Analysis result with candidates and statistics
   */
  async findDeadCode(
    token: CancellationToken,
    options?: { excludePatterns?: string[]; includeTests?: boolean }
  ): Promise<DeadCodeAnalysisResult> {
    const { connection } = this.services;
    const { deadCodeDetector } = this.state;
    
    if (!deadCodeDetector) {
      throw new Error('Dead code detector not initialized');
    }

    // Create progress indicator visible in VS Code
    const progress = await connection.window.createWorkDoneProgress();
    progress.begin('Finding Dead Code', 0, 'Preparing analysis...', true);

    const startTime = Date.now();
    const config = this.getConfig();

    try {
      const result = await deadCodeDetector.findDeadCode({
        ...options,
        entryPoints: config.entryPoints,
        checkBarrierFiles: config.checkBarrierFiles,
        cancellationToken: token,
        onProgress: (current, total, message) => {
          const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
          progress.report(percentage, message || `Analyzing files... (${current}/${total})`);
        }
      });

      const duration = Date.now() - startTime;
      connection.console.info(
        `[DeadCodeHandler] Workspace analysis complete: ${result.candidates.length} candidates found ` +
        `(${result.analyzedFiles} files, ${result.totalExports} exports) in ${duration}ms`
      );

      return result;
    } catch (error) {
      // Handle cancellation
      if (token.isCancellationRequested || error instanceof CancellationError) {
        connection.console.info('[DeadCodeHandler] Workspace analysis cancelled by user');
        throw new CancellationError('Dead code analysis cancelled');
      }
      throw error;
    } finally {
      progress.done();
    }
  }

  /**
   * Convert dead code candidates to LSP diagnostics.
   */
  private candidatesToDiagnostics(candidates: DeadCodeCandidate[]): Diagnostic[] {
    return candidates.map(candidate => this.createDiagnostic(candidate));
  }

  /**
   * Create a diagnostic for a dead code candidate.
   */
  private createDiagnostic(candidate: DeadCodeCandidate): Diagnostic {
    const { symbol, reason, confidence } = candidate;
    
    // Use Information severity for unused exports (not an error)
    // DiagnosticTag.Unnecessary causes VS Code to fade the code
    const diagnostic: Diagnostic = {
      severity: DiagnosticSeverity.Hint, // 4 = Hint (least intrusive)
      range: {
        start: {
          line: symbol.range.startLine,
          character: symbol.range.startCharacter
        },
        end: {
          line: symbol.range.endLine,
          character: symbol.range.endCharacter
        }
      },
      message: this.formatMessage(symbol, reason, confidence),
      source: 'smart-indexer',
      code: 'unused-export',
      tags: [DiagnosticTag.Unnecessary] // Fades the code in VS Code
    };

    return diagnostic;
  }

  /**
   * Format the diagnostic message.
   */
  private formatMessage(
    symbol: IndexedSymbol,
    reason: string,
    confidence: 'high' | 'medium' | 'low'
  ): string {
    const kindLabel = this.getKindLabel(symbol.kind);
    const confidenceLabel = confidence === 'high' ? '' : ` (${confidence} confidence)`;
    
    return `Unused export: ${kindLabel} '${symbol.name}' is declared but never used in the workspace${confidenceLabel}`;
  }

  /**
   * Get a human-readable label for a symbol kind.
   */
  private getKindLabel(kind: string): string {
    const labels: Record<string, string> = {
      'class': 'Class',
      'interface': 'Interface',
      'function': 'Function',
      'type': 'Type',
      'enum': 'Enum',
      'constant': 'Constant',
      'variable': 'Variable',
      'method': 'Method'
    };
    return labels[kind] || kind;
  }

  /**
   * Get dead code configuration from ConfigurationManager.
   */
  private getConfig(): DeadCodeDiagnosticConfig {
    const { configManager } = this.services;
    const config = configManager.getDeadCodeConfig();
    
    return {
      debounceMs: config.debounceMs ?? 1000,
      entryPoints: config.entryPoints ?? [],
      excludePatterns: config.excludePatterns ?? [],
      checkBarrierFiles: config.checkBarrierFiles ?? false
    };
  }
}

/**
 * Factory function for creating DeadCodeHandler.
 * Used with HandlerRegistry.register().
 */
export function createDeadCodeHandler(
  services: ServerServices,
  state: ServerState
): DeadCodeHandler {
  return new DeadCodeHandler(services, state);
}
