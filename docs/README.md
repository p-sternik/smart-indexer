# Smart Indexer - Documentation Index

## 🎯 Start Here

**New to Smart Indexer?**
1. Read: [`SMART_INDEXER_QUICK_REF.md`](SMART_INDEXER_QUICK_REF.md) (5-min overview)
2. Deep dive: [`SMART_INDEXER_CONTEXT.md`](SMART_INDEXER_CONTEXT.md) (complete reference)

**Making changes?**
- **Always reference:** [`SMART_INDEXER_CONTEXT.md`](SMART_INDEXER_CONTEXT.md) before implementing
- **Check feature status:** Section 4 - avoid reimplementing existing features

---

## 📚 Documentation Catalog

### Core Architecture
- **[`SMART_INDEXER_CONTEXT.md`](SMART_INDEXER_CONTEXT.md)** ⭐ **SOURCE OF TRUTH**
  - Complete architectural documentation
  - Threading model, caching strategy, data structures
  - Component deep dive, feature status, performance metrics
  - **Use this as authoritative reference for all AI-assisted development**

- **[`SMART_INDEXER_QUICK_REF.md`](SMART_INDEXER_QUICK_REF.md)**
  - TL;DR version (5-minute read)
  - Key components, data structures, recent fixes
  - Common pitfalls, entry points for development

### Implementation Details
- **[`IMPLEMENTATION_COMPLETE.md`](../IMPLEMENTATION_COMPLETE.md)**
  - Historical implementation summary
  - Clangd-inspired index architecture
  - Worker pool details

- **[`IMPLEMENTATION_COMPLETE_STORAGE.md`](../IMPLEMENTATION_COMPLETE_STORAGE.md)**
  - Storage optimization journey
  - Hash-based directory structure rationale

### Feature-Specific Documentation

#### Incremental Indexing
- **[`INCREMENTAL_INDEXING_IMPLEMENTATION.md`](../INCREMENTAL_INDEXING_IMPLEMENTATION.md)**
  - Mtime-based caching details
  - Git integration
  - Cache invalidation strategy

- **[`INCREMENTAL_INDEXING_QUICK_REF.md`](../INCREMENTAL_INDEXING_QUICK_REF.md)**
  - Quick reference for incremental features

#### Live Synchronization
- **[`LIVE_SYNC_IMPLEMENTATION.md`](../LIVE_SYNC_IMPLEMENTATION.md)**
  - File watcher architecture
  - Debouncing strategy
  - Dual listener (LSP + chokidar)

- **[`LIVE_SYNC_QUICK_REF.md`](../LIVE_SYNC_QUICK_REF.md)**
  - Quick reference for live sync

#### Worker Pool
- **[`WORKER_POOL_ARCHITECTURE.md`](../WORKER_POOL_ARCHITECTURE.md)**
  - Thread pool design
  - Queue management
  - Error recovery

- **[`WORKER_POOL_CODE_REFERENCE.md`](../WORKER_POOL_CODE_REFERENCE.md)**
  - Code-level details

#### Deduplication
- **[`HYBRID_DEDUPLICATION_IMPLEMENTATION.md`](../HYBRID_DEDUPLICATION_IMPLEMENTATION.md)**
  - Hybrid provider architecture
  - Near-duplicate detection (±2 lines)

- **[`HYBRID_DEDUPLICATION_QUICK_REF.md`](../HYBRID_DEDUPLICATION_QUICK_REF.md)**
  - Quick reference for hybrid mode

#### AST Parser
- **[`AST_PARSER_IMPROVEMENTS.md`](../AST_PARSER_IMPROVEMENTS.md)** ⭐ **RECENT**
  - Declaration vs Usage detection (2025-11-27)
  - Parent-aware AST traversal
  - Fix for method declarations in references

- **[`AST_PARSER_QUICK_REF.md`](../AST_PARSER_QUICK_REF.md)**
  - Quick reference for parser changes

- **[`AST_PARSER_CODE_CHANGES.md`](../AST_PARSER_CODE_CHANGES.md)**
  - Code diff summary

#### Generic Resolution
- **[`GENERIC_RESOLUTION_IMPLEMENTATION.md`](../GENERIC_RESOLUTION_IMPLEMENTATION.md)**
  - Symbol resolution strategy
  - Import/re-export handling

- **[`GENERIC_RESOLUTION_QUICK_REF.md`](../GENERIC_RESOLUTION_QUICK_REF.md)**
  - Quick reference

### Storage & Optimization
- **[`STORAGE_IMPLEMENTATION_SUMMARY.md`](../STORAGE_IMPLEMENTATION_SUMMARY.md)**
  - Shard-based storage details
  - Hash-based directory structure

- **[`STORAGE_OPTIMIZATION.md`](../STORAGE_OPTIMIZATION.md)**
  - Performance optimization journey

- **[`STORAGE_QUICK_REF.md`](../STORAGE_QUICK_REF.md)**
  - Quick reference

### User Documentation
- **[`MARKETPLACE_README.md`](MARKETPLACE_README.md)**
  - User-facing documentation
  - Features, installation, usage

- **[`../README.md`](../README.md)**
  - Project README
  - Quick start guide

### Verification & Testing
- **Verification Scripts:**
  - `verify-parser-improvements.ps1` - Test AST parser fixes
  - `verify-incremental-indexing.ps1` - Test mtime caching
  - `verify-worker-pool.ps1` - Test worker pool
  - `verify-hybrid-deduplication.ps1` - Test deduplication

### Development
- **[`COMMIT_GUIDE.md`](../COMMIT_GUIDE.md)**
  - Semantic commit conventions
  - Release workflow

- **[`CHANGELOG.md`](../CHANGELOG.md)**
  - Version history
  - Release notes

---

## 🔍 Finding What You Need

### By Use Case

**"I want to understand the overall architecture"**
→ Start with [`SMART_INDEXER_QUICK_REF.md`](SMART_INDEXER_QUICK_REF.md), then [`SMART_INDEXER_CONTEXT.md`](SMART_INDEXER_CONTEXT.md)

**"I need to modify symbol extraction"**
→ See [`SMART_INDEXER_CONTEXT.md`](SMART_INDEXER_CONTEXT.md) Section 2.1 (Worker) + [`AST_PARSER_IMPROVEMENTS.md`](../AST_PARSER_IMPROVEMENTS.md)

**"I want to change the cache strategy"**
→ See [`SMART_INDEXER_CONTEXT.md`](SMART_INDEXER_CONTEXT.md) Section 1.2-1.3 + [`INCREMENTAL_INDEXING_IMPLEMENTATION.md`](../INCREMENTAL_INDEXING_IMPLEMENTATION.md)

**"I need to add file watching for new file types"**
→ See [`SMART_INDEXER_CONTEXT.md`](SMART_INDEXER_CONTEXT.md) Section 2.3 + [`LIVE_SYNC_IMPLEMENTATION.md`](../LIVE_SYNC_IMPLEMENTATION.md)

**"I want to improve deduplication"**
→ See [`SMART_INDEXER_CONTEXT.md`](SMART_INDEXER_CONTEXT.md) Section 2.5 + [`HYBRID_DEDUPLICATION_IMPLEMENTATION.md`](../HYBRID_DEDUPLICATION_IMPLEMENTATION.md)

**"I need to understand why declarations appeared in references"**
→ See [`AST_PARSER_IMPROVEMENTS.md`](../AST_PARSER_IMPROVEMENTS.md) - recent fix (2025-11-27)

### By Technology

**Worker Threads:**
- [`SMART_INDEXER_CONTEXT.md`](SMART_INDEXER_CONTEXT.md) Section 1.1, 2.1
- [`WORKER_POOL_ARCHITECTURE.md`](../WORKER_POOL_ARCHITECTURE.md)

**AST Parsing:**
- [`SMART_INDEXER_CONTEXT.md`](SMART_INDEXER_CONTEXT.md) Section 2.1
- [`AST_PARSER_IMPROVEMENTS.md`](../AST_PARSER_IMPROVEMENTS.md)

**File System:**
- [`SMART_INDEXER_CONTEXT.md`](SMART_INDEXER_CONTEXT.md) Section 1.2, 2.2
- [`STORAGE_IMPLEMENTATION_SUMMARY.md`](../STORAGE_IMPLEMENTATION_SUMMARY.md)

**VS Code Extension API:**
- [`SMART_INDEXER_CONTEXT.md`](SMART_INDEXER_CONTEXT.md) Section 2.4, 2.5
- [`HYBRID_DEDUPLICATION_IMPLEMENTATION.md`](../HYBRID_DEDUPLICATION_IMPLEMENTATION.md)

---

## 🚀 Quick Start for Contributors

1. **Read the architecture:**
   ```bash
   cat docs/SMART_INDEXER_QUICK_REF.md
   ```

2. **Check feature status:**
   - See [`SMART_INDEXER_CONTEXT.md`](SMART_INDEXER_CONTEXT.md) Section 4

3. **Find the right component:**
   - See [`SMART_INDEXER_CONTEXT.md`](SMART_INDEXER_CONTEXT.md) Section 2

4. **Review recent changes:**
   - [`AST_PARSER_IMPROVEMENTS.md`](../AST_PARSER_IMPROVEMENTS.md) (latest)
   - [`CHANGELOG.md`](../CHANGELOG.md)

5. **Run verification:**
   ```powershell
   .\verify-parser-improvements.ps1
   npm run compile
   ```

---

## 📝 For AI-Assisted Development

**ALWAYS:**
1. Reference [`SMART_INDEXER_CONTEXT.md`](SMART_INDEXER_CONTEXT.md) before suggesting changes
2. Check feature status (Section 4) to avoid reimplementing
3. Understand existing data structures (Section 3)
4. Follow architectural patterns (Section 5)
5. Verify changes don't break incremental indexing or live sync

**NEVER:**
- Suggest complete rewrites
- Change core parser library (`@typescript-eslint/typescript-estree`)
- Remove mtime-based caching
- Remove worker pool parallelism
- Add declarations to references (recently fixed!)

---

**Last Updated:** 2025-11-27
