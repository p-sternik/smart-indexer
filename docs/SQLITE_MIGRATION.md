# SQLite Storage Migration Guide

## Overview

Smart Indexer has migrated from a fragmented file-based storage system to a single SQLite database using `sql.js` (WASM). This change solves file handle limit issues and improves startup performance.

## What Changed

### Before (File-Based Storage)
- **Storage Format**: One MessagePack (.bin) file per indexed source file
- **Directory Structure**: Nested hash-based directory structure (`.smart-index/index/XX/YY/filename.bin`)
- **Metadata**: Separate `summary.json` file for quick startup
- **Concurrency**: Per-URI mutex locks managed by `ShardPersistenceManager`
- **Write Strategy**: Buffered writes with 100ms coalescing window

### After (SQLite Storage)
- **Storage Format**: Single SQLite database file (`.smart-index/index.db`)
- **Schema**: Simple `files` table with URI as primary key
- **Data Format**: JSON-serialized `FileIndexData` objects
- **Concurrency**: Per-URI mutex locks managed by `SqlJsStorage`
- **Write Strategy**: In-memory WASM database with 2-second auto-save debouncing

## Benefits

1. **Solves File Handle Limits**: Single database file eliminates the "too many open files" error on large projects
2. **Faster Startup**: Single file read instead of scanning thousands of shard files
3. **Better Atomicity**: SQLite's ACID properties ensure data consistency
4. **Simpler Architecture**: No need for hash-based directory sharding logic
5. **Cross-Platform**: `sql.js` WASM works identically on all platforms

## Schema

```sql
CREATE TABLE IF NOT EXISTS files (
  uri TEXT PRIMARY KEY,
  json_data TEXT NOT NULL,      -- JSON-serialized FileIndexData
  updated_at INTEGER NOT NULL    -- Timestamp for tracking changes
);

CREATE INDEX IF NOT EXISTS idx_uri ON files(uri);
```

## API Compatibility

The storage backend change is **fully transparent** to consumers. Both `FileBasedStorage` and `SqlJsStorage` implement the same `IIndexStorage` interface, so no changes are needed in:

- `BackgroundIndex`
- `MergedIndex`
- `NgRxLinkResolver`
- Any other consumers of the storage layer

## Performance Characteristics

### File-Based Storage
- **Read**: O(1) - Direct file path calculation
- **Write**: Buffered with 100ms coalescing
- **Startup**: O(n) - Scan all shard files for metadata
- **Memory**: Minimal - Only metadata summary in memory

### SQLite Storage
- **Read**: O(1) - Indexed by URI
- **Write**: In-memory with 2-second auto-save
- **Startup**: O(1) - Single database load
- **Memory**: Higher - Entire database in WASM memory

## Migration

### Automatic Migration

The first time Smart Indexer starts with SQLite storage enabled:

1. If `.smart-index/index.db` doesn't exist, a new database is created
2. Old shard files in `.smart-index/index/` are **NOT** automatically migrated
3. The index will rebuild incrementally as files are opened/modified

### Manual Migration (Optional)

If you want to preserve the existing index, you can manually migrate:

```typescript
import { FileBasedStorage } from './storage/FileBasedStorage.js';
import { SqlJsStorage } from './storage/SqlJsStorage.js';

async function migrate(workspaceRoot: string) {
  const oldStorage = new FileBasedStorage();
  const newStorage = new SqlJsStorage();
  
  await oldStorage.init(workspaceRoot, '.smart-index');
  await newStorage.init(workspaceRoot, '.smart-index');
  
  // Get all files from old storage
  const fileUris = await oldStorage.collectAllFiles();
  
  console.log(`Migrating ${fileUris.length} files...`);
  
  for (const uri of fileUris) {
    const data = await oldStorage.getFile(uri);
    if (data) {
      await newStorage.storeFile(data);
    }
  }
  
  await newStorage.flush();
  console.log('Migration complete!');
}
```

### Cleanup Old Storage

After verifying the new SQLite storage works correctly, you can delete the old shard files:

```bash
# Remove old file-based shards (keep this backup until verified)
rm -rf .smart-index/index/
rm -f .smart-index/summary.json
```

## Configuration

No configuration changes are required. The storage backend is instantiated in `server.ts`:

```typescript
// Before
const storage = new FileBasedStorage(true, 100);

// After
const storage = new SqlJsStorage(2000); // 2-second auto-save
```

To adjust auto-save frequency:

```typescript
const storage = new SqlJsStorage(5000); // 5-second auto-save (less I/O, more potential data loss)
const storage = new SqlJsStorage(1000); // 1-second auto-save (more I/O, less data loss)
```

## Safety Features

### Auto-Save Mechanism

`SqlJsStorage` uses an in-memory database (WASM) with periodic flushes to disk:

- **Trigger**: Any write operation schedules an auto-save
- **Debouncing**: Multiple writes within the delay window are batched
- **Graceful Shutdown**: `dispose()` forces immediate flush

### Data Loss Prevention

1. **Automatic Flush on Exit**: `BackgroundIndex.dispose()` → `storage.dispose()` → `storage.flush()`
2. **Periodic Auto-Save**: Every 2 seconds (default) after write activity
3. **Manual Flush**: Call `await storage.flush()` for critical operations

### Concurrency Safety

Both storage implementations use per-URI mutex locks:

```typescript
await storage.withLock(uri, async () => {
  const data = await storage.getFileNoLock(uri);
  // ... modify data ...
  await storage.storeFileNoLock(data);
});
```

**Rule**: Always use `withLock()` for read-modify-write operations to prevent race conditions.

## Testing

The implementation includes comprehensive error handling:

1. ✅ Database initialization (create new or load existing)
2. ✅ Store and retrieve file data
3. ✅ Metadata operations (lightweight queries)
4. ✅ Batch operations (store multiple files)
5. ✅ Statistics (file count, symbol count, storage size)
6. ✅ Delete operations
7. ✅ Persistence (flush to disk)
8. ✅ Reload from disk (verify persistence)
9. ✅ Concurrency (mutex locks)
10. ✅ Graceful shutdown

## Rollback Plan

If you need to revert to file-based storage:

1. Edit `server/src/server.ts`:
   ```typescript
   // Change this:
   import { SqlJsStorage } from './storage/SqlJsStorage.js';
   const storage = new SqlJsStorage(2000);
   
   // Back to this:
   import { FileBasedStorage } from './storage/FileBasedStorage.js';
   const storage = new FileBasedStorage(true, 100);
   ```

2. Rebuild:
   ```bash
   npm run build
   ```

3. Restart VS Code

## Troubleshooting

### "Database file is locked"

**Cause**: Multiple LSP server instances accessing the same database.

**Solution**: Restart VS Code to ensure only one server instance is running.

### "Failed to initialize SQLite database"

**Cause**: `sql.js` WASM module failed to load.

**Solution**: Reinstall dependencies:
```bash
npm install sql.js
```

### High Memory Usage

**Cause**: SQLite database is entirely in WASM memory.

**Solution**: For very large projects (>10,000 files), consider using file-based storage or a native SQLite solution.

## Future Improvements

Potential enhancements to the SQLite storage:

1. **Compression**: Compress `json_data` column to reduce storage size
2. **Native SQLite**: Use `better-sqlite3` (Node.js native) instead of WASM for better performance
3. **Incremental Writes**: Write-ahead logging (WAL) mode for better concurrency
4. **Vacuum**: Periodic database vacuum to reclaim deleted space
5. **Query Optimization**: Add indexes for common query patterns

## References

- **Interface Definition**: `server/src/storage/IIndexStorage.ts`
- **SQLite Implementation**: `server/src/storage/SqlJsStorage.ts`
- **File-Based Implementation**: `server/src/storage/FileBasedStorage.ts`
- **Integration Point**: `server/src/server.ts` (lines 86-90)
- **sql.js Documentation**: https://github.com/sql-js/sql.js/
