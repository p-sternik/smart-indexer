import { parse } from '@typescript-eslint/typescript-estree';
import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/typescript-estree';
import { IndexedSymbol } from '../types.js';

const MAX_RECURSION_DEPTH = 10;

export interface ResolvedProperty {
  name: string;
  location: {
    uri: string;
    line: number;
    character: number;
  };
  range: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
}

export interface MemberAccessInfo {
  baseName: string;
  propertyChain: string[];
}

/**
 * Parse a member access expression like "ProductsPageActions.opened" or "myApi.v1.users.get"
 * Returns the base object name and the property chain
 */
export function parseMemberAccess(
  content: string,
  line: number,
  character: number
): MemberAccessInfo | null {
  try {
    const ast = parse(content, {
      loc: true,
      range: true,
      comment: false,
      tokens: false,
      errorOnUnknownASTType: false,
      jsx: false
    });

    const targetOffset = getOffset(content, line, character);
    const result = findMemberExpressionAtPosition(ast, targetOffset);
    
    return result;
  } catch (error) {

    return null;
  }
}

function getOffset(content: string, line: number, character: number): number {
  const lines = content.split('\n');
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  offset += character;
  return offset;
}

function findMemberExpressionAtPosition(
  node: TSESTree.Node,
  targetOffset: number
): MemberAccessInfo | null {
  if (!node || !node.range) {
    return null;
  }

  const [start, end] = node.range;
  if (targetOffset < start || targetOffset > end) {
    return null;
  }

  // Check if we're on a MemberExpression
  if (node.type === AST_NODE_TYPES.MemberExpression) {
    const memberExpr = node as TSESTree.MemberExpression;
    
    // Extract the full chain
    const chain: string[] = [];
    let current: TSESTree.Node | TSESTree.Expression | TSESTree.PrivateIdentifier = memberExpr;
    
    while (current.type === AST_NODE_TYPES.MemberExpression) {
      const expr = current as TSESTree.MemberExpression;
      if (expr.property.type === AST_NODE_TYPES.Identifier) {
        chain.unshift(expr.property.name);
      }
      current = expr.object;
    }
    
    // Get the base identifier
    if (current.type === AST_NODE_TYPES.Identifier) {
      const baseName = (current as TSESTree.Identifier).name;
      
      // Determine which property the cursor is on
      const propertyChain: string[] = [];
      if (memberExpr.property.type === AST_NODE_TYPES.Identifier && memberExpr.property.range) {
        const [propStart, propEnd] = memberExpr.property.range;
        if (targetOffset >= propStart && targetOffset <= propEnd) {
          // Cursor is on the last property in the chain
          propertyChain.push(...chain);
        }
      }
      
      return {
        baseName,
        propertyChain: propertyChain.length > 0 ? propertyChain : chain
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
            const result = findMemberExpressionAtPosition(item, targetOffset);
            if (result) {
              return result;
            }
          }
        }
      } else if (child.type) {
        const result = findMemberExpressionAtPosition(child, targetOffset);
        if (result) {
          return result;
        }
      }
    }
  }

  return null;
}

/**
 * Recursively resolve a property within an object or function result.
 * 
 * Algorithm:
 * 1. Find the base symbol definition (e.g., "ProductsPageActions")
 * 2. Analyze its initializer:
 *    a. If it's an object literal, find the property directly
 *    b. If it's a function call, analyze the function's return value
 *    c. If it's a variable reference, follow the chain
 * 3. Recurse with depth limit
 */
export async function resolvePropertyRecursively(
  baseSymbol: IndexedSymbol,
  propertyChain: string[],
  fileResolver: (uri: string) => Promise<string>,
  symbolFinder: (name: string, uri?: string) => Promise<IndexedSymbol[]>,
  depth: number = 0,
  visited: Set<string> = new Set()
): Promise<ResolvedProperty | null> {
  if (depth >= MAX_RECURSION_DEPTH) {

    return null;
  }

  if (propertyChain.length === 0) {
    return null;
  }

  const symbolKey = `${baseSymbol.location.uri}:${baseSymbol.name}`;
  if (visited.has(symbolKey)) {

    return null;
  }
  visited.add(symbolKey);

  try {
    // Read the file containing the base symbol
    const content = await fileResolver(baseSymbol.location.uri);
    const ast = parse(content, {
      loc: true,
      range: true,
      comment: false,
      tokens: false,
      errorOnUnknownASTType: false,
      jsx: baseSymbol.location.uri.endsWith('x')
    });

    // Find the symbol's declaration and analyze its initializer
    const targetProperty = propertyChain[0];
    const remainingChain = propertyChain.slice(1);

    const resolved = await analyzeSymbolInitializer(
      ast,
      baseSymbol,
      targetProperty,
      content,
      fileResolver,
      symbolFinder,
      depth,
      visited
    );

    if (resolved && remainingChain.length > 0) {
      // Continue resolving the chain
      const nextSymbols = await symbolFinder(targetProperty, baseSymbol.location.uri);
      if (nextSymbols.length > 0) {
        return resolvePropertyRecursively(
          nextSymbols[0],
          remainingChain,
          fileResolver,
          symbolFinder,
          depth + 1,
          visited
        );
      }
    }

    return resolved;
  } catch (error) {

    return null;
  }
}

async function analyzeSymbolInitializer(
  ast: TSESTree.Program,
  baseSymbol: IndexedSymbol,
  propertyName: string,
  content: string,
  fileResolver: (uri: string) => Promise<string>,
  symbolFinder: (name: string, uri?: string) => Promise<IndexedSymbol[]>,
  depth: number = 0,
  visited: Set<string> = new Set()
): Promise<ResolvedProperty | null> {
  // Find the variable declaration for the base symbol
  const declaration = findDeclarationByName(ast, baseSymbol.name);
  
  if (!declaration) {

    return null;
  }

  // Analyze the initializer
  if (declaration.type === AST_NODE_TYPES.VariableDeclarator && declaration.init) {
    const init = declaration.init;

    // Case 1: Object literal - find the property directly
    if (init.type === AST_NODE_TYPES.ObjectExpression) {

      return findPropertyInObjectLiteral(init, propertyName, baseSymbol.location.uri);
    }

    // Case 2: Function call - analyze the function's return value
    if (init.type === AST_NODE_TYPES.CallExpression) {

      return await analyzeFunctionCall(
        init,
        propertyName,
        baseSymbol.location.uri,
        content,
        fileResolver,
        symbolFinder,
        depth,
        visited
      );
    }

    // Case 3: Identifier reference - follow the chain
    if (init.type === AST_NODE_TYPES.Identifier) {

      const referencedSymbols = await symbolFinder(init.name, baseSymbol.location.uri);
      if (referencedSymbols.length > 0) {
        return resolvePropertyRecursively(
          referencedSymbols[0],
          [propertyName],
          fileResolver,
          symbolFinder,
          depth + 1,
          visited
        );
      }
    }
  }



  return null;
}

function findDeclarationByName(
  ast: TSESTree.Program,
  name: string
): TSESTree.VariableDeclarator | TSESTree.FunctionDeclaration | null {
  for (const statement of ast.body) {
    if (statement.type === AST_NODE_TYPES.VariableDeclaration) {
      for (const decl of statement.declarations) {
        if (decl.id.type === AST_NODE_TYPES.Identifier && decl.id.name === name) {
          return decl;
        }
      }
    } else if (statement.type === AST_NODE_TYPES.FunctionDeclaration) {
      if (statement.id?.name === name) {
        return statement;
      }
    } else if (statement.type === AST_NODE_TYPES.ExportNamedDeclaration) {
      if (statement.declaration?.type === AST_NODE_TYPES.VariableDeclaration) {
        for (const decl of statement.declaration.declarations) {
          if (decl.id.type === AST_NODE_TYPES.Identifier && decl.id.name === name) {
            return decl;
          }
        }
      } else if (statement.declaration?.type === AST_NODE_TYPES.FunctionDeclaration) {
        if (statement.declaration.id?.name === name) {
          return statement.declaration;
        }
      }
    }
  }
  return null;
}

function findPropertyInObjectLiteral(
  objExpr: TSESTree.ObjectExpression,
  propertyName: string,
  uri: string
): ResolvedProperty | null {
  for (const prop of objExpr.properties) {
    if (prop.type === AST_NODE_TYPES.Property) {
      if (prop.key.type === AST_NODE_TYPES.Identifier && prop.key.name === propertyName && prop.key.loc) {
        return {
          name: propertyName,
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
          }
        };
      }
    }
  }
  return null;
}

async function analyzeFunctionCall(
  callExpr: TSESTree.CallExpression,
  propertyName: string,
  uri: string,
  _content: string,
  fileResolver: (uri: string) => Promise<string>,
  symbolFinder: (name: string, uri?: string) => Promise<IndexedSymbol[]>,
  _depth: number = 0,
  _visited: Set<string> = new Set()
): Promise<ResolvedProperty | null> {
  // Get the function being called
  let functionName: string | null = null;
  
  if (callExpr.callee.type === AST_NODE_TYPES.Identifier) {
    functionName = callExpr.callee.name;
  } else if (callExpr.callee.type === AST_NODE_TYPES.MemberExpression) {
    if (callExpr.callee.property.type === AST_NODE_TYPES.Identifier) {
      functionName = callExpr.callee.property.name;
    }
  }

  if (!functionName) {
    return null;
  }

  // Find the function definition
  const functionSymbols = await symbolFinder(functionName, uri);
  if (functionSymbols.length === 0) {
    return null;
  }

  const functionSymbol = functionSymbols[0];
  const functionContent = await fileResolver(functionSymbol.location.uri);
  const functionAst = parse(functionContent, {
    loc: true,
    range: true,
    comment: false,
    tokens: false,
    errorOnUnknownASTType: false,
    jsx: functionSymbol.location.uri.endsWith('x')
  });

  // Analyze the function's return statement
  const returnProperty = analyzeFunctionReturn(functionAst, functionName, propertyName, functionSymbol.location.uri, callExpr);
  
  return returnProperty;
}

function analyzeFunctionReturn(
  ast: TSESTree.Program,
  functionName: string,
  propertyName: string,
  uri: string,
  callExpr: TSESTree.CallExpression
): ResolvedProperty | null {
  const funcDecl = findDeclarationByName(ast, functionName);
  
  if (!funcDecl || funcDecl.type !== AST_NODE_TYPES.FunctionDeclaration) {
    return null;
  }

  // Find return statements
  const returnStmt = findReturnStatement(funcDecl.body);
  
  if (!returnStmt?.argument) {
    return null;
  }

  // If return is an object literal, find the property
  if (returnStmt.argument.type === AST_NODE_TYPES.ObjectExpression) {

    return findPropertyInObjectLiteral(returnStmt.argument, propertyName, uri);
  }

  // Heuristic for framework patterns like createActionGroup
  // Look for properties in the first argument if it's an object
  if (callExpr.arguments.length > 0) {
    const firstArg = callExpr.arguments[0];
    if (firstArg.type === AST_NODE_TYPES.ObjectExpression) {
      // Look for "events" or similar property that might contain our target
      for (const prop of firstArg.properties) {
        if (prop.type === AST_NODE_TYPES.Property) {
          const key = prop.key.type === AST_NODE_TYPES.Identifier ? prop.key.name : null;
          if (key === 'events' && prop.value.type === AST_NODE_TYPES.ObjectExpression) {

            const result = findPropertyInObjectLiteral(prop.value as TSESTree.ObjectExpression, propertyName, uri);
            if (result) {
              return result;
            }
          }
        }
      }
    }
  }

  return null;
}

function findReturnStatement(node: TSESTree.Node): TSESTree.ReturnStatement | null {
  if (node.type === AST_NODE_TYPES.ReturnStatement) {
    return node as TSESTree.ReturnStatement;
  }

  for (const key in node) {
    const child = (node as any)[key];
    if (child && typeof child === 'object') {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && item.type) {
            const result = findReturnStatement(item);
            if (result) {
              return result;
            }
          }
        }
      } else if (child.type) {
        const result = findReturnStatement(child);
        if (result) {
          return result;
        }
      }
    }
  }

  return null;
}


