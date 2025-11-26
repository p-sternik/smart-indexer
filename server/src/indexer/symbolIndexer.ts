import { parse } from '@typescript-eslint/typescript-estree';
import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/typescript-estree';
import { IndexedFileResult, IndexedSymbol, IndexedReference, ImportInfo, ReExportInfo } from '../types.js';
import { createSymbolId } from './symbolResolver.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export class SymbolIndexer {
  async indexFile(uri: string, content?: string): Promise<IndexedFileResult> {
    try {
      const fileContent = content !== undefined ? content : await this.readFile(uri);
      const hash = this.computeHash(fileContent);
      
      const ext = path.extname(uri).toLowerCase();
      const isCodeFile = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(ext);
      
      if (isCodeFile) {
        const result = this.extractCodeSymbolsAndReferences(uri, fileContent);
        return {
          uri,
          hash,
          symbols: result.symbols,
          references: result.references,
          imports: result.imports,
          reExports: result.reExports
        };
      } else {
        const symbols = this.extractTextSymbols(uri, fileContent);
        return {
          uri,
          hash,
          symbols,
          references: [],
          imports: [],
          reExports: []
        };
      }
    } catch (error) {
      console.error(`[SymbolIndexer] Error indexing file ${uri}: ${error}`);
      const hash = this.computeHash(content || '');
      return {
        uri,
        hash,
        symbols: [],
        references: [],
        imports: [],
        reExports: []
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

  private extractCodeSymbolsAndReferences(uri: string, content: string): {
    symbols: IndexedSymbol[];
    references: IndexedReference[];
    imports: ImportInfo[];
    reExports: ReExportInfo[];
  } {
    const symbols: IndexedSymbol[] = [];
    const references: IndexedReference[] = [];
    const imports: ImportInfo[] = [];
    const reExports: ReExportInfo[] = [];

    try {
      const ast = parse(content, {
        loc: true,
        range: true,
        comment: false,
        tokens: false,
        errorOnUnknownASTType: false,
        jsx: uri.endsWith('x')
      });

      // First pass: extract imports and re-exports
      this.extractImports(ast, imports);
      this.extractReExports(ast, reExports);

      // Second pass: extract symbols and references
      this.traverseAST(ast, symbols, references, uri, undefined, undefined, [], imports);
    } catch (error) {
      console.error(`[SymbolIndexer] Error parsing code file ${uri}: ${error}`);
    }

    return { symbols, references, imports, reExports };
  }

  private extractImports(ast: TSESTree.Program, imports: ImportInfo[]): void {
    for (const statement of ast.body) {
      if (statement.type === AST_NODE_TYPES.ImportDeclaration) {
        const moduleSpecifier = statement.source.value as string;
        
        for (const specifier of statement.specifiers) {
          if (specifier.type === AST_NODE_TYPES.ImportDefaultSpecifier) {
            imports.push({
              localName: specifier.local.name,
              moduleSpecifier,
              isDefault: true
            });
          } else if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
            imports.push({
              localName: specifier.local.name,
              moduleSpecifier,
              isNamespace: true
            });
          } else if (specifier.type === AST_NODE_TYPES.ImportSpecifier) {
            imports.push({
              localName: specifier.local.name,
              moduleSpecifier,
              isDefault: false
            });
          }
        }
      }
    }
  }

  private extractReExports(ast: TSESTree.Program, reExports: ReExportInfo[]): void {
    for (const statement of ast.body) {
      // export * from './module'
      if (statement.type === AST_NODE_TYPES.ExportAllDeclaration) {
        const moduleSpecifier = statement.source.value as string;
        reExports.push({
          moduleSpecifier,
          isAll: true
        });
      }
      
      // export { Foo, Bar } from './module'
      else if (statement.type === AST_NODE_TYPES.ExportNamedDeclaration && statement.source) {
        const moduleSpecifier = statement.source.value as string;
        const exportedNames: string[] = [];
        
        for (const specifier of statement.specifiers) {
          if (specifier.type === AST_NODE_TYPES.ExportSpecifier) {
            // Handle both Identifier and string literal exports
            const exportedName = specifier.exported.type === AST_NODE_TYPES.Identifier
              ? specifier.exported.name
              : (specifier.exported as TSESTree.StringLiteral).value;
            exportedNames.push(exportedName);
          }
        }
        
        if (exportedNames.length > 0) {
          reExports.push({
            moduleSpecifier,
            exportedNames
          });
        }
      }
    }
  }

  private traverseAST(
    node: TSESTree.Node,
    symbols: IndexedSymbol[],
    references: IndexedReference[],
    uri: string,
    containerName?: string,
    containerKind?: string,
    containerPath: string[] = [],
    imports: ImportInfo[] = []
  ): void {
    if (!node || !node.loc) {return;}

    try {
      // Track references to identifiers
      if (node.type === AST_NODE_TYPES.Identifier && node.loc) {
        const parent = this.getParentContext(node);
        
        // Skip if this identifier is a declaration (we track it as a symbol)
        if (!this.isDeclaration(parent)) {
          const isImportRef = imports.some(imp => imp.localName === node.name);
          
          references.push({
            symbolName: node.name,
            location: {
              uri,
              line: node.loc.start.line - 1,
              character: node.loc.start.column
            },
            range: {
              startLine: node.loc.start.line - 1,
              startCharacter: node.loc.start.column,
              endLine: node.loc.end.line - 1,
              endCharacter: node.loc.end.column
            },
            containerName,
            isImport: isImportRef
          });
        }
      }
      
      // Track member expressions (e.g., obj.method())
      if (node.type === AST_NODE_TYPES.MemberExpression) {
        const memberExpr = node as TSESTree.MemberExpression;
        if (memberExpr.property.type === AST_NODE_TYPES.Identifier && memberExpr.property.loc) {
          references.push({
            symbolName: memberExpr.property.name,
            location: {
              uri,
              line: memberExpr.property.loc.start.line - 1,
              character: memberExpr.property.loc.start.column
            },
            range: {
              startLine: memberExpr.property.loc.start.line - 1,
              startCharacter: memberExpr.property.loc.start.column,
              endLine: memberExpr.property.loc.end.line - 1,
              endCharacter: memberExpr.property.loc.end.column
            },
            containerName
          });
        }
      }

      let symbolName: string | undefined;
      let symbolKind: string | undefined;
      let isStatic: boolean | undefined;
      let parametersCount: number | undefined;

      switch (node.type) {
        case AST_NODE_TYPES.FunctionDeclaration:
          if ((node as TSESTree.FunctionDeclaration).id?.name) {
            symbolName = (node as TSESTree.FunctionDeclaration).id!.name;
            symbolKind = 'function';
            parametersCount = (node as TSESTree.FunctionDeclaration).params.length;
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
            if (decl.id.type === AST_NODE_TYPES.Identifier && decl.id.loc) {
              const varKind = (node as TSESTree.VariableDeclaration).kind === 'const' ? 'constant' : 'variable';
              const varName = decl.id.name;
              const fullContainerPath = containerPath.length > 0 ? containerPath.join('.') : undefined;
              const id = createSymbolId(
                uri,
                varName,
                containerName,
                fullContainerPath,
                varKind,
                false,
                undefined,
                decl.id.loc.start.line - 1,
                decl.id.loc.start.column
              );
              symbols.push({
                id,
                name: varName,
                kind: varKind,
                location: {
                  uri,
                  line: decl.id.loc.start.line - 1,
                  character: decl.id.loc.start.column
                },
                range: {
                  startLine: decl.id.loc.start.line - 1,
                  startCharacter: decl.id.loc.start.column,
                  endLine: decl.id.loc.end.line - 1,
                  endCharacter: decl.id.loc.end.column
                },
                containerName,
                containerKind,
                fullContainerPath,
                filePath: uri
              });
            }
          }
          break;

        case AST_NODE_TYPES.MethodDefinition:
          if ((node as TSESTree.MethodDefinition).key.type === AST_NODE_TYPES.Identifier) {
            const methodNode = node as TSESTree.MethodDefinition;
            const methodName = (methodNode.key as TSESTree.Identifier).name;
            const methodStatic = methodNode.static;
            const methodParams = methodNode.value.params.length;
            const fullContainerPath = containerPath.length > 0 ? containerPath.join('.') : undefined;
            const id = createSymbolId(
              uri,
              methodName,
              containerName,
              fullContainerPath,
              'method',
              methodStatic,
              methodParams,
              methodNode.key.loc.start.line - 1,
              methodNode.key.loc.start.column
            );
            symbols.push({
              id,
              name: methodName,
              kind: 'method',
              location: {
                uri,
                line: methodNode.key.loc.start.line - 1,
                character: methodNode.key.loc.start.column
              },
              range: {
                startLine: node.loc.start.line - 1,
                startCharacter: node.loc.start.column,
                endLine: node.loc.end.line - 1,
                endCharacter: node.loc.end.column
              },
              containerName,
              containerKind,
              fullContainerPath,
              isStatic: methodStatic,
              parametersCount: methodParams,
              filePath: uri
            });
          }
          break;

        case AST_NODE_TYPES.PropertyDefinition:
          if ((node as TSESTree.PropertyDefinition).key.type === AST_NODE_TYPES.Identifier) {
            const propNode = node as TSESTree.PropertyDefinition;
            const propName = (propNode.key as TSESTree.Identifier).name;
            const propStatic = propNode.static;
            const fullContainerPath = containerPath.length > 0 ? containerPath.join('.') : undefined;
            const id = createSymbolId(
              uri,
              propName,
              containerName,
              fullContainerPath,
              'property',
              propStatic,
              undefined,
              propNode.key.loc.start.line - 1,
              propNode.key.loc.start.column
            );
            symbols.push({
              id,
              name: propName,
              kind: 'property',
              location: {
                uri,
                line: propNode.key.loc.start.line - 1,
                character: propNode.key.loc.start.column
              },
              range: {
                startLine: node.loc.start.line - 1,
                startCharacter: node.loc.start.column,
                endLine: node.loc.end.line - 1,
                endCharacter: node.loc.end.column
              },
              containerName,
              containerKind,
              fullContainerPath,
              isStatic: propStatic,
              filePath: uri
            });
          }
          break;
      }

      if (symbolName && symbolKind) {
        const fullContainerPath = containerPath.length > 0 ? containerPath.join('.') : undefined;
        const id = createSymbolId(
          uri,
          symbolName,
          containerName,
          fullContainerPath,
          symbolKind,
          isStatic,
          parametersCount,
          node.loc.start.line - 1,
          node.loc.start.column
        );
        symbols.push({
          id,
          name: symbolName,
          kind: symbolKind,
          location: {
            uri,
            line: node.loc.start.line - 1,
            character: node.loc.start.column
          },
          range: {
            startLine: node.loc.start.line - 1,
            startCharacter: node.loc.start.column,
            endLine: node.loc.end.line - 1,
            endCharacter: node.loc.end.column
          },
          containerName,
          containerKind,
          fullContainerPath,
          isStatic,
          parametersCount,
          filePath: uri
        });

        const newContainer = symbolName;
        const newContainerKind = symbolKind;
        
        // Build new container path for nested structures
        const newContainerPath = [...containerPath];
        if (['class', 'interface', 'enum', 'namespace', 'module'].includes(symbolKind)) {
          newContainerPath.push(symbolName);
        }
        
        for (const key in node) {
          const child = (node as any)[key];
          if (child && typeof child === 'object') {
            if (Array.isArray(child)) {
              for (const item of child) {
                if (item && typeof item === 'object' && item.type) {
                  this.traverseAST(item, symbols, references, uri, newContainer, newContainerKind, newContainerPath, imports);
                }
              }
            } else if (child.type) {
              this.traverseAST(child, symbols, references, uri, newContainer, newContainerKind, newContainerPath, imports);
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
                  this.traverseAST(item, symbols, references, uri, containerName, containerKind, containerPath, imports);
                }
              }
            } else if (child.type) {
              this.traverseAST(child, symbols, references, uri, containerName, containerKind, containerPath, imports);
            }
          }
        }
      }
    } catch (error) {
      console.error(`[SymbolIndexer] Error traversing AST node in ${uri}: ${error}`);
    }
  }

  private isDeclaration(parent: string | null): boolean {
    if (!parent) {
      return false;
    }
    return [
      'FunctionDeclaration',
      'ClassDeclaration',
      'VariableDeclarator',
      'MethodDefinition',
      'PropertyDefinition',
      'TSInterfaceDeclaration',
      'TSTypeAliasDeclaration',
      'TSEnumDeclaration',
      'ImportSpecifier',
      'ImportDefaultSpecifier',
      'ImportNamespaceSpecifier'
    ].includes(parent);
  }

  private getParentContext(node: TSESTree.Node): string | null {
    // This is a simplified version - in a real implementation,
    // you'd track parent during traversal
    return null;
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
            const id = createSymbolId(uri, word, undefined, undefined, 'text', false, undefined, i, index);
            symbols.push({
              id,
              name: word,
              kind: 'text',
              location: {
                uri,
                line: i,
                character: index
              },
              range: {
                startLine: i,
                startCharacter: index,
                endLine: i,
                endCharacter: index + word.length
              },
              filePath: uri
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
