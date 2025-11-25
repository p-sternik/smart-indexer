# Index Architecture

This document describes the clangd-inspired index architecture implemented in Smart Indexer.

## Overview

The indexing system follows the design principles of clangd's index architecture, with three main components:

1. **Dynamic Index** - Fast in-memory index for open/edited files
2. **Background Index** - Persistent sharded index for the workspace
3. **Merged Index** - Unified view combining both indices

## Components

### ISymbolIndex Interface

Core abstraction for all index implementations:

```typescript
interface ISymbolIndex {
  findDefinitions(name: string): Promise<IndexedSymbol[]>;
  findReferences(name: string): Promise<IndexedSymbol[]>;
  searchSymbols(query: string, limit: number): Promise<IndexedSymbol[]>;
  getFileSymbols(uri: string): Promise<IndexedSymbol[]>;
}
```

### Dynamic Index

**Location**: `server/src/index/dynamicIndex.ts`

**Purpose**: Maintains symbols for currently open files in memory.

**Key Features**:
- Instant updates on file changes
- No disk I/O overhead
- Automatically updated by text document events
- Takes priority over background index

**Operations**:
- `updateFile(uri, content?)` - Index an open file
- `removeFile(uri)` - Remove a closed file
- All ISymbolIndex query methods

### Background Index

**Location**: `server/src/index/backgroundIndex.ts`

**Purpose**: Persistent index for the entire workspace.

**Key Features**:
- **Sharded storage**: One JSON file per source file in `.smart-index/index/`
- **Incremental updates**: Only re-indexes changed files (via content hash)
- **Lazy loading**: Loads shards from disk only when needed
- **Parallel indexing**: Configurable worker pool (default 4 concurrent jobs)
- **Lightweight memory**: Keeps only metadata + symbol name→URI mapping in RAM

**Storage Layout**:
```
.smart-index/
  ├── index/
  │   ├── <hash-of-uri-1>.json  (shard for file 1)
  │   ├── <hash-of-uri-2>.json  (shard for file 2)
  │   └── ...
  └── metadata.json  (git hash, timestamps)
```

**Shard Format**:
```json
{
  "uri": "/path/to/file.ts",
  "hash": "sha256-content-hash",
  "symbols": [...],
  "lastIndexedAt": 1234567890
}
```

**Operations**:
- `init(workspaceRoot, cacheDirectory)` - Initialize and load metadata
- `ensureUpToDate(files, computeHash, onProgress?)` - Incremental indexing
- `updateFile(uri, result)` - Update a single file shard
- `removeFile(uri)` - Delete a file shard
- `clear()` - Remove all shards

### Merged Index

**Location**: `server/src/index/mergedIndex.ts`

**Purpose**: Combines dynamic and background indices with prioritization.

**Key Features**:
- Queries dynamic index first (open files always fresh)
- Merges with background index results
- Deduplicates by (name, uri, line, character)
- Provides single unified interface to LSP handlers

**Priority Order**:
1. Dynamic index (open files)
2. Background index (workspace files)

### Stats Manager

**Location**: `server/src/index/statsManager.ts`

**Purpose**: Tracks and aggregates statistics from all indices.

**Metrics**:
- Total files and symbols (combined)
- Dynamic index stats (files, symbols)
- Background index stats (files, symbols, shards)
- Cache hits/misses
- Last full/incremental index time

## Configuration

New settings in `package.json`:

```json
{
  "smartIndexer.maxConcurrentIndexJobs": {
    "type": "number",
    "default": 4,
    "description": "Maximum number of parallel indexing jobs (1-16)"
  },
  "smartIndexer.enableBackgroundIndex": {
    "type": "boolean",
    "default": true,
    "description": "Enable background indexing of the entire workspace"
  }
}
```

## Indexing Flow

### Initial Indexing (on startup)

1. Initialize background index (load shard metadata)
2. If Git enabled and repository detected:
   - Load last git hash from metadata
   - Compare with current hash
   - Index only changed/new files (incremental)
3. Otherwise:
   - Scan workspace for all files
   - Index files not in cache (full)

### File Change Events

**Open/Edit File**:
1. Update dynamic index immediately
2. Debounced update (500ms)
3. Stats refreshed

**Close File**:
1. Remove from dynamic index
2. Background index still has the data (persistent)

**Git HEAD Change**:
1. Detect added/modified/deleted files
2. Update background index
3. Save new git hash to metadata

### LSP Request Handling

All LSP handlers (`onDefinition`, `onReferences`, `onWorkspaceSymbol`, `onCompletion`) use **only the merged index**:

```typescript
const symbols = await mergedIndex.findDefinitions(word);
```

The merged index automatically:
- Checks dynamic index first
- Falls back to background index
- Deduplicates results

## Performance

### Memory Usage

- **Dynamic Index**: O(open files × symbols per file)
- **Background Index**: O(total files × metadata) + lazy shard loading
- **Total**: Minimal - only metadata + open files in RAM

### Disk I/O

- **Shard writes**: Batched per file (only on changes)
- **Shard reads**: Lazy (only when symbols are queried)
- **No centralized DB**: Each file is independent

### Parallelization

- Background indexing uses configurable worker pool
- Default: 4 concurrent jobs
- Configurable: 1-16 via `maxConcurrentIndexJobs`

## Migration from Old Architecture

The old `CacheManager` and `SqlJsStorage` are **no longer used** by the server.

**Before**:
- Single SQLite database with all symbols
- Full in-memory symbol cache
- Sequential indexing

**After**:
- Sharded JSON files (one per source file)
- Lightweight in-memory metadata
- Parallel indexing with worker pool
- Separate dynamic/background indices

## Benefits

1. **Scalability**: Sharded storage scales to large workspaces
2. **Incremental**: Only re-indexes changed files
3. **Fast**: Open files are always fresh (dynamic index)
4. **Parallel**: Multiple files indexed concurrently
5. **Persistent**: Full cache survives restarts
6. **Efficient**: Lazy loading + minimal memory footprint

## Future Enhancements

- [ ] Snapshot/static index for prebuilt indices
- [ ] Better symbol deduplication across files
- [ ] Index compression for large workspaces
- [ ] Cross-file reference tracking
- [ ] Incremental AST parsing
