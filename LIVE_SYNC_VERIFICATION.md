# Live Sync Verification Guide

## Quick Verification Steps

### 1. Build and Start Extension

```bash
# Install dependencies
npm install

# Build the extension
npm run compile

# Press F5 in VS Code to launch Extension Development Host
```

### 2. Enable Verbose Logging

1. Open Command Palette (Ctrl+Shift+P)
2. Run: "Developer: Set Log Level"
3. Select "Debug" or "Trace"
4. Open Output panel (Ctrl+Shift+U)
5. Select "Smart Indexer Language Server" from dropdown

### 3. Test Scenarios

#### Scenario A: Create New Function

1. **Open** any `.ts` file in your workspace
2. **Type** the following:
   ```typescript
   export function myTestFunction() {
     return "Hello Live Sync!";
   }
   ```
3. **Wait** 1 second (debounce)
4. **Check logs** - should see:
   ```
   [FileWatcher] Debounce timer fired for yourFile.ts (trigger: document-change)
   [FileWatcher] Re-indexed yourFile.ts in XXms (trigger: document-change)
   ```
5. **Test**: Press Ctrl+Shift+P → "Go to Symbol in Workspace" → Type "myTestFunction"
6. **Expected**: Function appears in results ✓

#### Scenario B: Modify and Save

1. **Modify** the function:
   ```typescript
   export function myTestFunction() {
     return "Hello Live Sync UPDATED!";
   }
   ```
2. **Save** (Ctrl+S)
3. **Check logs** - should see:
   ```
   [FileWatcher] File saved: /path/to/yourFile.ts
   [FileWatcher] Re-indexed yourFile.ts in XXms (trigger: file-saved)
   ```
4. **Expected**: No debounce delay, immediate re-index ✓

#### Scenario C: Create New File

1. **Create** new file `test-live-sync.ts` in your workspace
2. **Add content**:
   ```typescript
   export class LiveSyncTestClass {
     testMethod() {
       console.log("Live sync works!");
     }
   }
   ```
3. **Save** file
4. **Check logs** - should see:
   ```
   [FileWatcher] File created: /path/to/test-live-sync.ts
   [FileWatcher] Debounce timer fired for test-live-sync.ts (trigger: file-created)
   ```
5. **Test**: Search for "LiveSyncTestClass" in workspace symbols
6. **Expected**: Class appears ✓

#### Scenario D: Delete File

1. **Delete** the `test-live-sync.ts` file
2. **Check logs** - should see:
   ```
   [FileWatcher] File deleted: /path/to/test-live-sync.ts
   [FileWatcher] Removed deleted file from index: test-live-sync.ts
   ```
3. **Test**: Search for "LiveSyncTestClass"
4. **Expected**: Class no longer appears (immediate removal) ✓

#### Scenario E: External Change (Git)

1. **Checkout** a different branch or pull changes:
   ```bash
   git stash
   git checkout other-branch
   git checkout -
   git stash pop
   ```
2. **Check logs** - should see multiple:
   ```
   [FileWatcher] External change detected: /path/to/file1.ts
   [FileWatcher] External change detected: /path/to/file2.ts
   [FileWatcher] Debounce timer fired for file1.ts (trigger: external-change)
   [FileWatcher] Debounce timer fired for file2.ts (trigger: external-change)
   ```
3. **Expected**: All changed files re-indexed ✓

#### Scenario F: Rapid Typing (Debounce Test)

1. **Open** any file
2. **Type rapidly** without pausing (add 5-10 lines quickly)
3. **Observe**: 
   - No log messages during typing
   - Only ONE debounce timer fires after you stop
4. **Expected**: 
   ```
   [FileWatcher] Debounce timer fired for file.ts (trigger: document-change)
   [FileWatcher] Re-indexed file.ts in XXms (trigger: document-change)
   ```
   (Only appears ONCE after you stop typing) ✓

### 4. Monitor Statistics

Add this to your test file:

```typescript
// In server.ts or create a custom command
connection.onRequest('smart-indexer/getFileWatcherStats', async () => {
  if (fileWatcher) {
    return fileWatcher.getStats();
  }
  return null;
});
```

Then call from client:

```typescript
const stats = await client.sendRequest('smart-indexer/getFileWatcherStats');
console.log('FileWatcher Stats:', stats);
// Output:
// {
//   pendingDebounces: 2,      // 2 files waiting to be indexed
//   activeIndexing: 1,        // 1 file currently being indexed
//   debounceDelayMs: 600      // 600ms delay
// }
```

### 5. Performance Checks

#### Check A: Memory Usage

1. **Before**: Note VS Code's memory usage (Task Manager / Activity Monitor)
2. **Edit** 50 files rapidly
3. **After**: Memory should increase by < 10MB
4. **Expected**: No memory leak ✓

#### Check B: CPU Usage

1. **Monitor** CPU usage while editing
2. **Type** in a file continuously
3. **Expected**: CPU spikes only AFTER you stop typing (debounce fires) ✓

#### Check C: Latency

1. **Type** a new function
2. **Stop** typing
3. **Start timer**
4. **Wait** for log message "Re-indexed..."
5. **Check timer**: Should be ~600-650ms
6. **Expected**: Latency ≈ debounce delay ✓

### 6. Edge Cases

#### Edge Case A: Very Large File (> 1MB)

1. **Create** large file (or open existing)
2. **Modify** it
3. **Check**: Should still index, but may take longer
4. **Expected**: Works but logs might show 200-500ms indexing time ✓

#### Edge Case B: Excluded File

1. **Create** file in `node_modules/` or `dist/`
2. **Modify** it
3. **Check logs**: Should NOT see any FileWatcher messages
4. **Expected**: Excluded files are ignored ✓

#### Edge Case C: Multiple Simultaneous Edits

1. **Open** 3 files side-by-side
2. **Edit** all 3 rapidly (switch between them)
3. **Wait** 1 second
4. **Check logs**: Should see 3 separate re-index operations
5. **Expected**: All 3 files indexed independently ✓

## Troubleshooting Verification

### Problem: No log messages appear

**Solution**:
1. Check Output panel is set to "Smart Indexer Language Server"
2. Check log level is set to "Info" or "Debug"
3. Verify extension is running (check status bar)

### Problem: "Module 'chokidar' not found"

**Solution**:
```bash
npm install
npm run compile
```

### Problem: Changes not detected immediately

**Expected behavior**: 
- Document changes: 600ms delay (debounce)
- File saves: Immediate
- External changes: 600ms delay

If longer than 2 seconds, check:
1. Worker pool size (should be 4+)
2. System resources (CPU/memory)
3. File size (very large files take longer)

## Success Criteria

✅ **All scenarios pass**  
✅ **Latency < 1 second**  
✅ **No memory leaks**  
✅ **CPU usage normal**  
✅ **Logs appear as expected**  
✅ **Edge cases handled**  

## Report Issues

If verification fails, include:

1. **Scenario** that failed
2. **Expected** behavior
3. **Actual** behavior
4. **Logs** from Output panel
5. **File size** and type
6. **System specs** (OS, CPU, RAM)

## Next Steps After Verification

1. ✅ Verify all scenarios pass
2. ✅ Run in real workspace for 1 day
3. ✅ Monitor performance metrics
4. ✅ Tune debounce delay if needed
5. ✅ Report any issues found
6. ✅ Consider it production-ready
