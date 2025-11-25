# Smart Indexer Architecture Diagrams

## System Architecture

### High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         VS Code Client                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Commands    │  │  Settings    │  │  UI/Status   │          │
│  │  - Rebuild   │  │  - Config    │  │  - StatusBar │          │
│  │  - Clear     │  │  - Workers   │  │  - Progress  │          │
│  │  - Stats     │  │  - Git Mode  │  │  - Messages  │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                  │                   │
│         └─────────────────┴──────────────────┘                   │
│                           │                                       │
│                           │ Language Client Protocol (LSP)       │
└───────────────────────────┼───────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Language Server (Node.js)                     │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    LSP Request Handlers                     │ │
│  │  • onDefinition  • onReferences  • onWorkspaceSymbol       │ │
│  │  • onCompletion  • onDidOpen     • onDidChange             │ │
│  └───────────────────────────┬────────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                      Merged Index                           │ │
│  │  • Combines dynamic + background indices                    │ │
│  │  • Deduplicates results                                     │ │
│  │  • Dynamic index has priority                               │ │
│  └────────┬────────────────────────────┬─────────────────────┘ │
│           │                            │                         │
│           ▼                            ▼                         │
│  ┌─────────────────┐         ┌──────────────────────────────┐  │
│  │ Dynamic Index   │         │    Background Index          │  │
│  ├─────────────────┤         ├──────────────────────────────┤  │
│  │ • Open files    │         │ • Workspace files            │  │
│  │ • In-memory     │         │ • Sharded storage            │  │
│  │ • Fast updates  │         │ • Parallel indexing          │  │
│  │ • Temporary     │         │ • Persistent cache           │  │
│  └─────────────────┘         └──────────────────────────────┘  │
│                                       │                          │
│                                       ▼                          │
│                              ┌────────────────────────────────┐ │
│                              │   Disk Storage (Shards)        │ │
│                              │   .smart-index/index/*.json    │ │
│                              └────────────────────────────────┘ │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                     Support Components                      │ │
│  │  • SymbolIndexer  • FileScanner  • GitWatcher              │ │
│  │  • ConfigManager  • StatsManager                           │ │
│  └────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

## Data Flow Diagrams

### 1. LSP Query Flow (e.g., Go to Definition)

```
User presses F12
       │
       ▼
┌─────────────────┐
│  LSP Handler    │  Extract word at cursor
│  onDefinition   │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────┐
│      Merged Index               │
│  findDefinitions(word)          │
└───┬─────────────────────────┬───┘
    │                         │
    ▼                         ▼
┌──────────────┐      ┌──────────────────┐
│Dynamic Index │      │ Background Index │
│ Query in-mem │      │ Load shard(s)    │
│ symbols      │      │ from disk        │
└──────┬───────┘      └────────┬─────────┘
       │                       │
       ├───────────┬───────────┤
       ▼           ▼           ▼
    Results from  Results from  Merge &
    dynamic       background    deduplicate
       │           │           │
       └───────────┴───────────┘
                   │
                   ▼
         ┌─────────────────┐
         │  Return to LSP  │
         │  Client         │
         └─────────────────┘
                   │
                   ▼
         VS Code shows definition
```

### 2. File Change Flow

```
User edits file.ts
       │
       ▼
┌─────────────────┐
│ onDidChange     │  Debounce 500ms
│ event           │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────┐
│  Dynamic Index              │
│  updateFile(uri, content)   │
│                             │
│  1. Parse AST               │
│  2. Extract symbols         │
│  3. Store in memory         │
│  4. No disk I/O             │
└─────────────────────────────┘
         │
         ▼
┌─────────────────┐
│ Update Stats    │
└─────────────────┘
         │
         ▼
   Symbols immediately
   available for queries
```

### 3. Background Indexing Flow

```
Workspace scan
       │
       ▼
┌──────────────────────┐
│ Get all files        │
│ (FileScanner)        │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────────────┐
│ For each file:               │
│   1. Compute content hash    │
│   2. Compare with shard hash │
│   3. Add to queue if changed │
└──────────┬───────────────────┘
           │
           ▼
┌───────────────────────────────────┐
│ Parallel Worker Pool (N workers) │
│                                   │
│  Worker 1  Worker 2  ...  Worker N│
│     ║         ║            ║      │
│     ║         ║            ║      │
│     ╚═════════╩════════════╝      │
│              │                    │
│              ▼                    │
│  ┌────────────────────┐           │
│  │ Index File:        │           │
│  │ 1. Read content    │           │
│  │ 2. Parse AST       │           │
│  │ 3. Extract symbols │           │
│  │ 4. Create result   │           │
│  └────────┬───────────┘           │
└───────────┼───────────────────────┘
            │
            ▼
┌───────────────────────────┐
│ BackgroundIndex           │
│ updateFile(uri, result)   │
│                           │
│ 1. Update metadata        │
│ 2. Update name index      │
│ 3. Write shard to disk    │
└───────────────────────────┘
            │
            ▼
┌───────────────────────────┐
│ .smart-index/index/       │
│ <hash>.json written       │
└───────────────────────────┘
```

### 4. Incremental Git Flow

```
Git commit detected
       │
       ▼
┌──────────────────────┐
│ GitWatcher           │
│ getChangesSince()    │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────────┐
│ Git diff analysis        │
│ • Added files            │
│ • Modified files         │
│ • Deleted files          │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│ BackgroundIndex          │
│                          │
│ • Remove deleted files   │
│ • Index added files      │
│ • Index modified files   │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│ Save metadata            │
│ • New git hash           │
│ • Timestamp              │
└──────────────────────────┘
```

## Memory Model

### Dynamic Index (In-Memory)

```
Map<string, IndexedFileResult>
  │
  ├─ "file1.ts" → { uri, hash, symbols: [...] }
  ├─ "file2.ts" → { uri, hash, symbols: [...] }
  └─ "file3.ts" → { uri, hash, symbols: [...] }

Only open files are stored (auto-managed)
```

### Background Index (Hybrid)

**In-Memory (Lightweight)**:
```
Map<string, { hash, lastIndexedAt, symbolCount }>
  │
  ├─ "file1.ts" → { hash: "abc123", lastIndexedAt: 1234567890, symbolCount: 45 }
  ├─ "file2.ts" → { hash: "def456", lastIndexedAt: 1234567891, symbolCount: 67 }
  └─ ...

Map<string, Set<string>>  // name → URIs
  │
  ├─ "MyClass" → Set(["file1.ts", "file3.ts"])
  ├─ "myFunction" → Set(["file2.ts"])
  └─ ...
```

**On-Disk (Full Data)**:
```
.smart-index/index/
  ├─ <hash-of-file1-uri>.json → Full shard with all symbols
  ├─ <hash-of-file2-uri>.json → Full shard with all symbols
  └─ ...

Loaded lazily when symbols are queried
```

## Comparison with Clangd

| Feature | Clangd | Smart Indexer | Status |
|---------|--------|---------------|--------|
| Dynamic Index | ✅ | ✅ | Implemented |
| Background Index | ✅ | ✅ | Implemented |
| Merged Index | ✅ | ✅ | Implemented |
| Per-file Shards | ✅ | ✅ | Implemented |
| Lazy Loading | ✅ | ✅ | Implemented |
| Parallel Indexing | ✅ | ✅ | Implemented |
| Incremental Updates | ✅ | ✅ | Implemented |
| Snapshot Index | ✅ | ❌ | Future work |
| Symbol Relations | ✅ | ❌ | Future work |
| Cross-TU Analysis | ✅ | ❌ | Future work |

## Performance Characteristics

### Time Complexity

| Operation | Dynamic Index | Background Index | Merged Index |
|-----------|---------------|------------------|--------------|
| findDefinitions | O(open files) | O(shards with name) | O(both) |
| searchSymbols | O(open files) | O(matching names) | O(both) |
| updateFile | O(1) | O(1) + disk I/O | N/A |
| getFileSymbols | O(1) | O(1) + disk I/O | O(1) |

### Space Complexity

| Component | Memory | Disk |
|-----------|--------|------|
| Dynamic Index | O(open files × symbols) | None |
| Background Index (metadata) | O(total files) | None |
| Background Index (shards) | None | O(total symbols) |
| Symbol Name Index | O(unique names × files with name) | None |

## Thread Safety

All index operations are:
- ✅ Async/await based (single-threaded Node.js)
- ✅ No race conditions (sequential event processing)
- ✅ Parallel safe (worker pool uses independent file processing)

## Error Handling

Each layer has error handling:
- **LSP Handlers**: Catch and log, return null/empty
- **Index Methods**: Catch and log, return empty results
- **Indexing Workers**: Catch per-file, continue with others
- **Shard I/O**: Catch and log, skip problematic shards

## Monitoring

### Logs
- All operations logged to "Smart Indexer" output channel
- Includes timestamps, file counts, symbol counts
- Errors logged with stack traces

### Statistics
- Real-time metrics via StatsManager
- Accessible via "Show Statistics" command
- Includes breakdown by index type

### Progress
- Visual progress bar during indexing
- Shows current/total files
- Cancellable (though not implemented yet)

---

Generated: 2025-11-25
Architecture: Clangd-inspired
Status: ✅ Complete
