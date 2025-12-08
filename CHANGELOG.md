# Changelog

All notable changes to the "smart-indexer" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.67.0](https://github.com/p-sternik/smart-indexer/compare/v1.66.0...v1.67.0) (2025-12-08)


### Features

* enhance dead code analysis to be non-blocking and implement precision filtering for definition results ([b9e8a32](https://github.com/p-sternik/smart-indexer/commit/b9e8a327bd353391d38f13abf2e974dc09f40c94))

## [1.66.0](https://github.com/p-sternik/smart-indexer/compare/v1.65.0...v1.66.0) (2025-12-08)


### Features

* enhance traverseAST to utilize identifier node for improved symbol location tracking ([5d7b9e4](https://github.com/p-sternik/smart-indexer/commit/5d7b9e45d4c6051d2ab5df365ef38dd877a67dc3))

## [1.65.0](https://github.com/p-sternik/smart-indexer/compare/v1.64.0...v1.65.0) (2025-12-08)


### Features

* update fileScanner to support skipping folder hash optimization during full workspace scans ([6fbb645](https://github.com/p-sternik/smart-indexer/commit/6fbb64530f7320741c6e0d6268597271a18502ec))

## [1.64.0](https://github.com/p-sternik/smart-indexer/compare/v1.63.0...v1.64.0) (2025-12-08)


### Features

* enhance tryResolveFile to support ESM imports with .js extensions ([d0b4299](https://github.com/p-sternik/smart-indexer/commit/d0b42996e3c68d64b37cd8684c971e615701f866))

## [1.63.0](https://github.com/p-sternik/smart-indexer/compare/v1.62.0...v1.63.0) (2025-12-08)


### Features

* add WorkspaceSymbolHandler for workspace-wide symbol search with FTS5 ([3ff3bd5](https://github.com/p-sternik/smart-indexer/commit/3ff3bd50b3f957cc17eb7e315b168a2731ed615e))

## [1.62.0](https://github.com/p-sternik/smart-indexer/compare/v1.61.2...v1.62.0) (2025-12-08)


### Features

* implement full-text search and schema versioning in SqlJsStorage ([c883ac5](https://github.com/p-sternik/smart-indexer/commit/c883ac5498a94d7966b59b7982ee4139f16230ce))

## [1.61.2](https://github.com/p-sternik/smart-indexer/compare/v1.61.1...v1.61.2) (2025-12-07)


### Bug Fixes

* run server tests inside virtual display to resolve missing X server error ([ca00c81](https://github.com/p-sternik/smart-indexer/commit/ca00c8185349c8e4da3a16690194719b209f17b0))


### Code Refactoring

* remove pnpm configuration for onlyBuiltDependencies in package.json ([9db1fbc](https://github.com/p-sternik/smart-indexer/commit/9db1fbc852d9af66d149bfe31da57d44b5f47fbd))

## [1.61.1](https://github.com/p-sternik/smart-indexer/compare/v1.61.0...v1.61.1) (2025-12-07)


### Bug Fixes

* **dependencies:** downgrade TypeScript to version 5.6.3 and update Node.js engine requirement ([2f1b1d3](https://github.com/p-sternik/smart-indexer/commit/2f1b1d390bfd173d7fcd021b00dc0b4abc4db042))
* **dependencies:** update chokidar to version 4.0.0 and remove unused @types/minimatch ([5b4135a](https://github.com/p-sternik/smart-indexer/commit/5b4135a3508277331d701668a14776518e58017a))


### Code Refactoring

* **provider:** update HybridDefinitionProvider and HybridReferencesProvider to return only complementary results ([eac28a6](https://github.com/p-sternik/smart-indexer/commit/eac28a6ce18bb1dbde4fee05abdf152b6117fe58))

## [1.61.0](https://github.com/p-sternik/smart-indexer/compare/v1.60.0...v1.61.0) (2025-12-07)


### Features

* **storage:** enhance crash recovery and implement atomic writes for SqlJsStorage ([a545fcb](https://github.com/p-sternik/smart-indexer/commit/a545fcb33965b03c3ee95fcb693ce58ec1e86770))

## [1.60.0](https://github.com/p-sternik/smart-indexer/compare/v1.59.1...v1.60.0) (2025-12-07)


### Features

* **indexing:** add support for limiting concurrent indexing jobs and handle unsupported file types ([6b2a431](https://github.com/p-sternik/smart-indexer/commit/6b2a4318f25f27d1f9b86540b2c3ec11a03af8df))

## [1.59.1](https://github.com/p-sternik/smart-indexer/compare/v1.59.0...v1.59.1) (2025-12-07)


### Code Refactoring

* remove unused variables and parameters across multiple files ([87e3992](https://github.com/p-sternik/smart-indexer/commit/87e399288c1771c53d9e3b9de09dcb401fd6526b))

## [1.59.0](https://github.com/p-sternik/smart-indexer/compare/v1.58.0...v1.59.0) (2025-12-07)


### Features

* **storage:** add WASM file handling and verification in SqlJsStorage ([adb4861](https://github.com/p-sternik/smart-indexer/commit/adb4861271d388014f75bdbd3e2dbb92fd616399))

## [1.58.0](https://github.com/p-sternik/smart-indexer/compare/v1.57.0...v1.58.0) (2025-12-07)


### Features

* **logging:** Implement unified LoggerService for centralized logging ([2e5340a](https://github.com/p-sternik/smart-indexer/commit/2e5340aeb8b32b60fb81eccc6bb90afebb7b401c))

## [1.57.0](https://github.com/p-sternik/smart-indexer/compare/v1.56.0...v1.57.0) (2025-12-07)


### Features

* update package dependencies and improve WASM file handling in SqlJsStorage ([4447a77](https://github.com/p-sternik/smart-indexer/commit/4447a77ecd1dea6c4da07f6ecccbf483971f2e72))

## [1.56.0](https://github.com/p-sternik/smart-indexer/compare/v1.55.0...v1.56.0) (2025-12-07)


### Features

* introduce application-wide constants and refactor indexing logic with IndexScheduler ([2d52026](https://github.com/p-sternik/smart-indexer/commit/2d52026be16a09138a45c9e64104b0839f0e27ad))

## [1.55.0](https://github.com/p-sternik/smart-indexer/compare/v1.54.0...v1.55.0) (2025-12-07)


### Features

* enhance symbol handling with definition filtering and improved fuzzy scoring ([3b49b34](https://github.com/p-sternik/smart-indexer/commit/3b49b341af98897a6d1eaedf4682441bc35ea5fc))

## [1.54.0](https://github.com/p-sternik/smart-indexer/compare/v1.53.0...v1.54.0) (2025-12-01)


### Features

* consolidate CI workflows into a single pipeline.yml and remove legacy release.yml ([eda017f](https://github.com/p-sternik/smart-indexer/commit/eda017f287097c73ae382a94252a463802d12fff))


### Bug Fixes

* run tests inside virtual display to resolve "Missing X server or $DISPLAY" error ([ed3d5c1](https://github.com/p-sternik/smart-indexer/commit/ed3d5c1c10457edc095dad13c18332ad19ac7af0))

## [1.53.0](https://github.com/p-sternik/smart-indexer/compare/v1.52.0...v1.53.0) (2025-11-30)


### Features

* update tsconfig to exclude test files from compilation ([4b1c0e3](https://github.com/p-sternik/smart-indexer/commit/4b1c0e34f1092f9a405778d8c77f08f2b45ad07d))
* migrate tests to Vitest and remove legacy workerTest script ([231226c](https://github.com/p-sternik/smart-indexer/commit/231226cb88bcccbf554fd3b038301da82f20927e))

## [1.52.0](https://github.com/p-sternik/smart-indexer/compare/v1.51.0...v1.52.0) (2025-11-30)


### Features

* refactor ShardStore and worker to use dependency injection for persistence and plugin registry ([6ebb36f](https://github.com/p-sternik/smart-indexer/commit/6ebb36fc2d5730f39990cc984aadb21cf4dca2da))

## [1.51.0](https://github.com/p-sternik/smart-indexer/compare/v1.50.0...v1.51.0) (2025-11-30)


### Features

* simplify property handling in traverseAST by consolidating symbol internment and NgRx metadata management ([2ea9666](https://github.com/p-sternik/smart-indexer/commit/2ea96663abcb1eacfa0a63ab0511eaccbdfe5394))

## [1.50.0](https://github.com/p-sternik/smart-indexer/compare/v1.49.0...v1.50.0) (2025-11-30)


### Features

* enhance BackgroundIndex with dependency injection and add Angular parsing tests ([2252c99](https://github.com/p-sternik/smart-indexer/commit/2252c999305ac687ecd5b4b160e31fdef06f443e))

## [1.49.0](https://github.com/p-sternik/smart-indexer/compare/v1.48.0...v1.49.0) (2025-11-30)


### Features

* refactor shard management to use interfaces for improved testability and flexibility ([2a44252](https://github.com/p-sternik/smart-indexer/commit/2a442526619e439fb25ad5f5f825a08bae715c7a))

## [1.48.0](https://github.com/p-sternik/smart-indexer/compare/v1.47.0...v1.48.0) (2025-11-30)


### Features

* implement NgRxLinkResolver for deferred resolution of action group references ([b1f600d](https://github.com/p-sternik/smart-indexer/commit/b1f600db049c1a9a24dfd58641924a34408dae15))

## [1.47.0](https://github.com/p-sternik/smart-indexer/compare/v1.46.0...v1.47.0) (2025-11-30)


### Features

* enhance AST traversal to handle TSTypeReference and MemberExpression for improved symbol reference capturing ([3a6cc2f](https://github.com/p-sternik/smart-indexer/commit/3a6cc2fa6be29f4067f25bc5492fb63b178fd895))

## [1.46.0](https://github.com/p-sternik/smart-indexer/compare/v1.45.0...v1.46.0) (2025-11-30)


### Features

* implement deduplication of definition results to ensure unique locations per file ([f644fe5](https://github.com/p-sternik/smart-indexer/commit/f644fe54a369efe034337e2f165f069994f41b7c))

## [1.45.0](https://github.com/p-sternik/smart-indexer/compare/v1.44.0...v1.45.0) (2025-11-29)


### Features

* enhance dead code detection by checking usage of symbols by exported symbols ([2f2dad8](https://github.com/p-sternik/smart-indexer/commit/2f2dad8f5c840920cd5848fe8b3911d81b98f393))

## [1.44.0](https://github.com/p-sternik/smart-indexer/compare/v1.43.3...v1.44.0) (2025-11-29)


### Features

* add 'Find Dead Code in Folder' command and scope filtering for dead code analysis ([fba25dd](https://github.com/p-sternik/smart-indexer/commit/fba25dd16b7b78fdc9a60f5b66694c1cfa7e7c0f))

## [1.43.3](https://github.com/p-sternik/smart-indexer/compare/v1.43.2...v1.43.3) (2025-11-29)


### Code Refactoring

* optimize shard metadata loading and saving for improved startup performance ([63fcac5](https://github.com/p-sternik/smart-indexer/commit/63fcac5315c319f87feea5d26ac19fc70773bdcb))

## [1.43.2](https://github.com/p-sternik/smart-indexer/compare/v1.43.1...v1.43.2) (2025-11-29)


### Code Refactoring

* migrate file system operations to fs/promises for async support and adjust memory limits ([66611b3](https://github.com/p-sternik/smart-indexer/commit/66611b3f1e434e0b60e0ec7469780b45b8c73959))

## [1.43.1](https://github.com/p-sternik/smart-indexer/compare/v1.43.0...v1.43.1) (2025-11-29)


### Code Refactoring

* migrate file system operations to fs/promises for async support ([4591fef](https://github.com/p-sternik/smart-indexer/commit/4591fefd0cbc0422a303ca1b64cff3a6bc66635b))

## [1.43.0](https://github.com/p-sternik/smart-indexer/compare/v1.42.0...v1.43.0) (2025-11-29)


### Features

* Implement workspace-wide dead code analysis with progress reporting and cancellation support ([1b12059](https://github.com/p-sternik/smart-indexer/commit/1b12059faee5469b30b5a6cab501c422287a395c))

## [1.42.0](https://github.com/p-sternik/smart-indexer/compare/v1.41.0...v1.42.0) (2025-11-29)


### Features

* Enhance dead code analysis with cancellation and progress reporting ([5794448](https://github.com/p-sternik/smart-indexer/commit/579444855f5782746ec8b7d24e2a2789e4ade9d6))

## [1.41.0](https://github.com/p-sternik/smart-indexer/compare/v1.40.0...v1.41.0) (2025-11-29)


### Features

* Refactor file operations to use async I/O for improved performance and non-blocking behavior ([2618f16](https://github.com/p-sternik/smart-indexer/commit/2618f160255a285eeacb2c82540c7502fdac83dd))

## [1.40.0](https://github.com/p-sternik/smart-indexer/compare/v1.39.0...v1.40.0) (2025-11-29)


### Features

* Refactor ShardPersistenceManager to use async file operations and implement lock reference counting ([bd6ce27](https://github.com/p-sternik/smart-indexer/commit/bd6ce27576deb3bc19600e4cc563f77674bb245b))

## [1.39.0](https://github.com/p-sternik/smart-indexer/compare/v1.38.0...v1.39.0) (2025-11-29)


### Features

* Integrate LRU caching and optimize SQL queries for improved performance ([0a1cdb4](https://github.com/p-sternik/smart-indexer/commit/0a1cdb4b4859668ed8c4856a2d31a86b344169a8))

## [1.38.0](https://github.com/p-sternik/smart-indexer/compare/v1.37.0...v1.38.0) (2025-11-29)


### Features

* Add DeadCodeHandler for detecting and publishing diagnostics of unused exports ([351036d](https://github.com/p-sternik/smart-indexer/commit/351036d12e6af017e6de16237a206d5d458e2aab))

## [1.37.0](https://github.com/p-sternik/smart-indexer/compare/v1.36.0...v1.37.0) (2025-11-29)


### Features

* Implement LRU caching in BackgroundIndex to reduce disk I/O; optimize DynamicIndex with symbol name indexing for efficient lookups ([bce0c0b](https://github.com/p-sternik/smart-indexer/commit/bce0c0b16cc5a19a5187403be9e68837105d666d))

## [1.36.0](https://github.com/p-sternik/smart-indexer/compare/v1.35.0...v1.36.0) (2025-11-29)


### Features

* Enhance CompletionHandler and ShardPersistenceManager with async I/O; optimize BackgroundIndex for memory management and performance ([3d00d4d](https://github.com/p-sternik/smart-indexer/commit/3d00d4d6c8dcb55b9dbb7480519a72328eca1098))

## [1.35.0](https://github.com/p-sternik/smart-indexer/compare/v1.34.0...v1.35.0) (2025-11-29)


### Features

* Refactor Definition and References handlers to use shared getWordRangeAtPosition utility; improve deadlock handling in BackgroundIndex ([67486e8](https://github.com/p-sternik/smart-indexer/commit/67486e8efef3338f8cbd3b04e80dfed1b3ed0d56))

## [1.34.0](https://github.com/p-sternik/smart-indexer/compare/v1.33.0...v1.34.0) (2025-11-29)


### Features

* Add CompletionHandler to manage LSP textDocument/completion requests ([2a170fe](https://github.com/p-sternik/smart-indexer/commit/2a170fe2d06838af6f4c3126737d9e0b4c564008))

## [1.33.0](https://github.com/p-sternik/smart-indexer/compare/v1.32.0...v1.33.0) (2025-11-29)


### Features

* Implement LSP request handlers for Definition and References ([cce54e5](https://github.com/p-sternik/smart-indexer/commit/cce54e55fc377013edae8d7c1de8512475526005))

## [1.32.0](https://github.com/p-sternik/smart-indexer/compare/v1.31.0...v1.32.0) (2025-11-28)


### Features

* Implement loadShardNoLock and saveShardNoLock methods to prevent nested lock deadlocks ([5a5dcf3](https://github.com/p-sternik/smart-indexer/commit/5a5dcf3e52e636201004692b1a1c9cf4763c317b))

## [1.31.0](https://github.com/p-sternik/smart-indexer/compare/v1.30.0...v1.31.0) (2025-11-28)


### Features

* Optimize finalization of indexing by reducing I/O operations and improving reference resolution ([9e34d58](https://github.com/p-sternik/smart-indexer/commit/9e34d582c48620474660844095fff0eff6b41e85))

## [1.30.0](https://github.com/p-sternik/smart-indexer/compare/v1.29.0...v1.30.0) (2025-11-28)


### Features

* Implement compact storage format for shards and symbols to optimize memory usage ([7336afc](https://github.com/p-sternik/smart-indexer/commit/7336afc7d55ea1836a1374716751b70ac00b8b55))

## [1.29.0](https://github.com/p-sternik/smart-indexer/compare/v1.28.0...v1.29.0) (2025-11-28)


### Features

* Add MessagePack support for shard persistence and migration from JSON ([ab1a629](https://github.com/p-sternik/smart-indexer/commit/ab1a62964cdfa765d38f746cf0239070ef2aa16e))

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
