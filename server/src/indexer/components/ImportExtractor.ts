import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/typescript-estree';
import { ImportInfo, ReExportInfo } from '../../types.js';
import { StringInterner } from './StringInterner.js';

/**
 * ImportExtractor - Extracts import and re-export information from AST.
 * Supports both ESM (import) and CommonJS (require) with rename tracking.
 */
export class ImportExtractor {
  constructor(private interner: StringInterner) {}

  /**
   * Extract import declarations from AST - supports both ESM and CommonJS.
   * Captures aliasing: import { User as Admin } -> exportedName: "User", localName: "Admin"
   */
  extractImports(ast: TSESTree.Program): ImportInfo[] {
    const imports: ImportInfo[] = [];

    for (const statement of ast.body) {
      // ESM: import statements
      if (statement.type === AST_NODE_TYPES.ImportDeclaration) {
        const moduleSpecifier = this.interner.intern(statement.source.value as string);
        
        for (const specifier of statement.specifiers) {
          if (specifier.type === AST_NODE_TYPES.ImportDefaultSpecifier) {
            imports.push({
              localName: this.interner.intern(specifier.local.name),
              moduleSpecifier,
              isDefault: true
            });
          } else if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
            imports.push({
              localName: this.interner.intern(specifier.local.name),
              moduleSpecifier,
              isNamespace: true
            });
          } else if (specifier.type === AST_NODE_TYPES.ImportSpecifier) {
            const localName = this.interner.intern(specifier.local.name);
            const importedName = specifier.imported.type === AST_NODE_TYPES.Identifier
              ? specifier.imported.name
              : (specifier.imported as any).value;
            
            imports.push({
              localName,
              moduleSpecifier,
              isDefault: false,
              exportedName: importedName !== localName ? this.interner.intern(importedName) : undefined
            });
          }
        }
      }
      
      // CommonJS: const X = require('...')
      else if (statement.type === AST_NODE_TYPES.VariableDeclaration) {
        for (const declarator of statement.declarations) {
          if (declarator.init && 
              declarator.init.type === AST_NODE_TYPES.CallExpression &&
              declarator.init.callee.type === AST_NODE_TYPES.Identifier &&
              declarator.init.callee.name === 'require' &&
              declarator.init.arguments.length > 0 &&
              declarator.init.arguments[0].type === AST_NODE_TYPES.Literal) {
            
            const moduleSpecifier = this.interner.intern(declarator.init.arguments[0].value as string);
            
            // const X = require('...')
            if (declarator.id.type === AST_NODE_TYPES.Identifier) {
              imports.push({
                localName: this.interner.intern(declarator.id.name),
                moduleSpecifier,
                isDefault: true,
                isCJS: true
              });
            }
            // const { X, Y as Z } = require('...')
            else if (declarator.id.type === AST_NODE_TYPES.ObjectPattern) {
              for (const prop of declarator.id.properties) {
                if (prop.type === AST_NODE_TYPES.Property) {
                  const key = prop.key.type === AST_NODE_TYPES.Identifier 
                    ? prop.key.name 
                    : (prop.key as TSESTree.Literal).value as string;
                  const value = prop.value.type === AST_NODE_TYPES.Identifier 
                    ? prop.value.name 
                    : null;
                  
                  if (value) {
                    imports.push({
                      localName: this.interner.intern(value),
                      moduleSpecifier,
                      isDefault: false,
                      isCJS: true,
                      exportedName: key !== value ? this.interner.intern(key) : undefined
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    return imports;
  }

  /**
   * Extract re-export declarations from AST.
   */
  extractReExports(ast: TSESTree.Program): ReExportInfo[] {
    const reExports: ReExportInfo[] = [];

    for (const statement of ast.body) {
      if (statement.type === AST_NODE_TYPES.ExportAllDeclaration) {
        const moduleSpecifier = this.interner.intern(statement.source.value as string);
        reExports.push({
          moduleSpecifier,
          isAll: true
        });
      }
      else if (statement.type === AST_NODE_TYPES.ExportNamedDeclaration && statement.source) {
        const moduleSpecifier = this.interner.intern(statement.source.value as string);
        const exportedNames: string[] = [];
        
        for (const specifier of statement.specifiers) {
          if (specifier.type === AST_NODE_TYPES.ExportSpecifier) {
            const exportedName = specifier.exported.type === AST_NODE_TYPES.Identifier
              ? specifier.exported.name
              : (specifier.exported as TSESTree.StringLiteral).value;
            exportedNames.push(this.interner.intern(exportedName));
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

    return reExports;
  }
}
