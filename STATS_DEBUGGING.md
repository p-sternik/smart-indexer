# Statistics Tracking - Debugging Enhancement

## Problem
The "Show Statistics" command was showing zeros for all values (Total Files: 0, Total Symbols: 0, etc.) even though indexing was running and processing files.

## Root Cause
The statistics were being tracked correctly in the `CacheManager`, but there was insufficient logging to diagnose where the issue was occurring. The lack of visibility made it difficult to identify if:
- Stats were not being updated during indexing
- Stats were being reset unexpectedly
- Stats were not being retrieved properly
- The client was not receiving the stats correctly

## Solution Implemented

### 1. Enhanced CacheManager Logging (`server/src/cache/cacheManager.ts`)

**Changes:**
- **`upsertFileIndex()`**: Added detailed before/after logging showing stats progression
  - Logs: `[CacheManager] File indexed: {uri} ({symbolCount} symbols) | Stats: {prevFiles}->{currFiles} files, {prevSymbols}->{currSymbols} symbols`
  - This allows tracking how each file affects the total counts

- **`getStats()`**: Added comprehensive logging when stats are requested
  - Logs all stat values with ISO timestamps
  - Format: `[CacheManager] getStats() called - returning: totalFiles=X, totalSymbols=Y, cacheHits=Z, cacheMisses=W, lastUpdate={ISO}`

- **`clear()`**: Added confirmation that stats were reset to zero
  - Logs: `[CacheManager] Cache cleared successfully - stats reset to zero`

### 2. Enhanced Storage Layer Logging (`server/src/cache/storage.ts`)

**Changes:**
- **`upsertFile()`**: Now logs total file count after each upsert
  - Logs: `[Storage] File upserted: {uri} | Total files in DB: {count}`
  - Helps verify database operations are working

- **`insertSymbols()`**: Now logs batch size and total symbol count after insert
  - Logs: `[Storage] Inserted {count} symbols | Total symbols in DB: {total}`
  - Confirms symbols are actually being written to the database

- **`getAllFiles()`**: Now logs how many files are returned
  - Logs: `[Storage] getAllFiles() called - returning {count} files`
  
- **`getAllSymbols()`**: Now logs how many symbols are returned
  - Logs: `[Storage] getAllSymbols() called - returning {count} symbols`

### 3. Enhanced Server Indexing Logs (`server/src/server.ts`)

**Changes:**
- **`indexFiles()`**: Added session-style logging with clear boundaries
  - Start: `[Server] ========== INDEXING START ==========`
  - Progress: `[Server] [X/Y] Indexing file: {path}`
  - File result: `[Server] [X/Y] Extracted {count} symbols from {path}`
  - End: `[Server] ========== INDEXING COMPLETE ==========`
  - Final stats: `[Server] Final stats: {files} files, {symbols} symbols in cache`

- **`onRequest('smart-indexer/getStats')`**: Added clear section headers
  - Logs: `[Server] ========== GET STATS REQUEST ==========`
  - Logs: `[Server] Returning stats to client: totalFiles=X, totalSymbols=Y, ...`

- **`onRequest('smart-indexer/rebuildIndex')`**: Added session boundaries
  - Start: `[Server] ========== REBUILD INDEX COMMAND ==========`
  - End: `[Server] ========== REBUILD COMPLETE ==========`
  - Final stats logged

### 4. Enhanced Client Command Logging (`src/extension.ts`)

**Changes:**
- **`showStats` command**: Added detailed logging of received stats
  - Logs: `[Client] ========== SHOW STATS COMMAND ==========`
  - Logs each stat value individually for easy reading
  - Logs the ISO timestamp for correlation

- **`rebuildIndex` command**: Added request/response logging
  - Logs: `[Client] ========== REBUILD INDEX COMMAND ==========`
  - Logs when sending the request and when receiving the response

## How to Debug

### 1. Open the Smart Indexer Output Channel
- In VS Code, go to: **View > Output**
- Select **"Smart Indexer"** from the dropdown

### 2. Trigger a Rebuild
- Open Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
- Run: **"Smart Indexer: Rebuild Index"**

### 3. Watch the Logs
You should see a sequence like:

```
[Client] ========== REBUILD INDEX COMMAND ==========
[Server] ========== REBUILD INDEX COMMAND ==========
[CacheManager] Cache cleared successfully - stats reset to zero
[Server] ========== INDEXING START ==========
[Server] [1/50] Indexing file: C:\path\to\file1.ts
[Storage] File upserted: C:\path\to\file1.ts | Total files in DB: 1
[Storage] Inserted 15 symbols | Total symbols in DB: 15
[CacheManager] File indexed: C:\path\to\file1.ts (15 symbols) | Stats: 0->1 files, 0->15 symbols
...
[Server] ========== INDEXING COMPLETE ==========
[Server] Final stats: 50 files, 850 symbols in cache
[Server] ========== REBUILD COMPLETE ==========
[Client] Index rebuild complete
```

### 4. Check Statistics
- Run: **"Smart Indexer: Show Statistics"**
- Check the logs:

```
[Client] ========== SHOW STATS COMMAND ==========
[Server] ========== GET STATS REQUEST ==========
[Storage] getAllFiles() called - returning 50 files
[Storage] getAllSymbols() called - returning 850 symbols
[CacheManager] getStats() called - returning: totalFiles=50, totalSymbols=850, ...
[Client] Stats received from server:
  - Total Files: 50
  - Total Symbols: 850
  - Cache Hits: 0
  - Cache Misses: 0
```

## What to Look For

### If stats are still showing zeros:

1. **Check if indexing is running:**
   - Look for `[Server] ========== INDEXING START ==========`
   - If missing, indexing never started

2. **Check if files are being found:**
   - Look for `[Server] File scanner discovered X indexable files`
   - If X is 0, check excludePatterns configuration

3. **Check if files are being indexed:**
   - Look for `[Server] [N/M] Indexing file:` messages
   - If missing, files were found but not processed

4. **Check if symbols are being extracted:**
   - Look for `[Server] Extracted X symbols from {file}`
   - If X is always 0, check file parsing

5. **Check if database is updating:**
   - Look for `[Storage] File upserted:` and `[Storage] Inserted X symbols`
   - If missing, database writes are failing

6. **Check if stats are being updated:**
   - Look for `[CacheManager] File indexed:` with changing totals
   - If totals aren't increasing, stats calculation is broken

7. **Check if stats are being returned:**
   - Look for `[Server] Returning stats to client:`
   - Compare values with what client receives

## Architecture

The statistics flow:
```
SymbolIndexer.indexFile()
    ↓
CacheManager.upsertFileIndex()
    ↓
Storage.upsertFile() + Storage.insertSymbols()
    ↓
CacheManager updates stats from Storage.getAllFiles() and Storage.getAllSymbols()
    ↓
Server onRequest('smart-indexer/getStats')
    ↓
CacheManager.getStats()
    ↓
Client receives stats and displays
```

Every step now has logging to trace the data flow.

## Configuration Check

Ensure your settings don't exclude all files:

```json
{
  "smartIndexer.excludePatterns": [
    "**/node_modules/**",
    "**/dist/**",
    "**/.git/**"
  ]
}
```

## Performance Note

The added logging in storage operations uses `COUNT(*)` queries which are fast in SQLite but add minimal overhead. This is acceptable for debugging. If needed for production, these verbose logs can be removed or reduced to debug-level only.
