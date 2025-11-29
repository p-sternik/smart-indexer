import { parentPort } from 'worker_threads';
import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/typescript-estree';
import { IndexedFileResult, IndexedSymbol, IndexedReference, ImportInfo, ReExportInfo, PendingReference, SHARD_VERSION, NgRxMetadata } from '../types.js';
import { createSymbolId } from './symbolResolver.js';
import { PluginRegistry, PluginVisitorContext } from '../plugins/FrameworkPlugin.js';
import { AngularPlugin } from '../plugins/angular/AngularPlugin.js';
import { NgRxPlugin } from '../plugins/ngrx/NgRxPlugin.js';
import * as path from 'path';
import * as fsPromises from 'fs/promises';

// Import refactored components
import {
  StringInterner,
  ScopeTracker,
  astParser,
  ImportExtractor,
  isNgRxCreateActionCall,
  isNgRxCreateActionGroupCall,
  isNgRxCreateEffectCall,
  isNgRxOnCall,
  isNgRxOfTypeCall,
  extractActionTypeString,
  hasActionInterface,
  hasEffectDecorator,
  processCreateActionGroup
} from './components/index.js';

// Initialize plugin registry for worker thread
const workerPluginRegistry = new PluginRegistry();
workerPluginRegistry.register(new AngularPlugin());
workerPluginRegistry.register(new NgRxPlugin());

// Global interner instance per worker - reused across all file processing
const interner = new StringInterner();
const importExtractor = new ImportExtractor(interner);

interface WorkerTaskData {
  uri: string;
  content?: string;
}

interface WorkerResult {
  success: boolean;
  result?: IndexedFileResult;
  error?: string;
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
    
    // Import specifiers: only treat the LOCAL name as a declaration
    // The IMPORTED name is a reference to an external symbol
    case AST_NODE_TYPES.ImportSpecifier:
      const importSpec = parent as TSESTree.ImportSpecifier;
      // local is the declaration (what we're binding to in this file)
      // imported is a reference (what we're importing from external module)
      return importSpec.local === node;
      
    case AST_NODE_TYPES.ImportDefaultSpecifier:
    case AST_NODE_TYPES.ImportNamespaceSpecifier:
      // For default/namespace imports, the identifier is the local binding
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
        // Use .name directly (already a string) and intern it
        const propName = interner.intern(prop.key.name);
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
        
        // Build POJO with only primitive values - no ts.Node references
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
        // Use .name directly (string property) and intern it
        const symbolName = interner.intern(node.name);
        const isImportRef = imports.some(imp => imp.localName === symbolName);
        const isLocal = scopeTracker?.isLocalVariable(node.name) || false;
        const scopeId = scopeTracker?.getCurrentScopeId() || '<global>';
        
        // Build POJO with only primitive values
        references.push({
          symbolName,
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
        // Intern the property name
        const propName = interner.intern(memberExpr.property.name);
        
        // Check if this is an imported symbol access (will become pending reference)
        // This prevents duplicate references for NgRx action group usages
        const isImportedAccess = pendingReferences && 
          memberExpr.object.type === AST_NODE_TYPES.Identifier &&
          imports.some(imp => imp.localName === (memberExpr.object as TSESTree.Identifier).name);
        
        // Only add to regular references if NOT an imported symbol access
        // (imported accesses are handled via pendingReferences for cross-file resolution)
        if (!isImportedAccess) {
          // Build POJO with only primitive values
          references.push({
            symbolName: propName,
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
          // Build POJO with interned strings
          pendingReferences!.push({
            container: interner.intern(objectIdentifier.name),
            member: propName,
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
          // Build POJO with interned name
          references.push({
            symbolName: interner.intern(firstArg.name),
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
            // Build POJO with interned name
            references.push({
              symbolName: interner.intern(arg.name),
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
              // Build POJO with interned name
              references.push({
                symbolName: interner.intern(memberExpr.property.name),
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
          // Intern the function name
          symbolName = interner.intern((node as TSESTree.FunctionDeclaration).id!.name);
          symbolKind = 'function';
          parametersCount = (node as TSESTree.FunctionDeclaration).params.length;
          needsScopeTracking = true;
        }
        break;

      case AST_NODE_TYPES.ClassDeclaration:
        if ((node as TSESTree.ClassDeclaration).id?.name) {
          // Intern the class name
          symbolName = interner.intern((node as TSESTree.ClassDeclaration).id!.name);
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
                      type: interner.intern(actionType),
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
          // Intern the interface name
          symbolName = interner.intern((node as TSESTree.TSInterfaceDeclaration).id.name);
          symbolKind = 'interface';
        }
        break;

      case AST_NODE_TYPES.TSTypeAliasDeclaration:
        if ((node as TSESTree.TSTypeAliasDeclaration).id?.name) {
          // Intern the type alias name
          symbolName = interner.intern((node as TSESTree.TSTypeAliasDeclaration).id.name);
          symbolKind = 'type';
        }
        break;

      case AST_NODE_TYPES.TSEnumDeclaration:
        if ((node as TSESTree.TSEnumDeclaration).id?.name) {
          // Intern the enum name
          symbolName = interner.intern((node as TSESTree.TSEnumDeclaration).id.name);
          symbolKind = 'enum';
        }
        break;

      case AST_NODE_TYPES.VariableDeclaration:
        for (const decl of (node as TSESTree.VariableDeclaration).declarations) {
          if (decl.id.type === AST_NODE_TYPES.Identifier && decl.id.loc) {
            const varKind = (node as TSESTree.VariableDeclaration).kind === 'const' ? 'constant' : 'variable';
            // Intern the variable name
            const varName = interner.intern(decl.id.name);
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
                    type: interner.intern(actionType),
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
                  [...containerPath, varName],
                  interner
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
            // Build POJO with only primitive values - no AST node references
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
          // Intern the method name
          const methodName = interner.intern((methodNode.key as TSESTree.Identifier).name);
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
          // Build POJO with only primitive values
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
          // Intern the property name
          const propName = interner.intern((propNode.key as TSESTree.Identifier).name);
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
          // Build POJO with only primitive values
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
      
      // Build the base symbol
      const newSymbol: IndexedSymbol = {
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
      };
      
      // Invoke plugins to collect metadata and additional symbols/references
      const pluginContext: PluginVisitorContext = {
        uri,
        containerName,
        containerKind,
        containerPath,
        scopeId: scopeTracker?.getCurrentScopeId() || '<global>',
        imports: imports.map(imp => ({ localName: imp.localName, moduleSpecifier: imp.moduleSpecifier }))
      };
      
      const pluginResult = workerPluginRegistry.visitNode(node, newSymbol, pluginContext);
      
      // Merge plugin metadata into symbol
      if (pluginResult.metadata && Object.keys(pluginResult.metadata).length > 0) {
        newSymbol.metadata = { ...(newSymbol.metadata || {}), ...pluginResult.metadata };
      }
      
      // Add plugin-generated symbols
      if (pluginResult.symbols && pluginResult.symbols.length > 0) {
        symbols.push(...pluginResult.symbols);
      }
      
      // Add plugin-generated references
      if (pluginResult.references && pluginResult.references.length > 0) {
        references.push(...pluginResult.references);
      }
      
      symbols.push(newSymbol);

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
      // Even if no symbol is created, invoke plugins to catch framework-specific patterns
      const pluginContext: PluginVisitorContext = {
        uri,
        containerName,
        containerKind,
        containerPath,
        scopeId: scopeTracker?.getCurrentScopeId() || '<global>',
        imports: imports.map(imp => ({ localName: imp.localName, moduleSpecifier: imp.moduleSpecifier }))
      };
      
      const pluginResult = workerPluginRegistry.visitNode(node, null, pluginContext);
      
      // Add plugin-generated symbols
      if (pluginResult.symbols && pluginResult.symbols.length > 0) {
        symbols.push(...pluginResult.symbols);
      }
      
      // Add plugin-generated references
      if (pluginResult.references && pluginResult.references.length > 0) {
        references.push(...pluginResult.references);
      }
      
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
  parseError?: string;
} {
  const symbols: IndexedSymbol[] = [];
  const references: IndexedReference[] = [];
  const pendingReferences: PendingReference[] = [];

  try {
    const ast = astParser.parse(content, uri);
    if (!ast) {
      return { symbols, references, imports: [], reExports: [], pendingReferences, parseError: 'Failed to parse AST' };
    }

    const imports = importExtractor.extractImports(ast);
    const reExports = importExtractor.extractReExports(ast);

    const scopeTracker = new ScopeTracker();
    traverseAST(ast, symbols, references, uri, undefined, undefined, [], imports, scopeTracker, null, undefined, pendingReferences);
    
    return { symbols, references, imports, reExports, pendingReferences };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Worker] Error parsing code file ${uri}: ${errorMessage}`);
    return { symbols, references, imports: [], reExports: [], pendingReferences, parseError: errorMessage };
  }
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
          // Intern text symbols for deduplication
          const internedWord = interner.intern(word);
          const index = line.indexOf(word);
          const id = createSymbolId(uri, internedWord, undefined, undefined, 'text', false, undefined, i, index);
          // Build POJO with only primitive values
          symbols.push({
            id,
            name: internedWord,
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

async function processFile(taskData: WorkerTaskData): Promise<IndexedFileResult> {
  const { uri } = taskData;
  
  // Read file content with safe error handling (async I/O for I/O concurrency in worker)
  // If reading fails, return a valid "skipped" result to ensure the task counter decrements
  let content: string;
  try {
    content = taskData.content ?? await fsPromises.readFile(uri, 'utf-8');
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
  
  const hash = astParser.computeHash(content);
  
  const ext = path.extname(uri).toLowerCase();
  const isCodeFile = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(ext);
  
  if (isCodeFile) {
    const result = extractCodeSymbolsAndReferences(uri, content);
    
    // If parsing failed, mark as skipped so the task counter decrements properly
    if (result.parseError) {
      return {
        uri,
        hash,
        symbols: result.symbols,
        references: result.references,
        imports: result.imports,
        reExports: result.reExports,
        pendingReferences: result.pendingReferences.length > 0 ? result.pendingReferences : undefined,
        isSkipped: true,
        skipReason: `Parse error: ${result.parseError}`,
        shardVersion: SHARD_VERSION
      };
    }
    
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
  parentPort.on('message', async (taskData: WorkerTaskData) => {
    try {
      const result = await processFile(taskData);
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
