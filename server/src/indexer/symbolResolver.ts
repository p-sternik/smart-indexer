import { parse } from '@typescript-eslint/typescript-estree';
import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/typescript-estree';
import { IndexedSymbol } from '../types.js';
import * as crypto from 'crypto';

export interface SymbolAtPosition {
  name: string;
  kind: string;
  containerName?: string;
  containerKind?: string;
  fullContainerPath?: string;
  isStatic?: boolean;
  parametersCount?: number;
  range: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
}

/**
 * Create a stable, unique symbol ID based on symbol metadata.
 */
export function createSymbolId(
  uri: string,
  name: string,
  containerName: string | undefined,
  fullContainerPath: string | undefined,
  kind: string,
  isStatic: boolean | undefined,
  parametersCount: number | undefined,
  startLine: number,
  startCharacter: number
): string {
  const parts = [
    uri,
    fullContainerPath || containerName || '<global>',
    name,
    kind,
    isStatic ? 'static' : 'instance',
    parametersCount !== undefined ? parametersCount.toString() : 'na',
    startLine.toString(),
    startCharacter.toString()
  ];
  const combined = parts.join(':');
  return crypto.createHash('sha256').update(combined).digest('hex').substring(0, 16);
}

/**
 * Find the symbol at a given position in the document.
 * This resolves the container and determines if the symbol is static.
 */
export function findSymbolAtPosition(
  uri: string,
  content: string,
  line: number,
  character: number
): SymbolAtPosition | null {
  try {
    const ast = parse(content, {
      loc: true,
      range: true,
      comment: false,
      tokens: false,
      errorOnUnknownASTType: false,
      jsx: uri.endsWith('x')
    });

    const targetOffset = getOffset(content, line, character);
    return findSymbolInAST(ast, targetOffset, uri);
  } catch (error) {
    console.error(`[SymbolResolver] Error parsing ${uri}: ${error}`);
    return null;
  }
}

function getOffset(content: string, line: number, character: number): number {
  const lines = content.split('\n');
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for newline
  }
  offset += character;
  return offset;
}

function findSymbolInAST(
  node: TSESTree.Node,
  targetOffset: number,
  uri: string,
  containerName?: string,
  containerKind?: string
): SymbolAtPosition | null {
  if (!node || !node.range) {
    return null;
  }

  const [start, end] = node.range;

  if (targetOffset < start || targetOffset > end) {
    return null;
  }

  // Check if we're directly on a symbol declaration
  const symbolInfo = getSymbolInfo(node, containerName, containerKind);
  if (symbolInfo && node.loc) {
    const nameNode = getNameNode(node);
    if (nameNode && nameNode.range) {
      const [nameStart, nameEnd] = nameNode.range;
      if (targetOffset >= nameStart && targetOffset <= nameEnd) {
        return {
          name: symbolInfo.name,
          kind: symbolInfo.kind,
          containerName: symbolInfo.containerName,
          containerKind: symbolInfo.containerKind,
          isStatic: symbolInfo.isStatic,
          parametersCount: symbolInfo.parametersCount,
          range: {
            startLine: node.loc.start.line - 1,
            startCharacter: node.loc.start.column,
            endLine: node.loc.end.line - 1,
            endCharacter: node.loc.end.column
          }
        };
      }
    }
  }

  // Update container context if this node defines one
  let newContainerName = containerName;
  let newContainerKind = containerKind;
  if (symbolInfo && (symbolInfo.kind === 'class' || symbolInfo.kind === 'interface' || 
      symbolInfo.kind === 'enum' || symbolInfo.kind === 'namespace')) {
    newContainerName = symbolInfo.name;
    newContainerKind = symbolInfo.kind;
  }

  // Check if we're on an identifier that's a reference
  if (node.type === AST_NODE_TYPES.Identifier && node.range) {
    const [nameStart, nameEnd] = node.range;
    if (targetOffset >= nameStart && targetOffset <= nameEnd && node.loc) {
      // Determine kind based on parent context
      const parent = findParent(node);
      let kind = 'variable';
      let isStatic = false;

      if (parent) {
        if (parent.type === AST_NODE_TYPES.MemberExpression) {
          kind = 'property';
        } else if (parent.type === AST_NODE_TYPES.CallExpression) {
          kind = 'function';
        }
      }

      return {
        name: node.name,
        kind,
        containerName: newContainerName,
        containerKind: newContainerKind,
        isStatic,
        range: {
          startLine: node.loc.start.line - 1,
          startCharacter: node.loc.start.column,
          endLine: node.loc.end.line - 1,
          endCharacter: node.loc.end.column
        }
      };
    }
  }

  // Recursively search children
  for (const key in node) {
    const child = (node as any)[key];
    if (child && typeof child === 'object') {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && item.type) {
            const result = findSymbolInAST(item, targetOffset, uri, newContainerName, newContainerKind);
            if (result) {
              return result;
            }
          }
        }
      } else if (child.type) {
        const result = findSymbolInAST(child, targetOffset, uri, newContainerName, newContainerKind);
        if (result) {
          return result;
        }
      }
    }
  }

  return null;
}

function getSymbolInfo(
  node: TSESTree.Node,
  containerName?: string,
  containerKind?: string
): { name: string; kind: string; containerName?: string; containerKind?: string; isStatic?: boolean; parametersCount?: number } | null {
  switch (node.type) {
    case AST_NODE_TYPES.FunctionDeclaration:
      if ((node as TSESTree.FunctionDeclaration).id?.name) {
        return {
          name: (node as TSESTree.FunctionDeclaration).id!.name,
          kind: 'function',
          containerName,
          containerKind,
          parametersCount: (node as TSESTree.FunctionDeclaration).params.length
        };
      }
      break;

    case AST_NODE_TYPES.ClassDeclaration:
      if ((node as TSESTree.ClassDeclaration).id?.name) {
        return {
          name: (node as TSESTree.ClassDeclaration).id!.name,
          kind: 'class',
          containerName,
          containerKind
        };
      }
      break;

    case AST_NODE_TYPES.TSInterfaceDeclaration:
      return {
        name: (node as TSESTree.TSInterfaceDeclaration).id.name,
        kind: 'interface',
        containerName,
        containerKind
      };

    case AST_NODE_TYPES.TSTypeAliasDeclaration:
      return {
        name: (node as TSESTree.TSTypeAliasDeclaration).id.name,
        kind: 'type',
        containerName,
        containerKind
      };

    case AST_NODE_TYPES.TSEnumDeclaration:
      return {
        name: (node as TSESTree.TSEnumDeclaration).id.name,
        kind: 'enum',
        containerName,
        containerKind
      };

    case AST_NODE_TYPES.MethodDefinition:
      if ((node as TSESTree.MethodDefinition).key.type === AST_NODE_TYPES.Identifier) {
        const methodNode = node as TSESTree.MethodDefinition;
        return {
          name: ((methodNode).key as TSESTree.Identifier).name,
          kind: 'method',
          containerName,
          containerKind,
          isStatic: methodNode.static,
          parametersCount: methodNode.value.params.length
        };
      }
      break;

    case AST_NODE_TYPES.PropertyDefinition:
      if ((node as TSESTree.PropertyDefinition).key.type === AST_NODE_TYPES.Identifier) {
        const propNode = node as TSESTree.PropertyDefinition;
        return {
          name: ((propNode).key as TSESTree.Identifier).name,
          kind: 'property',
          containerName,
          containerKind,
          isStatic: propNode.static
        };
      }
      break;

    case AST_NODE_TYPES.VariableDeclarator:
      if ((node as TSESTree.VariableDeclarator).id.type === AST_NODE_TYPES.Identifier) {
        return {
          name: ((node as TSESTree.VariableDeclarator).id as TSESTree.Identifier).name,
          kind: 'variable',
          containerName,
          containerKind
        };
      }
      break;
  }

  return null;
}

function getNameNode(node: TSESTree.Node): TSESTree.Node | null {
  switch (node.type) {
    case AST_NODE_TYPES.FunctionDeclaration:
      return (node as TSESTree.FunctionDeclaration).id || null;
    case AST_NODE_TYPES.ClassDeclaration:
      return (node as TSESTree.ClassDeclaration).id || null;
    case AST_NODE_TYPES.TSInterfaceDeclaration:
      return (node as TSESTree.TSInterfaceDeclaration).id;
    case AST_NODE_TYPES.TSTypeAliasDeclaration:
      return (node as TSESTree.TSTypeAliasDeclaration).id;
    case AST_NODE_TYPES.TSEnumDeclaration:
      return (node as TSESTree.TSEnumDeclaration).id;
    case AST_NODE_TYPES.MethodDefinition:
      return (node as TSESTree.MethodDefinition).key;
    case AST_NODE_TYPES.PropertyDefinition:
      return (node as TSESTree.PropertyDefinition).key;
    case AST_NODE_TYPES.VariableDeclarator:
      return (node as TSESTree.VariableDeclarator).id;
    default:
      return null;
  }
}

function findParent(node: TSESTree.Node): TSESTree.Node | null {
  // This is a simplified version - in production, you'd track parents during traversal
  return null;
}

/**
 * Match a symbol at cursor position against indexed symbols to find the exact match.
 */
export function matchSymbolById(
  symbolAtCursor: SymbolAtPosition,
  candidates: IndexedSymbol[]
): IndexedSymbol | null {
  // First try exact match by metadata
  for (const candidate of candidates) {
    if (
      candidate.name === symbolAtCursor.name &&
      candidate.kind === symbolAtCursor.kind &&
      candidate.containerName === symbolAtCursor.containerName &&
      candidate.isStatic === symbolAtCursor.isStatic
    ) {
      return candidate;
    }
  }

  // Fallback: match by name and container only
  for (const candidate of candidates) {
    if (
      candidate.name === symbolAtCursor.name &&
      candidate.containerName === symbolAtCursor.containerName
    ) {
      return candidate;
    }
  }

  return null;
}
