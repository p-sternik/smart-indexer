import { parse } from '@typescript-eslint/typescript-estree';
import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/typescript-estree';
import { IndexedFileResult, IndexedSymbol } from '../types.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export class SymbolIndexer {
  async indexFile(uri: string, content?: string): Promise<IndexedFileResult> {
    try {
      const fileContent = content !== undefined ? content : await this.readFile(uri);
      const hash = this.computeHash(fileContent);
      const symbols = await this.extractSymbols(uri, fileContent);

      return {
        uri,
        hash,
        symbols
      };
    } catch (error) {
      console.error(`[SymbolIndexer] Error indexing file ${uri}: ${error}`);
      const hash = this.computeHash(content || '');
      return {
        uri,
        hash,
        symbols: []
      };
    }
  }

  private async readFile(uri: string): Promise<string> {
    try {
      return fs.readFileSync(uri, 'utf-8');
    } catch (error) {
      console.error(`[SymbolIndexer] Error reading file ${uri}: ${error}`);
      return '';
    }
  }

  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private async extractSymbols(uri: string, content: string): Promise<IndexedSymbol[]> {
    try {
      const ext = path.extname(uri).toLowerCase();

      if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(ext)) {
        return this.extractCodeSymbols(uri, content);
      }

      return this.extractTextSymbols(uri, content);
    } catch (error) {
      console.error(`[SymbolIndexer] Error extracting symbols from ${uri}: ${error}`);
      return [];
    }
  }

  private extractCodeSymbols(uri: string, content: string): IndexedSymbol[] {
    const symbols: IndexedSymbol[] = [];

    try {
      const ast = parse(content, {
        loc: true,
        range: true,
        comment: false,
        tokens: false,
        errorOnUnknownASTType: false,
        jsx: uri.endsWith('x')
      });

      this.traverseAST(ast, symbols, uri);
    } catch (error) {
      console.error(`[SymbolIndexer] Error parsing code file ${uri}: ${error}`);
    }

    return symbols;
  }

  private traverseAST(
    node: TSESTree.Node,
    symbols: IndexedSymbol[],
    uri: string,
    containerName?: string
  ): void {
    if (!node || !node.loc) {return;}

    try {
      let symbolName: string | undefined;
      let symbolKind: string | undefined;

      switch (node.type) {
        case AST_NODE_TYPES.FunctionDeclaration:
          if ((node as TSESTree.FunctionDeclaration).id?.name) {
            symbolName = (node as TSESTree.FunctionDeclaration).id!.name;
            symbolKind = 'function';
          }
          break;

        case AST_NODE_TYPES.ClassDeclaration:
          if ((node as TSESTree.ClassDeclaration).id?.name) {
            symbolName = (node as TSESTree.ClassDeclaration).id!.name;
            symbolKind = 'class';
          }
          break;

        case AST_NODE_TYPES.TSInterfaceDeclaration:
          if ((node as TSESTree.TSInterfaceDeclaration).id?.name) {
            symbolName = (node as TSESTree.TSInterfaceDeclaration).id.name;
            symbolKind = 'interface';
          }
          break;

        case AST_NODE_TYPES.TSTypeAliasDeclaration:
          if ((node as TSESTree.TSTypeAliasDeclaration).id?.name) {
            symbolName = (node as TSESTree.TSTypeAliasDeclaration).id.name;
            symbolKind = 'type';
          }
          break;

        case AST_NODE_TYPES.TSEnumDeclaration:
          if ((node as TSESTree.TSEnumDeclaration).id?.name) {
            symbolName = (node as TSESTree.TSEnumDeclaration).id.name;
            symbolKind = 'enum';
          }
          break;

        case AST_NODE_TYPES.VariableDeclaration:
          for (const decl of (node as TSESTree.VariableDeclaration).declarations) {
            if (decl.id.type === AST_NODE_TYPES.Identifier) {
              symbols.push({
                name: decl.id.name,
                kind: (node as TSESTree.VariableDeclaration).kind === 'const' ? 'constant' : 'variable',
                location: {
                  uri,
                  line: decl.id.loc.start.line - 1,
                  character: decl.id.loc.start.column
                },
                containerName
              });
            }
          }
          break;

        case AST_NODE_TYPES.MethodDefinition:
          if ((node as TSESTree.MethodDefinition).key.type === AST_NODE_TYPES.Identifier) {
            symbols.push({
              name: ((node as TSESTree.MethodDefinition).key as TSESTree.Identifier).name,
              kind: 'method',
              location: {
                uri,
                line: (node as TSESTree.MethodDefinition).key.loc.start.line - 1,
                character: (node as TSESTree.MethodDefinition).key.loc.start.column
              },
              containerName
            });
          }
          break;

        case AST_NODE_TYPES.PropertyDefinition:
          if ((node as TSESTree.PropertyDefinition).key.type === AST_NODE_TYPES.Identifier) {
            symbols.push({
              name: ((node as TSESTree.PropertyDefinition).key as TSESTree.Identifier).name,
              kind: 'property',
              location: {
                uri,
                line: (node as TSESTree.PropertyDefinition).key.loc.start.line - 1,
                character: (node as TSESTree.PropertyDefinition).key.loc.start.column
              },
              containerName
            });
          }
          break;
      }

      if (symbolName && symbolKind) {
        symbols.push({
          name: symbolName,
          kind: symbolKind,
          location: {
            uri,
            line: node.loc.start.line - 1,
            character: node.loc.start.column
          },
          containerName
        });

        const newContainer = symbolName;
        for (const key in node) {
          const child = (node as any)[key];
          if (child && typeof child === 'object') {
            if (Array.isArray(child)) {
              for (const item of child) {
                if (item && typeof item === 'object' && item.type) {
                  this.traverseAST(item, symbols, uri, newContainer);
                }
              }
            } else if (child.type) {
              this.traverseAST(child, symbols, uri, newContainer);
            }
          }
        }
      } else {
        for (const key in node) {
          const child = (node as any)[key];
          if (child && typeof child === 'object') {
            if (Array.isArray(child)) {
              for (const item of child) {
                if (item && typeof item === 'object' && item.type) {
                  this.traverseAST(item, symbols, uri, containerName);
                }
              }
            } else if (child.type) {
              this.traverseAST(child, symbols, uri, containerName);
            }
          }
        }
      }
    } catch (error) {
      console.error(`[SymbolIndexer] Error traversing AST node in ${uri}: ${error}`);
    }
  }

  private extractTextSymbols(uri: string, content: string): IndexedSymbol[] {
    const symbols: IndexedSymbol[] = [];
    
    try {
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const words = line.match(/\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g);

        if (words) {
          for (const word of words) {
            const index = line.indexOf(word);
            symbols.push({
              name: word,
              kind: 'text',
              location: {
                uri,
                line: i,
                character: index
              }
            });
          }
        }
      }
    } catch (error) {
      console.error(`[SymbolIndexer] Error extracting text symbols from ${uri}: ${error}`);
    }

    return symbols;
  }
}
