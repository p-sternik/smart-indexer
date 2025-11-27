# ⚡ Smart Indexer

**Instant code navigation for massive TypeScript/JavaScript projects**

Stop waiting for IntelliSense. Smart Indexer delivers blazing-fast symbol lookup, dead code detection, and fuzzy search—even in monorepos with 10,000+ files. Perfect for Angular, React, and Node.js teams tired of slow "Go to Definition."

---

## 🚀 Why Smart Indexer?

| Problem | VS Code Native | **Smart Indexer** |
|---------|----------------|-------------------|
| **Cold Start** | 10-30 seconds | **<100ms** ✅ |
| **Large Monorepos** | Slow/crashes | **Handles 10k+ files** ✅ |
| **Find References** | Incomplete | **Tracks actual usages** ✅ |
| **Dead Code** | Manual search | **Automated detection** ✅ |
| **Fuzzy Search** | Basic | **Acronym matching** ✅ |

### ⚡ Instant Cold Start
Open VS Code and **start coding immediately**. No 10-second wait while TypeScript "builds the project graph." Index persists on disk, loads in <100ms.

### 🔍 Fuzzy Symbol Search
Type **"CFA"** → finds **"CompatFieldAdapter"**. Acronym matching, CamelCase-aware ranking, and context prioritization (open files ranked higher).

### 🧠 Hybrid Mode (Best of Both Worlds)
Tries VS Code's native TypeScript first (accurate), falls back to Smart Indexer if slow (fast). **Zero duplicate results.** You get accuracy when available, speed when needed.

### 💀 Dead Code Detection (Beta)
Find unused exports across your workspace with confidence scoring. Excludes `@public` API symbols. Perfect for cleaning up legacy codebases.

### 🎯 NgRx Support
Specialized detection for Angular/NgRx patterns:
- Navigate from `ofType(loadUsers)` to action creator
- Find all effects/reducers using an action
- Support for modern `createAction()` and legacy action classes

### 🌍 Multi-Language Support
Not just TypeScript! Text-based indexing for **Java, Go, C#, Python, Rust, C++**. Works in polyglot monorepos.

---

## 📦 Installation & Usage

### Install
1. Search **"Smart Indexer"** in VS Code Extensions
2. Click **Install**
3. Reload VS Code

### Use
**No configuration needed!** Works out-of-the-box.

- **Go to Definition**: `F12` or `Ctrl+Click`
- **Find References**: `Shift+F12`
- **Workspace Symbols**: `Ctrl+T` (Windows/Linux) or `Cmd+T` (Mac)
- **Find Dead Code**: `Ctrl+Shift+P` → "Smart Indexer: Find Dead Code"
- **Impact Analysis**: `Ctrl+Shift+P` → "Smart Indexer: Show Impact Analysis"

---

## ⚙️ Configuration

Smart Indexer works great with **zero config**, but power users can tune it:

| Setting | Default | Description |
|---------|---------|-------------|
| `smartIndexer.mode` | `"hybrid"` | `"hybrid"` = Try native TS first, fallback to indexer<br>`"standalone"` = Use only Smart Indexer<br>`"disabled"` = Disable extension |
| `smartIndexer.enableGitIntegration` | `true` | Only reindex Git-changed files (15x faster) |
| `smartIndexer.indexing.maxConcurrentWorkers` | `4` | Parallel indexing threads (1-16) |
| `smartIndexer.hybridTimeoutMs` | `100` | Max wait for native TS in hybrid mode (ms) |
| `smartIndexer.maxFileSizeMB` | `50` | Skip files larger than this |
| `smartIndexer.excludePatterns` | See below | Glob patterns to exclude from indexing |

### Default Exclusions
```json
{
  "smartIndexer.excludePatterns": [
    "**/node_modules/**",
    "**/dist/**",
    "**/out/**",
    "**/.git/**",
    "**/build/**",
    "**/*.min.js",
    "**/.angular/**",
    "**/.nx/**",
    "**/coverage/**"
  ]
}
```

### Recommended Settings

**For TypeScript Projects** (Best Accuracy):
```json
{
  "smartIndexer.mode": "hybrid",
  "smartIndexer.enableGitIntegration": true
}
```

**For Maximum Speed** (Large Monorepos):
```json
{
  "smartIndexer.mode": "standalone",
  "smartIndexer.indexing.maxConcurrentWorkers": 8
}
```

**For Low-Memory Systems**:
```json
{
  "smartIndexer.indexing.maxConcurrentWorkers": 2,
  "smartIndexer.maxFileSizeMB": 10
}
```

---

## 🎯 Key Features in Detail

### 1️⃣ Persistent Cache (Instant Restarts)
Unlike native TypeScript, Smart Indexer saves the index to disk (`.smart-index/` folder). **Restart VS Code 100x faster**—no re-parsing required.

### 2️⃣ Git-Aware Incremental Indexing
Changed 10 files in a 5,000-file repo? Smart Indexer **only reindexes those 10** (using Git diff or file watcher). **15x faster** than full reindex.

### 3️⃣ Stable Symbol IDs
Symbol IDs based on **content**, not line numbers. Refactor freely—references don't break when you add lines above.

### 4️⃣ Scope-Based Reference Filtering
No more false positives! Distinguishes local variables from global symbols. `const user = ...` in `fileA.ts` won't match `user` in `fileB.ts`.

### 5️⃣ Sharded Storage
Large projects split into per-file shards (`.smart-index/index/<hash>.json`). **Lazy loading**—only loads files you navigate to. Scales to 10,000+ files.

### 6️⃣ Worker Pool Architecture
Parallel AST parsing with configurable worker threads. Indexes 1,000 files in ~5 seconds on modern hardware (4 workers).

### 7️⃣ Live Synchronization
Real-time index updates as you type (debounced 600ms). File watcher detects external changes (Git operations, build tools).

### 8️⃣ Impact Analysis
Visualize dependencies between files with Mermaid diagrams. Understand blast radius before making changes.

---

## 🛠️ Troubleshooting

### ❓ "I see duplicate results in symbol search"
**Solution**: You have hybrid mode enabled AND another TypeScript extension active. Either:
1. Set `"smartIndexer.mode": "standalone"` to use only Smart Indexer
2. Disable competing extensions (e.g., custom TS language servers)

### ❓ "Index is outdated after Git pull"
**Solution**: Run **"Smart Indexer: Rebuild Index"** (`Ctrl+Shift+P`). Or enable:
```json
{
  "smartIndexer.enableGitIntegration": true
}
```
Auto-detects Git changes on file save.

### ❓ "Extension is slow in huge monorepo (20k+ files)"
**Solution**: Increase workers or reduce scope:
```json
{
  "smartIndexer.indexing.maxConcurrentWorkers": 8,
  "smartIndexer.excludePatterns": [
    "**/node_modules/**",
    "**/dist/**",
    "**/test/**"
  ]
}
```

### ❓ "Dead code detection shows false positives"
**Cause**: Beta feature uses heuristics (e.g., cross-file reference analysis).

**Workaround**: Mark public APIs with JSDoc:
```typescript
/** @public */
export class MyAPI { ... }

/** @api */
export function publicFunction() { ... }
```
Smart Indexer excludes `@public` and `@api` symbols from dead code detection.

### ❓ "Where is the index stored?"
**Location**: `.smart-index/` folder in your workspace root.

**Size**: ~5-10MB per 1,000 TypeScript files.

**To clear**: Run **"Smart Indexer: Clear Cache"** or delete `.smart-index/`.

**Git**: Automatically added to `.gitignore` (don't commit the cache).

---

## 📊 Performance Benchmarks

Tested on **Angular monorepo** (5,247 TypeScript files):

| Operation | Smart Indexer | Native TS | Improvement |
|-----------|---------------|-----------|-------------|
| **Cold start** | 87ms | 14s | **160x faster** |
| **Workspace symbol search** | 42ms | 1.2s | **28x faster** |
| **Find references** | 18ms | 340ms | **18x faster** |
| **Full index (first run)** | 6.3s | N/A | With 4 workers |
| **Incremental (23 files changed)** | 480ms | 6.3s | **13x faster** |

---

## 📚 Available Commands

Access via Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

- **Smart Indexer: Rebuild Index** - Full workspace reindex
- **Smart Indexer: Clear Cache** - Delete `.smart-index/` folder
- **Smart Indexer: Show Statistics** - View index size, file counts, performance
- **Smart Indexer: Inspect Index** - Browse indexed symbols by folder
- **Smart Indexer: Find Dead Code (Beta)** - Detect unused exports
- **Smart Indexer: Show Impact Analysis** - Visualize file dependencies

---

## 🎯 Use Cases

### Large Angular/React Monorepos
- **Problem**: TypeScript takes 30+ seconds to analyze workspace
- **Solution**: Smart Indexer indexes in 5-10 seconds, loads <100ms on restart

### Legacy Code Cleanup
- **Problem**: Unknown which exports are actually used
- **Solution**: "Find Dead Code" scans entire workspace, returns unused symbols with confidence scores

### Fast Refactoring
- **Problem**: Need to find all usages of a function across 100+ files
- **Solution**: "Find References" returns results in <50ms

### Multi-Language Projects
- **Problem**: Java/Go code in same repo as TypeScript
- **Solution**: Smart Indexer provides basic navigation for all languages

---

## 🔄 What's New

### v1.5.0 - Impact Analysis & NgRx Enhancements
- 🎨 **Impact Analysis**: Visualize file dependencies with Mermaid diagrams
- 🎯 **NgRx Action Groups**: Support for `createActionGroup()` pattern
- 🔍 **Enhanced Search**: Improved fuzzy matching for CamelCase symbols

### v1.4.0 - Live Synchronization
- ⚡ **Real-time Updates**: Index updates as you type (600ms debounce)
- 👀 **File Watcher**: Detects external changes (Git pull, build tools)
- 🚀 **Incremental Indexing**: Only reindex changed files (15x faster)

### v1.3.0 - Dead Code Detection
- 💀 **Beta Feature**: Find unused exports with confidence scoring
- 🏷️ **JSDoc Support**: Excludes `@public` and `@api` symbols
- 📊 **Statistics**: View dead code metrics per folder

See [CHANGELOG.md](CHANGELOG.md) for complete version history.

---

## 🤝 Feedback & Support

- **Issues**: Report bugs or request features
- **Questions**: Open a discussion
- **Rating**: Leave a ⭐ review on the Marketplace!

---

## 📄 License

MIT License - Free for commercial and personal use.

---

**Made for developers tired of waiting. Start navigating at the speed of thought.** ⚡
