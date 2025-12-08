import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/typescript-estree';
import { FrameworkPlugin, PluginVisitorContext, PluginVisitResult } from '../FrameworkPlugin.js';
import { IndexedSymbol, IndexedReference, SymbolRange } from '../../types.js';
import { createSymbolId } from '../../indexer/symbolResolver.js';
import { toCamelCase } from '../../utils/stringUtils.js';

/**
 * NgRx metadata structure stored in symbol.metadata.ngrx
 */
export interface NgRxSymbolMetadata {
  type: string;
  role: 'action' | 'effect' | 'reducer';
  isGroup?: boolean;
  events?: Record<string, string>;
}

/**
 * NgRxPlugin - Handles NgRx-specific indexing logic.
 * 
 * Responsibilities:
 * - Detect createAction, createActionGroup, createEffect calls
 * - Generate virtual symbols for action group methods
 * - Handle on(...) and ofType(...) reference detection
 * - Protect NgRx actions/effects from dead code detection
 */
export class NgRxPlugin implements FrameworkPlugin {
  readonly name = 'ngrx';

  private isCreateActionCall(node: TSESTree.CallExpression): boolean {
    return (
      node.callee.type === AST_NODE_TYPES.Identifier &&
      node.callee.name === 'createAction'
    );
  }

  private isCreateActionGroupCall(node: TSESTree.CallExpression): boolean {
    return (
      node.callee.type === AST_NODE_TYPES.Identifier &&
      node.callee.name === 'createActionGroup'
    );
  }

  private isCreateEffectCall(node: TSESTree.CallExpression): boolean {
    return (
      node.callee.type === AST_NODE_TYPES.Identifier &&
      node.callee.name === 'createEffect'
    );
  }

  private isOnCall(node: TSESTree.CallExpression): boolean {
    return (
      node.callee.type === AST_NODE_TYPES.Identifier &&
      node.callee.name === 'on'
    );
  }

  private isOfTypeCall(node: TSESTree.CallExpression): boolean {
    return (
      node.callee.type === AST_NODE_TYPES.Identifier &&
      node.callee.name === 'ofType'
    );
  }

  private hasEffectDecorator(node: TSESTree.PropertyDefinition): boolean {
    if (!node.decorators || node.decorators.length === 0) {
      return false;
    }

    for (const decorator of node.decorators) {
      if (
        decorator.expression.type === AST_NODE_TYPES.Identifier &&
        decorator.expression.name === 'Effect'
      ) {
        return true;
      }
      if (
        decorator.expression.type === AST_NODE_TYPES.CallExpression &&
        decorator.expression.callee.type === AST_NODE_TYPES.Identifier &&
        decorator.expression.callee.name === 'Effect'
      ) {
        return true;
      }
    }
    return false;
  }

  private hasActionInterface(node: TSESTree.ClassDeclaration): boolean {
    if (!node.implements || node.implements.length === 0) {
      return false;
    }

    for (const impl of node.implements) {
      if (
        impl.expression.type === AST_NODE_TYPES.Identifier &&
        impl.expression.name === 'Action'
      ) {
        return true;
      }
    }
    return false;
  }

  private extractActionTypeString(node: TSESTree.CallExpression): string | null {
    if (node.arguments.length > 0) {
      const firstArg = node.arguments[0];
      if (
        firstArg.type === AST_NODE_TYPES.Literal &&
        typeof firstArg.value === 'string'
      ) {
        return firstArg.value;
      }
    }
    return null;
  }

  /**
   * Process createActionGroup and generate virtual symbols for action methods.
   */
  private processCreateActionGroup(
    callExpr: TSESTree.CallExpression,
    containerName: string,
    context: PluginVisitorContext
  ): { symbols: IndexedSymbol[]; eventsMap: Record<string, string> } | undefined {
    const symbols: IndexedSymbol[] = [];
    const eventsMap: Record<string, string> = {};

    if (callExpr.arguments.length === 0) {
      return undefined;
    }

    const configArg = callExpr.arguments[0];
    if (configArg.type !== AST_NODE_TYPES.ObjectExpression) {
      return undefined;
    }

    // Find the 'events' property
    let eventsProperty: TSESTree.Property | null = null;
    for (const prop of configArg.properties) {
      if (
        prop.type === AST_NODE_TYPES.Property &&
        prop.key.type === AST_NODE_TYPES.Identifier &&
        prop.key.name === 'events'
      ) {
        eventsProperty = prop;
        break;
      }
    }

    if (!eventsProperty || eventsProperty.value.type !== AST_NODE_TYPES.ObjectExpression) {
      return undefined;
    }

    const eventsObject = eventsProperty.value as TSESTree.ObjectExpression;
    const fullContainerPath = context.containerPath.length > 0
      ? context.containerPath.join('.')
      : undefined;

    for (const eventProp of eventsObject.properties) {
      if (eventProp.type !== AST_NODE_TYPES.Property || !eventProp.loc) {
        continue;
      }

      let eventKey: string | null = null;
      let keyLocation: { line: number; character: number } | null = null;
      let keyRange: SymbolRange | null = null;

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
      } else if (
        eventProp.key.type === AST_NODE_TYPES.Literal &&
        typeof eventProp.key.value === 'string' &&
        eventProp.key.loc
      ) {
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

      const camelCaseName = toCamelCase(eventKey) || '';
      if (!camelCaseName) {
        continue;
      }

      eventsMap[camelCaseName] = eventKey;

      const id = createSymbolId(
        context.uri,
        camelCaseName,
        containerName,
        fullContainerPath,
        'method',
        false,
        0,
        keyLocation.line,
        keyLocation.character
      );

      symbols.push({
        id,
        name: camelCaseName,
        kind: 'method',
        location: {
          uri: context.uri,
          line: keyLocation.line,
          character: keyLocation.character
        },
        range: keyRange,
        containerName,
        containerKind: 'constant',
        fullContainerPath,
        filePath: context.uri,
        parametersCount: 0,
        metadata: {
          ngrx: {
            type: eventKey,
            role: 'action'
          } as NgRxSymbolMetadata
        },
        isDefinition: true
      });
    }

    return Object.keys(eventsMap).length > 0 ? { symbols, eventsMap } : undefined;
  }

  visitNode(
    node: TSESTree.Node,
    _currentSymbol: IndexedSymbol | null,
    context: PluginVisitorContext
  ): PluginVisitResult | undefined {
    // Handle VariableDeclarator with NgRx call expressions
    if (
      node.type === AST_NODE_TYPES.VariableDeclarator &&
      node.init?.type === AST_NODE_TYPES.CallExpression &&
      node.id.type === AST_NODE_TYPES.Identifier
    ) {
      const callExpr = node.init;
      const varName = node.id.name;

      // createAction
      if (this.isCreateActionCall(callExpr)) {
        const actionType = this.extractActionTypeString(callExpr);
        if (actionType) {
          return {
            metadata: {
              ngrx: {
                type: actionType,
                role: 'action'
              } as NgRxSymbolMetadata
            }
          };
        }
      }

      // createActionGroup
      if (this.isCreateActionGroupCall(callExpr)) {
        const result = this.processCreateActionGroup(callExpr, varName, context);
        if (result) {
          return {
            symbols: result.symbols,
            metadata: {
              ngrx: {
                type: varName,
                role: 'action',
                isGroup: true,
                events: result.eventsMap
              } as NgRxSymbolMetadata
            }
          };
        }
      }

      // createEffect
      if (this.isCreateEffectCall(callExpr)) {
        return {
          metadata: {
            ngrx: {
              type: varName,
              role: 'effect'
            } as NgRxSymbolMetadata
          }
        };
      }
    }

    // Handle PropertyDefinition with @Effect decorator or createEffect
    if (node.type === AST_NODE_TYPES.PropertyDefinition) {
      const propNode = node as TSESTree.PropertyDefinition;
      
      if (propNode.key.type === AST_NODE_TYPES.Identifier) {
        const propName = propNode.key.name;

        if (this.hasEffectDecorator(propNode)) {
          return {
            metadata: {
              ngrx: {
                type: propName,
                role: 'effect'
              } as NgRxSymbolMetadata
            }
          };
        }

        if (
          propNode.value?.type === AST_NODE_TYPES.CallExpression &&
          this.isCreateEffectCall(propNode.value)
        ) {
          return {
            metadata: {
              ngrx: {
                type: propName,
                role: 'effect'
              } as NgRxSymbolMetadata
            }
          };
        }
      }
    }

    // Handle ClassDeclaration implementing Action interface (legacy NgRx)
    if (node.type === AST_NODE_TYPES.ClassDeclaration && this.hasActionInterface(node)) {
      // Look for 'readonly type' property
      for (const member of node.body.body) {
        if (member.type === AST_NODE_TYPES.PropertyDefinition) {
          const prop = member as TSESTree.PropertyDefinition;
          if (
            prop.key.type === AST_NODE_TYPES.Identifier &&
            prop.key.name === 'type' &&
            prop.readonly &&
            prop.value
          ) {
            let actionType: string | null = null;
            
            if (
              prop.value.type === AST_NODE_TYPES.Literal &&
              typeof prop.value.value === 'string'
            ) {
              actionType = prop.value.value;
            } else if (prop.value.type === AST_NODE_TYPES.MemberExpression) {
              const memberExpr = prop.value as TSESTree.MemberExpression;
              if (memberExpr.property.type === AST_NODE_TYPES.Identifier) {
                actionType = memberExpr.property.name;
              }
            }

            if (actionType) {
              return {
                metadata: {
                  ngrx: {
                    type: actionType,
                    role: 'action'
                  } as NgRxSymbolMetadata
                }
              };
            }
          }
        }
      }
    }

    // Handle on() calls in reducers - add references to action creators
    if (node.type === AST_NODE_TYPES.CallExpression && this.isOnCall(node)) {
      const references: IndexedReference[] = [];
      
      for (const arg of node.arguments) {
        if (arg.type === AST_NODE_TYPES.Identifier && arg.loc) {
          references.push({
            symbolName: arg.name,
            location: {
              uri: context.uri,
              line: arg.loc.start.line - 1,
              character: arg.loc.start.column
            },
            range: {
              startLine: arg.loc.start.line - 1,
              startCharacter: arg.loc.start.column,
              endLine: arg.loc.end.line - 1,
              endCharacter: arg.loc.end.column
            },
            containerName: context.containerName,
            scopeId: context.scopeId,
            isLocal: false
          });
        }
      }

      if (references.length > 0) {
        return { references };
      }
    }

    // Handle ofType() calls in effects - add references to action creators
    if (node.type === AST_NODE_TYPES.CallExpression && this.isOfTypeCall(node)) {
      const references: IndexedReference[] = [];

      for (const arg of node.arguments) {
        if (arg.type === AST_NODE_TYPES.Identifier && arg.loc) {
          references.push({
            symbolName: arg.name,
            location: {
              uri: context.uri,
              line: arg.loc.start.line - 1,
              character: arg.loc.start.column
            },
            range: {
              startLine: arg.loc.start.line - 1,
              startCharacter: arg.loc.start.column,
              endLine: arg.loc.end.line - 1,
              endCharacter: arg.loc.end.column
            },
            containerName: context.containerName,
            scopeId: context.scopeId,
            isLocal: false
          });
        } else if (arg.type === AST_NODE_TYPES.MemberExpression && arg.loc) {
          const memberExpr = arg as TSESTree.MemberExpression;
          if (memberExpr.property.type === AST_NODE_TYPES.Identifier && memberExpr.property.loc) {
            references.push({
              symbolName: memberExpr.property.name,
              location: {
                uri: context.uri,
                line: memberExpr.property.loc.start.line - 1,
                character: memberExpr.property.loc.start.column
              },
              range: {
                startLine: memberExpr.property.loc.start.line - 1,
                startCharacter: memberExpr.property.loc.start.column,
                endLine: memberExpr.property.loc.end.line - 1,
                endCharacter: memberExpr.property.loc.end.column
              },
              containerName: context.containerName,
              scopeId: context.scopeId,
              isLocal: false
            });
          }
        }
      }

      if (references.length > 0) {
        return { references };
      }
    }

    return undefined;
  }

  /**
   * Determine if a symbol is an NgRx entry point.
   * Actions and effects are framework-managed.
   */
  isEntryPoint(symbol: IndexedSymbol): boolean {
    // Check for NgRx metadata in new location
    const ngrxMeta = symbol.metadata?.['ngrx'] as NgRxSymbolMetadata | undefined;
    if (ngrxMeta) {
      // Actions and effects are entry points
      return ngrxMeta.role === 'action' || ngrxMeta.role === 'effect';
    }

    // Legacy: check for ngrxMetadata field (for backwards compatibility)
    if ((symbol as any).ngrxMetadata) {
      return true;
    }

    return false;
  }

  extractMetadata(
    _symbol: IndexedSymbol,
    _node: TSESTree.Node
  ): Record<string, unknown> | undefined {
    // Metadata extraction is handled in visitNode
    return undefined;
  }
}
