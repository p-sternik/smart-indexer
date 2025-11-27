# Smart Indexer (Development)

> **Developer Documentation** - For repository contributors and maintainers.  
> **Marketplace Users**: See the published extension description in VS Code.

A high-performance VS Code extension that provides fast IntelliSense support with persistent caching and Git-aware incremental indexing. Built with TypeScript and the Language Server Protocol.

---

## 🏗️ Architecture Overview

Smart Indexer uses a **dual-index architecture** inspired by LLVM's clangd:

```
┌─────────────────────────────────────────────────────────────┐
│                      MergedIndex                            │
│  (Unified Query Interface - Priority-based Result Merging)  │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌────────────────┐  ┌────────────────────┐  ┌──────────────┐
│ DynamicIndex   │  │ BackgroundIndex    │  │ StaticIndex  │
│ (In-Memory)    │  │ (Persistent)       │  │ (Optional)   │
│ Open files     │  │ Entire workspace   │  │ Pre-gen LSIF │
└────────────────┘  └────────────────────┘  └──────────────┘
```

### Key Components

- **DynamicIndex**: In-memory index for currently open files (instant updates via LSP events)
- **BackgroundIndex**: Persistent sharded index stored in `.smart-index/` (survives restarts)
- **MergedIndex**: Combines both indices with deduplication and priority rules
- **Worker Pool**: Parallel AST parsing with `@typescript-eslint/typescript-estree`
- **HybridResolver**: Optional fallback to TypeScript Language Service for ambiguous queries

**📖 Detailed Architecture**: See [`docs/SMART_INDEXER_CONTEXT.md`](docs/SMART_INDEXER_CONTEXT.md) - the authoritative source of truth.

---

## 📂 Project Structure

```
smart-indexer/
├── src/                          # VS Code extension (client)
│   ├── extension.ts             # Entry point
│   ├── providers/               # Hybrid providers (Definition, References)
│   └── features/                # UI features (Dead Code, Impact Analysis)
│
├── server/                       # Language Server (LSP)
│   ├── src/
│   │   ├── server.ts            # LSP server entry
│   │   ├── index/               # Index implementations (Dynamic, Background, Merged)
│   │   ├── indexer/             # AST parsers and symbol extractors
│   │   ├── typescript/          # TypeScript service integration
│   │   ├── utils/               # Worker pool, file scanner
│   │   └── features/            # Server-side features (Dead code, Impact)
│   └── dist/                    # Compiled server code
│
├── docs/                         # Documentation
│   ├── SMART_INDEXER_CONTEXT.md # 🎯 SSOT - Master architectural doc
│   ├── ARCHITECTURE.md          # High-level design
│   ├── FEATURES.md              # Feature descriptions
│   ├── CONFIGURATION.md         # Settings reference
│   └── MARKETPLACE_README.md    # Product-focused description (used in packaging)
│
├── test-files/                   # Test cases for feature verification
├── .smart-index/                # Cache directory (git-ignored)
├── package.json                 # Extension manifest
└── tsconfig.json                # TypeScript config
```

---

## 🚀 Build & Debug

### Prerequisites

- **Node.js**: v16+ (LTS recommended)
- **npm**: v8+
- **VS Code**: v1.106.1+

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd smart-indexer

# Install dependencies
npm install

# Compile TypeScript
npm run compile
```

### Development Workflow

#### 1. **Compile** (Watch Mode)
```bash
npm run watch
```
Watches for changes and recompiles client + server automatically.

#### 2. **Debug** (Press `F5` in VS Code)
- Opens **Extension Development Host** with the extension loaded
- Attach debugger to both client and server
- Set breakpoints in `src/` (client) or `server/src/` (server)

**Launch Configurations** (`.vscode/launch.json`):
- **Launch Extension** - Starts extension in debug mode
- **Attach to Server** - Connects to running LSP server

#### 3. **Test** (Verification Scripts)
```bash
# Test worker pool
.\verify-worker-pool.ps1

# Test incremental indexing
.\verify-incremental-indexing.ps1

# Test hybrid deduplication
.\verify-hybrid-deduplication.ps1

# Test NgRx support
.\verify-ngrx-action-group.ps1

# Test impact analysis
.\verify-impact-analysis.ps1
```

#### 4. **Lint**
```bash
npm run lint
```
Runs ESLint with TypeScript parser. Fix issues before committing.

---

## 📦 Building & Publishing

### Package Extension

```bash
# Build production bundle
npm run build

# Package VSIX (uses MARKETPLACE_README.md)
npm run vsix

# Output: smart-indexer-<version>.vsix
```

**Important**: The VSIX package uses `MARKETPLACE_README.md` as the README shown in the VS Code Marketplace (configured via `"readme": "./MARKETPLACE_README.md"` in `package.json`).

**Two README Files**:
- **`README.md`** (this file) - Developer documentation for GitHub repository
- **`MARKETPLACE_README.md`** - Product-focused description for VS Code Marketplace

When you run `npm run vsix`, the packager automatically uses `MARKETPLACE_README.md` for the extension package. The GitHub repository continues to show `README.md` with developer-focused content.

### Publishing Workflow

**Manual Publishing** (Current Approach):
```bash
# 1. Update version in package.json
npm version patch  # or minor/major

# 2. Update CHANGELOG.md

# 3. Package extension
npm run package

# 4. Publish to Marketplace (requires PAT)
npx vsce publish

# 5. Create GitHub release with VSIX attached
```

**Automated Publishing** (Semantic Release):
- Uses `.releaserc.json` for automated versioning
- See `docs/SEMANTIC_RELEASE_SETUP.md` for CI/CD setup
- Currently not enabled (manual releases only)

---

## 🧪 Testing & Verification

### Unit Tests (Not Yet Implemented)
```bash
npm test  # TODO: Add Jest/Mocha tests
```

### Integration Tests (PowerShell Scripts)
Located in repository root:
- `verify-architecture.ps1` - Validates core architecture
- `verify-features.ps1` - Tests all major features
- `verify-hashed-storage.ps1` - Tests sharded storage
- `verify-parser-improvements.ps1` - Tests AST parser accuracy
- `verify-ngrx.ps1` - Tests NgRx pattern detection

### Manual Testing Checklist

**Before Release**:
1. ✅ `F5` - Extension activates without errors
2. ✅ Open large project (1000+ files) - Index completes
3. ✅ `F12` (Go to Definition) - Works on various symbols
4. ✅ `Shift+F12` (Find References) - No false positives
5. ✅ `Ctrl+T` (Workspace Symbols) - Fuzzy search works
6. ✅ Edit file - Live sync updates index within 1s
7. ✅ Restart VS Code - Cache loads instantly (<100ms)
8. ✅ Git pull - Incremental indexing works
9. ✅ "Find Dead Code" - Returns results with confidence scores
10. ✅ Hybrid mode - No duplicate results

---

## 🔧 Configuration for Development

**Recommended `.vscode/settings.json`** (in this repo):
```json
{
  "smartIndexer.mode": "hybrid",
  "smartIndexer.enableBackgroundIndex": true,
  "smartIndexer.enableGitIntegration": true,
  "smartIndexer.indexing.maxConcurrentWorkers": 4,
  "smartIndexer.excludePatterns": [
    "**/node_modules/**",
    "**/dist/**",
    "**/out/**",
    "**/.smart-index/**"
  ]
}
```

---

## 📚 Documentation

### For Contributors
- **[SMART_INDEXER_CONTEXT.md](docs/SMART_INDEXER_CONTEXT.md)** - 🎯 **START HERE** - Complete architectural reference
- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** - High-level system design
- **[FEATURES.md](docs/FEATURES.md)** - Feature documentation

### For Users (Marketplace)
- **[MARKETPLACE_README.md](docs/MARKETPLACE_README.md)** - Product-focused description (used in packaging)

### Repository Audit
- **[SMART_INDEXER_AUDIT.md](SMART_INDEXER_AUDIT.md)** - Technical comparison with VS Code native TS service

---

## 🐛 Debugging Tips

### Enable Verbose Logging
```json
{
  "smartIndexer.logging.level": "debug"
}
```
View logs in **Output** panel → "Smart Indexer Language Server".

### Inspect Index State
Command: **"Smart Indexer: Inspect Index"**
- Shows all indexed files
- Displays symbol counts per folder
- Reveals cache size

### Common Issues

**Issue**: Extension doesn't activate
- Check **Output** panel for errors
- Verify `engines.vscode` version in `package.json` matches installed VS Code

**Issue**: Index is stale after editing
- Check if file watcher is initialized (see server logs)
- Verify file isn't excluded by `excludePatterns`

**Issue**: Worker pool errors
- Check available CPU cores (`os.cpus().length`)
- Reduce `maxConcurrentWorkers` setting

---

## 🤝 Contributing

### Workflow

1. **Create Feature Branch**
   ```bash
   git checkout -b feature/my-feature
   ```

2. **Make Changes**
   - Update code in `src/` or `server/src/`
   - Update documentation in `docs/SMART_INDEXER_CONTEXT.md`
   - Add tests if applicable

3. **Verify**
   ```bash
   npm run compile
   npm run lint
   # Run relevant verify-*.ps1 script
   ```

4. **Commit** (Follow Conventional Commits)
   ```bash
   git commit -m "feat: add new feature"
   # or
   git commit -m "fix: resolve issue with worker pool"
   ```

5. **Pull Request**
   - Target `main` branch
   - Include description of changes
   - Reference related issues

### Commit Message Format
```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`

**Example**:
```
feat(indexer): add NgRx action group detection

- Detects modern createActionGroup() pattern
- Extracts action type strings
- Links actions to effects/reducers

Closes #123
```

---

## 📄 License

MIT License - See [LICENSE](LICENSE) for details.

---

## 🔗 Additional Resources

- **VS Code Extension API**: https://code.visualstudio.com/api
- **Language Server Protocol**: https://microsoft.github.io/language-server-protocol/
- **TypeScript ESTree**: https://github.com/typescript-eslint/typescript-eslint/tree/main/packages/typescript-estree

---

**Questions?** Check [`docs/SMART_INDEXER_CONTEXT.md`](docs/SMART_INDEXER_CONTEXT.md) for implementation details.
