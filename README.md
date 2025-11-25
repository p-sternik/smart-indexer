# Smart Indexer

A high-performance VS Code extension that provides fast IntelliSense support with persistent caching and Git-aware incremental indexing.

## Features

- **Fast IntelliSense**: Quick symbol lookup, go-to-definition, find references, and workspace symbol search
- **Persistent Cache**: Maintains an on-disk index that survives editor restarts
- **Git-Aware Indexing**: Only reindexes files that have changed between commits
- **Language Support**: TypeScript, JavaScript (including .tsx, .jsx, .mts, .cts, .mjs, .cjs)
- **Scalable**: Designed for large monorepos with many files

## Commands

- **Smart Indexer: Rebuild Index** - Triggers a full reindex of the workspace
- **Smart Indexer: Clear Cache** - Clears the on-disk index cache
- **Smart Indexer: Show Statistics** - Displays indexing statistics

## Configuration

```json
{
  "smartIndexer.cacheDirectory": ".smart-index",
  "smartIndexer.enableGitIntegration": true,
  "smartIndexer.excludePatterns": [
    "**/node_modules/**",
    "**/dist/**",
    "**/out/**",
    "**/.git/**",
    "**/build/**",
    "**/*.min.js"
  ],
  "smartIndexer.maxIndexedFileSize": 1048576
}
```

### Settings

- `smartIndexer.cacheDirectory` - Directory name for index cache (relative to workspace root)
- `smartIndexer.enableGitIntegration` - Enable Git-aware incremental indexing
- `smartIndexer.excludePatterns` - Glob patterns to exclude from indexing
- `smartIndexer.maxIndexedFileSize` - Maximum file size to index in bytes (default: 1MB)

## How It Works

### Architecture

The extension consists of two main components:

1. **Client (Extension)**: The VS Code extension that communicates with the language server
2. **Server (Language Server)**: An LSP-based backend that handles indexing and symbol lookups

### Indexing Strategy

1. **Initial Scan**: On first run, scans all eligible files in the workspace
2. **Git-Aware Updates**: Detects changes between the last indexed commit and current HEAD
3. **Incremental Updates**: Only reindexes modified files
4. **Real-time Updates**: Watches for file changes and updates the index automatically

### Cache Layer

- Uses SQLite (via WebAssembly - `sql.js`) for persistent storage (`.smart-index/index.sqlite`)
- No native dependencies - works reliably in VS Code Extension Host (Electron)
- Maintains an in-memory cache for fast lookups
- Stores file hashes to detect changes
- Tracks Git commit hashes for incremental indexing

## Requirements

- VS Code 1.106.1 or higher
- Workspace must be opened (single folder or workspace)

## Performance

- **Startup**: Loads existing index from disk in milliseconds
- **Indexing**: Processes files asynchronously in batches to avoid blocking
- **Memory**: Compact in-memory representation with full data in SQLite
- **Git Integration**: Only reindexes changed files, not the entire workspace

## Known Limitations

- Currently supports TypeScript/JavaScript only (generic text indexing for other files)
- Maximum file size limit (configurable, default 1MB)
- Requires Git for optimal incremental indexing

## Development

```bash
# Install dependencies
npm install

# Compile both client and server
npm run compile

# Watch mode
npm run watch

# Run tests
npm test
```

## License

MIT
