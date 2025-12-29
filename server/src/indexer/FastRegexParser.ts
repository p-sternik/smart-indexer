import { IndexedSymbol, IndexedReference } from '../types.js';
import { createSymbolId } from './symbolResolver.js';

/**
 * FastRegexParser - A high-performance, regex-based symbol extractor.
 * 
 * This parser is used for ultra-fast indexing (Level 4 optimization)
 * where full AST parsing is too expensive or unnecessary.
 */
export class FastRegexParser {
  private static readonly PATTERNS = {
    class: /(?:export\s+)?class\s+([A-Z][a-zA-Z0-9_]*)/g,
    function: /(?:export\s+)?function\s+([a-zA-Z0-9_]+)\s*\(/g,
    interface: /(?:export\s+)?interface\s+([A-Z][a-zA-Z0-9_]*)/g,
    type: /(?:export\s+)?type\s+([A-Z][a-zA-Z0-9_]*)\s*=/g,
    enum: /(?:export\s+)?enum\s+([A-Z][a-zA-Z0-9_]*)/g,
    const: /(?:export\s+)?const\s+([a-zA-Z0-9_]+)\s*[:=]/g,
    method: /^\s*(?:public|private|protected|static|async)?\s*([a-zA-Z0-9_]+)\s*\([^)]*\)\s*[:{]/gm
  };

  /**
   * Masks comments and strings with spaces to avoid false positives
   * while preserving character offsets.
   */
  private static maskComments(content: string): string {
    // Mask block comments
    let masked = content.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length));
    // Mask line comments
    masked = masked.replace(/\/\/.*/g, m => ' '.repeat(m.length));
    // Mask strings (single and double quotes)
    masked = masked.replace(/(['"])(?:(?!\1|\\).|\\.)*\1/g, m => ' '.repeat(m.length));
    return masked;
  }

  /**
   * Rapidly extract symbols from a file using regex.
   * This is ~10-20x faster than full AST parsing.
   */
  public static extractSymbols(uri: string, content: string): IndexedSymbol[] {
    const symbols: IndexedSymbol[] = [];
    const lines = content.split('\n');
    const maskedContent = this.maskComments(content);

    for (const [kind, regex] of Object.entries(this.PATTERNS)) {
      const matches = maskedContent.matchAll(regex);
      for (const match of matches) {
        const name = match[1];
        const offset = match.index!;
        
        // Find line and column in ORIGINAL content (offsets are same)
        let currentOffset = 0;
        let line = 0;
        for (let i = 0; i < lines.length; i++) {
          if (currentOffset + lines[i].length + 1 > offset) {
            line = i;
            break;
          }
          currentOffset += lines[i].length + 1;
        }
        const character = offset - currentOffset;

        const id = createSymbolId(uri, name, undefined, undefined, kind, false, undefined, line, character);
        
        symbols.push({
          id,
          name,
          kind: kind as any,
          location: { uri, line, character },
          range: {
            startLine: line,
            startCharacter: character,
            endLine: line,
            endCharacter: character + name.length
          },
          filePath: uri,
          isDefinition: true,
          isExported: match[0].includes('export')
        });
      }
    }

    return symbols;
  }

  /**
   * Rapidly extract references using a simple word-boundary regex.
   */
  public static extractReferences(uri: string, content: string, symbolNames: Set<string>): IndexedReference[] {
    const references: IndexedReference[] = [];
    const maskedContent = this.maskComments(content);
    const words = maskedContent.matchAll(/\b([a-zA-Z0-9_]{3,})\b/g);
    const lines = content.split('\n');

    for (const match of words) {
      const name = match[1];
      if (symbolNames.has(name)) {
        const offset = match.index!;
        let currentOffset = 0;
        let line = 0;
        for (let i = 0; i < lines.length; i++) {
          if (currentOffset + lines[i].length + 1 > offset) {
            line = i;
            break;
          }
          currentOffset += lines[i].length + 1;
        }
        const character = offset - currentOffset;

        references.push({
          symbolName: name,
          location: { uri, line, character },
          range: {
            startLine: line,
            startCharacter: character,
            endLine: line,
            endCharacter: character + name.length
          },
          isLocal: false // Regex can't easily determine locality
        });
      }
    }
    return references;
  }
}
