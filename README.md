# ⚡ Smart Indexer

**Instant Navigation for Large Angular Monorepos**

![Version](https://img.shields.io/visual-studio-marketplace/v/psternik.smart-indexer)
![Installs](https://img.shields.io/visual-studio-marketplace/i/psternik.smart-indexer)
![Rating](https://img.shields.io/visual-studio-marketplace/r/psternik.smart-indexer)

> **Stop waiting for VS Code IntelliSense to load.** Smart Indexer creates a persistent cache for instant Go to Definition and Find References—even in monorepos with 10,000+ files.

---

## 🚀 Key Features

### ⚡ Parallel Indexing
Uses worker threads for blazing-fast initial indexing. Index 5,000 files in ~6 seconds.

### 🧠 NgRx Semantic Linking
Navigate **Actions → Effects → Reducers** instantly. "Go to Definition" connects Actions to Facades across files. Full support for modern `createActionGroup()` pattern!

### ⚡ Smart Fuzzy Search
Navigate symbols using abbreviations (e.g., `usrSrv` → `UserService`). Find what you need without typing full names.

### 🧹 Dead Code Detection
Identify unused exports in real-time. Perfect for cleaning up legacy Angular codebases.

### 💾 Persistent Cache
Index survives VS Code restarts. Cold start in <100ms instead of 10-30 seconds.

### 🔄 Git-Aware Incremental
Only re-indexes changed files. Pull 100 commits? Only changed files get reprocessed.

### 🛡️ Robustness
Atomic saves and self-healing index ensure 100% consistency. No more corrupted caches.

### 📊 Visibility
Status bar integration shows real-time indexing progress and health statistics.

---

## 📦 Quick Start

1. **Install** the extension from VS Code Marketplace
2. **Wait** for initial indexing (status bar shows progress)
3. **Enjoy** instant navigation with `F12`, `Shift+F12`, and `Ctrl+T`

**That's it!** No configuration required.

---

## ⚙️ Configuration

Smart Indexer works great out-of-the-box, but power users can tune these settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `smartIndexer.excludePatterns` | `["**/node_modules/**", "**/dist/**", ...]` | Glob patterns to exclude from indexing |
| `smartIndexer.indexing.maxConcurrentWorkers` | `4` | Parallel indexing threads (1-16) |
| `smartIndexer.mode` | `"hybrid"` | `"hybrid"` or `"standalone"` |
| `smartIndexer.enableGitIntegration` | `true` | Use Git to detect changed files |

### Recommended for Large Monorepos
```json
{
  "smartIndexer.indexing.maxConcurrentWorkers": 8,
  "smartIndexer.excludePatterns": [
    "**/node_modules/**",
    "**/dist/**",
    "**/.angular/**",
    "**/coverage/**"
  ]
}
```

---

## 🔒 Privacy & Performance

- **100% Offline** — No code leaves your machine. Ever.
- **Git-Aware** — Only re-indexes changed files (15x faster than full scan)
- **Lazy Loading** — Only loads index shards you actually navigate to
- **Disk Persistence** — Index stored in `.smart-index/` folder (auto-added to `.gitignore`)

---

## 📊 Performance Benchmarks

Tested on Angular monorepo (5,247 TypeScript files):

| Operation | Smart Indexer | Native TS | Improvement |
|-----------|---------------|-----------|-------------|
| **Cold start** | 87ms | 14s | **160x faster** |
| **Find references** | 18ms | 340ms | **18x faster** |
| **Workspace symbols** | 42ms | 1.2s | **28x faster** |

---

## 📚 Available Commands

Access via Command Palette (`Ctrl+Shift+P`):

| Command | Description |
|---------|-------------|
| **Smart Indexer: Quick Menu** | Access all commands in one place |
| **Smart Indexer: Rebuild Index** | Full workspace reindex |
| **Smart Indexer: Clear Cache** | Delete cached index |
| **Smart Indexer: Show Statistics** | View index metrics and health |
| **Smart Indexer: Inspect Index** | Debug symbol resolution |
| **Smart Indexer: Find Dead Code (Beta)** | Detect unused exports |

---

## 🛠️ Troubleshooting

### Index seems outdated?
Run **"Smart Indexer: Rebuild Index"** from the Command Palette.

### Extension slow in huge monorepo?
Increase workers: `"smartIndexer.indexing.maxConcurrentWorkers": 8`

### Where is the cache stored?
`.smart-index/` folder in your workspace root (~5-10MB per 1,000 files).

---

## 👩‍💻 Contributing & Architecture

Want to contribute or build from source?

📖 **See the [Architectural Documentation](docs/SMART_INDEXER_CONTEXT.md) for a deep dive.**

### Quick Build

```bash
# Clone and install
git clone https://github.com/p-sternik/smart-indexer.git
cd smart-indexer
npm install

# Compile
npm run compile

# Debug in VS Code
# Press F5 to launch Extension Development Host
```

### Project Structure

```
smart-indexer/
├── src/                    # VS Code extension (client)
├── server/                 # Language Server (LSP)
├── docs/                   # Architecture documentation
└── test-files/             # Test fixtures
```

---

## 📄 License

MIT License — Free for commercial and personal use.

---

**Made for developers tired of waiting. Start navigating at the speed of thought.** ⚡
