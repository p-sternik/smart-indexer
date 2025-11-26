# Smart Indexer Features

## Overview

Smart Indexer provides fast, persistent symbol indexing for TypeScript/JavaScript projects with optional multi-language support. This document outlines all key features and capabilities.

---

## Core Features

### 1. Fast Cold Start

**What it does**: Index data persists on disk, enabling instant navigation after VS Code restart.

**Technical Details**:
- Sharded JSON storage in .smart-index/index/
- Metadata loaded in <5ms on startup
- No need to re-parse files after restart
- Works immediately, even before background indexing completes

**Benefit**: Open VS Code and start navigating code immediately, unlike native TypeScript which requires seconds to rebuild the project graph.

---

### 2. Dual-Index Architecture

**Components**:
- **DynamicIndex**: In-memory index for currently open files
- **BackgroundIndex**: Persistent sharded index for entire workspace
- **MergedIndex**: Unified query interface combining both

**How it works**:
1. Open files indexed immediately in memory (instant updates)
2. Workspace files indexed in background with parallel processing
3. Queries check open files first, fall back to workspace index
4. Results deduplicated and merged

**Benefit**: Best of both worlds—fast updates for current work, comprehensive coverage for entire codebase.

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed diagrams.

---

### 3. True Reference Tracking

**Previous Behavior** (v0.0.1):
- "Find References" returned only definitions with matching names
- No tracking of actual symbol usages

**Current Behavior** (v0.0.2+):
- Tracks actual identifier usages: `Identifier`, `MemberExpression`, `CallExpression`
- Indexes references during AST traversal
- Stores reference locations in shards
- Returns actual usages across workspace

**Example**:
```typescript
class MyClass {
  myMethod() {}  // Definition
}

const obj = new MyClass();
obj.myMethod();  // Reference - NOW TRACKED ✓
```

**Benefit**: True "Find All References" that shows where symbols are actually used.

---

### 4. Import Resolution

**Problem Solved**:
Previously, clicking on an imported symbol would search the entire workspace, returning false positives.

**Solution**:
- New `ImportResolver` class resolves import paths to exact files
- Supports relative imports (`./foo`, `../bar`)
- Handles multiple file extensions (`.ts`, `.tsx`, `.js`, etc.)
- Resolves directory imports with `index.*` files
- Tracks import declarations during indexing

**Example**:
```typescript
import { Foo } from './bar';  // Resolves to /path/to/bar.ts
const x = new Foo();          // Ctrl+Click → jumps to Foo in bar.ts only
```

**Benefit**: Eliminates false positives, accurate navigation for imported symbols.

---

### 5. Hybrid Mode

**What it does**: Intelligently delegates to VS Code's native TypeScript service when available, falls back to Smart Indexer when needed.

**Configuration**:
```json
{
  \"smartIndexer.mode\": \"hybrid\",  // \"standalone\" | \"hybrid\" | \"disabled\"
  \"smartIndexer.hybridTimeoutMs\": 100
}
```

**Delegation Strategy**:
1. User invokes \"Go to Definition\" or \"Find References\"
2. Smart Indexer tries native TypeScript provider first
3. If response arrives within 100ms → use native result (type-aware, accurate)
4. If timeout or no results → fall back to Smart Indexer (fast, persistent)

**Benefits**:
- **Best accuracy**: Leverages TypeScript's semantic analysis when fast
- **No duplicate results**: Only one provider active at a time
- **Graceful fallback**: Works even when TypeScript is slow or unavailable
- **User control**: Configurable timeout and mode

---

### 6. Fuzzy Search & Relevance Ranking (v0.0.3)

**Fuzzy Matching**:
- Acronym support: \"CFA\" finds \"CompatFieldAdapter\"
- CamelCase boundary matching: +25 points per match
- Word boundary detection: Matches after `_`, `-`, `.`, `/`
- Consecutive character bonuses
- Prefix matching bonus

**Relevance Ranking**:
Symbols ranked by:
1. Open files: +100 points
2. Same directory: +100 points
3. Parent/sibling directories: +70/+50 points
4. Symbol kind: Classes/interfaces +15, Functions +10
5. Source code (`src/`): +10 points
6. Build folders (`dist/`, `out/`): -30 points
7. Dependencies (`node_modules`): -80 points

**Performance**:
- Batched processing for large result sets (1000 symbols/batch)
- Event loop yielding prevents UI blocking
- Maximum 50ms per batch

**Benefit**: Relevant symbols appear first, acronym search works naturally.

---

### 7. Semantic Disambiguation (Optional)

**What it does**: Uses TypeScript's `TypeChecker` for ambiguous cases.

**When used**:
- Multiple symbols with same name
- Container information unavailable at cursor
- Timeout configurable (default: 200ms)

**How it works**:
```typescript
// Multiple \"newRoot\" methods exist
class A { newRoot() {} }
class B { newRoot() {} }

const x = new A();
x.newRoot();  // TypeScript resolves type of \"x\" → A.newRoot only
```

**Benefit**: More accurate than pure AST analysis, faster than full type-checking.

---

### 8. Incremental Indexing

**Git Integration**:
- Detects Git commit changes
- Only re-indexes files that changed between commits
- Stores last known Git hash in metadata

**Folder Hashing** (v0.0.2):
- Merkle-style tree hashing of directory contents
- Skip unchanged folders entirely (15x faster for incremental builds)
- Configurable via `useFolderHashing` setting

**Content Hashing**:
- SHA-256 hash of file contents
- Compares hash before re-indexing
- Skips files with unchanged content

**Benefit**: Fast incremental updates, workspace changes indexed in seconds.

---

### 9. Multi-Language Support (Optional)

**Supported Languages**:
- TypeScript/JavaScript (AST-based, full support)
- Java, Go, C#, Python, Rust, C++ (text-based, regex patterns)

**Text Indexing**:
- Regex-based symbol extraction
- Faster than AST parsing
- Limited accuracy compared to AST analysis

**Configuration**:
```json
{
  \"smartIndexer.textIndexing.enabled\": true
}
```

**Benefit**: Navigate symbols in multiple languages from one extension.

---

### 10. Static Index Support (Optional)

**What it does**: Load pre-generated symbol indices for third-party libraries.

**Use Case**:
- Index `node_modules` once, share across team
- Skip indexing large dependencies
- Pre-built LSIF or JSON format

**Configuration**:
```json
{
  \"smartIndexer.staticIndex.enabled\": true,
  \"smartIndexer.staticIndex.path\": \"./static-symbols.json\"
}
```

**Benefit**: Faster workspace setup, shared indices across team.

---

### 11. Performance Profiling & Auto-tuning (v0.0.2)

**Built-in Metrics**:
- Average definition lookup time
- Average reference lookup time
- Indexing performance per file
- Background index shard loading time

**Auto-tuning**:
- Monitors indexing performance
- Adjusts worker pool size dynamically
- Optimizes for CPU and I/O balance

**Statistics Display**:
- Command: **Smart Indexer: Show Statistics**
- Shows: files indexed, symbols indexed, avg query time, worker count

**Benefit**: Transparent performance, automatic optimization.

---

### 12. Index Inspection (v0.0.2)

**What it does**: Visual breakdown of indexed files and symbols per folder.

**Command**: **Smart Indexer: Inspect Index**

**Shows**:
- Files indexed per folder
- Symbols per folder
- Total symbol count
- Nested folder breakdown

**Benefit**: Understand what's indexed, debug indexing issues.

---

## Feature Comparison

### Smart Indexer vs. VS Code Native TypeScript

| Feature | Smart Indexer | VS Code Native |
|---------|---------------|----------------|
| **Startup** | Instant (<100ms) | Slow (seconds for large projects) |
| **Persistence** | Yes (disk shards) | No (rebuilds on restart) |
| **Type Awareness** | No | Yes (full type graph) |
| **Works on Invalid Code** | Yes (fault-tolerant) | Limited (needs valid types) |
| **Multi-language** | Yes (8 languages) | No (TS/JS only) |
| **Fuzzy Search** | Yes (acronyms, ranking) | Limited |
| **Reference Tracking** | Yes (AST-based) | Yes (semantic) |
| **Import Resolution** | Basic (relative paths) | Full (module resolution) |
| **Scalability** | Excellent (sharded) | Good (in-memory) |

---

## Recursive Re-exports

**What it does**: Follows barrel files (`index.ts` that re-export from other files).

**Example**:
```typescript
// components/index.ts (barrel file)
export { Button } from './Button';
export { Input } from './Input';

// app.ts
import { Button } from './components';  // Re-export resolved ✓
```

**Implementation**:
- Tracks `ReExportInfo` during indexing
- Follows export chains up to 5 levels deep
- Prevents infinite loops with visited set

**Benefit**: Navigate through barrel files accurately.

---

## Definition-only vs. True Reference Tracking

### Old Behavior (v0.0.1)

**\"Find References\" algorithm**:
1. Find all symbols with matching name
2. Return their definition locations
3. No actual usage tracking

**Problem**: Missed where symbols were actually used.

### New Behavior (v0.0.2+)

**\"Find References\" algorithm**:
1. Index `Identifier` usages during AST traversal
2. Store reference locations in shards
3. Query references from merged index
4. Return actual usage locations

**Result**: True \"Find All References\" functionality.

---

## Planned Features

### Near-term

1. **Full Import Graph**: Track all import/export relationships
2. **Type Inference**: Limited type information without full type-checking
3. **Cross-Project Navigation**: Monorepo support with project references
4. **LSIF Export**: Export to standardized Language Server Index Format

### Research

- **Partial Type Checking**: Lightweight type resolution for local scopes
- **Cached Type Information**: Store inferred types in shards
- **Distributed Indexing**: Multi-machine indexing for very large repos

---

## Summary

Smart Indexer provides:
- ✅ **Fast**: Instant cold start, <10ms queries
- ✅ **Persistent**: Index survives restarts
- ✅ **Accurate**: Import resolution, reference tracking, fuzzy search
- ✅ **Scalable**: Sharded storage, parallel indexing
- ✅ **Intelligent**: Hybrid mode, semantic disambiguation
- ✅ **Flexible**: Multi-language support, static indices

**Best Use Case**: Large TypeScript/JavaScript projects where instant cold start and persistent indexing provide significant productivity gains, with Hybrid Mode for best accuracy.
