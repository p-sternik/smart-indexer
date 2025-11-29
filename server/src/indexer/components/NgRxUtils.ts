import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/typescript-estree';
import { IndexedSymbol, NgRxMetadata } from '../../types.js';
import { createSymbolId } from '../symbolResolver.js';
import { StringInterner } from './StringInterner.js';
import { toCamelCase } from '../../utils/stringUtils.js';

/**
 * NgRx-specific utility functions for detecting and processing NgRx patterns.
 */

export function isNgRxCreateActionCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return node.callee.name === 'createAction';
  }
  return false;
}

export function isNgRxCreateActionGroupCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return node.callee.name === 'createActionGroup';
  }
  return false;
}

export function isNgRxCreateEffectCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return node.callee.name === 'createEffect';
  }
  return false;
}

export function isNgRxOnCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return node.callee.name === 'on';
  }
  return false;
}

export function isNgRxOfTypeCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return node.callee.name === 'ofType';
  }
  return false;
}

export function extractActionTypeString(node: TSESTree.CallExpression): string | null {
  if (node.arguments.length > 0) {
    const firstArg = node.arguments[0];
    if (firstArg.type === AST_NODE_TYPES.Literal && typeof firstArg.value === 'string') {
      return firstArg.value;
    }
  }
  return null;
}

export function hasActionInterface(node: TSESTree.ClassDeclaration): boolean {
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

export function hasEffectDecorator(node: TSESTree.PropertyDefinition): boolean {
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
export function processCreateActionGroup(
  callExpr: TSESTree.CallExpression,
  containerName: string,
  uri: string,
  symbols: IndexedSymbol[],
  containerPath: string[],
  interner: StringInterner
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
    const camelCaseName = interner.intern(toCamelCase(eventKey) || '');

    if (!camelCaseName) {
      continue;
    }

    // Intern the event key for the events map
    const internedEventKey = interner.intern(eventKey);

    // Store in events map for container's ngrxMetadata
    eventsMap[camelCaseName] = internedEventKey;

    // Create a virtual symbol for the generated action method
    const id = createSymbolId(
      uri,
      camelCaseName,
      containerName,
      fullContainerPath,
      'method',
      false,
      0,
      keyLocation.line,
      keyLocation.character
    );

    // Build POJO with only primitive values
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
        type: internedEventKey,
        role: 'action'
      }
    });
  }

  return Object.keys(eventsMap).length > 0 ? eventsMap : undefined;
}
