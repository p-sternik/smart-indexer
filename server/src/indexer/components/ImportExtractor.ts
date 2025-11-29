import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/typescript-estree';
import { ImportInfo, ReExportInfo } from '../../types.js';
import { StringInterner } from './StringInterner.js';

/**
 * ImportExtractor - Extracts import and re-export information from AST.
 */
export class ImportExtractor {
  constructor(private interner: StringInterner) {}

  /**
   * Extract import declarations from AST.
   */
  extractImports(ast: TSESTree.Program): ImportInfo[] {
    const imports: ImportInfo[] = [];

    for (const statement of ast.body) {
      if (statement.type === AST_NODE_TYPES.ImportDeclaration) {
        // Intern module specifiers - commonly repeated across files
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
            imports.push({
              localName: this.interner.intern(specifier.local.name),
              moduleSpecifier,
              isDefault: false
            });
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
