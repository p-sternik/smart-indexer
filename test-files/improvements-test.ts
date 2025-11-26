// Test file for Smart Indexer improvements

/**
 * @public
 * This class should be excluded from dead code detection
 */
export class PublicUserService {
  save() {
    return 'saved';
  }
}

/**
 * This class has no @public marker and is never imported.
 * Should be flagged as dead code with HIGH confidence.
 */
export class UnusedDataService {
  private data: string[] = [];
  
  add(item: string) {
    this.data.push(item);
  }
  
  getAll() {
    return this.data;
  }
}

/**
 * This function is used locally but never imported.
 * Should be flagged with MEDIUM confidence.
 */
export function localHelper(value: number): number {
  return value * 2;
}

// Using the function in same file
const result = localHelper(5);

/**
 * Test stable symbol IDs:
 * - Adding/removing lines above should not break symbol references
 * - The ID should be based on semantic path, not line numbers
 */
export class StableIdTest {
  methodOne(param: string) {
    // Local variable 'temp' in this scope
    const temp = param.toUpperCase();
    return temp;
  }
  
  methodTwo(value: number) {
    // Different 'temp' in different scope
    // Should NOT show references from methodOne
    const temp = value * 2;
    return temp;
  }
}

/**
 * Test scope-based reference filtering
 */
function scopeTestA() {
  const temp = 'A';
  console.log(temp); // Reference in scope A
}

function scopeTestB() {
  const temp = 'B';
  console.log(temp); // Reference in scope B - should be separate
}

/**
 * Test overloaded methods - should get different symbol IDs
 */
export class OverloadTest {
  process(value: string): string;
  process(value: number): number;
  process(value: string | number): string | number {
    return value;
  }
}
