# Change Log

All notable changes to the "smart-indexer" extension will be documented in this file.

## [0.0.4] - 2025-11-27

### Fixed
- **Critical**: Resolved crash on startup due to missing `vscode-languageserver` dependency in packaged extension
  - Created server-specific `package.json` with required dependencies
  - Implemented esbuild bundling for server code to create self-contained `server.js`
  - Server dependencies now properly bundled into production `.vsix` package

## [0.0.4] - 2025-11-26

### Major Improvements - Stability & Dead Code Detection

#### Added
- **Stable Symbol IDs**: Content-based identifiers that survive code shifts
  - New ID format: `<fileHash>:<semanticPath>[#signatureHash]`
  - Position-independent (IDs don't break when adding/removing lines)
  - File hash based on path (8 chars) + semantic path (e.g., `UserService.save`)
  - Signature hash for overloaded methods/functions
  - Shard version bumped to 2 for automatic migration

- **Scope-Based Reference Filtering**: Accurate local variable tracking
  - New `ScopeTracker` class tracks lexical scopes during AST traversal
  - `IndexedReference` now includes `scopeId` and `isLocal` fields
  - Eliminates false positives for local variables in "Find References"
  - Enhanced `findReferencesByName()` with `excludeLocal` and `scopeId` options
  - Automatically registers function/method parameters as local variables

- **Dead Code Detection (Beta)**: Find unused exports
  - New command: `Smart Indexer: Find Dead Code (Beta)`
  - Analyzes cross-file references to identify unused exports
  - Confidence scoring: High (no refs) / Medium (few same-file refs) / Low (many refs)
  - Excludes symbols with `@public` or `@api` JSDoc tags
  - QuickPick UI with navigation to symbol definitions
  - Supports configurable exclusion patterns (node_modules, tests, etc.)

#### Changed
- Shard format version bumped from 1 to 2
- Automatic re-indexing when old shard format detected
- Symbol ID generation now uses MD5 hash of file path + semantic path

#### Fixed
- Symbol references breaking when code shifts (adding/removing lines above)
- False positives in "Find References" for local variables with common names
- Reference tracking now distinguishes local vs global scope

#### Documentation
- Added `IMPLEMENTATION_SUMMARY.md` - Detailed technical documentation
- Added `IMPROVEMENTS_QUICK_REFERENCE.md` - User-facing quick reference guide
- Added `IMPLEMENTATION_COMPLETE.md` - Implementation checklist and status
- Updated README.md with new features and commands

## [0.2.0] - 2025-11-26

### Major Phase 2 Improvements - Enhanced Accuracy & UX

#### Added
- **Hybrid Mode**: Intelligent delegation to VS Code's native TypeScript server for higher accuracy
  - New `smartIndexer.mode` configuration: `"hybrid"` | `"standalone"` | `"disabled"`
  - Configurable timeout (`smartIndexer.hybridTimeoutMs`, default 100ms)
  - Falls back to Smart Indexer if tsserver is slow or returns no results
  - Eliminates duplicate results from competing providers

- **Import Resolution**: Support for relative imports and partial path mapping
  - New `ImportResolver` class maps imported symbols to exact source files
  - Handles relative imports (`./foo`, `../bar`) with proper file extension resolution
  - Significantly reduces false positives in "Go to Definition"
  - Example: `import { Foo } from './bar'` now resolves to exact file

- **True Reference Tracking**: Now indexes actual symbol usages, not just definitions
  - Tracks `Identifier`, `CallExpression`, and `MemberExpression` nodes during AST traversal
  - Creates `IndexedReference` entries for actual symbol usages
  - "Find References" now returns where symbols are actually used
  - Improved cross-file reference tracking

- **Semantic Disambiguation**: Optional TypeChecker fallback for ambiguous symbols
  - Lightweight `TypeScriptService` class for on-demand semantic resolution
  - Uses `getSymbolAtLocation()` to disambiguate multiple symbols with same name
  - Faster than full tsserver, more accurate than pure AST analysis
  - Configurable timeout (default 200ms)

- **Fuzzy Search & Ranking** (Step 3):
  - Acronym matching: "CFA" finds "CompatFieldAdapter"
  - CamelCase boundary detection with +25 point bonus
  - Word boundary support for delimiters (`_`, `-`, `.`, `/`, `\`)
  - Smart relevance ranking with multiple factors
  - Symbol kind prioritization (classes > functions > variables)
  - Proximity-based ranking (same/parent/sibling directories)
  - Batched processing prevents UI blocking for large result sets

#### Changed
- **Significantly reduced false positives** in "Find References"
  - Now tracks actual usages instead of just matching names
  - Container-based filtering for better precision
  
- **Improved "Go to Definition" accuracy** for common method names
  - Import resolution eliminates false matches from other files
  - Semantic disambiguation handles ambiguous cases
  - Proximity ranking prioritizes likely candidates

- **Enhanced workspace symbol search**:
  - Fuzzy matching supports acronyms and partial strings
  - Results ranked by relevance (open files, proximity, symbol kind)
  - Increased result limit from 100 to 200
  - Batched processing for non-blocking search

#### Performance
- Batched symbol ranking (1000 symbols per batch)
- Event loop yielding prevents UI freezing
- Maximum 50ms blocking time per batch (down from 500ms+)

#### Documentation
- Created comprehensive `docs/` folder structure
- `docs/ARCHITECTURE.md` - System architecture and design
- `docs/FEATURES.md` - Complete feature documentation
- `docs/CONFIGURATION.md` - All configuration settings
- Migrated content from `SMART_INDEXER_VS_VSCODE_NATIVE.md`

## [0.0.2] - 2025-11-25

### Major Architecture Refactoring - Clangd-Inspired Index Design

#### Added
- **New Index Architecture** following clangd design principles:
  - `ISymbolIndex` interface - Core abstraction for all index implementations
  - `DynamicIndex` - Fast in-memory index for currently open/edited files
  - `BackgroundIndex` - Persistent sharded index for the entire workspace
  - `MergedIndex` - Unified view combining dynamic and background indices
  - `StatsManager` - Centralized statistics tracking and aggregation

- **Sharded Storage System**:
  - Per-file shards stored as JSON in `.smart-index/index/<hash>.json`
  - Each shard contains: uri, content hash, symbols, timestamp
  - Lazy loading: shards loaded from disk only when needed
  - Incremental updates: only changed files are re-indexed

- **Parallel Indexing**:
  - Configurable worker pool for background indexing
  - New setting: `smartIndexer.maxConcurrentIndexJobs` (1-16, default 4)
  - 2-4x faster workspace indexing on multi-core systems

- **Enhanced Statistics**:
  - Separate metrics for dynamic and background indices
  - Total shard count
  - Last full/incremental index timestamps
  - Detailed breakdown in statistics display

- **New Configuration Options**:
  - `smartIndexer.maxConcurrentIndexJobs` - Control parallel indexing (default 4)
  - `smartIndexer.enableBackgroundIndex` - Toggle background indexing (default true)

#### Changed
- **Complete Server Refactoring** (`server/src/server.ts`):
  - Removed dependency on `CacheManager` and `SqlJsStorage`
  - All LSP handlers now use `MergedIndex` for queries
  - Document events update `DynamicIndex` directly
  - Background indexing runs asynchronously with worker pool
  - Git integration triggers incremental background updates

- **Indexing Strategy**:
  - Open files: Updated in `DynamicIndex` (instant, in-memory)
  - Workspace files: Indexed in `BackgroundIndex` (persistent, sharded)
  - Queries: `MergedIndex` combines both (dynamic has priority)

- **Storage Migration**:
  - Old: Single SQLite database (`.smart-index/index.sqlite`)
  - New: Per-file JSON shards (`.smart-index/index/<hash>.json`)
  - Metadata: Simple JSON file (`.smart-index/metadata.json`)

#### Improved
- **Memory Efficiency**:
  - Background index keeps only lightweight metadata in RAM
  - Full symbol data loaded lazily from shards
  - Dynamic index only holds open files (automatically cleaned on close)
  - Scales to very large workspaces (1000+ files)

- **Performance**:
  - Parallel indexing: 2-4x faster on multi-core CPUs
  - Incremental updates: Only changed files re-indexed
  - Open files: Instant updates (no disk I/O)
  - Lazy loading: Better memory usage and startup time

- **Maintainability**:
  - Clean interface-based design
  - Each index type has single responsibility
  - Well-factored modules
  - Comprehensive documentation

#### Documentation
- `INDEX_ARCHITECTURE.md` - Detailed architecture documentation
- `REFACTORING_SUMMARY.md` - Summary of changes
- `TESTING_GUIDE.md` - Comprehensive testing guide
- `verify-architecture.ps1` - Automated verification script

#### Notes
- **Backward Compatibility**: All existing LSP features work the same
- **Migration**: Old `.smart-index/index.sqlite` no longer used (will auto-rebuild)
- **Breaking**: Users need to rebuild index on first run (automatic)

### Technical Details

**Index Query Flow**:
1. LSP request arrives (definition, references, workspace symbol)
2. Query goes to `MergedIndex`
3. `MergedIndex` checks `DynamicIndex` first (open files)
4. Falls back to `BackgroundIndex` (lazily loads shards)
5. Results merged and deduplicated
6. Response sent to client

**Background Indexing Flow**:
1. Scan workspace for indexable files
2. Compare content hashes with existing shards
3. Queue changed files for indexing
4. Process in parallel (configurable worker pool)
5. Write updated shards to disk
6. Update in-memory metadata and symbol name index

**Dynamic Index Flow**:
1. File opened → add to dynamic index
2. File changed → update dynamic index (debounced 500ms)
3. File closed → remove from dynamic index
4. Background index retains persistent data

## [0.0.1] - 2025-11-25

### Added
- Initial release with LSP-based architecture
- Fast IntelliSense support (definitions, references, workspace symbols, completion)
- Persistent SQLite cache for index data
- Git-aware incremental indexing
- Support for TypeScript and JavaScript files (.ts, .tsx, .js, .jsx, .mts, .cts, .mjs, .cjs)
- Commands:
  - Rebuild Index
  - Clear Cache
  - Show Statistics
- Configuration options:
  - Cache directory location
  - Git integration toggle
  - Exclude patterns
  - Maximum file size limit
- Status bar indicator
- Real-time file change monitoring and incremental updates