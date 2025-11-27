# Smart Indexer - Quick Architecture Reference

> **TL;DR** for `SMART_INDEXER_CONTEXT.md`

## Core Architecture (5-Minute Read)

### Threading Model
- **Workers:** 3-7 threads (cpu_count - 1)
- **Queue:** FIFO, automatic dispatch
- **Script:** `server/src/indexer/worker.ts`
- **Parser:** `@typescript-eslint/typescript-estree` (NOT TypeScript Compiler API)

### Storage
```
.smart-index/index/<hash[0:2]>/<hash[2:4]>/<full_hash>.json
```
- **Hash-based** nested directories (filesystem performance)
- **One shard per file** (granular invalidation)
- **Lazy loading** (never all in memory)

### Caching
```typescript
needsReindexing(uri) {
  if (fs.statSync(uri).mtimeMs === shard.mtime) {
    return false; // ✅ CACHE HIT (0.1ms)
  }
  return true; // Re-index needed
}
```

### Exclusions
**Hardcoded:**
- `/.angular/`, `/.nx/`, `/dist/`, `/node_modules/`, `/coverage/`

**Applied:**
- Before indexing queue (BackgroundIndex)
- In file watcher (chokidar)

## Key Components

| Component | Purpose | Technology |
|-----------|---------|------------|
| `worker.ts` | Parse files → symbols/refs | typescript-estree AST |
| `backgroundIndex.ts` | Persistent sharded index | Hash-based nested dirs |
| `fileWatcher.ts` | Live sync (600ms debounce) | LSP + chokidar |
| `workerPool.ts` | Parallel indexing | Node.js worker_threads |
| `HybridDefinitionProvider` | Deduplicate TS + Smart | ±2 line near-duplicate |

## Critical Data Structures

### IndexedSymbol (Definition)
```typescript
{
  id: "hash_based_stable_id",
  name: "createAction",
  kind: "function" | "class" | "method" | "property" | ...,
  location: { uri, line, character },
  containerName: "MyClass",
  parametersCount: 2  // For overloads
}
```

### IndexedReference (Usage)
```typescript
{
  symbolName: "createAction",
  location: { uri, line, character },
  isLocal: false,
  scopeId: "MyClass::myMethod"
}
```

### Inverted Index (Fast Lookup)
```typescript
referenceMap: Map<string, Set<string>>
// Example: 'createAction' → Set(['/file1.ts', '/file2.ts'])
```

## Recent Fixes (2025-11-27)

**Problem:** Method declarations appeared in "Find References"
```typescript
public createSigningStepStart() {  // ❌ Was returned as reference
  this.store.dispatch(Actions.createSigningStepStart()); // ✅ True reference
}
```

**Solution:** Parent-aware AST traversal
```typescript
function isDeclarationContext(node, parent) {
  if (parent.type === 'MethodDefinition' && parent.key === node) {
    return true; // Skip adding to references
  }
}
```

## Feature Status

| Feature | Status |
|---------|--------|
| Worker Pool | ✅ IMPLEMENTED |
| Incremental (mtime) | ✅ IMPLEMENTED |
| Live Sync (debounce) | ✅ IMPLEMENTED |
| Deduplication | ✅ IMPLEMENTED |
| Declaration Filter | ✅ IMPLEMENTED (recent) |
| NgRx Patterns | ❌ MISSING |
| Type Inference | ❌ MISSING |

## Performance

| Operation | Time |
|-----------|------|
| Initial index (10k files) | 20-60s |
| Single file update | 5-50ms |
| Cache hit | 0.1ms |
| Find definitions | 5-20ms |
| Find references | 2-5ms |

## Common Pitfalls

❌ **DON'T:**
- Index build artifacts (`.angular/`, `dist/`)
- Use TS Compiler API in workers (too heavy)
- Skip mtime storage (breaks incremental)
- Add declarations to references (fixed!)

✅ **DO:**
- Use mtime checks for cache
- Load shards lazily
- Pass parent in AST traversal
- Apply exclusions early
- Debounce file changes (600ms)

## Configuration Essentials

```json
{
  "smartIndexer.mode": "hybrid",  // Merge TS + Smart
  "smartIndexer.maxConcurrentIndexJobs": 4,
  "smartIndexer.excludePatterns": [
    "**/node_modules/**",
    "**/.angular/**",
    "**/dist/**"
  ]
}
```

## Entry Points for Development

**Want to modify:**
- **Symbol extraction?** → `server/src/indexer/worker.ts` (traverseAST)
- **Cache strategy?** → `server/src/index/backgroundIndex.ts` (needsReindexing)
- **Live sync?** → `server/src/index/fileWatcher.ts` (scheduleReindex)
- **Deduplication?** → `src/providers/HybridDefinitionProvider.ts`
- **Exclusions?** → `server/src/config/configurationManager.ts`

## Testing

**Verify parser improvements:**
```powershell
.\verify-parser-improvements.ps1
```

**Full build:**
```bash
npm run compile
```

## Next Steps for AI Prompts

**Always reference:**
- `docs/SMART_INDEXER_CONTEXT.md` (full architecture)
- Existing implementation before suggesting changes
- Hardcoded exclusions list
- Worker pool size limits (1-16)
- Shard version compatibility

**Never suggest:**
- Complete rewrites (use surgical changes)
- Changing core AST parser library
- Removing mtime-based caching
- Synchronous indexing (workers required)

---

**For full details, see:** `docs/SMART_INDEXER_CONTEXT.md`
