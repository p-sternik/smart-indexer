import { parse, TSESTree } from '@typescript-eslint/typescript-estree';
import * as crypto from 'crypto';

/**
 * AstParser - Wraps the TypeScript-ESTree parser with consistent options.
 */
export class AstParser {
  /**
   * Parse TypeScript/JavaScript source code into an AST.
   * 
   * @param content - Source code content
   * @param uri - File URI (used to determine JSX support)
   * @returns Parsed AST or null if parsing failed
   */
  parse(content: string, uri: string): TSESTree.Program | null {
    try {
      return parse(content, {
        loc: true,
        range: true,
        comment: false,
        tokens: false,
        errorOnUnknownASTType: false,
        jsx: uri.endsWith('x')
      });
    } catch (error) {
      return null;
    }
  }

  /**
   * Compute a SHA-256 hash of the content for change detection.
   */
  computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}

// Singleton instance for the worker
export const astParser = new AstParser();
