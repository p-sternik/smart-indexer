/**
 * DeadCodeHandler - Handles dead code detection and diagnostic publishing.
 * 
 * Responsibilities:
 * - Analyze files for unused exports on didSave (PASSIVE - only when idle)
 * - Publish diagnostics for unused exports (Information severity with fade effect)
 * - Debounce analysis with 5000ms delay to avoid blocking user interactions
 * - Handle entry point whitelisting (main.ts, index.ts, test files, etc.)
 * 
 * Performance Architecture (NON-BLOCKING):
 * 1. **Passive Triggering**: Only runs 5 seconds after user stops typing
 * 2. **Event Loop Yielding**: Uses setImmediate to prevent blocking main thread
 * 3. **Abort Controller**: Immediately cancels previous analysis when new request arrives
 * 4. **Fire-and-Forget**: Analysis runs in background, never blocks LSP requests
 * 
 * Performance:
 * - Only analyzes the currently active file (not workspace-wide)
 * - Uses O(1) reverse index from MergedIndex for fast reference lookups
 * - Target: < 50ms per file analysis (runs async, doesn't block)
 * - **Critical**: Typing and clicking feels instant, analysis happens silently
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
import { DeadCodeCandidate, DeadCodeAnalysisResult } from '../features/deadCode.js';
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
  private runningAnalyses: Map<string, AbortController> = new Map();

  constructor(services: ServerServices, state: ServerState) {
    this.services = services;
    this.state = state;
  }

  register(): void {
    // This handler doesn't register LSP methods directly.
    // Instead, it provides methods to be called from document lifecycle events.
    // The registration is done by the server calling analyzeFile on didOpen/didSave.
    const { logger } = this.services;
    logger.info('[DeadCodeHandler] Registered');
  }

  /**
   * Analyze a file for dead code (unused exports) and publish diagnostics.
   * 
   * **PASSIVE DESIGN**:
   * - Debounced with 5000ms delay (user must be idle for 5 seconds)
   * - Runs asynchronously with setImmediate to yield to event loop
   * - Aborts previous analysis automatically if new request arrives
   * - Never blocks LSP requests (definition, hover, etc.)
   * 
   * **Usage**: Call from didSave events only (not didOpen).
   * 
   * @param uri - File path to analyze (not URI format)
   */
  async analyzeFile(uri: string): Promise<void> {
    const { configManager, logger } = this.services;
    const { deadCodeDetector } = this.state;
    
    // Check if dead code detection is enabled
    if (!deadCodeDetector || !configManager.isDeadCodeEnabled()) {
      return;
    }

    try {
      // Cancel existing analysis for this file
      const existingController = this.runningAnalyses.get(uri);
      if (existingController) {
        existingController.abort();
        this.runningAnalyses.delete(uri);
      }

      // Clear existing timer for this file
      const existingTimer = this.debounceTimers.get(uri);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const config = this.getConfig();
      
      // Debounce the analysis (5000ms for low-priority diagnostic)
      const timer = setTimeout(() => {
        // Run asynchronously without blocking
        this.runAnalysisAsync(uri, config).catch(error => {
          logger.error(`[DeadCodeHandler] Async analysis error for ${uri}: ${error}`);
        });
        this.debounceTimers.delete(uri);
      }, config.debounceMs);

      this.debounceTimers.set(uri, timer);
    } catch (error) {
      logger.error(`[DeadCodeHandler] Error setting up analysis for ${uri}: ${error}`);
    }
  }

  /**
   * Run dead code analysis asynchronously without blocking the main thread.
   * This method is fire-and-forget and uses an AbortController for cancellation.
   * Uses setImmediate to yield to the event loop and prevent blocking.
   */
  private async runAnalysisAsync(uri: string, config: DeadCodeDiagnosticConfig): Promise<void> {
    const { connection, logger } = this.services;
    const { deadCodeDetector } = this.state;
    
    if (!deadCodeDetector) {
      return;
    }

    const abortController = new AbortController();
    this.runningAnalyses.set(uri, abortController);

    // Yield to event loop immediately - don't block the main thread
    setImmediate(async () => {
      try {
        const startTime = Date.now();
        logger.info(`[DeadCodeHandler] Analyzing ${uri} (async, low-priority, non-blocking)`);
        
        // Run the analysis in chunks to avoid blocking
        const candidates = await this.runAnalysisWithYielding(
          uri,
          deadCodeDetector,
          config,
          abortController
        );

        // Check if aborted
        if (abortController.signal.aborted) {
          logger.info(`[DeadCodeHandler] Analysis cancelled for ${uri}`);
          return;
        }

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
          logger.info(
            `[DeadCodeHandler] Found ${candidates.length} unused exports in ${uri} (${duration}ms)`
          );
        } else {
          logger.info(`[DeadCodeHandler] No unused exports in ${uri} (${duration}ms)`);
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          logger.error(`[DeadCodeHandler] Error analyzing ${uri}: ${error}`);
        }
      } finally {
        this.runningAnalyses.delete(uri);
      }
    });
  }

  /**
   * Run analysis with periodic yielding to event loop.
   * This prevents blocking the main thread during intensive computation.
   */
  private async runAnalysisWithYielding(
    uri: string,
    deadCodeDetector: any,
    config: DeadCodeDiagnosticConfig,
    abortController: AbortController
  ): Promise<DeadCodeCandidate[]> {
    // Yield to event loop before starting
    await this.yieldToEventLoop();
    
    // Check for cancellation before starting
    if (abortController.signal.aborted) {
      return [];
    }
    
    // Run the actual analysis
    const candidates = await deadCodeDetector.analyzeFile(uri, {
      entryPoints: config.entryPoints,
      excludePatterns: config.excludePatterns,
      checkBarrierFiles: config.checkBarrierFiles
    });
    
    // Yield after analysis completes
    await this.yieldToEventLoop();
    
    return candidates;
  }

  /**
   * Yield control to the event loop using setImmediate.
   * This allows other pending operations (like definition requests) to execute.
   */
  private yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
  }

  /**
   * Clear diagnostics for a file.
   * Call this when a file is closed.
   * 
   * @param uri - File path to clear diagnostics for
   */
  clearDiagnostics(uri: string): void {
    const { connection } = this.services;
    
    // Cancel running analysis
    const controller = this.runningAnalyses.get(uri);
    if (controller) {
      controller.abort();
      this.runningAnalyses.delete(uri);
    }
    
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
    // Cancel all running analyses
    for (const controller of this.runningAnalyses.values()) {
      controller.abort();
    }
    this.runningAnalyses.clear();
    
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
   * @param options - Analysis options (excludePatterns, includeTests, scopeUri, etc.)
   * @returns Analysis result with candidates and statistics
   */
  async findDeadCode(
    token: CancellationToken,
    options?: { excludePatterns?: string[]; includeTests?: boolean; scopeUri?: string }
  ): Promise<DeadCodeAnalysisResult> {
    const { connection } = this.services;
    const { deadCodeDetector } = this.state;
    
    if (!deadCodeDetector) {
      throw new Error('Dead code detector not initialized');
    }

    // Determine progress title based on scope
    let progressTitle = 'Finding Dead Code';
    let scopePath: string | undefined;
    
    if (options?.scopeUri) {
      // Parse the URI and extract the folder path
      const scopeUriParsed = URI.parse(options.scopeUri);
      scopePath = scopeUriParsed.fsPath;
      
      // Normalize path for comparison (handle trailing slashes)
      if (scopePath && !scopePath.endsWith('/') && !scopePath.endsWith('\\')) {
        scopePath = scopePath + (scopePath.includes('\\') ? '\\' : '/');
      }
      
      // Extract folder name for display
      const folderName = scopePath.split(/[/\\]/).filter(Boolean).pop() || 'folder';
      progressTitle = `Finding Dead Code in ${folderName}`;
      connection.console.info(`[DeadCodeHandler] Scoped analysis to: ${scopePath}`);
    }

    // Create progress indicator visible in VS Code
    const progress = await connection.window.createWorkDoneProgress();
    progress.begin(progressTitle, 0, 'Preparing analysis...', true);

    const startTime = Date.now();
    const config = this.getConfig();

    try {
      const result = await deadCodeDetector.findDeadCode({
        ...options,
        scopePath,
        entryPoints: config.entryPoints,
        checkBarrierFiles: config.checkBarrierFiles,
        cancellationToken: token,
        onProgress: (current, total, message) => {
          const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
          progress.report(percentage, message || `Analyzing files... (${current}/${total})`);
        }
      });

      const duration = Date.now() - startTime;
      const scopeInfo = scopePath ? ` in scope '${scopePath}'` : '';
      connection.console.info(
        `[DeadCodeHandler] Analysis complete${scopeInfo}: ${result.candidates.length} candidates found ` +
        `(${result.analyzedFiles} files, ${result.totalExports} exports) in ${duration}ms`
      );

      return result;
    } catch (error) {
      // Handle cancellation
      if (token.isCancellationRequested || error instanceof CancellationError) {
        connection.console.info('[DeadCodeHandler] Analysis cancelled by user');
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
    _reason: string,
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
   * 
   * Default debounce: 5000ms (5 seconds) - ensures passive, non-intrusive behavior.
   * User must stop typing for 5 seconds before analysis begins.
   */
  private getConfig(): DeadCodeDiagnosticConfig {
    const { configManager } = this.services;
    const config = configManager.getDeadCodeConfig();
    
    return {
      debounceMs: config.debounceMs ?? 5000, // 5 seconds - passive mode (runs only when idle)
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
