# AST Parser Improvements - Quick Reference

## What Changed?
The parser now correctly distinguishes between **declarations** and **usages** when indexing TypeScript/JavaScript code.

## Key Changes

### 1. New Function: `isDeclarationContext()`
Determines if an identifier is being **declared** (definition) vs **used** (reference).

**Handles:**
- `FunctionDeclaration` - `function myFunc() {}`
- `ClassDeclaration` - `class MyClass {}`
- `VariableDeclarator` - `const myVar = ...`
- `MethodDefinition` - `public myMethod() {}`
- `PropertyDefinition` - `myProperty = value`
- `TSInterfaceDeclaration` - `interface MyInterface {}`
- `TSTypeAliasDeclaration` - `type MyType = ...`
- `TSEnumDeclaration` - `enum MyEnum {}`
- Import statements
- Function parameters
- Object literal properties

### 2. Updated: `traverseAST()`
- **New parameter:** `parent: TSESTree.Node | null = null`
- **Identifier handling:** Skips identifiers that are declarations
- **All recursive calls:** Now pass current node as parent

### 3. Example Behavior

**Before:**
```typescript
// When searching for "createSigningStepStart" action references:
public createSigningStepStart() {  // ❌ Incorrectly returned as reference
  this.store.dispatch(SigningActions.createSigningStepStart());  // ✅ Correct
}
```

**After:**
```typescript
// When searching for "createSigningStepStart" action references:
public createSigningStepStart() {  // ✅ Excluded (it's a declaration)
  this.store.dispatch(SigningActions.createSigningStepStart());  // ✅ Correct
}
```

## Testing

**Run verification:**
```powershell
.\verify-parser-improvements.ps1
```

**Test file:** `test-files/reference-test.ts`

## Impact

### Use Cases That Now Work Correctly

1. **NgRx Pattern:**
   - Actions with same name as facade methods
   - Effects referencing actions
   - Reducers handling actions

2. **Generic Patterns:**
   - Interface/class with same-named members
   - Nested object properties
   - Function parameters vs usages

### Symbols Index
- **Unchanged** - Still captures all declarations correctly
- Includes: functions, classes, methods, properties, variables, etc.

### References Index  
- **Improved** - Now excludes declaration sites
- Includes only: actual usages, calls, property access, variable references

## Build Commands

```bash
# Full build
npm run compile

# Server only
npm run compile:server

# Type check
npm run check-types
```

## Code Location
- **File:** `server/src/indexer/worker.ts`
- **Key functions:** `isDeclarationContext()`, `traverseAST()`
- **Lines:** ~117-167 (isDeclarationContext), ~230-547 (traverseAST)

## Backward Compatibility
✅ **Fully backward compatible**
- No breaking changes to API
- Symbols index unchanged
- References index more accurate (fewer false positives)
- Build/test scripts unchanged
