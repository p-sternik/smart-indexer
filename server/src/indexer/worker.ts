import { parentPort } from 'worker_threads';
import { parse } from '@typescript-eslint/typescript-estree';
import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/typescript-estree';
import { IndexedFileResult, IndexedSymbol, IndexedReference, ImportInfo, ReExportInfo, PendingReference, SHARD_VERSION, NgRxMetadata } from '../types.js';
import { createSymbolId } from './symbolResolver.js';
import { toCamelCase } from '../utils/stringUtils.js';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

interface WorkerTaskData {
  uri: string;
  content?: string;
}

interface WorkerResult {
  success: boolean;
  result?: IndexedFileResult;
  error?: string;
}

class ScopeTracker {
  private scopeStack: string[] = [];
  private localVariables: Map<string, Set<string>> = new Map();
  
  enterScope(scopeName: string): void {
    this.scopeStack.push(scopeName);
  }
  
  exitScope(): void {
    this.scopeStack.pop();
  }
  
  getCurrentScopeId(): string {
    return this.scopeStack.join('::') || '<global>';
  }
  
  addLocalVariable(varName: string): void {
    const scopeId = this.getCurrentScopeId();
    if (!this.localVariables.has(scopeId)) {
      this.localVariables.set(scopeId, new Set());
    }
    this.localVariables.get(scopeId)!.add(varName);
  }
  
  isLocalVariable(varName: string): boolean {
    const scopeId = this.getCurrentScopeId();
    return this.localVariables.get(scopeId)?.has(varName) || false;
  }
}

function isNgRxCreateActionCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return node.callee.name === 'createAction';
  }
  return false;
}

function isNgRxCreateActionGroupCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return node.callee.name === 'createActionGroup';
  }
  return false;
}

function isNgRxCreateEffectCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return node.callee.name === 'createEffect';
  }
  return false;
}

function isNgRxOnCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return node.callee.name === 'on';
  }
  return false;
}

function isNgRxOfTypeCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return node.callee.name === 'ofType';
  }
  return false;
}

function extractActionTypeString(node: TSESTree.CallExpression): string | null {
  if (node.arguments.length > 0) {
    const firstArg = node.arguments[0];
    if (firstArg.type === AST_NODE_TYPES.Literal && typeof firstArg.value === 'string') {
      return firstArg.value;
    }
  }
  return null;
}

function hasActionInterface(node: TSESTree.ClassDeclaration): boolean {
  if (!node.implements || node.implements.length === 0) {
    return false;
  }
  
  for (const impl of node.implements) {
    if (impl.expression.type === AST_NODE_TYPES.Identifier && impl.expression.name === 'Action') {
      return true;
    }
  }
  return false;
}

/**
 * Process createActionGroup calls and generate virtual symbols for action methods
 * 
 * Example:
 *   const PageActions = createActionGroup({
 *     source: 'Page',
 *     events: {
 *       'Load Data': emptyProps(),
 *       'Load': emptyProps()
 *     }
 *   });
 * 
 * This generates virtual symbols:
 *   - loadData (method) for 'Load Data'
 *   - load (method) for 'Load'
 * 
 * Returns the events mapping (camelCase -> 'Event String') for the container's ngrxMetadata.
 */
function processCreateActionGroup(
  callExpr: TSESTree.CallExpression,
  containerName: string,
  uri: string,
  symbols: IndexedSymbol[],
  containerPath: string[]
): Record<string, string> | undefined {
  const eventsMap: Record<string, string> = {};
  
  // createActionGroup expects a config object as first argument
  if (callExpr.arguments.length === 0) {
    return undefined;
  }

  const configArg = callExpr.arguments[0];
  if (configArg.type !== AST_NODE_TYPES.ObjectExpression) {
    return undefined;
  }

  // Find the 'events' property in the config object
  let eventsProperty: TSESTree.Property | null = null;
  for (const prop of configArg.properties) {
    if (prop.type === AST_NODE_TYPES.Property && 
        prop.key.type === AST_NODE_TYPES.Identifier &&
        prop.key.name === 'events') {
      eventsProperty = prop;
      break;
    }
  }

  if (!eventsProperty || eventsProperty.value.type !== AST_NODE_TYPES.ObjectExpression) {
    return undefined;
  }

  const eventsObject = eventsProperty.value as TSESTree.ObjectExpression;
  const fullContainerPath = containerPath.length > 0 ? containerPath.join('.') : undefined;

  // Process each event in the events object
  for (const eventProp of eventsObject.properties) {
    if (eventProp.type !== AST_NODE_TYPES.Property || !eventProp.loc) {
      continue;
    }

    let eventKey: string | null = null;
    let keyLocation: { line: number; character: number } | null = null;
    let keyRange: { startLine: number; startCharacter: number; endLine: number; endCharacter: number } | null = null;

    // Extract the event key (can be Identifier or StringLiteral)
    if (eventProp.key.type === AST_NODE_TYPES.Identifier && eventProp.key.loc) {
      eventKey = eventProp.key.name;
      keyLocation = {
        line: eventProp.key.loc.start.line - 1,
        character: eventProp.key.loc.start.column
      };
      keyRange = {
        startLine: eventProp.key.loc.start.line - 1,
        startCharacter: eventProp.key.loc.start.column,
        endLine: eventProp.key.loc.end.line - 1,
        endCharacter: eventProp.key.loc.end.column
      };
    } else if (eventProp.key.type === AST_NODE_TYPES.Literal && 
               typeof eventProp.key.value === 'string' &&
               eventProp.key.loc) {
      eventKey = eventProp.key.value;
      keyLocation = {
        line: eventProp.key.loc.start.line - 1,
        character: eventProp.key.loc.start.column
      };
      keyRange = {
        startLine: eventProp.key.loc.start.line - 1,
        startCharacter: eventProp.key.loc.start.column,
        endLine: eventProp.key.loc.end.line - 1,
        endCharacter: eventProp.key.loc.end.column
      };
    }

    if (!eventKey || !keyLocation || !keyRange) {
      continue;
    }

    // Convert the event key to camelCase (this is what NgRx generates at runtime)
    // 'Load Data' -> 'loadData'
    // 'Load' -> 'load'
    const camelCaseName = toCamelCase(eventKey);

    if (!camelCaseName) {
      continue;
    }

    // Store in events map for container's ngrxMetadata
    eventsMap[camelCaseName] = eventKey;

    // Create a virtual symbol for the generated action method
    const id = createSymbolId(
      uri,
      camelCaseName,
      containerName,
      fullContainerPath,
      'method',
      false,
      0, // Action creators typically have 0 or optional props parameter
      keyLocation.line,
      keyLocation.character
    );

    symbols.push({
      id,
      name: camelCaseName,
      kind: 'method',
      location: {
        uri,
        line: keyLocation.line,
        character: keyLocation.character
      },
      range: keyRange,
      containerName,
      containerKind: 'constant',
      fullContainerPath,
      filePath: uri,
      parametersCount: 0,
      ngrxMetadata: {
        type: eventKey, // Original event key name
        role: 'action'
      }
    });
  }

  return Object.keys(eventsMap).length > 0 ? eventsMap : undefined;
}

function hasEffectDecorator(node: TSESTree.PropertyDefinition): boolean {
  if (!node.decorators || node.decorators.length === 0) {
    return false;
  }
  
  for (const decorator of node.decorators) {
    if (decorator.expression.type === AST_NODE_TYPES.Identifier && decorator.expression.name === 'Effect') {
      return true;
    }
    if (decorator.expression.type === AST_NODE_TYPES.CallExpression &&
        decorator.expression.callee.type === AST_NODE_TYPES.Identifier &&
        decorator.expression.callee.name === 'Effect') {
      return true;
    }
  }
  return false;
}

function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function extractImports(ast: TSESTree.Program, imports: ImportInfo[]): void {
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

function extractReExports(ast: TSESTree.Program, reExports: ReExportInfo[]): void {
  for (const statement of ast.body) {
    if (statement.type === AST_NODE_TYPES.ExportAllDeclaration) {
      const moduleSpecifier = statement.source.value as string;
      reExports.push({
        moduleSpecifier,
        isAll: true
      });
    }
    else if (statement.type === AST_NODE_TYPES.ExportNamedDeclaration && statement.source) {
      const moduleSpecifier = statement.source.value as string;
      const exportedNames: string[] = [];
      
      for (const specifier of statement.specifiers) {
        if (specifier.type === AST_NODE_TYPES.ExportSpecifier) {
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

function isDeclarationContext(node: TSESTree.Node, parent: TSESTree.Node | null): boolean {
  if (!parent) {
    return false;
  }

  // Check if this identifier is the name being declared
  switch (parent.type) {
    case AST_NODE_TYPES.FunctionDeclaration:
      return (parent as TSESTree.FunctionDeclaration).id === node;
    
    case AST_NODE_TYPES.ClassDeclaration:
      return (parent as TSESTree.ClassDeclaration).id === node;
    
    case AST_NODE_TYPES.VariableDeclarator:
      return (parent as TSESTree.VariableDeclarator).id === node;
    
    case AST_NODE_TYPES.MethodDefinition:
      return (parent as TSESTree.MethodDefinition).key === node;
    
    case AST_NODE_TYPES.PropertyDefinition:
      return (parent as TSESTree.PropertyDefinition).key === node;
    
    case AST_NODE_TYPES.TSMethodSignature:
      return (parent as TSESTree.TSMethodSignature).key === node;
    
    case AST_NODE_TYPES.TSPropertySignature:
      return (parent as TSESTree.TSPropertySignature).key === node;
    
    case AST_NODE_TYPES.TSInterfaceDeclaration:
      return (parent as TSESTree.TSInterfaceDeclaration).id === node;
    
    case AST_NODE_TYPES.TSTypeAliasDeclaration:
      return (parent as TSESTree.TSTypeAliasDeclaration).id === node;
    
    case AST_NODE_TYPES.TSEnumDeclaration:
      return (parent as TSESTree.TSEnumDeclaration).id === node;
    
    case AST_NODE_TYPES.ImportSpecifier:
    case AST_NODE_TYPES.ImportDefaultSpecifier:
    case AST_NODE_TYPES.ImportNamespaceSpecifier:
      return true;
    
    // Parameter declarations
    case AST_NODE_TYPES.FunctionExpression:
    case AST_NODE_TYPES.ArrowFunctionExpression:
      const funcExpr = parent as TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression;
      return funcExpr.params.includes(node as any);
    
    // Property key in object literal (when not computed)
    case AST_NODE_TYPES.Property:
      const prop = parent as TSESTree.Property;
      return prop.key === node && !prop.computed;
    
    default:
      return false;
  }
}

function indexObjectProperties(
  objExpr: TSESTree.ObjectExpression,
  containerName: string,
  containerKind: string,
  uri: string,
  symbols: IndexedSymbol[],
  containerPath: string[]
): void {
  for (const prop of objExpr.properties) {
    if (prop.type === AST_NODE_TYPES.Property && prop.loc) {
      if (prop.key.type === AST_NODE_TYPES.Identifier && prop.key.loc) {
        const propName = prop.key.name;
        const fullContainerPath = containerPath.join('.');
        const id = createSymbolId(
          uri,
          propName,
          containerName,
          fullContainerPath,
          'property',
          false,
          undefined,
          prop.key.loc.start.line - 1,
          prop.key.loc.start.column
        );
        
        symbols.push({
          id,
          name: propName,
          kind: 'property',
          location: {
            uri,
            line: prop.key.loc.start.line - 1,
            character: prop.key.loc.start.column
          },
          range: {
            startLine: prop.key.loc.start.line - 1,
            startCharacter: prop.key.loc.start.column,
            endLine: prop.key.loc.end.line - 1,
            endCharacter: prop.key.loc.end.column
          },
          containerName,
          containerKind,
          fullContainerPath,
          filePath: uri
        });
        
        if (prop.value.type === AST_NODE_TYPES.ObjectExpression) {
          indexObjectProperties(
            prop.value,
            propName,
            'property',
            uri,
            symbols,
            [...containerPath, propName]
          );
        }
      }
    }
  }
}

function traverseAST(
  node: TSESTree.Node,
  symbols: IndexedSymbol[],
  references: IndexedReference[],
  uri: string,
  containerName?: string,
  containerKind?: string,
  containerPath: string[] = [],
  imports: ImportInfo[] = [],
  scopeTracker?: ScopeTracker,
  parent: TSESTree.Node | null = null,
  pendingNgRxMetadata?: NgRxMetadata,
  pendingReferences?: PendingReference[]
): void {
  if (!node || !node.loc) {return;}

  try {
    // Handle Identifiers - but only if they are NOT part of a declaration
    if (node.type === AST_NODE_TYPES.Identifier && node.loc) {
      // Skip if this identifier is the name being declared
      if (!isDeclarationContext(node, parent)) {
        const isImportRef = imports.some(imp => imp.localName === node.name);
        const isLocal = scopeTracker?.isLocalVariable(node.name) || false;
        const scopeId = scopeTracker?.getCurrentScopeId() || '<global>';
        
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
          isImport: isImportRef,
          scopeId,
          isLocal
        });
      }
    }
    
    // Handle MemberExpression (e.g., SigningActions.createSigningStepStart)
    if (node.type === AST_NODE_TYPES.MemberExpression) {
      const memberExpr = node as TSESTree.MemberExpression;
      if (memberExpr.property.type === AST_NODE_TYPES.Identifier && memberExpr.property.loc) {
        const scopeId = scopeTracker?.getCurrentScopeId() || '<global>';
        
        // Check if this is an imported symbol access (will become pending reference)
        // This prevents duplicate references for NgRx action group usages
        const isImportedAccess = pendingReferences && 
          memberExpr.object.type === AST_NODE_TYPES.Identifier &&
          imports.some(imp => imp.localName === (memberExpr.object as TSESTree.Identifier).name);
        
        // Only add to regular references if NOT an imported symbol access
        // (imported accesses are handled via pendingReferences for cross-file resolution)
        if (!isImportedAccess) {
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
            containerName,
            scopeId,
            isLocal: false
          });
        }
        
        // Capture pending references for cross-file resolution (NgRx action groups)
        // Pattern: ImportedSymbol.member() where ImportedSymbol is an import
        if (isImportedAccess && memberExpr.object.type === AST_NODE_TYPES.Identifier) {
          const objectIdentifier = memberExpr.object as TSESTree.Identifier;
          pendingReferences!.push({
            container: objectIdentifier.name,
            member: memberExpr.property.name,
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
    }
    // Handle NgRx-specific CallExpressions: on(), ofType()
    if (node.type === AST_NODE_TYPES.CallExpression) {
      const callExpr = node as TSESTree.CallExpression;
      
      // Check for on(ActionCreator, ...) in reducers
      if (isNgRxOnCall(callExpr) && callExpr.arguments.length > 0) {
        const firstArg = callExpr.arguments[0];
        // The first argument is the action creator reference
        if (firstArg.type === AST_NODE_TYPES.Identifier && firstArg.loc) {
          const scopeId = scopeTracker?.getCurrentScopeId() || '<global>';
          references.push({
            symbolName: firstArg.name,
            location: {
              uri,
              line: firstArg.loc.start.line - 1,
              character: firstArg.loc.start.column
            },
            range: {
              startLine: firstArg.loc.start.line - 1,
              startCharacter: firstArg.loc.start.column,
              endLine: firstArg.loc.end.line - 1,
              endCharacter: firstArg.loc.end.column
            },
            containerName,
            scopeId,
            isLocal: false
          });
        }
      }
      
      // Check for ofType(ActionCreator) in effects
      if (isNgRxOfTypeCall(callExpr) && callExpr.arguments.length > 0) {
        for (const arg of callExpr.arguments) {
          if (arg.type === AST_NODE_TYPES.Identifier && arg.loc) {
            const scopeId = scopeTracker?.getCurrentScopeId() || '<global>';
            references.push({
              symbolName: arg.name,
              location: {
                uri,
                line: arg.loc.start.line - 1,
                character: arg.loc.start.column
              },
              range: {
                startLine: arg.loc.start.line - 1,
                startCharacter: arg.loc.start.column,
                endLine: arg.loc.end.line - 1,
                endCharacter: arg.loc.end.column
              },
              containerName,
              scopeId,
              isLocal: false
            });
          } else if (arg.type === AST_NODE_TYPES.MemberExpression && arg.loc) {
            // Handle ofType(Actions.someAction)
            const memberExpr = arg as TSESTree.MemberExpression;
            if (memberExpr.property.type === AST_NODE_TYPES.Identifier && memberExpr.property.loc) {
              // Check if this is an imported symbol access (will be handled via pendingReferences)
              // This prevents duplicate references for NgRx action group usages
              const isImportedAccess = pendingReferences && 
                memberExpr.object.type === AST_NODE_TYPES.Identifier &&
                imports.some(imp => imp.localName === (memberExpr.object as TSESTree.Identifier).name);
              
              // Skip if already handled via pendingReferences
              if (isImportedAccess) {
                continue;
              }
              
              const scopeId = scopeTracker?.getCurrentScopeId() || '<global>';
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
                containerName,
                scopeId,
                isLocal: false
              });
            }
          }
        }
      }
    }

    let symbolName: string | undefined;
    let symbolKind: string | undefined;
    let isStatic: boolean | undefined;
    let parametersCount: number | undefined;
    let needsScopeTracking = false;

    switch (node.type) {
      case AST_NODE_TYPES.FunctionDeclaration:
        if ((node as TSESTree.FunctionDeclaration).id?.name) {
          symbolName = (node as TSESTree.FunctionDeclaration).id!.name;
          symbolKind = 'function';
          parametersCount = (node as TSESTree.FunctionDeclaration).params.length;
          needsScopeTracking = true;
        }
        break;

      case AST_NODE_TYPES.ClassDeclaration:
        if ((node as TSESTree.ClassDeclaration).id?.name) {
          symbolName = (node as TSESTree.ClassDeclaration).id!.name;
          symbolKind = 'class';
          
          // Check if this class implements Action interface (legacy NgRx)
          const classNode = node as TSESTree.ClassDeclaration;
          if (hasActionInterface(classNode)) {
            // Look for 'readonly type' property in class body
            for (const member of classNode.body.body) {
              if (member.type === AST_NODE_TYPES.PropertyDefinition) {
                const prop = member as TSESTree.PropertyDefinition;
                if (prop.key.type === AST_NODE_TYPES.Identifier && 
                    prop.key.name === 'type' && 
                    prop.readonly) {
                  // Try to extract the type value
                  let actionType: string | null = null;
                  if (prop.value) {
                    if (prop.value.type === AST_NODE_TYPES.Literal && typeof prop.value.value === 'string') {
                      actionType = prop.value.value;
                    } else if (prop.value.type === AST_NODE_TYPES.MemberExpression) {
                      // Handle enum case: ActionTypes.Load
                      const memberExpr = prop.value as TSESTree.MemberExpression;
                      if (memberExpr.property.type === AST_NODE_TYPES.Identifier) {
                        actionType = memberExpr.property.name;
                      }
                    }
                  }
                  
                  if (actionType) {
                    pendingNgRxMetadata = {
                      type: actionType,
                      role: 'action'
                    };
                  }
                  break;
                }
              }
            }
          }
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
            
            // Check if this is an NgRx call expression
            let ngrxMetadata: NgRxMetadata | undefined;
            if (decl.init && decl.init.type === AST_NODE_TYPES.CallExpression) {
              const callExpr = decl.init as TSESTree.CallExpression;
              
              // Modern NgRx: createAction
              if (isNgRxCreateActionCall(callExpr)) {
                const actionType = extractActionTypeString(callExpr);
                if (actionType) {
                  ngrxMetadata = {
                    type: actionType,
                    role: 'action'
                  };
                }
              }
              
              // Modern NgRx: createActionGroup
              // Process this BEFORE creating the main symbol, so virtual symbols are added first
              if (isNgRxCreateActionGroupCall(callExpr)) {
                const eventsMap = processCreateActionGroup(
                  callExpr,
                  varName,
                  uri,
                  symbols,
                  [...containerPath, varName]
                );
                
                // Add metadata to the container variable with isGroup flag and events map
                ngrxMetadata = {
                  type: varName,
                  role: 'action',
                  isGroup: true,
                  events: eventsMap
                };
              }
              
              // Modern NgRx: createEffect
              if (isNgRxCreateEffectCall(callExpr)) {
                ngrxMetadata = {
                  type: varName,
                  role: 'effect'
                };
              }
            }
            
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
              filePath: uri,
              ngrxMetadata
            });
            
            if (decl.init && decl.init.type === AST_NODE_TYPES.ObjectExpression) {
              indexObjectProperties(decl.init, varName, varKind, uri, symbols, [...containerPath, varName]);
            }
            
            if (scopeTracker && containerName) {
              scopeTracker.addLocalVariable(varName);
            }
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
          needsScopeTracking = true;
        }
        break;

      case AST_NODE_TYPES.PropertyDefinition:
        if ((node as TSESTree.PropertyDefinition).key.type === AST_NODE_TYPES.Identifier) {
          const propNode = node as TSESTree.PropertyDefinition;
          const propName = (propNode.key as TSESTree.Identifier).name;
          const propStatic = propNode.static;
          const fullContainerPath = containerPath.length > 0 ? containerPath.join('.') : undefined;
          
          // Check for NgRx legacy @Effect decorator or modern createEffect
          let ngrxMetadata: NgRxMetadata | undefined;
          if (hasEffectDecorator(propNode)) {
            ngrxMetadata = {
              type: propName,
              role: 'effect'
            };
          } else if (propNode.value && 
                     propNode.value.type === AST_NODE_TYPES.CallExpression &&
                     isNgRxCreateEffectCall(propNode.value as TSESTree.CallExpression)) {
            ngrxMetadata = {
              type: propName,
              role: 'effect'
            };
          }
          
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
            filePath: uri,
            ngrxMetadata
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
        filePath: uri,
        ngrxMetadata: pendingNgRxMetadata
      });

      const newContainer = symbolName;
      const newContainerKind = symbolKind;
      const newContainerPath = [...containerPath];
      if (['class', 'interface', 'enum', 'namespace', 'module'].includes(symbolKind)) {
        newContainerPath.push(symbolName);
      }
      
      if (needsScopeTracking && scopeTracker) {
        scopeTracker.enterScope(symbolName);
        
        if (node.type === AST_NODE_TYPES.FunctionDeclaration) {
          const funcNode = node as TSESTree.FunctionDeclaration;
          for (const param of funcNode.params) {
            if (param.type === AST_NODE_TYPES.Identifier) {
              scopeTracker.addLocalVariable(param.name);
            }
          }
        } else if (node.type === AST_NODE_TYPES.MethodDefinition) {
          const methodNode = node as TSESTree.MethodDefinition;
          for (const param of methodNode.value.params) {
            if (param.type === AST_NODE_TYPES.Identifier) {
              scopeTracker.addLocalVariable(param.name);
            }
          }
        }
      }
      
      for (const key in node) {
        const child = (node as any)[key];
        if (child && typeof child === 'object') {
          if (Array.isArray(child)) {
            for (const item of child) {
              if (item && typeof item === 'object' && item.type) {
                traverseAST(item, symbols, references, uri, newContainer, newContainerKind, newContainerPath, imports, scopeTracker, node, undefined, pendingReferences);
              }
            }
          } else if (child.type) {
            traverseAST(child, symbols, references, uri, newContainer, newContainerKind, newContainerPath, imports, scopeTracker, node, undefined, pendingReferences);
          }
        }
      }
      
      if (needsScopeTracking && scopeTracker) {
        scopeTracker.exitScope();
      }
    } else {
      for (const key in node) {
        const child = (node as any)[key];
        if (child && typeof child === 'object') {
          if (Array.isArray(child)) {
            for (const item of child) {
              if (item && typeof item === 'object' && item.type) {
                traverseAST(item, symbols, references, uri, containerName, containerKind, containerPath, imports, scopeTracker, node, undefined, pendingReferences);
              }
            }
          } else if (child.type) {
            traverseAST(child, symbols, references, uri, containerName, containerKind, containerPath, imports, scopeTracker, node, undefined, pendingReferences);
          }
        }
      }
    }
  } catch (error) {
    console.error(`[Worker] Error traversing AST node in ${uri}: ${error}`);
  }
}

function extractCodeSymbolsAndReferences(uri: string, content: string): {
  symbols: IndexedSymbol[];
  references: IndexedReference[];
  imports: ImportInfo[];
  reExports: ReExportInfo[];
  pendingReferences: PendingReference[];
} {
  const symbols: IndexedSymbol[] = [];
  const references: IndexedReference[] = [];
  const imports: ImportInfo[] = [];
  const reExports: ReExportInfo[] = [];
  const pendingReferences: PendingReference[] = [];

  try {
    const ast = parse(content, {
      loc: true,
      range: true,
      comment: false,
      tokens: false,
      errorOnUnknownASTType: false,
      jsx: uri.endsWith('x')
    });

    extractImports(ast, imports);
    extractReExports(ast, reExports);

    const scopeTracker = new ScopeTracker();
    traverseAST(ast, symbols, references, uri, undefined, undefined, [], imports, scopeTracker, null, undefined, pendingReferences);
  } catch (error) {
    console.error(`[Worker] Error parsing code file ${uri}: ${error}`);
  }

  return { symbols, references, imports, reExports, pendingReferences };
}

function extractTextSymbols(uri: string, content: string): IndexedSymbol[] {
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
    console.error(`[Worker] Error extracting text symbols from ${uri}: ${error}`);
  }

  return symbols;
}

function processFile(taskData: WorkerTaskData): IndexedFileResult {
  const { uri } = taskData;
  
  // Read file content with safe error handling
  // If reading fails, return a valid "skipped" result to ensure the task counter decrements
  let content: string;
  try {
    content = taskData.content ?? fs.readFileSync(uri, 'utf-8');
  } catch (error: any) {
    // Return a safe empty result so the main thread counts this task as "done"
    // This prevents the indexer from hanging on malformed paths or missing files
    console.warn(`[Worker] File read failed for ${uri}: ${error.message}`);
    return {
      uri,
      hash: '',
      symbols: [],
      references: [],
      imports: [],
      reExports: [],
      isSkipped: true,
      skipReason: error.code === 'ENOENT' 
        ? `File not found (possible path encoding issue)` 
        : `Read error: ${error.message}`,
      shardVersion: SHARD_VERSION
    };
  }
  
  const hash = computeHash(content);
  
  const ext = path.extname(uri).toLowerCase();
  const isCodeFile = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(ext);
  
  if (isCodeFile) {
    const result = extractCodeSymbolsAndReferences(uri, content);
    return {
      uri,
      hash,
      symbols: result.symbols,
      references: result.references,
      imports: result.imports,
      reExports: result.reExports,
      pendingReferences: result.pendingReferences.length > 0 ? result.pendingReferences : undefined,
      shardVersion: SHARD_VERSION
    };
  } else {
    const symbols = extractTextSymbols(uri, content);
    return {
      uri,
      hash,
      symbols,
      references: [],
      imports: [],
      reExports: [],
      shardVersion: SHARD_VERSION
    };
  }
}

if (parentPort) {
  parentPort.on('message', (taskData: WorkerTaskData) => {
    try {
      const result = processFile(taskData);
      const response: WorkerResult = {
        success: true,
        result
      };
      parentPort!.postMessage(response);
    } catch (error) {
      const response: WorkerResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
      parentPort!.postMessage(response);
    }
  });
}
