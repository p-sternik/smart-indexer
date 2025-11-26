import { BackgroundIndex } from '../index/backgroundIndex.js';
import { IndexedSymbol, IndexedReference } from '../types.js';
import * as fs from 'fs';

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

/**
 * Dead Code Detector - Beta Feature
 * 
 * Identifies potentially unused exports by analyzing reference counts.
 * Leverages the background index to find symbols with zero cross-file references.
 */
export class DeadCodeDetector {
  constructor(private backgroundIndex: BackgroundIndex) {}

  /**
   * Find unused exports across the workspace.
   * 
   * @param options Analysis options
   * @returns List of dead code candidates
   */
  async findDeadCode(options?: {
    excludePatterns?: string[];
    includeTests?: boolean;
  }): Promise<DeadCodeAnalysisResult> {
    const excludePatterns = options?.excludePatterns || ['node_modules', '.test.', '.spec.', 'test/', 'tests/'];
    const includeTests = options?.includeTests || false;
    
    const candidates: DeadCodeCandidate[] = [];
    let totalExports = 0;
    let analyzedFiles = 0;

    // Get all files from the background index
    const allFiles = await this.backgroundIndex.getAllFiles();
    
    for (const fileUri of allFiles) {
      // Skip excluded patterns
      if (this.shouldExcludeFile(fileUri, excludePatterns, includeTests)) {
        continue;
      }

      analyzedFiles++;
      const fileResult = await this.backgroundIndex.getFileResult(fileUri);
      
      if (!fileResult) {
        continue;
      }

      // Check each exported symbol
      for (const symbol of fileResult.symbols) {
        if (!this.isExportedSymbol(symbol, fileResult.imports)) {
          continue;
        }

        totalExports++;

        // Check if symbol has JSDoc @public tag or similar markers
        if (await this.hasPublicMarker(symbol, fileUri)) {
          continue;
        }

        // Find references to this symbol
        const references = await this.backgroundIndex.findReferences(symbol.name);
        
        // Filter out references in the same file
        const crossFileReferences = references.filter(
          ref => ref.location.uri !== fileUri
        );

        if (crossFileReferences.length === 0) {
          candidates.push({
            symbol,
            reason: 'No cross-file references found',
            confidence: this.calculateConfidence(symbol, references.length)
          });
        }
      }
    }

    return {
      candidates,
      totalExports,
      analyzedFiles
    };
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
    
    for (const pattern of excludePatterns) {
      if (!includeTests && (pattern.includes('test') || pattern.includes('spec'))) {
        if (normalizedUri.includes(pattern)) {
          return true;
        }
      } else if (normalizedUri.includes(pattern)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Determine if a symbol is exported.
   * Heuristic: class, interface, function, type, enum at top level.
   */
  private isExportedSymbol(symbol: IndexedSymbol, imports: any[]): boolean {
    // Only consider top-level symbols (no container)
    if (symbol.containerName) {
      return false;
    }

    // Consider these kinds as potentially exported
    const exportableKinds = ['class', 'interface', 'function', 'type', 'enum', 'constant'];
    return exportableKinds.includes(symbol.kind);
  }

  /**
   * Check if symbol has @public marker in JSDoc or comments.
   */
  private async hasPublicMarker(symbol: IndexedSymbol, fileUri: string): Promise<boolean> {
    try {
      const content = fs.readFileSync(fileUri, 'utf-8');
      const lines = content.split('\n');
      
      // Check a few lines before the symbol for JSDoc
      const symbolLine = symbol.location.line;
      const startLine = Math.max(0, symbolLine - 10);
      
      for (let i = startLine; i < symbolLine; i++) {
        const line = lines[i];
        if (line.includes('@public') || line.includes('@api')) {
          return true;
        }
      }
      
      return false;
    } catch (error) {
      console.error(`[DeadCodeDetector] Error reading file ${fileUri}: ${error}`);
      return false;
    }
  }

  /**
   * Calculate confidence level based on symbol characteristics.
   */
  private calculateConfidence(
    symbol: IndexedSymbol,
    sameFileReferences: number
  ): 'high' | 'medium' | 'low' {
    // High confidence: no references at all
    if (sameFileReferences === 0) {
      return 'high';
    }

    // Medium confidence: only used in same file
    if (sameFileReferences < 3) {
      return 'medium';
    }

    // Low confidence: used multiple times in same file (might be intentional)
    return 'low';
  }
}
