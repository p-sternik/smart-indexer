import { IndexedSymbol, IndexedFileResult } from '../types.js';
import { createSymbolId } from './symbolResolver.js';
import * as crypto from 'crypto';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

/**
 * Simple regex-based indexer for non-TypeScript/JavaScript files.
 * Extracts likely symbol names using heuristics.
 */
export class TextIndexer {
  // Language-specific patterns
  private patterns = {
    // Java: class, interface, enum, method
    java: [
      /(?:public|private|protected)?\s*(?:static|final|abstract)?\s*class\s+(\w+)/g,
      /(?:public|private|protected)?\s*interface\s+(\w+)/g,
      /(?:public|private|protected)?\s*enum\s+(\w+)/g,
      /(?:public|private|protected)?\s+(?:static\s+)?(?:\w+\s+)?(\w+)\s*\(/g
    ],
    // Go: type, func, interface
    go: [
      /type\s+(\w+)\s+struct/g,
      /type\s+(\w+)\s+interface/g,
      /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/g
    ],
    // C#: class, interface, struct, method
    csharp: [
      /(?:public|private|protected|internal)?\s*(?:static|sealed|abstract)?\s*class\s+(\w+)/g,
      /(?:public|private|protected|internal)?\s*interface\s+(\w+)/g,
      /(?:public|private|protected|internal)?\s*struct\s+(\w+)/g,
      /(?:public|private|protected|internal)?\s+(?:static\s+)?(?:\w+\s+)?(\w+)\s*\(/g
    ],
    // Python: class, def
    python: [
      /class\s+(\w+)/g,
      /def\s+(\w+)\s*\(/g
    ],
    // Rust: struct, enum, fn, trait
    rust: [
      /(?:pub\s+)?struct\s+(\w+)/g,
      /(?:pub\s+)?enum\s+(\w+)/g,
      /(?:pub\s+)?fn\s+(\w+)/g,
      /(?:pub\s+)?trait\s+(\w+)/g
    ],
    // C/C++: class, struct, function
    cpp: [
      /class\s+(\w+)/g,
      /struct\s+(\w+)/g,
      /(?:\w+\s+)+(\w+)\s*\([^)]*\)\s*(?:const)?\s*\{/g
    ]
  };

  /**
   * Index a file using text-based heuristics
   */
  async indexFile(uri: string, content?: string): Promise<IndexedFileResult> {
    try {
      const fileContent = content !== undefined ? content : await this.readFile(uri);
      const hash = this.computeHash(fileContent);
      const symbols = this.extractSymbols(uri, fileContent);

      return { uri, hash, symbols, references: [], imports: [] };
    } catch (error) {
      return {
        uri,
        hash: this.computeHash(content || ''),
        symbols: [],
        references: [],
        imports: []
      };
    }
  }

  private async readFile(uri: string): Promise<string> {
    try {
      return await fsPromises.readFile(uri, 'utf-8');
    } catch (error) {
      return '';
    }
  }

  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private extractSymbols(uri: string, content: string): IndexedSymbol[] {
    const ext = path.extname(uri).toLowerCase();
    const language = this.detectLanguage(ext);
    
    if (!language) {
      return [];
    }

    const symbols: IndexedSymbol[] = [];
    const lines = content.split('\n');
    const patterns = this.patterns[language] || [];

    for (const pattern of patterns) {
      // Reset regex state
      pattern.lastIndex = 0;
      
      let match;
      const text = content;
      
      while ((match = pattern.exec(text)) !== null) {
        const symbolName = match[1];
        if (!symbolName || symbolName.length === 0) {
          continue;
        }

        // Find line number
        const position = match.index;
        let line = 0;
        let currentPos = 0;
        
        for (let i = 0; i < lines.length; i++) {
          const lineLength = lines[i].length + 1; // +1 for newline
          if (currentPos + lineLength > position) {
            line = i;
            break;
          }
          currentPos += lineLength;
        }

        const character = position - currentPos;

        const id = createSymbolId(uri, symbolName, undefined, undefined, 'text', false, undefined, line, Math.max(0, character));

        symbols.push({
          id,
          name: symbolName,
          kind: 'text', // Mark as text-indexed
          location: {
            uri,
            line,
            character: Math.max(0, character)
          },
          range: {
            startLine: line,
            startCharacter: Math.max(0, character),
            endLine: line,
            endCharacter: Math.max(0, character) + symbolName.length
          },
          filePath: uri,
          isDefinition: false // Text symbols are not true definitions
        });
      }
    }

    return symbols;
  }

  private detectLanguage(ext: string): keyof typeof this.patterns | null {
    switch (ext) {
      case '.java':
        return 'java';
      case '.go':
        return 'go';
      case '.cs':
        return 'csharp';
      case '.py':
        return 'python';
      case '.rs':
        return 'rust';
      case '.cpp':
      case '.cc':
      case '.cxx':
      case '.c':
      case '.h':
      case '.hpp':
        return 'cpp';
      default:
        return null;
    }
  }
}
