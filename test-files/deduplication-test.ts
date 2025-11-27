/**
 * Manual Test Case for Hybrid Deduplication
 * 
 * This file demonstrates how to test the deduplication feature.
 * 
 * Setup:
 * 1. Open this project in VS Code with Smart Indexer installed
 * 2. Set "smartIndexer.mode": "hybrid" in settings
 * 3. Reload VS Code window (Ctrl+R / Cmd+R)
 */

// Test Case 1: Standard TypeScript Function
export function testFunction(param: string): void {
  console.log(param);
}

// Test Case 2: Imported Symbol (should deduplicate across providers)
import { useState } from 'react'; // If React is installed

// Test Case 3: Type Definition
export type TestType = {
  id: number;
  name: string;
};

// Test Case 4: Interface Definition
export interface TestInterface {
  method(): void;
}

// Test Case 5: Class with Methods
export class TestClass implements TestInterface {
  method(): void {
    // Right-click on 'method' and Go to Definition
    // Should show only ONE result, not duplicates from:
    //   - Native TS (interface definition)
    //   - Smart Indexer (interface definition)
    //   - Native TS (implementation)
    //   - Smart Indexer (implementation)
  }
}

// Test Case 6: Variable References
const myVariable = "test";
console.log(myVariable); // Right-click myVariable -> Find References
                         // Should show unique list without duplicates

/**
 * How to Test:
 * 
 * 1. Go to Definition Test:
 *    - Right-click on any symbol (e.g., 'testFunction', 'TestType')
 *    - Select "Go to Definition" (F12)
 *    - Expected: Single result, no duplicates
 * 
 * 2. Find References Test:
 *    - Right-click on 'myVariable' (line 44)
 *    - Select "Find All References" (Shift+F12)
 *    - Expected: Unique list of references (line 43 and 44)
 * 
 * 3. Check Logs:
 *    - Open Output panel (Ctrl+Shift+U / Cmd+Shift+U)
 *    - Select "Smart Indexer" channel
 *    - Look for deduplication logs:
 *      [HybridDefinitionProvider] Native: 1, Smart: 1
 *      [HybridDefinitionProvider] Merged: 1 locations (45ms)
 * 
 * 4. Compare Modes:
 *    - Test with "smartIndexer.mode": "hybrid" → Should see deduplication
 *    - Test with "smartIndexer.mode": "standalone" → Only Smart Indexer
 * 
 * 5. Performance Check:
 *    - Check timing in output logs
 *    - Should be <100ms for most queries
 * 
 * Expected Behavior:
 * ✅ No duplicate entries in peek window
 * ✅ Fast response time (<100ms)
 * ✅ Logs show deduplication working
 * ✅ Results combine Native TS accuracy + Smart Indexer speed
 */

// Edge Case: Near-Duplicate Detection
export function nearDuplicateTest() {
  // If Native TS returns line 66 and Smart Indexer returns line 67,
  // the proximity heuristic should detect them as duplicates
  // and keep only the Native TS result
  return "testing proximity detection";
}

/**
 * Troubleshooting:
 * 
 * Still seeing duplicates?
 * → Check settings: "smartIndexer.mode" should be "hybrid"
 * → Reload VS Code window
 * → Check extension is active (look for status bar item)
 * 
 * No results at all?
 * → Increase "smartIndexer.hybridTimeoutMs" to 200-500
 * → Check TypeScript server is working (try disabling Smart Indexer)
 * → Rebuild Smart Indexer index (Cmd+Shift+P → "Smart Indexer: Rebuild Index")
 * 
 * Slow performance?
 * → Reduce "smartIndexer.hybridTimeoutMs" to 50-100
 * → Switch to "standalone" mode for maximum speed
 * → Check for large files that slow Native TS
 */
