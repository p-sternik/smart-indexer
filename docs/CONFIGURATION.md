# Smart Indexer Configuration

Complete configuration reference for Smart Indexer.

---

## Quick Configuration Examples

### Best Accuracy (TypeScript Projects)

```json
{
  "smartIndexer.mode": "hybrid",
  "smartIndexer.hybridTimeoutMs": 200,
  "smartIndexer.enableGitIntegration": true,
  "smartIndexer.enableBackgroundIndex": true
}
```

**Use when**: You want the best of both worlds—native TypeScript accuracy with Smart Indexer's speed when VS Code is slow.

---

### Maximum Performance

```json
{
  "smartIndexer.mode": "standalone",
  "smartIndexer.indexing.maxConcurrentWorkers": 8,
  "smartIndexer.indexing.useFolderHashing": true,
  "smartIndexer.enableBackgroundIndex": true
}
```

**Use when**: You prioritize speed over 100% accuracy and work in large codebases.

---

### Low Memory

```json
{
  "smartIndexer.enableBackgroundIndex": false,
  "smartIndexer.indexing.maxConcurrentWorkers": 1,
  "smartIndexer.maxIndexedFileSize": 524288
}
```

**Use when**: Running on constrained hardware or want minimal memory footprint (indexes only open files).

---

### Multi-language Support

```json
{
  "smartIndexer.textIndexing.enabled": true,
  "smartIndexer.textIndexing.languages": ["java", "go", "csharp", "python", "rust", "cpp"]
}
```

**Use when**: Working in polyglot repositories with Java, Go, C#, Python, Rust, or C++ alongside TypeScript/JavaScript.

---

## All Configuration Settings

### Core Settings

#### `smartIndexer.mode`
- **Type**: `"standalone"` | `"hybrid"`
- **Default**: `"hybrid"`
- **Description**: Operation mode for the indexer
  - `"standalone"`: Use only Smart Indexer (faster, good accuracy)
  - `"hybrid"`: Delegate to VS Code's native TypeScript service first, fall back to Smart Indexer if slow (best accuracy)

#### `smartIndexer.enableBackgroundIndex`
- **Type**: `boolean`
- **Default**: `true`
- **Description**: Enable persistent background indexing of entire workspace. Disable to only index open files (saves memory).

#### `smartIndexer.enableGitIntegration`
- **Type**: `boolean`
- **Default**: `true`
- **Description**: Enable Git-aware incremental indexing. Only reindexes files changed since last commit (15x faster updates).

#### `smartIndexer.cacheDirectory`
- **Type**: `string`
- **Default**: `".smart-index"`
- **Description**: Directory name for index cache (relative to workspace root). Index data persists here.

#### `smartIndexer.excludePatterns`
- **Type**: `string[]`
- **Default**: `["**/node_modules/**", "**/dist/**", "**/out/**", "**/.git/**"]`
- **Description**: Glob patterns to exclude from indexing. Add more to skip vendor directories, build outputs, etc.

#### `smartIndexer.maxIndexedFileSize`
- **Type**: `number` (bytes)
- **Default**: `1048576` (1 MB)
- **Description**: Maximum file size to index. Files larger than this are skipped (prevents indexing minified bundles).

---

### Hybrid Mode Settings

#### `smartIndexer.hybridTimeoutMs`
- **Type**: `number` (milliseconds)
- **Default**: `100`
- **Description**: Timeout for native TypeScript service in hybrid mode. If VS Code doesn't respond within this time, Smart Indexer provides results immediately.

**Tuning**:
- **50-100ms**: Prioritize speed (fall back quickly)
- **200-500ms**: Prioritize accuracy (wait longer for native TypeScript)

---

### Indexing Settings

#### `smartIndexer.indexing.maxConcurrentWorkers`
- **Type**: `number` (1-16)
- **Default**: `4`
- **Description**: Maximum concurrent indexing workers. Auto-tunes based on performance. Increase for faster indexing on multi-core systems.

**Tuning**:
- **1-2**: Low-end hardware or battery-saving mode
- **4-6**: Typical desktop/laptop
- **8-16**: High-end workstations with many cores

#### `smartIndexer.indexing.batchSize`
- **Type**: `number`
- **Default**: `50`
- **Description**: Number of files processed per indexing batch. Higher values = faster indexing but longer pauses.

#### `smartIndexer.indexing.useFolderHashing`
- **Type**: `boolean`
- **Default**: `true`
- **Description**: Use Merkle-style folder hashing to skip unchanged directories. Dramatically speeds up incremental indexing (15x faster).

---

### Multi-language Indexing

#### `smartIndexer.textIndexing.enabled`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Enable text-based indexing for non-TypeScript/JavaScript files (Java, Go, C#, Python, Rust, C++).

#### `smartIndexer.textIndexing.languages`
- **Type**: `string[]`
- **Default**: `["java", "go", "csharp", "python", "rust", "cpp"]`
- **Description**: Languages to index when text indexing is enabled.

**Note**: Text-based indexing uses regex patterns to extract symbols. Accuracy is lower than AST-based parsing but provides basic navigation.

---

### Static Index Settings

#### `smartIndexer.staticIndex.enabled`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Enable loading of pre-generated static index (e.g., third-party library symbols).

#### `smartIndexer.staticIndex.path`
- **Type**: `string`
- **Default**: `""`
- **Description**: Path to static index file or directory (relative to workspace or absolute). Supports LSIF or JSON format.

**Example Static Index** (`static-index.json`):
```json
{
  "symbols": [
    {
      "name": "ExternalClass",
      "kind": "class",
      "location": {
        "uri": "file:///path/to/external/lib.java",
        "line": 10,
        "character": 0
      },
      "containerName": "com.example.lib"
    }
  ]
}
```

---

## Commands

Smart Indexer provides the following VS Code commands:

- **Smart Indexer: Rebuild Index** - Triggers a full reindex of the workspace
- **Smart Indexer: Clear Cache** - Clears the on-disk index cache (forces rebuild on next start)
- **Smart Indexer: Show Statistics** - Displays indexing statistics, performance metrics, and profiling data
- **Smart Indexer: Inspect Index** - Browse index state with folder-by-folder breakdown

Access via Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).

---

## Performance Tuning

### Large Codebases (1000+ files)

```json
{
  "smartIndexer.indexing.maxConcurrentWorkers": 8,
  "smartIndexer.indexing.batchSize": 100,
  "smartIndexer.indexing.useFolderHashing": true,
  "smartIndexer.excludePatterns": [
    "**/node_modules/**",
    "**/dist/**",
    "**/out/**",
    "**/.git/**",
    "**/vendor/**",
    "**/build/**"
  ]
}
```

### Monorepos

```json
{
  "smartIndexer.mode": "hybrid",
  "smartIndexer.enableGitIntegration": true,
  "smartIndexer.indexing.useFolderHashing": true,
  "smartIndexer.excludePatterns": [
    "**/node_modules/**",
    "**/packages/*/dist/**",
    "**/apps/*/build/**"
  ]
}
```

### Remote Development (VS Code Remote)

```json
{
  "smartIndexer.indexing.maxConcurrentWorkers": 2,
  "smartIndexer.indexing.batchSize": 25,
  "smartIndexer.maxIndexedFileSize": 524288
}
```

**Rationale**: Reduce concurrent workers and batch size to minimize network I/O and memory usage on remote machines.

---

## Troubleshooting

### Index not updating

1. Check if Git integration is enabled: `"smartIndexer.enableGitIntegration": true`
2. Manually trigger rebuild: **Command Palette → Smart Indexer: Rebuild Index**
3. Clear cache and restart: **Command Palette → Smart Indexer: Clear Cache**

### Slow indexing

1. Increase workers: `"smartIndexer.indexing.maxConcurrentWorkers": 8`
2. Enable folder hashing: `"smartIndexer.indexing.useFolderHashing": true`
3. Exclude more patterns: Add `vendor/`, `build/`, `.next/`, etc. to `excludePatterns`

### High memory usage

1. Disable background index: `"smartIndexer.enableBackgroundIndex": false`
2. Reduce workers: `"smartIndexer.indexing.maxConcurrentWorkers": 1`
3. Lower file size limit: `"smartIndexer.maxIndexedFileSize": 524288` (512 KB)

### Hybrid mode not working

1. Verify mode: `"smartIndexer.mode": "hybrid"`
2. Check timeout: Increase `"smartIndexer.hybridTimeoutMs": 200` for slower systems
3. Ensure TypeScript extension is enabled in VS Code

---

## See Also

- [Architecture](ARCHITECTURE.md) - System design and dual-index architecture
- [Features](FEATURES.md) - Complete feature list and capabilities
- [../CHANGELOG.md](../CHANGELOG.md) - Version history and release notes
