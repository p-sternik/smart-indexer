# Quick Reference - Index Architecture

## Key Concepts

### Three Index Types

| Index | Purpose | Storage | Updates |
|-------|---------|---------|---------|
| **Dynamic** | Open files | In-memory | Instant |
| **Background** | Workspace | Disk shards | Async batch |
| **Merged** | Unified view | N/A | Combines both |

### Query Priority

```
LSP Query → Merged Index
              ├─ Dynamic Index (check first)
              └─ Background Index (fallback)
```

## File Locations

### Source Files
```
server/src/index/
  ├── ISymbolIndex.ts      # Core interface
  ├── dynamicIndex.ts      # Open files index
  ├── backgroundIndex.ts   # Workspace index
  ├── mergedIndex.ts       # Unified queries
  ├── statsManager.ts      # Metrics tracking
  └── index.ts             # Module exports
```

### Storage Layout
```
.smart-index/
  ├── index/               # Sharded symbol data
  │   ├── <hash1>.json     # Shard for file1
  │   ├── <hash2>.json     # Shard for file2
  │   └── ...
  └── metadata.json        # Git hash, timestamps
```

## Configuration

```json
{
  "smartIndexer.maxConcurrentIndexJobs": 4,  // 1-16 workers
  "smartIndexer.enableBackgroundIndex": true, // Toggle background indexing
  "smartIndexer.cacheDirectory": ".smart-index",
  "smartIndexer.enableGitIntegration": true,
  "smartIndexer.excludePatterns": ["**/node_modules/**"],
  "smartIndexer.maxFileSizeMB": 50,
  "smartIndexer.maxCacheSizeMB": 500
}
```

## API Reference

### ISymbolIndex Interface

```typescript
interface ISymbolIndex {
  findDefinitions(name: string): Promise<IndexedSymbol[]>;
  findReferences(name: string): Promise<IndexedSymbol[]>;
  searchSymbols(query: string, limit: number): Promise<IndexedSymbol[]>;
  getFileSymbols(uri: string): Promise<IndexedSymbol[]>;
}
```

### DynamicIndex

```typescript
class DynamicIndex implements ISymbolIndex {
  // Update file in dynamic index
  async updateFile(uri: string, content?: string): Promise<void>;
  
  // Remove file from dynamic index
  removeFile(uri: string): void;
  
  // Check if file is indexed
  hasFile(uri: string): boolean;
  
  // Get statistics
  getStats(): { files: number; symbols: number };
  
  // ISymbolIndex methods...
}
```

### BackgroundIndex

```typescript
class BackgroundIndex implements ISymbolIndex {
  // Initialize with workspace root
  async init(workspaceRoot: string, cacheDirectory: string): Promise<void>;
  
  // Update max concurrent jobs
  setMaxConcurrentJobs(max: number): void;
  
  // Update/add file to index
  async updateFile(uri: string, result: IndexedFileResult): Promise<void>;
  
  // Remove file and its shard
  async removeFile(uri: string): Promise<void>;
  
  // Check if shard is up-to-date
  async hasUpToDateShard(uri: string, hash: string): Promise<boolean>;
  
  // Incremental indexing
  async ensureUpToDate(
    allFiles: string[],
    computeHash: (uri: string) => Promise<string>,
    onProgress?: (current: number, total: number) => void
  ): Promise<void>;
  
  // Get all indexed URIs
  getAllFileUris(): string[];
  
  // Get statistics
  getStats(): { files: number; symbols: number; shards: number };
  
  // Clear all shards
  async clear(): Promise<void>;
  
  // ISymbolIndex methods...
}
```

### MergedIndex

```typescript
class MergedIndex implements ISymbolIndex {
  constructor(
    dynamicIndex: ISymbolIndex,
    backgroundIndex: ISymbolIndex
  );
  
  // ISymbolIndex methods automatically merge results
}
```

### StatsManager

```typescript
class StatsManager {
  updateDynamicStats(files: number, symbols: number): void;
  updateBackgroundStats(files: number, symbols: number, shards: number): void;
  recordCacheHit(): void;
  recordCacheMiss(): void;
  recordFullIndex(): void;
  recordIncrementalIndex(): void;
  getStats(): EnhancedIndexStats;
  reset(): void;
}
```

## Common Operations

### Initialize Index System
```typescript
// In server.ts
const dynamicIndex = new DynamicIndex(symbolIndexer);
const backgroundIndex = new BackgroundIndex(symbolIndexer, 4);
const mergedIndex = new MergedIndex(dynamicIndex, backgroundIndex);

await backgroundIndex.init(workspaceRoot, '.smart-index');
```

### Update Open File
```typescript
// On document open/change
await dynamicIndex.updateFile(uri, content);
updateStats();
```

### Query Symbols
```typescript
// All queries go through merged index
const symbols = await mergedIndex.findDefinitions('MyClass');
const refs = await mergedIndex.findReferences('myFunction');
const results = await mergedIndex.searchSymbols('prefix', 100);
```

### Background Indexing
```typescript
// Incremental indexing
const allFiles = await fileScanner.scanWorkspace(workspaceRoot);
await backgroundIndex.ensureUpToDate(
  allFiles,
  async (uri) => computeHash(uri),
  (current, total) => console.log(`${current}/${total}`)
);
```

### Clear Cache
```typescript
await backgroundIndex.clear();
statsManager.reset();
```

## Debugging Tips

### Enable Verbose Logging
Check "Smart Indexer" output channel in VS Code.

### Check Shard Files
```powershell
ls .smart-index/index/
# Should show <hash>.json files
```

### View Shard Content
```powershell
cat .smart-index/index/<some-hash>.json | jq
```

### Check Statistics
Run command: "Smart Indexer: Show Statistics"

### Monitor Indexing
Watch output channel during indexing:
- "BACKGROUND INDEXING START"
- "Indexing N files in background"
- "BACKGROUND INDEXING COMPLETE"

## Performance Tuning

### Increase Parallel Workers
```json
{
  "smartIndexer.maxConcurrentIndexJobs": 8  // For fast CPUs
}
```

### Disable Background Index (Testing Only)
```json
{
  "smartIndexer.enableBackgroundIndex": false
}
```

### Reduce Memory Usage
- Close unused files (clears from dynamic index)
- Reduce `maxConcurrentIndexJobs` (less RAM during indexing)

### Speed Up Indexing
- Increase `maxConcurrentIndexJobs` (more parallel workers)
- Add more patterns to `excludePatterns` (fewer files)
- Increase `maxFileSizeMB` threshold (index larger files)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No shards created | Check excludePatterns, file extensions |
| Symbols not found | Rebuild index, check file was indexed |
| Slow queries | Check shard count, may need optimization |
| High memory | Close files, reduce open editors |
| Stale results | Rebuild index or wait for incremental update |

## Key Files to Modify

### To change indexing behavior:
- `server/src/indexer/symbolIndexer.ts` - AST parsing and symbol extraction

### To change storage format:
- `server/src/index/backgroundIndex.ts` - Shard format and I/O

### To change query logic:
- `server/src/index/mergedIndex.ts` - How indices are combined

### To add new index type:
- Implement `ISymbolIndex`
- Add to `MergedIndex` constructor
- Wire up in `server.ts`

## Version History

- **v0.0.2** - Clangd-inspired architecture (current)
- **v0.0.1** - Initial SQLite-based implementation

---

**Quick Start**: `npm run build` → Press F5 → Open workspace → Check `.smart-index/index/`

**Documentation**: See `INDEX_ARCHITECTURE.md` for full details
