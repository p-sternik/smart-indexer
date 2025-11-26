import { IndexedFileResult } from '../types.js';
import { SymbolIndexer } from './symbolIndexer.js';
import { TextIndexer } from './textIndexer.js';
import * as path from 'path';

/**
 * Routes files to the appropriate indexer based on language.
 */
export class LanguageRouter {
  private symbolIndexer: SymbolIndexer;
  private textIndexer: TextIndexer;
  private textIndexingEnabled: boolean;

  constructor(symbolIndexer: SymbolIndexer, textIndexingEnabled: boolean = false) {
    this.symbolIndexer = symbolIndexer;
    this.textIndexer = new TextIndexer();
    this.textIndexingEnabled = textIndexingEnabled;
  }

  setTextIndexingEnabled(enabled: boolean): void {
    this.textIndexingEnabled = enabled;
  }

  /**
   * Index a file using the appropriate indexer
   */
  async indexFile(uri: string, content?: string): Promise<IndexedFileResult> {
    const ext = path.extname(uri).toLowerCase();
    
    // TypeScript/JavaScript files use AST-based indexer
    if (this.isTsJsFile(ext)) {
      return this.symbolIndexer.indexFile(uri, content);
    }

    // Other files use text-based indexer if enabled
    if (this.textIndexingEnabled && this.isTextIndexableFile(ext)) {
      return this.textIndexer.indexFile(uri, content);
    }

    // Unknown or disabled - return empty result
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256').update(content || '').digest('hex');
    return { uri, hash, symbols: [], references: [], imports: [] };
  }

  private isTsJsFile(ext: string): boolean {
    return ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(ext);
  }

  private isTextIndexableFile(ext: string): boolean {
    return [
      '.java', '.go', '.cs', '.py', '.rs',
      '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp'
    ].includes(ext);
  }
}
