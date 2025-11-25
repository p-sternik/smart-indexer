# Migration from better-sqlite3 to sql.js

## Summary

The Smart Indexer extension has been successfully migrated from `better-sqlite3` (a native Node.js module) to `sql.js` (a pure WebAssembly implementation of SQLite). This migration eliminates NODE_MODULE_VERSION mismatch errors and other ABI compatibility issues that occur in VS Code's Electron environment.

## Why the Migration?

### Problems with better-sqlite3
- **Native Dependency**: Requires compilation for specific Node.js versions and architectures
- **ABI Mismatches**: VS Code's Electron runtime can have different Node.js versions than the one used to compile the native module
- **Build Complexity**: Required electron-rebuild or similar tools
- **Cross-Platform Issues**: Different binaries needed for Windows, macOS, Linux

### Benefits of sql.js
- **No Native Dependencies**: Pure JavaScript/WebAssembly implementation
- **Universal Compatibility**: Works in any Node.js/Electron environment
- **No Compilation**: No need for native module rebuilding
- **Portable**: Same binary works across all platforms

## Technical Changes

### Storage Implementation

**Before (better-sqlite3):**
```typescript
import Database from 'better-sqlite3';

this.db = new Database(dbPath);
this.db.pragma('journal_mode = WAL');
// Synchronous operations
const result = this.db.prepare('SELECT * FROM files').all();
```

**After (sql.js):**
```typescript
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';

const SQL = await initSqlJs({ locateFile: ... });
this.db = new SQL.Database(buffer);
// Synchronous operations wrapped in async methods
const result = this.db.exec('SELECT * FROM files');
// Periodic disk persistence
await this.saveToDisk();
```

### Key Differences

1. **In-Memory Database**: sql.js keeps the database in memory and requires manual persistence to disk
2. **Async Initialization**: Database initialization is now asynchronous
3. **WASM Loading**: Requires locating and loading the sql-wasm.wasm file
4. **Manual Saves**: Changes are batched and saved to disk periodically (every 2 seconds)
5. **No WAL Mode**: sql.js doesn't support WAL mode, but this is acceptable for our use case

### File Structure

- `server/src/cache/sqlJsStorage.ts` - New storage implementation
- `server/src/cache/cacheManager.ts` - Updated to use SqlJsStorage
- Database file: `.smart-index/index.sqlite` (was `index.db`)

## API Compatibility

The public API of `CacheManager` remains unchanged:

```typescript
interface CacheManager {
  init(workspaceRoot: string, cacheDir: string, maxCacheSizeBytes?: number): Promise<void>;
  upsertFileIndex(result: IndexedFileResult): Promise<void>;
  removeFile(uri: string): Promise<void>;
  findSymbolsByName(name: string): Promise<IndexedSymbol[]>;
  findSymbolsByPrefix(prefix: string, limit: number): Promise<IndexedSymbol[]>;
  getStats(): IndexStats;
  clear(): Promise<void>;
  close(): Promise<void>;
}
```

## Performance Considerations

### Advantages
- Fast in-memory operations (same as before)
- Batched disk writes reduce I/O overhead
- No context switching between JavaScript and native code

### Trade-offs
- Slightly higher memory usage (entire database in memory)
- Periodic saves instead of immediate persistence
- No concurrent access (not needed for our use case)

## Migration Path for Users

**Users do not need to do anything.** The migration is transparent:

1. Extension will continue to work with existing cache
2. Database will be automatically migrated on first load
3. If any issues occur, the cache is simply rebuilt from scratch

### Manual Migration (if needed)

If you want to start fresh:

1. Run command: **Smart Indexer: Clear Cache**
2. Run command: **Smart Indexer: Rebuild Index**

## Testing Checklist

- ✅ Build succeeds without errors
- ✅ No native module dependencies in package.json
- ✅ Extension loads without NODE_MODULE_VERSION errors
- ✅ Cache persists between VS Code restarts
- ✅ Symbol indexing works correctly
- ✅ Statistics are accurate
- ✅ All commands function properly

## Rollback Plan

If issues are encountered, the old `better-sqlite3` implementation can be restored from git history. However, this would reintroduce the native dependency issues.

## Future Improvements

Potential enhancements to consider:

1. **Compression**: Compress the database file on disk
2. **Incremental Saves**: Save only changed data instead of entire database
3. **Background Saves**: Use worker threads for non-blocking saves
4. **Cache Partitioning**: Split large databases into smaller chunks

## Dependencies

### Added
- `sql.js: ^1.10.3` - SQLite compiled to WebAssembly

### Removed
- `better-sqlite3` - Native SQLite bindings
- `@types/better-sqlite3` - TypeScript definitions

### Kept
- All other dependencies remain unchanged

## Files Changed

- ✅ `server/src/cache/sqlJsStorage.ts` - New storage implementation
- ✅ `server/src/cache/cacheManager.ts` - Uses SqlJsStorage
- ✅ `package.json` - Updated dependencies
- ✅ `IMPLEMENTATION.md` - Updated documentation
- ✅ `README.md` - Updated architecture description
- 🗑️ `server/src/cache/storage.ts.old` - Removed old implementation

## Conclusion

The migration to sql.js successfully eliminates all native dependencies while maintaining full functionality and performance. The extension now works reliably across all platforms and VS Code/Electron versions without build or compatibility issues.
