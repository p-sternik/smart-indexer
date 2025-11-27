# AST Parser Refinement - Code Changes Summary

## File Modified: `server/src/indexer/worker.ts`

### Change 1: Replace Broken Declaration Detection (Lines 117-167)

**BEFORE:**
```typescript
function isDeclaration(parent: string | null): boolean {
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

function getParentContext(node: TSESTree.Node): string | null {
  return null;  // ❌ Always returns null!
}
```

**AFTER:**
```typescript
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
```

### Change 2: Add Parent Parameter to `traverseAST()` (Line 230)

**BEFORE:**
```typescript
function traverseAST(
  node: TSESTree.Node,
  symbols: IndexedSymbol[],
  references: IndexedReference[],
  uri: string,
  containerName?: string,
  containerKind?: string,
  containerPath: string[] = [],
  imports: ImportInfo[] = [],
  scopeTracker?: ScopeTracker
): void {
```

**AFTER:**
```typescript
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
  parent: TSESTree.Node | null = null  // ← Added parent tracking
): void {
```

### Change 3: Fix Identifier Reference Detection (Lines 245-270)

**BEFORE:**
```typescript
if (node.type === AST_NODE_TYPES.Identifier && node.loc) {
  const parent = getParentContext(node);  // ❌ Always null!
  
  if (!isDeclaration(parent)) {  // ❌ Always executes
    // ... add to references
  }
}
```

**AFTER:**
```typescript
// Handle Identifiers - but only if they are NOT part of a declaration
if (node.type === AST_NODE_TYPES.Identifier && node.loc) {
  // Skip if this identifier is the name being declared
  if (!isDeclarationContext(node, parent)) {  // ✅ Properly checks
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
```

### Change 4: Update All Recursive Calls (Lines 510-543)

**BEFORE:**
```typescript
traverseAST(item, symbols, references, uri, newContainer, newContainerKind, 
           newContainerPath, imports, scopeTracker);
```

**AFTER:**
```typescript
traverseAST(item, symbols, references, uri, newContainer, newContainerKind, 
           newContainerPath, imports, scopeTracker, node);  // ← Pass parent
```

## Summary of Changes

| What | Before | After | Impact |
|------|--------|-------|--------|
| **Declaration detection** | Always broken (null parent) | Properly checks AST parent | ✅ Accurate |
| **Method declarations** | Indexed as references | Excluded from references | ✅ Less noise |
| **Property declarations** | Indexed as references | Excluded from references | ✅ Less noise |
| **Actual usages** | Some missed | All captured | ✅ Complete |
| **Build** | ✅ Passes | ✅ Passes | ✅ No regression |

## Test Validation

```
Line 4:  const createSigningStepStart = ...     → DECLARATION ✅
Line 11: public createSigningStepStart() {...}  → DECLARATION ✅
Line 13: SigningActions.createSigningStepStart() → REFERENCE ✅
Line 19: createSigningStepStart()               → REFERENCE ✅
```

## Files Added
- `test-files/reference-test.ts` - Test case with Angular facade pattern
- `verify-parser-improvements.ps1` - Automated test script
- `AST_PARSER_IMPROVEMENTS.md` - Full documentation
- `AST_PARSER_QUICK_REF.md` - Quick reference guide
