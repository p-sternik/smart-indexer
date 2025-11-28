# Changelog

All notable changes to the "smart-indexer" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.28.0](https://github.com/p-sternik/smart-indexer/compare/v1.27.0...v1.28.0) (2025-11-28)


### Features

* Optimize NgRx action group lookup by iterating over files instead of symbols ([94e8e18](https://github.com/p-sternik/smart-indexer/commit/94e8e182311eddcf0558752483a61ad70dfce78b))

## [1.27.0](https://github.com/p-sternik/smart-indexer/compare/v1.26.0...v1.27.0) (2025-11-28)


### Features

* Enhance finalization logging and progress tracking in indexing process ([f6cdac7](https://github.com/p-sternik/smart-indexer/commit/f6cdac7edb7a0e93eaa02c21d9ca762e3c94299e))

## [1.26.0](https://github.com/p-sternik/smart-indexer/compare/v1.25.0...v1.26.0) (2025-11-28)


### Features

* Add finalizing state to progress callback and update status bar ([b270349](https://github.com/p-sternik/smart-indexer/commit/b270349642bc9aef2a032d7a9eeb5acf8c5d6485))

## [1.25.0](https://github.com/p-sternik/smart-indexer/compare/v1.24.0...v1.25.0) (2025-11-28)


### Features

* Enhance debugging and error handling in file indexing process ([1dc9491](https://github.com/p-sternik/smart-indexer/commit/1dc94916f4dea9e76e4cef65b961895d8b39cf2d))

## [1.24.0](https://github.com/p-sternik/smart-indexer/compare/v1.23.0...v1.24.0) (2025-11-28)


### Features

* Ensure progress callback is emitted on error during indexing ([03c118f](https://github.com/p-sternik/smart-indexer/commit/03c118f2cf45043579f91a2cb9b5ba09b011e7c1))

## [1.23.0](https://github.com/p-sternik/smart-indexer/compare/v1.22.0...v1.23.0) (2025-11-28)


### Features

* Add error handling and reporting for code parsing in extractCodeSymbolsAndReferences ([842d363](https://github.com/p-sternik/smart-indexer/commit/842d36338dbe357a917f532d1a8a319cbb521484))

## [1.22.0](https://github.com/p-sternik/smart-indexer/compare/v1.21.0...v1.22.0) (2025-11-28)


### Features

* Enhance file handling by adding path sanitization and error management ([d2bd64f](https://github.com/p-sternik/smart-indexer/commit/d2bd64fbc4e71b0b5ff907abc7f9f5a6912b48df))

## [1.21.0](https://github.com/p-sternik/smart-indexer/compare/v1.20.0...v1.21.0) (2025-11-28)


### Features

* Improve change detection by using raw git diff for accurate file tracking ([1937920](https://github.com/p-sternik/smart-indexer/commit/1937920f9786832fb619cebb2ae0fa4d83b4fb6d))

## [1.20.0](https://github.com/p-sternik/smart-indexer/compare/v1.19.0...v1.20.0) (2025-11-28)


### Features

* Update release workflow to publish VSIX package to VS Code Marketplace ([6153e2d](https://github.com/p-sternik/smart-indexer/commit/6153e2d928e4c2585ff878144d3dccc4163890e8))
* Update release workflow to create and upload VSIX package for VS Code Marketplace ([ec5328b](https://github.com/p-sternik/smart-indexer/commit/ec5328ba8860a72a57d4686da7acc2590ee7031e))
* Update release workflow for VS Code Marketplace with improved Node.js version and removed unnecessary steps ([1335f2a](https://github.com/p-sternik/smart-indexer/commit/1335f2a33a6548e13e4aac85e072f0a117d77094))


### Bug Fixes

* Correct environment variable name for VS Code Marketplace token in release workflow ([abd470e](https://github.com/p-sternik/smart-indexer/commit/abd470e5ba6aeb7b93cff45bcb2e23eedaf296e9))

## [1.19.0](https://github.com/p-sternik/smart-indexer/compare/v1.18.0...v1.19.0) (2025-11-28)


### Features

* Enhance GitWatcher and BackgroundIndex with path sanitization and file existence checks ([48e36eb](https://github.com/p-sternik/smart-indexer/commit/48e36eb1076796651a158f1629f306e738188fcc))

## [1.18.0](https://github.com/p-sternik/smart-indexer/compare/v1.17.0...v1.18.0) (2025-11-28)


### Features

* Implement ShardPersistenceManager for centralized shard I/O management and buffering ([09625c2](https://github.com/p-sternik/smart-indexer/commit/09625c20ffaf2c1194924da48f087440d44966f3))

## [1.17.0](https://github.com/p-sternik/smart-indexer/compare/v1.16.0...v1.17.0) (2025-11-28)


### Features

* Enhance WorkerPool with task timeout management and crash recovery ([8449a9c](https://github.com/p-sternik/smart-indexer/commit/8449a9c4e8014f42c1829bebfb94daa7ac38c344))

## [1.16.0](https://github.com/p-sternik/smart-indexer/compare/v1.15.0...v1.16.0) (2025-11-28)


### Features

* Implement shard locking to prevent concurrent writes and enhance NgRx reference resolution ([a12190d](https://github.com/p-sternik/smart-indexer/commit/a12190d17b79d35b7107c02e49a9abe8db8e569f))

## [1.15.0](https://github.com/p-sternik/smart-indexer/compare/v1.14.0...v1.15.0) (2025-11-28)


### Features

* Refine deferred reference resolution strategy for NgRx action groups ([98165b2](https://github.com/p-sternik/smart-indexer/commit/98165b2462f1c39bb8d977fe1b2651ee69542919))

## [1.14.0](https://github.com/p-sternik/smart-indexer/compare/v1.13.0...v1.14.0) (2025-11-28)


### Features

* Enhance reference handling for NgRx action groups to prevent duplicates ([33ac1db](https://github.com/p-sternik/smart-indexer/commit/33ac1db247a4f55b2a853db6c6bc42b7261e1a51))

## [1.13.0](https://github.com/p-sternik/smart-indexer/compare/v1.12.0...v1.13.0) (2025-11-28)


### Features

* Implement bulk indexing and deferred NgRx resolution for performance optimization ([3937630](https://github.com/p-sternik/smart-indexer/commit/39376308e8d0ab9ccb7d2601097bba053ee71435))

## [1.12.0](https://github.com/p-sternik/smart-indexer/compare/v1.11.0...v1.12.0) (2025-11-28)


### Features

* Enhance searchSymbols with fuzzy matching and duplicate prevention ([959c4f9](https://github.com/p-sternik/smart-indexer/commit/959c4f9977fd73e9174db0b3f6d86a00a8b569b8))

## [1.11.0](https://github.com/p-sternik/smart-indexer/compare/v1.10.0...v1.11.0) (2025-11-28)


### Features

* Implement self-healing mechanism for DynamicIndex and enhance worker pool task prioritization ([4982570](https://github.com/p-sternik/smart-indexer/commit/4982570a4c4165259c781ce82950c38a88e5d0e7))

## [1.10.0](https://github.com/p-sternik/smart-indexer/compare/v1.9.0...v1.10.0) (2025-11-28)


### Features

* Remove Impact Analysis feature and related components ([0a89ded](https://github.com/p-sternik/smart-indexer/commit/0a89ded4c3f487ccfb59cdccc2f948942ab3cfcf))

## [1.9.0](https://github.com/p-sternik/smart-indexer/compare/v1.8.0...v1.9.0) (2025-11-28)


### Features

* Add quick menu and progress notifications for indexing operations ([5b5a99c](https://github.com/p-sternik/smart-indexer/commit/5b5a99c58646199835d895d6d5f9c730b9bad54b))

## [1.8.0](https://github.com/p-sternik/smart-indexer/compare/v1.7.0...v1.8.0) (2025-11-28)


### Features

* Enhance NgRx support with cross-file reference resolution and pending references handling ([0ba1957](https://github.com/p-sternik/smart-indexer/commit/0ba195758969d20e9c7ab242f5242dae79435dd1))

## [1.7.0](https://github.com/p-sternik/smart-indexer/compare/v1.6.3...v1.7.0) (2025-11-28)


### Features

* Implement cross-platform publish script for README management ([301a33c](https://github.com/p-sternik/smart-indexer/commit/301a33c6261b6591ad406522cb04bf0aa916d1c2))

## [1.6.3](https://github.com/p-sternik/smart-indexer/compare/v1.6.2...v1.6.3) (2025-11-27)


### Bug Fixes

* Update version and readme path in package.json; modify .vscodeignore to include additional files ([d4ba91d](https://github.com/p-sternik/smart-indexer/commit/d4ba91d94be308c1d299300c81b288fcff621c81))

## [1.6.2](https://github.com/p-sternik/smart-indexer/compare/v1.6.1...v1.6.2) (2025-11-27)


### Bug Fixes

* Correct readme path in package.json ([3e59b73](https://github.com/p-sternik/smart-indexer/commit/3e59b73c49f7a6d11a208776526fc4013d3da4db))

## [1.6.1](https://github.com/p-sternik/smart-indexer/compare/v1.6.0...v1.6.1) (2025-11-27)


### Bug Fixes

* Update readme path in package.json to correct location ([72183af](https://github.com/p-sternik/smart-indexer/commit/72183afea28cc818457b206143938071870bab5d))

## [1.6.0](https://github.com/p-sternik/smart-indexer/compare/v1.5.0...v1.6.0) (2025-11-27)


### Features

* Implement NgRx createActionGroup support with virtual symbol generation ([4191245](https://github.com/p-sternik/smart-indexer/commit/4191245e2204ac08073bed7eee8d9ba1ab955ce0))

## [1.5.0](https://github.com/p-sternik/smart-indexer/compare/v1.4.0...v1.5.0) (2025-11-27)


### Features

* Implement NgRx Pattern Recognition with modern and legacy support ([3005df3](https://github.com/p-sternik/smart-indexer/commit/3005df30de1553232df4635b13f3fe25eb66d867))

## [1.4.0](https://github.com/p-sternik/smart-indexer/compare/v1.3.0...v1.4.0) (2025-11-27)


### Features

* Add Smart Indexer quick reference documentation ([160b3e9](https://github.com/p-sternik/smart-indexer/commit/160b3e98984497025cd28a5861d9a383f2e3d2d6))

## [1.3.0](https://github.com/p-sternik/smart-indexer/compare/v1.2.0...v1.3.0) (2025-11-27)


### Features

* Implement hybrid deduplication for definition and reference providers ([2bc62bc](https://github.com/p-sternik/smart-indexer/commit/2bc62bcba51fb5cb8f5b0abbd2902a25f86e60d7))

## [1.2.0](https://github.com/p-sternik/smart-indexer/compare/v1.1.0...v1.2.0) (2025-11-27)


### Features

* Implement worker pool optimization for Smart Indexer ([1a348a0](https://github.com/p-sternik/smart-indexer/commit/1a348a01f7b25b369ab1a0eceb2f8f49c62249ca))

## [1.1.0](https://github.com/p-sternik/smart-indexer/compare/v1.0.0...v1.1.0) (2025-11-27)


### Features

* implement worker pool and integrate with background indexing for improved performance ([ef57176](https://github.com/p-sternik/smart-indexer/commit/ef57176572483653d1eb917a7251b18cf1e7a09a))

## 1.0.0 (2025-11-27)


### Features

* update release notes generator and configure Git date format ([82be80e](https://github.com/p-sternik/smart-indexer/commit/82be80ef35400cc0eb7b2233c9c271dd870d5b91))
* Implement Generic Symbol Resolution Engine for enhanced "Go to Definition" functionality ([e532de0](https://github.com/p-sternik/smart-indexer/commit/e532de0c0d07b2b0c053fb89273e396a58e4dbd9))
* update version to 0.0.5 and enhance semantic release with debug option ([cac77fb](https://github.com/p-sternik/smart-indexer/commit/cac77fb2bdee3b303a0893d791ba6541850be27c))
* implement hashed directory structure for shard storage ([aec13a5](https://github.com/p-sternik/smart-indexer/commit/aec13a5d88b1303c8383359deb49228ebf98b319))
* resolve startup crash by bundling server dependencies and updating README ([b039444](https://github.com/p-sternik/smart-indexer/commit/b039444b7d60bf118d24d5cddad4366bc8120a41))
* add semantic release configuration and setup documentation ([dacd1f2](https://github.com/p-sternik/smart-indexer/commit/dacd1f2fbc2355b9759f255d6302b008fa01b3b9))
* **dead-code:** add dead code detection feature with analysis and reporting ([2883d60](https://github.com/p-sternik/smart-indexer/commit/2883d60cd669a8bff33e7259df2bf415834edc86))
* Implement symbol disambiguation and fuzzy search utilities ([a53a88c](https://github.com/p-sternik/smart-indexer/commit/a53a88c2a781a73cf8a40f53f577bf17350d51b7))


### Bug Fixes

* downgrade conventional-changelog-conventionalcommits to 7.0.2 to resolve RangeError ([f043e0f](https://github.com/p-sternik/smart-indexer/commit/f043e0f7f84db06c499652e1ce9060e0673a51e5))
* disable commit sorting in release notes generator ([4314474](https://github.com/p-sternik/smart-indexer/commit/431447454f080d42ff6fe231b152c507067bba59))
* correct key name for VSIX publishing configuration ([d175c54](https://github.com/p-sternik/smart-indexer/commit/d175c54b553f2d16e8addc56266c752d832a0f22))
* disable VSIX publishing in release configuration ([385f39a](https://github.com/p-sternik/smart-indexer/commit/385f39a3e2348b84c90f224721da446121884295))
* update branch name from main to master in configuration files ([1df8887](https://github.com/p-sternik/smart-indexer/commit/1df8887a0a5acae6696f041f9aea16686a8d3da0))
* update branch name from main to master in release workflow ([d0a8909](https://github.com/p-sternik/smart-indexer/commit/d0a890941d0509153f6d2b5a9f699f9e73eaf7d5))

# Change Log

All notable changes to the "smart-indexer" extension will be documented in this file.

## [0.0.5] - 2025-11-27

### Performance
- **Hashed Directory Structure**: Implemented nested directory structure for index shards (`.smart-index/index/<prefix1>/<prefix2>/<hash>.json`) to improve filesystem performance on large repositories with thousands of files
- Storage now uses 2-character hash prefixes for directory organization, preventing issues with flat directory structures containing 50,000+ files

### Safety
- **Automatic .gitignore Configuration**: Cache directory is now automatically added to `.gitignore` on extension activation to prevent accidental commits of index files

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
