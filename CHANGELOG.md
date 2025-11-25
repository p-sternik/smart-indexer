# Change Log

All notable changes to the "smart-indexer" extension will be documented in this file.

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