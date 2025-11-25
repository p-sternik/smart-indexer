# Quick Start Guide

## Installation & Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Build the Extension**
   ```bash
   npm run compile
   ```

3. **Run in Development Mode**
   - Open the project in VS Code
   - Press `F5` to launch Extension Development Host
   - A new VS Code window will open with the extension loaded

## First Time Use

When you first open a workspace with Smart Indexer:

1. The extension activates automatically (look for "Smart Indexer" in status bar)
2. It checks if the workspace is a Git repository
3. If yes, it performs incremental indexing based on Git changes
4. If no, it scans all eligible files in the workspace
5. An index database is created at `.smart-index/index.db`

## Using the Extension

### IntelliSense Features

- **Go to Definition**: `F12` or right-click → "Go to Definition"
- **Find References**: `Shift+F12` or right-click → "Find All References"
- **Workspace Symbols**: `Ctrl+T` (Windows/Linux) or `Cmd+T` (Mac)
- **Auto-completion**: Type and get symbol suggestions

### Commands

Open Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`):

- **Smart Indexer: Rebuild Index** - Forces a complete reindex of all files
- **Smart Indexer: Clear Cache** - Clears the index database (requires rebuild)
- **Smart Indexer: Show Statistics** - Displays indexing stats

## Configuration

Create or modify `.vscode/settings.json` in your workspace:

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

## Development Workflow

### Watch Mode

For active development, use watch mode:

```bash
npm run watch
```

This starts three watch processes:
- `watch:esbuild` - Client bundling
- `watch:tsc` - Client type checking
- `watch:server` - Server compilation

### Building for Production

```bash
npm run package
```

This creates an optimized build suitable for distribution.

### Testing Changes

1. Make code changes
2. If watch mode is running, changes are automatically compiled
3. Press `Ctrl+R` (Windows/Linux) or `Cmd+R` (Mac) in Extension Development Host to reload
4. Test your changes

## Troubleshooting

### Extension Not Activating

- Check the Output panel: View → Output → Select "Smart Indexer"
- Look for error messages in the Developer Tools: Help → Toggle Developer Tools

### Indexing Not Working

1. Check if workspace is open (extension requires a workspace)
2. Verify the status bar shows "Smart Indexer" indicator
3. Run "Smart Indexer: Show Statistics" to see if files are indexed
4. Try "Smart Indexer: Rebuild Index" to force reindexing

### Performance Issues

- Reduce file size limit: `smartIndexer.maxIndexedFileSize`
- Add more exclusion patterns: `smartIndexer.excludePatterns`
- Disable Git integration if not needed: `smartIndexer.enableGitIntegration`

### Cache Issues

If you encounter cache corruption or inconsistencies:

1. Run "Smart Indexer: Clear Cache"
2. Run "Smart Indexer: Rebuild Index"
3. Or manually delete `.smart-index/` folder and reload VS Code

## Supported File Types

Currently indexes:
- TypeScript: `.ts`, `.tsx`, `.mts`, `.cts`
- JavaScript: `.js`, `.jsx`, `.mjs`, `.cjs`
- Other files (basic text indexing): `.json`, `.md`, `.txt`, `.yml`, `.yaml`

## Git Integration

When enabled (default):
- Tracks the last indexed Git commit
- On startup, compares current HEAD with last indexed commit
- Only reindexes changed files (added, modified)
- Removes deleted files from index
- Watches for branch switches and reindexes accordingly

## Architecture Overview

```
┌─────────────────────────────────────────┐
│         VS Code Extension               │
│  (src/extension.ts - LSP Client)        │
└──────────────┬──────────────────────────┘
               │ IPC
┌──────────────▼──────────────────────────┐
│      Language Server Process            │
│   (server/src/server.ts)                │
│                                          │
│  ┌────────────┐  ┌──────────────┐      │
│  │  Indexer   │  │ Git Watcher  │      │
│  └────────────┘  └──────────────┘      │
│                                          │
│  ┌─────────────────────────────┐       │
│  │    Cache Manager            │       │
│  │  (In-Memory + SQLite)       │       │
│  └─────────────────────────────┘       │
└─────────────────────────────────────────┘
               │
               ▼
        .smart-index/
         index.db
```

## Next Steps

- Explore the codebase starting with `src/extension.ts` (client)
- Check out `server/src/server.ts` (LSP server)
- Review `server/src/indexer/symbolIndexer.ts` (core indexing logic)
- Read `IMPLEMENTATION.md` for detailed architecture

## Support

For issues, questions, or contributions:
- Check the console output for errors
- Review the implementation documentation
- Examine the LSP trace: File → Preferences → Settings → search "trace.server"
