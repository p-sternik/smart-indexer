# Smart Indexer

A high-performance VS Code extension that provides fast IntelliSense support with persistent caching and Git-aware incremental indexing.

## 📚 Documentation

For detailed information, see the [docs/](docs/) folder:
- **[Architecture](docs/ARCHITECTURE.md)** - System design, dual-index architecture, hybrid mode
- **[Features](docs/FEATURES.md)** - Complete feature list and capabilities
- **[Configuration](docs/CONFIGURATION.md)** - All configuration settings and examples

## Quick Start

1. Install the extension
2. Open a TypeScript/JavaScript workspace
3. Extension automatically indexes your code
4. Use `Ctrl+P` for workspace symbols, `F12` for go-to-definition

**Recommended Settings** for best experience:
```json
{
  "smartIndexer.mode": "hybrid",
  "smartIndexer.enableBackgroundIndex": true,
  "smartIndexer.enableGitIntegration": true
}
```

## ✨ What's New

**Latest Version** - Enhanced Accuracy & UX:
- 🎯 **Hybrid Mode** - Intelligent delegation to VS Code's TypeScript with fast fallback
- 🔗 **Import Resolution** - Navigate imports to exact files (eliminates false positives)
- 📍 **True Reference Tracking** - Find References returns actual usages across the workspace
- 🔍 **Fuzzy Search** - Acronym matching ("CFA" → "CompatFieldAdapter"), smart ranking
- 🧠 **Semantic Disambiguation** - TypeScript fallback for ambiguous symbols
- ⚡ **Dual-Index Architecture** - Fast dynamic index + persistent background index
- 🌍 **Multi-language Support** - Text-based indexing for Java, Go, C#, Python, Rust, C++

See [CHANGELOG.md](CHANGELOG.md) for complete version history.

## Features

### Core Capabilities
- **Fast IntelliSense**: Symbol lookup, go-to-definition, find references, workspace search
- **Persistent Cache**: On-disk index survives editor restarts (instant cold start)
- **Git-Aware Indexing**: Only reindexes changed files (15x faster incremental updates)
- **Dual-Index Architecture**: Dynamic (open files) + Background (workspace) indices
- **Multi-language Support**: TypeScript, JavaScript, Java, Go, C#, Python, Rust, C++

### Advanced Features
- **Hybrid Mode**: Delegate to native TypeScript when fast, fall back when slow
- **Fuzzy Search**: Acronym matching, smart ranking, context-aware results
- **Import Resolution**: Navigate imports to exact files (no false positives)
- **True Reference Tracking**: Find actual usages, not just definitions
- **Semantic Disambiguation**: TypeScript fallback for ambiguous symbols

See [docs/FEATURES.md](docs/FEATURES.md) for complete feature list.

## Commands

- **Smart Indexer: Rebuild Index** - Triggers a full reindex of the workspace
- **Smart Indexer: Clear Cache** - Clears the on-disk index cache
- **Smart Indexer: Show Statistics** - Displays indexing statistics with profiling metrics
- **Smart Indexer: Inspect Index** - Browse index state with folder breakdown

## Configuration

Quick configuration examples (see [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for all settings):

### Best Accuracy (TypeScript Projects)

```json
{
  "smartIndexer.mode": "hybrid",
  "smartIndexer.hybridTimeoutMs": 200,
  "smartIndexer.enableGitIntegration": true
}
```

### Maximum Performance
```json
{
  "smartIndexer.mode": "standalone",
  "smartIndexer.indexing.maxConcurrentWorkers": 8,
  "smartIndexer.indexing.useFolderHashing": true
}
```

### Low Memory
```json
{
  "smartIndexer.enableBackgroundIndex": false,
  "smartIndexer.indexing.maxConcurrentWorkers": 1
}
```

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for all settings and detailed examples.

## Performance

| Operation | Time | Notes |
|-----------|------|-------|
| Cold start | <100ms | Loads metadata only |
| Find definition | 5-20ms | Index lookup |
| Find references | 10-50ms | Shard loading |
| Workspace search | 20-100ms | With fuzzy ranking |
| Full index (1000 files) | ~5s | With 4 workers |
| Incremental (10% changed) | ~500ms | With Git integration |

## Architecture

Smart Indexer uses a **dual-index architecture** inspired by clangd:
- **DynamicIndex**: In-memory index for open files (instant updates)
- **BackgroundIndex**: Persistent sharded index for workspace (survives restarts)
- **MergedIndex**: Unified query interface combining both

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed design documentation.

## License

MIT

---

**For detailed documentation, see the [docs/](docs/) folder.**
