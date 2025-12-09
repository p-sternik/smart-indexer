/**
 * Integration test for NgRx createActionGroup support
 * Tests the complete pipeline from source code to indexed symbols
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test cases with TypeScript code and expected symbols
const testCases = [
  {
    name: 'Basic createActionGroup',
    code: `
export const UserActions = createActionGroup({
  source: 'User',
  events: {
    'Load User': props<{ id: string }>(),
    'Log Out': emptyProps()
  }
});
    `,
    expectedSymbols: [
      { name: 'UserActions', kind: 'constant' },
      { name: 'loadUser', kind: 'method', containerName: 'UserActions', ngrxType: 'Load User' },
      { name: 'logOut', kind: 'method', containerName: 'UserActions', ngrxType: 'Log Out' }
    ]
  },
  {
    name: 'Edge cases - single word and already camelCase',
    code: `
const SimpleActions = createActionGroup({
  source: 'Simple',
  events: {
    'simple': props(),
    'AlreadyCamel': props()
  }
});
    `,
    expectedSymbols: [
      { name: 'SimpleActions', kind: 'constant' },
      { name: 'simple', kind: 'method', containerName: 'SimpleActions', ngrxType: 'simple' },
      { name: 'alreadyCamel', kind: 'method', containerName: 'SimpleActions', ngrxType: 'AlreadyCamel' }
    ]
  },
  {
    name: 'Complex naming with underscores and dashes',
    code: `
const MixedActions = createActionGroup({
  source: 'Mixed',
  events: {
    'load_user_data': props(),
    'save-user-data': props(),
    'Update Signing Action': props()
  }
});
    `,
    expectedSymbols: [
      { name: 'MixedActions', kind: 'constant' },
      { name: 'loadUserData', kind: 'method', containerName: 'MixedActions', ngrxType: 'load_user_data' },
      { name: 'saveUserData', kind: 'method', containerName: 'MixedActions', ngrxType: 'save-user-data' },
      { name: 'updateSigningAction', kind: 'method', containerName: 'MixedActions', ngrxType: 'Update Signing Action' }
    ]
  },
  {
    name: 'Identifier keys (not string literals)',
    code: `
const IdentifierActions = createActionGroup({
  source: 'Identifier',
  events: {
    loadData: props(),
    saveData: emptyProps()
  }
});
    `,
    expectedSymbols: [
      { name: 'IdentifierActions', kind: 'constant' },
      { name: 'loadData', kind: 'method', containerName: 'IdentifierActions', ngrxType: 'loadData' },
      { name: 'saveData', kind: 'method', containerName: 'IdentifierActions', ngrxType: 'saveData' }
    ]
  }
];

async function runWorkerTest(code, uri) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'server', 'out', 'indexer', 'worker.js');
    
    // Check if worker exists
    if (!fs.existsSync(workerPath)) {
      reject(new Error(`Worker not found at ${workerPath}`));
      return;
    }
    
    const worker = new Worker(workerPath);
    
    worker.on('message', (result) => {
      if (result.success) {
        resolve(result.result);
      } else {
        reject(new Error(result.error || 'Worker failed'));
      }
      worker.terminate();
    });
    
    worker.on('error', (error) => {
      reject(error);
      worker.terminate();
    });
    
    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
    
    // Send task to worker
    worker.postMessage({
      uri,
      content: code
    });
  });
}

async function runTests() {
  console.log('Running NgRx createActionGroup Integration Tests...\n');
  
  let passed = 0;
  let failed = 0;
  
  for (const testCase of testCases) {
    console.log(`Test: ${testCase.name}`);
    
    try {
      const result = await runWorkerTest(testCase.code, 'test.ts');
      
      // Verify symbols
      for (const expectedSymbol of testCase.expectedSymbols) {
        const actualSymbol = result.symbols.find(s => s.name === expectedSymbol.name);
        
        if (!actualSymbol) {
          console.log(`  ✗ Symbol '${expectedSymbol.name}' not found`);
          failed++;
          continue;
        }
        
        if (actualSymbol.kind !== expectedSymbol.kind) {
          console.log(`  ✗ Symbol '${expectedSymbol.name}' has kind '${actualSymbol.kind}', expected '${expectedSymbol.kind}'`);
          failed++;
          continue;
        }
        
        if (expectedSymbol.containerName && actualSymbol.containerName !== expectedSymbol.containerName) {
          console.log(`  ✗ Symbol '${expectedSymbol.name}' has containerName '${actualSymbol.containerName}', expected '${expectedSymbol.containerName}'`);
          failed++;
          continue;
        }
        
        if (expectedSymbol.ngrxType && actualSymbol.ngrxMetadata?.type !== expectedSymbol.ngrxType) {
          console.log(`  ✗ Symbol '${expectedSymbol.name}' has ngrxType '${actualSymbol.ngrxMetadata?.type}', expected '${expectedSymbol.ngrxType}'`);
          failed++;
          continue;
        }
        
        console.log(`  ✓ Symbol '${expectedSymbol.name}' (${expectedSymbol.kind})`);
        passed++;
      }
    } catch (error) {
      console.log(`  ✗ Test failed: ${error.message}`);
      failed++;
    }
    
    console.log('');
  }
  
  console.log(`\n${passed} assertions passed, ${failed} failed`);
  
  if (failed > 0) {
    process.exit(1);
  }
  
  console.log('\n✅ All NgRx createActionGroup tests passed!');
}

runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
