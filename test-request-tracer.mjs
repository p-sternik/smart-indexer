/**
 * Test script to demonstrate RequestTracer functionality.
 * Run with: node --loader ts-node/esm test-request-tracer.ts
 */

import { RequestTracer, IOTracker } from './server/src/utils/RequestTracer.js';
import { NullLogger } from './server/src/utils/Logger.js';

console.log('=== RequestTracer Forensic Diagnostics Test ===\n');

// Create logger and tracer
const logger = new NullLogger(); // Use console logger in real scenarios
const tracer = new RequestTracer(logger);

console.log('1. Testing Normal Operation (Healthy)');
console.log('─'.repeat(50));
{
  const startMem = tracer.captureMemory();
  const ioTracker = tracer.createIOTracker();
  
  // Simulate 10 cache hits, 2 misses
  for (let i = 0; i < 10; i++) {
    ioTracker.recordCacheHit();
  }
  ioTracker.recordCacheMiss(5);
  ioTracker.recordCacheMiss(8);
  
  const endMem = tracer.captureMemory();
  
  tracer.logTrace(
    'references',
    '/workspace/userService.ts',
    '45:12',
    startMem,
    endMem,
    ioTracker,
    150, // 150ms total
    25,  // 25 results
    { queuedTasks: 3 }
  );
}

console.log('\n2. Testing Disk I/O Bottleneck');
console.log('─'.repeat(50));
{
  const startMem = tracer.captureMemory();
  const ioTracker = tracer.createIOTracker();
  
  // Simulate heavy disk I/O: 2 hits, 15 misses
  ioTracker.recordCacheHit();
  ioTracker.recordCacheHit();
  for (let i = 0; i < 15; i++) {
    ioTracker.recordCacheMiss(30); // 30ms per miss
  }
  
  const endMem = tracer.captureMemory();
  
  tracer.logTrace(
    'definition',
    '/workspace/apiTypes.ts',
    '120:8',
    startMem,
    endMem,
    ioTracker,
    600, // 600ms total (450ms I/O = 75%)
    12,
    { queuedTasks: 5 }
  );
}

console.log('\n3. Testing Outlier Files');
console.log('─'.repeat(50));
{
  const startMem = tracer.captureMemory();
  const ioTracker = tracer.createIOTracker(10); // 10ms threshold
  
  // Simulate normal files
  ioTracker.recordFileProcessing('/workspace/utils.ts', 2);
  ioTracker.recordFileProcessing('/workspace/helpers.ts', 3);
  
  // Simulate outliers
  ioTracker.recordFileProcessing('/workspace/huge-schema.ts', 500);
  ioTracker.recordFileProcessing('/workspace/generated-types.d.ts', 150);
  ioTracker.recordFileProcessing('/workspace/legacy-api.ts', 80);
  
  ioTracker.recordCacheHit();
  ioTracker.recordCacheMiss(20);
  
  const endMem = tracer.captureMemory();
  
  tracer.logTrace(
    'references',
    '/workspace/productService.ts',
    '88:15',
    startMem,
    endMem,
    ioTracker,
    800,
    42,
    { queuedTasks: 8 }
  );
}

console.log('\n4. Testing Memory Spike');
console.log('─'.repeat(50));
{
  const startMem = 180; // Simulate 180MB heap
  const ioTracker = tracer.createIOTracker();
  
  ioTracker.recordCacheHit();
  ioTracker.recordCacheHit();
  ioTracker.recordCacheMiss(15);
  
  const endMem = 400; // Simulate spike to 400MB (+220MB)
  
  tracer.logTrace(
    'references',
    '/workspace/dataModel.ts',
    '200:5',
    startMem,
    endMem,
    ioTracker,
    350,
    500, // Large result set
    { queuedTasks: 2 }
  );
}

console.log('\n5. Testing Indexing Storm');
console.log('─'.repeat(50));
{
  // Simulate recent file save
  tracer.recordFileSave();
  
  // Wait 100ms to simulate storm scenario
  await new Promise(resolve => setTimeout(resolve, 100));
  
  const startMem = tracer.captureMemory();
  const ioTracker = tracer.createIOTracker();
  
  ioTracker.recordCacheHit();
  ioTracker.recordCacheMiss(10);
  
  const endMem = tracer.captureMemory();
  
  tracer.logTrace(
    'definition',
    '/workspace/controller.ts',
    '55:20',
    startMem,
    endMem,
    ioTracker,
    200,
    8,
    { queuedTasks: 30 } // High queue depth
  );
}

console.log('\n=== Test Complete ===');
console.log('\nInterpretation Guide:');
console.log('─'.repeat(50));
console.log('✅ Test 1: Normal operation - low I/O, low memory, low queue');
console.log('⚠️  Test 2: Disk bottleneck - 75% time in I/O');
console.log('⚠️  Test 3: Outlier files - specific files are slow');
console.log('⚠️  Test 4: Memory spike - large allocation causing GC');
console.log('⚠️  Test 5: Indexing storm - recent saves + high queue');
