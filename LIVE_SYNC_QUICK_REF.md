# Live Synchronization - Quick Reference

## Files Modified/Created

### New Files
- `server/src/index/fileWatcher.ts` - Main file watcher implementation

### Modified Files
- `server/src/index/backgroundIndex.ts` - Added `updateSingleFile()` method
- `server/src/server.ts` - Initialize and integrate FileWatcher
- `package.json` - Added `chokidar` dependency

## Key Classes & Methods

### FileWatcher

```typescript
class FileWatcher {
  // Initialize watcher
  async init(): Promise<void>
  
  // Update debounce delay
  setDebounceDelay(delayMs: number): void
  
  // Get statistics
  getStats(): { pendingDebounces, activeIndexing, debounceDelayMs }
  
  // Cleanup
  async dispose(): Promise<void>
}
```

### BackgroundIndex

```typescript
class BackgroundIndex {
  // New: Update single file (live sync)
  async updateSingleFile(filePath: string): Promise<void>
  
  // Existing: Remove file from index
  async removeFile(uri: string): Promise<void>
  
  // Existing: Batch update
  async updateFile(uri: string, result: IndexedFileResult): Promise<void>
}
```

## Data Flow

### On Document Change (Typing)

```
User types in VS Code
  ↓
documents.onDidChangeContent
  ↓
FileWatcher.scheduleReindex()
  ↓
[Wait 600ms - debounce]
  ↓
FileWatcher.reindexFile()
  ↓
BackgroundIndex.updateSingleFile()
  ↓
  1. cleanupFileFromIndexes() - Remove old entries
  2. workerPool.runTask() - Re-index file
  3. updateFile() - Merge new entries
  4. (In-memory only, no disk write)
```

### On File Save

```
User presses Ctrl+S
  ↓
documents.onDidSave
  ↓
Cancel pending debounce timer
  ↓
FileWatcher.reindexFile() (immediate)
  ↓
BackgroundIndex.updateSingleFile()
  ↓
  1. cleanupFileFromIndexes()
  2. workerPool.runTask()
  3. updateFile()
  4. saveShard() - Write to disk ✓
```

### On External Change (Git Pull)

```
git pull
  ↓
Chokidar detects file changes
  ↓
fsWatcher.on('change')
  ↓
FileWatcher.scheduleReindex()
  ↓
[Wait 600ms - debounce]
  ↓
Same as document change...
```

### On File Deletion

```
User deletes file / git operation
  ↓
Chokidar detects deletion
  ↓
fsWatcher.on('unlink')
  ↓
FileWatcher.handleFileDeletion() (immediate, no debounce)
  ↓
BackgroundIndex.removeFile()
  ↓
  1. Remove from fileMetadata
  2. Remove from symbolNameIndex
  3. Remove from symbolIdIndex
  4. Remove from referenceMap
  5. deleteShard() - Remove from disk
```

## Configuration

### Default Settings

```typescript
const DEBOUNCE_DELAY_MS = 600;
const SUPPORTED_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp'
];
```

### Chokidar Exclusions

```typescript
ignored: [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/.smart-index/**'
]
```

### Tuning Parameters

| Parameter | Default | Fast Machine | Slow Machine | Large Files |
|-----------|---------|--------------|--------------|-------------|
| debounceDelayMs | 600ms | 400ms | 1000ms | 1500ms |
| awaitWriteFinish | 300ms | 200ms | 500ms | 500ms |

## Debugging

### Enable Verbose Logging

All log statements use `connection.console.info()` and can be viewed in:
- **VS Code**: Output → Smart Indexer Language Server

### Key Log Messages

```
[FileWatcher] Initializing file watcher...
[FileWatcher] External file system watcher (chokidar) initialized
[FileWatcher] File watcher initialized with 600ms debounce delay

[FileWatcher] External change detected: /path/to/file.ts
[FileWatcher] File saved: /path/to/file.ts
[FileWatcher] File deleted: /path/to/file.ts

[FileWatcher] Debounce timer fired for file.ts (trigger: document-change)
[FileWatcher] Re-indexed file.ts in 35ms (trigger: document-change)
[FileWatcher] Removed deleted file from index: file.ts

[FileWatcher] Skipping re-index of file.ts - already in progress
```

### Stats API

```typescript
const stats = fileWatcher.getStats();
console.log({
  pendingDebounces: stats.pendingDebounces,  // How many files waiting
  activeIndexing: stats.activeIndexing,      // How many being indexed
  debounceDelayMs: stats.debounceDelayMs     // Current delay
});
```

## Performance Metrics

### Expected Timings

| Operation | Expected Time |
|-----------|--------------|
| Schedule re-index | < 1ms |
| Debounce timer fire | 600ms (configurable) |
| Re-index small file | 10-30ms |
| Re-index large file | 50-200ms |
| Handle deletion | 5-10ms |
| Persist shard | 5-20ms |

### Memory Usage

| Component | Per File | 1000 Files |
|-----------|----------|------------|
| Debounce timer | ~100 bytes | ~100 KB |
| Indexing tracker | ~50 bytes | ~50 KB |
| **Total overhead** | ~150 bytes | ~150 KB |

## Testing Checklist

- [ ] Create new file → Wait 1s → Search → Found ✓
- [ ] Modify existing file → Wait 1s → "Go to Def" → Works ✓
- [ ] Delete file → Immediately search → Not found ✓
- [ ] Add import → Wait 1s → "Go to Def" on import → Works ✓
- [ ] Git pull → Wait 2s → Search new symbols → Found ✓
- [ ] Rapid typing → UI remains responsive ✓
- [ ] Multiple files simultaneously → All indexed ✓
- [ ] External editor change → Detected and indexed ✓

## Common Issues & Solutions

### Issue: Index not updating

**Check**:
1. Is file excluded? → Check `configManager.shouldExcludePath()`
2. Is debounce too long? → Reduce to 400ms
3. Is worker pool saturated? → Check active indexing count

### Issue: High CPU usage

**Solution**:
1. Increase debounce delay to 1000ms
2. Reduce worker pool size
3. Exclude more patterns

### Issue: External changes not detected

**Check**:
1. Is chokidar initialized? → Check logs
2. Is file in workspace? → Verify path
3. Is file ignored? → Check chokidar `ignored` patterns

## Integration Points

### Existing Dynamic Index

The FileWatcher **complements** the existing DynamicIndex:

- **DynamicIndex**: Handles open documents in-memory (onDidChangeContent)
- **FileWatcher**: Updates BackgroundIndex (persistent, all files)
- **MergedIndex**: Combines both for queries

### Git Integration

FileWatcher works **alongside** GitWatcher:

- **GitWatcher**: Bulk changes on git operations (branch switch, pull)
- **FileWatcher**: Incremental changes during development
- Both update the same BackgroundIndex

## Migration Notes

### No Breaking Changes

- Existing functionality unchanged
- FileWatcher is additive
- Can be disabled by not initializing it

### Backward Compatibility

- Old shards are still valid
- No cache format changes
- No configuration changes required

## Next Steps

1. **Test thoroughly** in your workspace
2. **Monitor performance** using stats API
3. **Tune debounce delay** based on your machine/files
4. **Report issues** with detailed logs

## Summary

✅ **What it does**: Automatically re-indexes files as you edit them  
✅ **How**: Per-file debouncing + worker pool + smart cleanup  
✅ **Performance**: < 1s latency, < 150KB memory overhead  
✅ **Compatibility**: Works with existing indexes, no migration needed  
✅ **Monitoring**: Built-in stats and verbose logging  
