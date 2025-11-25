# Index Module

This directory contains the core indexing architecture, inspired by clangd's index design.

## Components

### `ISymbolIndex.ts`
Core interface that all index implementations must follow.

### `dynamicIndex.ts`
In-memory index for currently open/edited files.
- Updates instantly on file changes
- No disk I/O
- Automatically managed by text document events

### `backgroundIndex.ts`
Persistent sharded index for the entire workspace.
- One JSON shard per file in `.smart-index/index/`
- Lazy loading (shards loaded only when queried)
- Incremental updates (content hash-based)
- Parallel indexing with worker pool

### `mergedIndex.ts`
Combines dynamic and background indices.
- Queries dynamic index first (priority)
- Merges with background index
- Deduplicates results
- Used by all LSP handlers

### `statsManager.ts`
Tracks metrics from all indices.
- Aggregates statistics
- Records indexing events
- Provides unified stats view

## Usage

```typescript
import { DynamicIndex, BackgroundIndex, MergedIndex, StatsManager } from './index/index.js';

// Create indices
const dynamic = new DynamicIndex(symbolIndexer);
const background = new BackgroundIndex(symbolIndexer, 4);
const merged = new MergedIndex(dynamic, background);
const stats = new StatsManager();

// Initialize
await background.init(workspaceRoot, '.smart-index');

// Query (use merged index for all LSP requests)
const symbols = await merged.findDefinitions('MyClass');

// Update (on file changes)
await dynamic.updateFile(uri, content);

// Stats
stats.updateDynamicStats(dynamic.getStats().files, dynamic.getStats().symbols);
```

## Design Principles

1. **Interface-based**: All indices implement `ISymbolIndex`
2. **Single Responsibility**: Each index type has one job
3. **Lazy Loading**: Load data only when needed
4. **Incremental**: Only process changes
5. **Parallel**: Use worker pools for speed
6. **Persistent**: Full cache on disk

## See Also

- `../../../INDEX_ARCHITECTURE.md` - Detailed architecture documentation
- `../../../QUICK_REFERENCE.md` - API reference
- `../../../ARCHITECTURE_DIAGRAMS.md` - Visual diagrams
