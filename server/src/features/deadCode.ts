import { BackgroundIndex } from '../index/backgroundIndex.js';
import { IndexedSymbol, IndexedReference, IndexedFileResult } from '../types.js';
import { ConfigurationManager } from '../config/configurationManager.js';
import { pluginRegistry } from '../plugins/FrameworkPlugin.js';
import * as fsPromises from 'fs/promises';
import { minimatch } from 'minimatch';
import { 
  CancellationToken, 
  ProgressCallback, 
  throwIfCancelled, 
  yieldToEventLoop 
} from '../utils/asyncUtils.js';

export interface DeadCodeCandidate {
  symbol: IndexedSymbol;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface DeadCodeAnalysisResult {
  candidates: DeadCodeCandidate[];
  totalExports: number;
  analyzedFiles: number;
}

export interface DeadCodeOptions {
  excludePatterns?: string[];
  includeTests?: boolean;
  entryPoints?: string[];
  checkBarrierFiles?: boolean;
  /** Scope path to limit analysis to a specific folder */
  scopePath?: string;
  /** Cancellation token for aborting the operation */
  cancellationToken?: CancellationToken;
  /** Progress callback for reporting analysis progress */
  onProgress?: ProgressCallback;
}

/**
 * Angular lifecycle hooks that should never be flagged as unused
 * (called by the framework, not directly referenced in code)
 */
const ANGULAR_LIFECYCLE_HOOKS = new Set([
  'ngOnInit',
  'ngOnChanges',
  'ngDoCheck',
  'ngAfterContentInit',
  'ngAfterContentChecked',
  'ngAfterViewInit',
  'ngAfterViewChecked',
  'ngOnDestroy',
  'OnInit',
  'OnChanges',
  'DoCheck',
  'AfterContentInit',
  'AfterContentChecked',
  'AfterViewInit',
  'AfterViewChecked',
  'OnDestroy'
]);

/**
 * Framework-specific patterns that should not be flagged as dead
 */
const FRAMEWORK_PATTERNS = new Set([
  'Component',
  'Directive',
  'Injectable',
  'NgModule',
  'Pipe'
]);

/**
 * Dead Code Detector - Production Feature
 * 
 * Identifies potentially unused exports by analyzing reference counts.
 * Leverages the background index to find symbols with zero cross-file references.
 * 
 * Key Features:
 * - Entry point awareness (don't flag public APIs)
 * - Angular lifecycle hook detection
 * - Barrier file analysis (recursive check for re-exports)
 * - Framework pattern recognition
 * - Configurable exclusion patterns
 */
export class DeadCodeDetector {
  private defaultEntryPoints: string[] = [
    '**/main.ts',
    '**/public-api.ts',
    '**/index.ts',
    '**/*.stories.ts',
    '**/*.spec.ts',
    '**/*.test.ts',
    '**/test/**',
    '**/tests/**'
  ];

  constructor(private backgroundIndex: BackgroundIndex) {}

  /**
   * Set the configuration manager for accessing user settings
   */
  setConfigurationManager(_configManager: ConfigurationManager): void {
    // No-op - configuration manager is no longer used by this class
  }

  /**
   * Analyze a single file for dead code
   * (Performance-optimized for real-time analysis)
   */
  async analyzeFile(fileUri: string, options?: DeadCodeOptions): Promise<DeadCodeCandidate[]> {
    const candidates: DeadCodeCandidate[] = [];
    
    // Check if file should be analyzed
    if (this.isEntryPoint(fileUri, options?.entryPoints)) {
      return candidates; // Entry points are never dead
    }

    const fileResult = await this.backgroundIndex.getFileResult(fileUri);
    if (!fileResult) {
      return candidates;
    }

    // Build a set of exported symbol names for "used by exported symbol" check
    const exportedSymbolNames = new Set<string>();
    for (const sym of fileResult.symbols) {
      if (this.isExportedSymbol(sym, fileResult.imports)) {
        exportedSymbolNames.add(sym.name);
      }
    }

    // Check each symbol in the file
    for (const symbol of fileResult.symbols) {
      if (!this.isExportedSymbol(symbol, fileResult.imports)) {
        continue; // Only check exported symbols
      }

      // Skip framework lifecycle hooks
      if (this.isFrameworkMethod(symbol)) {
        continue;
      }

      // Skip symbols with @public/@api markers
      if (await this.hasPublicMarker(symbol, fileUri)) {
        continue;
      }

      // Find references to this symbol
      const references = await this.backgroundIndex.findReferencesByName(symbol.name);
      
      // Filter out references in the same file
      const crossFileReferences = references.filter(
        ref => ref.location.uri !== fileUri
      );

      // Check if symbol is dead
      if (crossFileReferences.length === 0) {
        // NEW: Check if this symbol is used by an EXPORTED symbol in the same file
        // e.g., interface DeadCodeConfig is used by exported SmartIndexerConfig
        const isUsedByExportedSymbol = this.isUsedByExportedSymbol(
          symbol,
          fileResult,
          exportedSymbolNames
        );
        
        if (isUsedByExportedSymbol) {
          // Symbol is implicitly alive - used by an exported symbol
          continue;
        }

        // Advanced: Check if all references come from barrier files
        if (options?.checkBarrierFiles && references.length > 0) {
          const allReferencesAreBarriers = await this.areAllReferencesFromBarriers(
            references,
            fileUri
          );
          
          if (allReferencesAreBarriers) {
            candidates.push({
              symbol,
              reason: 'Only referenced from unused re-export files',
              confidence: 'medium'
            });
          }
        } else {
          candidates.push({
            symbol,
            reason: 'No cross-file references found',
            confidence: this.calculateConfidence(symbol, references.length)
          });
        }
      }
    }

    return candidates;
  }

  /**
   * Find unused exports across the workspace.
   * (Batch analysis - used for workspace-wide reports)
   * 
   * @param options Analysis options including cancellation and progress
   * @returns List of dead code candidates
   */
  async findDeadCode(options?: DeadCodeOptions): Promise<DeadCodeAnalysisResult> {
    const excludePatterns = options?.excludePatterns || [];
    const includeTests = options?.includeTests || false;
    const scopePath = options?.scopePath;
    const cancellationToken = options?.cancellationToken;
    const onProgress = options?.onProgress;
    
    const candidates: DeadCodeCandidate[] = [];
    let totalExports = 0;
    let analyzedFiles = 0;

    // Check for cancellation before starting
    throwIfCancelled(cancellationToken);

    // Get all files from the background index
    const allFiles = await this.backgroundIndex.getAllFiles();
    const totalIndexedFiles = allFiles.length;
    
    // Pre-filter files to get accurate total count
    const filesToAnalyze: string[] = [];
    let scopeFilteredCount = 0;
    let excludedCount = 0;
    let entryPointCount = 0;
    
    for (const fileUri of allFiles) {
      // Apply scope filtering if scopePath is provided
      // Only analyze files within the specified folder
      if (scopePath && !this.isFileInScope(fileUri, scopePath)) {
        scopeFilteredCount++;
        continue;
      }
      
      if (this.shouldExcludeFile(fileUri, excludePatterns, includeTests)) {
        excludedCount++;
        continue;
      }
      if (this.isEntryPoint(fileUri, options?.entryPoints)) {
        entryPointCount++;
        continue;
      }
      filesToAnalyze.push(fileUri);
    }
    
    const totalFiles = filesToAnalyze.length;
    
    // Log scope filtering stats for debugging
    if (scopePath) {
      // Debug info omitted
    }
    
    // Report initial progress with scope info
    const scopeLabel = scopePath ? ` in scope` : '';
    const progressMessage = scopePath 
      ? `Analyzing ${totalFiles}/${totalIndexedFiles} files in scope...`
      : `Starting dead code analysis${scopeLabel}...`;
    onProgress?.(0, totalFiles, progressMessage);
    
    // Yield frequency: every 50 files to allow cancellation checks
    const YIELD_INTERVAL = 50;
    
    for (let i = 0; i < filesToAnalyze.length; i++) {
      const fileUri = filesToAnalyze[i];
      
      // Yield to event loop periodically to allow cancellation processing
      if (i % YIELD_INTERVAL === 0 && i > 0) {
        await yieldToEventLoop();
        throwIfCancelled(cancellationToken);
        
        // Report progress
        onProgress?.(analyzedFiles, totalFiles, `Analyzing usage... (${analyzedFiles}/${totalFiles} files)`);
      }

      analyzedFiles++;
      
      // Analyze this file - NOTE: Reference search is NOT scoped
      // We check if symbols in this folder are used ANYWHERE in the workspace
      const fileCandidates = await this.analyzeFile(fileUri, options);
      candidates.push(...fileCandidates);
      
      // Count exports for statistics
      const fileResult = await this.backgroundIndex.getFileResult(fileUri);
      if (fileResult) {
        totalExports += fileResult.symbols.filter(s => 
          this.isExportedSymbol(s, fileResult.imports)
        ).length;
      }
    }

    // Final progress update
    onProgress?.(totalFiles, totalFiles, 'Analysis complete');

    return {
      candidates,
      totalExports,
      analyzedFiles
    };
  }

  /**
   * Check if a file is an entry point (public API boundary)
   */
  private isEntryPoint(fileUri: string, customEntryPoints?: string[]): boolean {
    const entryPoints = customEntryPoints || this.defaultEntryPoints;
    const normalizedUri = fileUri.replace(/\\/g, '/');
    
    for (const pattern of entryPoints) {
      if (minimatch(normalizedUri, pattern, { matchBase: true })) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Check if a file is within the specified scope path.
   * Performs case-insensitive comparison on Windows/macOS.
   */
  private isFileInScope(fileUri: string, scopePath: string): boolean {
    // Normalize paths for comparison
    const normalizedFile = fileUri.replace(/\\/g, '/').toLowerCase();
    const normalizedScope = scopePath.replace(/\\/g, '/').toLowerCase();
    
    // Ensure scope path ends with a slash for proper prefix matching
    const scopePrefix = normalizedScope.endsWith('/') 
      ? normalizedScope 
      : normalizedScope + '/';
    
    return normalizedFile.startsWith(scopePrefix) || normalizedFile === normalizedScope.replace(/\/$/, '');
  }

  /**
   * Check if symbol is a framework lifecycle method or decorated element.
   * Delegates to registered plugins first, then falls back to hardcoded checks
   * for backwards compatibility.
   */
  private isFrameworkMethod(symbol: IndexedSymbol): boolean {
    // First, check with registered plugins (Open-Closed Principle)
    if (pluginRegistry.isEntryPoint(symbol)) {
      return true;
    }
    
    // Fallback: Angular lifecycle hooks (for backwards compatibility)
    if (ANGULAR_LIFECYCLE_HOOKS.has(symbol.name)) {
      return true;
    }

    // Fallback: Framework decorators (e.g., @Component, @Injectable)
    if (FRAMEWORK_PATTERNS.has(symbol.name)) {
      return true;
    }

    // Legacy: check for ngrxMetadata field (deprecated, use metadata.ngrx)
    if (symbol.ngrxMetadata) {
      // Actions and Effects are part of the framework pattern
      // Only flag if truly unused
      return false; // Let the reference check handle NgRx
    }

    return false;
  }

  /**
   * Check if all references come from barrier files (re-export files with no usage)
   * This is a recursive check to find truly dead code hidden behind re-exports.
   */
  private async areAllReferencesFromBarriers(
    references: IndexedReference[],
    originalFile: string
  ): Promise<boolean> {
    const barrierPattern = /\/(index|public-api|barrel)\.ts$/i;
    
    for (const ref of references) {
      const refFile = ref.location.uri;
      
      // Skip self-references
      if (refFile === originalFile) {
        continue;
      }

      // Check if this is a barrier file
      if (!barrierPattern.test(refFile)) {
        return false; // Found a non-barrier reference
      }

      // Check if the barrier file itself has any external references
      // (If the re-export is also unused, it's still dead code)
      const barrierResult = await this.backgroundIndex.getFileResult(refFile);
      if (!barrierResult) {
        continue;
      }

      // Find symbols in the barrier that re-export our symbol
      for (const barrierSymbol of barrierResult.symbols) {
        if (barrierSymbol.name === ref.symbolName) {
          // Check if this re-exported symbol has external references
          const barrierRefs = await this.backgroundIndex.findReferencesByName(barrierSymbol.name);
          const externalBarrierRefs = barrierRefs.filter(
            r => r.location.uri !== refFile && r.location.uri !== originalFile
          );
          
          if (externalBarrierRefs.length > 0) {
            return false; // The re-export is actually used
          }
        }
      }
    }

    return true; // All references are from unused barriers
  }

  /**
   * Check if a file should be excluded from analysis.
   */
  private shouldExcludeFile(
    fileUri: string,
    excludePatterns: string[],
    includeTests: boolean
  ): boolean {
    const normalizedUri = fileUri.replace(/\\/g, '/');
    
    // Always exclude node_modules and build artifacts
    const defaultExclusions = ['node_modules', 'dist/', 'out/', 'build/', '.angular/', '.nx/'];
    
    for (const pattern of defaultExclusions) {
      if (normalizedUri.includes(pattern)) {
        return true;
      }
    }
    
    // Check user-defined exclusions
    for (const pattern of excludePatterns) {
      if (minimatch(normalizedUri, pattern, { matchBase: true })) {
        return true;
      }
    }
    
    // Optionally exclude test files
    if (!includeTests) {
      const testPatterns = ['.test.', '.spec.', '/test/', '/tests/', '/__tests__/'];
      for (const pattern of testPatterns) {
        if (normalizedUri.includes(pattern)) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Determine if a symbol is exported.
   * Enhanced heuristic: class, interface, function, type, enum at top level.
   */
  private isExportedSymbol(symbol: IndexedSymbol, _imports: any[]): boolean {
    // Only consider top-level symbols (no container)
    if (symbol.containerName) {
      return false;
    }

    // Consider these kinds as potentially exported
    const exportableKinds = [
      'class', 
      'interface', 
      'function', 
      'type', 
      'enum', 
      'constant',
      'variable' // Some exported variables are intentional APIs
    ];
    
    return exportableKinds.includes(symbol.kind);
  }

  /**
   * Check if symbol has @public, @api, or @export marker in JSDoc or comments.
   */
  private async hasPublicMarker(symbol: IndexedSymbol, fileUri: string): Promise<boolean> {
    try {
      const content = await fsPromises.readFile(fileUri, 'utf-8');
      const lines = content.split('\n');
      
      // Check a few lines before the symbol for JSDoc
      const symbolLine = symbol.location.line;
      const startLine = Math.max(0, symbolLine - 10);
      
      for (let i = startLine; i < symbolLine; i++) {
        const line = lines[i];
        
        // Check for JSDoc tags
        if (line.includes('@public') || 
            line.includes('@api') ||
            line.includes('@export') ||
            line.includes('@publicApi')) {
          return true;
        }
        
        // Check for explicit 'export' keyword (more reliable)
        if (i === symbolLine || i === symbolLine - 1) {
          if (line.trim().startsWith('export ')) {
            // This is definitely exported, but we still want to check usage
            // Don't return true here, let the reference check proceed
          }
        }
      }
      
      return false;
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        // File read error
      }
      return false;
    }
  }

  /**
   * Calculate confidence level based on symbol characteristics.
   */
  private calculateConfidence(
    _symbol: IndexedSymbol,
    sameFileReferences: number
  ): 'high' | 'medium' | 'low' {
    // High confidence: no references at all (truly unused)
    if (sameFileReferences === 0) {
      return 'high';
    }

    // Medium confidence: only used in same file (might be utility function)
    if (sameFileReferences < 3) {
      return 'medium';
    }

    // Low confidence: used multiple times in same file
    // (Could be intentional internal API)
    return 'low';
  }

  /**
   * Check if a symbol is used by an exported symbol in the same file.
   * 
   * This handles the case where an interface (e.g., DeadCodeConfig) is only
   * referenced by another exported symbol (e.g., SmartIndexerConfig) in the same file.
   * The interface is "implicitly alive" through the exported parent symbol.
   * 
   * @param symbol The symbol to check
   * @param fileResult The complete file result with all symbols and references
   * @param exportedSymbolNames Set of exported symbol names in this file
   * @returns true if the symbol is used by an exported symbol (and thus implicitly alive)
   */
  private isUsedByExportedSymbol(
    symbol: IndexedSymbol,
    fileResult: IndexedFileResult,
    exportedSymbolNames: Set<string>
  ): boolean {
    // Find all references to this symbol within the same file
    const localReferences = fileResult.references.filter(
      ref => ref.symbolName === symbol.name && !ref.isImport
    );

    if (localReferences.length === 0) {
      return false;
    }

    // Check if any of these references are within an exported symbol's body
    for (const ref of localReferences) {
      // The containerName tells us which symbol contains this reference
      const containerName = ref.containerName;
      
      if (containerName && exportedSymbolNames.has(containerName)) {
        // This symbol is used by an exported symbol
        return true;
      }
    }

    // Additional check: Look for type annotations in exported symbols
    // Some references may not have containerName set (e.g., property types)
    // In this case, check if any exported symbol uses this type by position
    for (const exportedSymbol of fileResult.symbols) {
      if (!exportedSymbolNames.has(exportedSymbol.name)) {
        continue;
      }
      
      // Skip self-reference
      if (exportedSymbol.name === symbol.name) {
        continue;
      }

      // Check if any reference to our symbol falls within the exported symbol's range
      for (const ref of localReferences) {
        if (this.isPositionWithinRange(ref, exportedSymbol)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if a reference position is within a symbol's range.
   */
  private isPositionWithinRange(ref: IndexedReference, symbol: IndexedSymbol): boolean {
    const refLine = ref.location.line;
    const refChar = ref.location.character;
    const { startLine, startCharacter, endLine, endCharacter } = symbol.range;

    // Check if reference is within the symbol's range
    if (refLine < startLine || refLine > endLine) {
      return false;
    }
    
    if (refLine === startLine && refChar < startCharacter) {
      return false;
    }
    
    if (refLine === endLine && refChar > endCharacter) {
      return false;
    }

    return true;
  }
}
