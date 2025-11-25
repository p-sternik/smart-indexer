# Testing the New Index Architecture

This guide walks through testing the refactored clangd-inspired index architecture.

## Quick Verification

Run the automated verification script:

```powershell
.\verify-architecture.ps1
```

This checks:
- ✅ All new index modules compiled
- ✅ Configuration schema updated
- ✅ Old CacheManager removed from server
- ✅ New architecture properly integrated

## Manual Testing in VS Code

### 1. Build and Launch

```powershell
npm run build
```

Then press **F5** in VS Code to start the Extension Development Host.

### 2. Verify Background Indexing

1. Open the "Smart Indexer" output channel
2. Look for log messages:
   ```
   [Server] Background index initialized with 4 concurrent jobs
   [Server] Starting full workspace background indexing...
   [Server] File scanner discovered N indexable files
   [Server] Indexing N files in background...
   [Server] ========== BACKGROUND INDEXING COMPLETE ==========
   ```

### 3. Check Sharded Storage

Navigate to your workspace directory and verify:

```powershell
ls .smart-index/index/
```

You should see:
- Multiple `*.json` files (one per indexed source file)
- Each file is a shard containing symbols for one source file

Example shard content:
```json
{
  "uri": "C:\\path\\to\\file.ts",
  "hash": "abc123...",
  "symbols": [
    {
      "name": "MyClass",
      "kind": "class",
      "location": {
        "uri": "C:\\path\\to\\file.ts",
        "line": 5,
        "character": 13
      }
    }
  ],
  "lastIndexedAt": 1732532606613
}
```

### 4. Test Dynamic Index

1. Open a TypeScript file
2. Make a change (add a new function/class)
3. Check the output channel - should see:
   ```
   [Server] Document opened: <path>
   [Server] Document changed, updating dynamic index: <path>
   [Server] Dynamic index updated for: <path>
   ```
4. The new symbol should be immediately available for:
   - Go to Definition (F12)
   - Find References (Shift+F12)
   - Workspace Symbol Search (Ctrl+T)

### 5. Test Merged Index Queries

#### Test Go to Definition (F12)
1. Open a file with a class/function
2. Place cursor on the class/function name
3. Press F12
4. Should jump to definition (from dynamic or background index)

#### Test Find References (Shift+F12)
1. Place cursor on a symbol
2. Press Shift+F12
3. Should show all references (merged from both indices)

#### Test Workspace Symbol (Ctrl+T)
1. Press Ctrl+T
2. Type a symbol name or prefix
3. Should show symbols from both:
   - Open files (dynamic index)
   - Workspace files (background index)

### 6. Test Statistics Command

1. Open Command Palette (Ctrl+Shift+P)
2. Run: "Smart Indexer: Show Statistics"
3. Verify the message shows:
   ```
   **Smart Indexer Statistics**

   **Total**: X files, Y symbols, Z shards

   **Dynamic Index**: A files, B symbols
   **Background Index**: C files, D symbols

   **Cache Performance**:
   - Hits: ...
   - Misses: ...

   **Last Update**: ...
   ```

### 7. Test Rebuild Index

1. Run: "Smart Indexer: Rebuild Index"
2. Check output channel for:
   ```
   [Server] ========== REBUILD INDEX COMMAND ==========
   [Server] Background index cleared, starting full indexing...
   [Server] ========== BACKGROUND INDEXING START ==========
   [Server] ========== BACKGROUND INDEXING COMPLETE ==========
   ```
3. Verify `.smart-index/index/` directory is recreated with fresh shards

### 8. Test Incremental Indexing (Git Integration)

If your workspace is a git repository:

1. Make changes to a file
2. Commit the changes: `git commit -am "test"`
3. Reload VS Code window (Ctrl+Shift+P → "Reload Window")
4. Check output channel - should see:
   ```
   [Server] Git repository detected, performing incremental indexing...
   [Server] Current git hash: <new-hash>, cached hash: <old-hash>
   [Server] Git changes detected: X added, Y modified, Z deleted
   [Server] Indexing N changed files...
   ```
5. Only changed files should be re-indexed (not the entire workspace)

### 9. Test File Watching

If git HEAD changes while extension is running:

1. Make a commit in another terminal
2. Watch the output channel
3. Should see:
   ```
   [Server] Git HEAD changed, reindexing affected files...
   ```
4. Only affected files are re-indexed

### 10. Test Configuration Changes

1. Open Settings (Ctrl+,)
2. Search for "Smart Indexer"
3. Change "Max Concurrent Index Jobs" to 2
4. Check output channel:
   ```
   [Server] Configuration changed
   [Server] Configuration updated and applied
   ```
5. Next indexing operation should use 2 concurrent jobs

## Performance Testing

### Test Parallel Indexing

1. Clear cache: Run "Smart Indexer: Clear Cache"
2. Set `maxConcurrentIndexJobs` to 1
3. Rebuild index - note the time
4. Clear cache again
5. Set `maxConcurrentIndexJobs` to 8
6. Rebuild index - should be faster

### Test Memory Usage

1. Open a large workspace (e.g., 1000+ files)
2. Wait for background indexing to complete
3. Check Task Manager / Activity Monitor
4. Memory usage should be reasonable (not loading all symbols)
5. Open/close files - dynamic index should grow/shrink

### Test Incremental Performance

1. Start with a fully indexed workspace
2. Change one file
3. Reload window
4. Indexing should complete very quickly (only one file re-indexed)

## Debugging

### Check Logs

Output channel: "Smart Indexer"

Key log messages to look for:

**Initialization**:
- `[Server] ========== INITIALIZATION START ==========`
- `[Server] Background index initialized with N concurrent jobs`

**Indexing**:
- `[Server] ========== BACKGROUND INDEXING START ==========`
- `[Server] Indexing N files in background...`
- `[Server] ========== BACKGROUND INDEXING COMPLETE ==========`

**Dynamic Updates**:
- `[Server] Document opened: <path>`
- `[Server] Document changed, updating dynamic index: <path>`
- `[Server] Dynamic index updated for: <path>`

**Queries**:
- Check for errors in `onDefinition`, `onReferences`, `onWorkspaceSymbol`

### Common Issues

**Issue**: No shards created
- **Solution**: Check excludePatterns, verify files are TypeScript/JavaScript

**Issue**: Symbols not found
- **Solution**: Check that files are indexed (view stats), verify symbol names

**Issue**: Slow indexing
- **Solution**: Increase `maxConcurrentIndexJobs` (up to 16)

**Issue**: High memory usage
- **Solution**: Close unused files, reduce number of open editors

**Issue**: Stale results
- **Solution**: Run "Smart Indexer: Rebuild Index"

## Expected Behavior

### On First Run (No Cache)
1. Background index loads (no shards found)
2. Full workspace scan
3. All files indexed in parallel
4. Shards written to `.smart-index/index/`
5. Metadata saved

### On Subsequent Runs (With Cache)
1. Background index loads shard metadata
2. Compares current file hashes with cached hashes
3. Re-indexes only changed files
4. Updates shards incrementally

### On File Open/Edit
1. File added to dynamic index
2. Changes reflected immediately
3. No background index update (happens on close/git commit)

### On LSP Query
1. Query goes to merged index
2. Merged index checks dynamic first
3. Falls back to background (loads shard if needed)
4. Results deduplicated and returned

## Success Criteria

✅ Extension activates without errors
✅ Background indexing completes successfully
✅ Shard files created in `.smart-index/index/`
✅ Go to Definition works (F12)
✅ Find References works (Shift+F12)
✅ Workspace Symbol works (Ctrl+T)
✅ Statistics show correct counts
✅ Incremental indexing only processes changed files
✅ Dynamic index updates on file changes
✅ Build succeeds without errors
✅ No type errors
✅ No lint errors

All these criteria should be met for the refactoring to be considered successful.
