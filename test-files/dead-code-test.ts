// Dead Code Detection Test File
// This file demonstrates the Smart Indexer's ability to detect unused exports

// =================================================================
// USED EXPORTS (Should NOT be flagged)
// =================================================================

// Used in another file (simulated)
export function activeFunction() {
  return 'This function is used elsewhere';
}

// Used class
export class ActiveClass {
  constructor() {
    console.log('Active class');
  }
  
  // Lifecycle hook - should NOT be flagged even with 0 references
  ngOnInit() {
    console.log('Component initialized');
  }
}

// Used interface
export interface ActiveInterface {
  id: number;
  name: string;
}

// =================================================================
// DEAD CODE (Should be flagged as unused)
// =================================================================

// Unused function - HIGH confidence
export function unusedFunction() {
  return 'This is never called';
}

// Unused class - HIGH confidence
export class UnusedClass {
  private value: number = 0;
  
  getValue(): number {
    return this.value;
  }
}

// Unused interface - HIGH confidence
export interface UnusedInterface {
  deprecated: boolean;
}

// Unused type alias - HIGH confidence
export type UnusedType = {
  oldField: string;
};

// Unused constant - HIGH confidence
export const UNUSED_CONSTANT = 'This const is never imported';

// Unused enum - HIGH confidence
export enum UnusedEnum {
  Option1 = 'opt1',
  Option2 = 'opt2'
}

// =================================================================
// INTERNAL/PRIVATE CODE (Should NOT be flagged - not exported)
// =================================================================

// Not exported - should be ignored by dead code detector
function internalHelper() {
  return 'internal use only';
}

// Not exported
class InternalClass {
  doSomething() {
    console.log('internal');
  }
}

// =================================================================
// PUBLIC API MARKERS (Should NOT be flagged even if unused)
// =================================================================

/**
 * Public API function
 * @public
 * @api
 */
export function publicApiFunction() {
  return 'This is part of the public API';
}

/**
 * Public API class
 * @publicApi
 */
export class PublicApiClass {
  constructor() {
    console.log('Public API');
  }
}

// =================================================================
// MEDIUM CONFIDENCE (Used only in same file)
// =================================================================

export function partiallyUsedFunction() {
  return 'Only used locally';
}

// Called within the same file
const localUsage = partiallyUsedFunction();

// =================================================================
// NGRX PATTERNS (Should be handled correctly)
// =================================================================

// NgRx action - may have 0 direct references but used via type string
export const loadData = createAction('[Data] Load');

// NgRx effect - should not be flagged
export class DataEffects {
  loadData$ = createEffect(() =>
    this.actions$.pipe(
      ofType(loadData)
    )
  );
  
  constructor(private actions$: any) {}
}

// =================================================================
// EXPECTED BEHAVIOR
// =================================================================
//
// When this file is opened in VS Code with Smart Indexer enabled:
//
// 1. The following should be flagged (grayed out):
//    ✓ unusedFunction (line 39)
//    ✓ UnusedClass (line 44)
//    ✓ UnusedInterface (line 53)
//    ✓ UnusedType (line 58)
//    ✓ UNUSED_CONSTANT (line 63)
//    ✓ UnusedEnum (line 66)
//
// 2. The following should NOT be flagged:
//    ✓ activeFunction (used elsewhere)
//    ✓ ActiveClass (used elsewhere)
//    ✓ ngOnInit (Angular lifecycle hook)
//    ✓ publicApiFunction (@public marker)
//    ✓ PublicApiClass (@publicApi marker)
//    ✓ internalHelper (not exported)
//    ✓ loadData (NgRx action with references)
//    ✓ DataEffects (has effect property)
//
// 3. Medium confidence (may be flagged with hint):
//    ? partiallyUsedFunction (only used in same file)
//
// =================================================================

console.log('Dead Code Detection Test Loaded');

// Placeholder implementations
function createAction(type: string): any { return null; }
function createEffect(fn: any): any { return null; }
function ofType(...args: any[]): any { return null; }
