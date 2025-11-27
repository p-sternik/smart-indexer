# AST Parser Refinement - Declaration vs Usage Detection

## Overview
Enhanced the TypeScript AST parser in `server/src/indexer/worker.ts` to properly distinguish between **symbol declarations** and **symbol usages/references**. This prevents "Find References" from returning noisy results that include the declaration itself.

## Problem Statement
Previously, the parser was too naive and would incorrectly index method/property declarations as references to similarly-named symbols. For example:

```typescript
// Action definition
const createSigningStepStart = () => ({ type: 'CREATE_SIGNING_STEP_START' });

// Facade with same-named method
public createSigningStepStart() {
  this.store.dispatch(SigningActions.createSigningStepStart()); // ← True reference
}
```

When searching for references to the **action** `createSigningStepStart`, the parser would incorrectly return the **method declaration** `public createSigningStepStart()` as a reference.

## Solution Implemented

### 1. Created `isDeclarationContext()` Function
Replaced the broken `isDeclaration()` and `getParentContext()` functions with a comprehensive `isDeclarationContext()` that:
- Receives both the node and its parent
- Checks if the node is the identifier being declared in various contexts
- Handles all TypeScript/JavaScript declaration types:
  - Function declarations
  - Class declarations
  - Variable declarators
  - Method definitions
  - Property definitions
  - Interface declarations
  - Type alias declarations
  - Enum declarations
  - Import specifiers
  - Function parameters
  - Object literal properties (non-computed)

### 2. Enhanced `traverseAST()` Function
- Added `parent: TSESTree.Node | null = null` parameter
- Modified identifier handling to skip declaration contexts:
  ```typescript
  if (node.type === AST_NODE_TYPES.Identifier && node.loc) {
    if (!isDeclarationContext(node, parent)) {
      // Only add to references if NOT a declaration
      references.push({...});
    }
  }
  ```
- Updated all recursive calls to pass the current node as parent

### 3. Improved MemberExpression Handling
Added clarifying comments that `MemberExpression` (e.g., `SigningActions.createSigningStepStart`) always represents a usage, never a declaration.

## Test Results

Created `test-files/reference-test.ts` with comprehensive test cases and `verify-parser-improvements.ps1` to validate the changes.

### Test Output:
```
=== DECLARATIONS ===
Found 3 declarations:
  1. Line 4: createSigningStepStart (parent: VariableDeclarator)
  2. Line 11: createSigningStepStart (parent: MethodDefinition)  ← Correctly identified
  3. Line 27: createSigningStepStart (parent: Property)

=== REFERENCES (Usages) ===
Found 4 references:
  1. Line 13: createSigningStepStart (parent: MemberExpression)  ← Dispatch call
  2. Line 19: createSigningStepStart (parent: CallExpression)
  3. Line 37: createSigningStepStart (parent: MemberExpression)  ← Effect usage
  4. Line 57: createSigningStepStart (parent: CallExpression)

✅ PASSED: Line 11 method declaration correctly identified as DECLARATION
✅ PASSED: Line 13 action call correctly identified as REFERENCE
✅ PASSED: Line 4 constant declaration correctly identified as DECLARATION
```

## Impact

### Before:
- "Find References" on NgRx action `createSigningStepStart` would return:
  - ❌ Facade method declaration `public createSigningStepStart()`
  - ✅ Actual dispatch calls
  - ✅ Effect usages
  - ✅ Reducer references

### After:
- "Find References" on NgRx action `createSigningStepStart` returns ONLY:
  - ✅ Actual dispatch calls (e.g., `this.store.dispatch(SigningActions.createSigningStepStart())`)
  - ✅ Effect usages (e.g., `ofType(SigningActions.createSigningStepStart)`)
  - ✅ Direct function calls (e.g., `createSigningStepStart()`)
  - ✅ Property access (e.g., `SigningActions.createSigningStepStart`)

## Files Modified
- `server/src/indexer/worker.ts`
  - Replaced `isDeclaration()` and `getParentContext()` with `isDeclarationContext()`
  - Updated `traverseAST()` signature to include parent parameter
  - Modified identifier handling to skip declarations
  - Updated all recursive calls to pass parent context

## Files Created
- `test-files/reference-test.ts` - Comprehensive test file with multiple declaration/usage patterns
- `verify-parser-improvements.ps1` - Automated test script to verify the improvements

## Build Status
✅ All type checks passed
✅ All lints passed
✅ All tests passed
✅ Build successful

## Next Steps (Optional Enhancements)
1. Add deduplication for property access chains (e.g., count `a.b.c` as one reference, not three)
2. Consider tracking declaration locations separately for "Go to Definition" feature
3. Add support for destructuring patterns
4. Enhance scope tracking for better local variable detection

## Verification Command
```powershell
.\verify-parser-improvements.ps1
```
