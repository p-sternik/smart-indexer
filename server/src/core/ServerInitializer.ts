import {
  Connection,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  DidChangeConfigurationNotification
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import * as path from 'path';
import * as crypto from 'crypto';

import { ConfigurationManager } from '../config/configurationManager.js';
import { DynamicIndex } from '../index/dynamicIndex.js';
import { BackgroundIndex } from '../index/backgroundIndex.js';
import { MergedIndex } from '../index/mergedIndex.js';
import { StaticIndex } from '../index/staticIndex.js';
import { StatsManager } from '../index/statsManager.js';
import { FileWatcher } from '../index/fileWatcher.js';
import { TypeScriptService } from '../typescript/typeScriptService.js';
import { DeadCodeDetector } from '../features/deadCode.js';
import { ImportResolver } from '../indexer/importResolver.js';
import { LanguageRouter } from '../indexer/languageRouter.js';
import { FileScanner } from '../indexer/fileScanner.js';
import { GitWatcher } from '../git/gitWatcher.js';
import { FolderHasher } from '../cache/folderHasher.js';
import { Profiler } from '../profiler/profiler.js';
import { FileSystemService } from '../utils/FileSystemService.js';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

/**
 * Result of server initialization.
 */
export interface InitializationResult {
  workspaceRoot: string;
  hasConfigurationCapability: boolean;
  hasWorkspaceFolderCapability: boolean;
  importResolver: ImportResolver | null;
  deadCodeDetector: DeadCodeDetector | null;
  fileWatcher: FileWatcher | null;
  staticIndex: StaticIndex | undefined;
}

/**
 * Dependencies required for server initialization.
 */
export interface ServerDependencies {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  configManager: ConfigurationManager;
  dynamicIndex: DynamicIndex;
  backgroundIndex: BackgroundIndex;
  mergedIndex: MergedIndex;
  statsManager: StatsManager;
  typeScriptService: TypeScriptService;
  languageRouter: LanguageRouter;
  fileScanner: FileScanner;
  gitWatcher: GitWatcher;
  folderHasher: FolderHasher;
  profiler: Profiler;
  fileSystem: FileSystemService;
}

/**
 * Metadata structure for persistence.
 */
interface IndexMetadata {
  version: number;
  lastGitHash?: string;
  lastUpdatedAt: number;
  folderHashes?: Record<string, any>;
}

/**
 * Handles server initialization and indexing setup.
 * Extracted from server.ts for single-responsibility.
 */
export class ServerInitializer {
  private workspaceRoot: string = '';
  private hasConfigurationCapability: boolean = false;
  private hasWorkspaceFolderCapability: boolean = false;
  private importResolver: ImportResolver | null = null;
  private deadCodeDetector: DeadCodeDetector | null = null;
  private fileWatcher: FileWatcher | null = null;
  private staticIndex: StaticIndex | undefined;

  constructor(private readonly deps: ServerDependencies) {}

  /**
   * Handle LSP initialize request.
   */
  async handleInitialize(params: InitializeParams): Promise<InitializeResult> {
    const { connection, configManager, typeScriptService } = this.deps;

    try {
      connection.console.info('[ServerInitializer] ========== INITIALIZATION START ==========');
      connection.console.info(`[ServerInitializer] VS Code version: ${params.clientInfo?.name} ${params.clientInfo?.version}`);
      
      const capabilities = params.capabilities;

      this.hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
      );
      this.hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
      );

      connection.console.info(`[ServerInitializer] Configuration capability: ${this.hasConfigurationCapability}`);
      connection.console.info(`[ServerInitializer] Workspace folder capability: ${this.hasWorkspaceFolderCapability}`);

      // Log initialization options
      if (params.initializationOptions) {
        connection.console.info(`[ServerInitializer] Initialization options received: ${JSON.stringify(params.initializationOptions, null, 2)}`);
        configManager.updateFromInitializationOptions(params.initializationOptions);
      } else {
        connection.console.warn('[ServerInitializer] No initialization options provided');
      }

      // Determine workspace root
      this.workspaceRoot = this.determineWorkspaceRoot(params);

      // Initialize import resolver and TypeScript service
      if (this.workspaceRoot) {
        this.importResolver = new ImportResolver(this.workspaceRoot);
        connection.console.info('[ServerInitializer] Import resolver initialized');
        
        await typeScriptService.init(this.workspaceRoot);
        connection.console.info('[ServerInitializer] TypeScript service initialized');
      }

      const result: InitializeResult = {
        capabilities: {
          textDocumentSync: TextDocumentSyncKind.Incremental,
          completionProvider: {
            resolveProvider: false,
            triggerCharacters: ['.']
          },
          definitionProvider: true,
          referencesProvider: true,
          workspaceSymbolProvider: true
        }
      };

      if (this.hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
          workspaceFolders: {
            supported: true
          }
        };
      }

      connection.console.info('[ServerInitializer] ========== INITIALIZATION COMPLETE ==========');
      return result;
    } catch (error) {
      connection.console.error(`[ServerInitializer] Error during initialization: ${error}`);
      throw error;
    }
  }

  /**
   * Handle LSP initialized notification.
   */
  async handleInitialized(): Promise<void> {
    const { connection } = this.deps;

    try {
      connection.console.info('[ServerInitializer] ========== ON INITIALIZED FIRED ==========');
      
      if (this.hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
        connection.console.info('[ServerInitializer] Registered for configuration changes');
      }

      if (this.hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
          connection.console.info('[ServerInitializer] Workspace folder change event received');
        });
      }

      // Load static index if enabled
      await this.loadStaticIndexIfEnabled();

      connection.console.info('[ServerInitializer] Starting automatic indexing...');
      await this.initializeIndexing();
      connection.console.info('[ServerInitializer] ========== INDEXING INITIALIZATION COMPLETE ==========');
    } catch (error) {
      connection.console.error(`[ServerInitializer] Fatal error in onInitialized: ${error}`);
      if (error instanceof Error) {
        connection.console.error(`[ServerInitializer] Stack trace: ${error.stack}`);
      }
      connection.window.showErrorMessage(`Smart Indexer initialization failed: ${error}`);
    }
  }

  /**
   * Get initialization result for other components.
   */
  getResult(): InitializationResult {
    return {
      workspaceRoot: this.workspaceRoot,
      hasConfigurationCapability: this.hasConfigurationCapability,
      hasWorkspaceFolderCapability: this.hasWorkspaceFolderCapability,
      importResolver: this.importResolver,
      deadCodeDetector: this.deadCodeDetector,
      fileWatcher: this.fileWatcher,
      staticIndex: this.staticIndex
    };
  }

  /**
   * Determine workspace root from initialization params.
   */
  private determineWorkspaceRoot(params: InitializeParams): string {
    const { connection } = this.deps;

    if (params.workspaceFolders && params.workspaceFolders.length > 0) {
      connection.console.info(`[ServerInitializer] Workspace folders (${params.workspaceFolders.length}):`);
      params.workspaceFolders.forEach((folder, idx) => {
        connection.console.info(`  [${idx}] ${folder.uri} -> ${URI.parse(folder.uri).fsPath}`);
      });
      const root = URI.parse(params.workspaceFolders[0].uri).fsPath;
      connection.console.info(`[ServerInitializer] Selected workspace root: ${root}`);
      return root;
    } else if (params.rootUri) {
      const root = URI.parse(params.rootUri).fsPath;
      connection.console.info(`[ServerInitializer] Using rootUri: ${root}`);
      return root;
    } else if (params.rootPath) {
      connection.console.info(`[ServerInitializer] Using rootPath: ${params.rootPath}`);
      return params.rootPath;
    } else {
      connection.console.warn('[ServerInitializer] No workspace root found - indexing will be disabled');
      return '';
    }
  }

  /**
   * Load static index if enabled in configuration.
   */
  private async loadStaticIndexIfEnabled(): Promise<void> {
    const { connection, configManager, mergedIndex, statsManager } = this.deps;
    const config = configManager.getConfig();
    
    if (!config.staticIndexEnabled || !config.staticIndexPath) {
      connection.console.info('[ServerInitializer] Static index disabled');
      return;
    }

    try {
      connection.console.info(`[ServerInitializer] Loading static index from: ${config.staticIndexPath}`);
      const start = Date.now();
      
      this.staticIndex = new StaticIndex();
      
      // Resolve path (relative to workspace or absolute)
      let indexPath = config.staticIndexPath;
      if (!path.isAbsolute(indexPath) && this.workspaceRoot) {
        indexPath = path.join(this.workspaceRoot, indexPath);
      }
      
      await this.staticIndex.load(indexPath);
      mergedIndex.setStaticIndex(this.staticIndex);
      
      const stats = this.staticIndex.getStats();
      statsManager.updateStaticStats(stats.files, stats.symbols);
      
      connection.console.info(`[ServerInitializer] Static index loaded: ${stats.files} files, ${stats.symbols} symbols in ${Date.now() - start} ms`);
    } catch (error) {
      connection.console.warn(`[ServerInitializer] Failed to load static index: ${error}`);
      connection.console.warn('[ServerInitializer] Continuing without static index');
      this.staticIndex = undefined;
      mergedIndex.setStaticIndex(undefined);
    }
  }

  /**
   * Initialize the indexing system.
   */
  private async initializeIndexing(): Promise<void> {
    const {
      connection, configManager, backgroundIndex, dynamicIndex,
      languageRouter, fileScanner, gitWatcher, folderHasher,
      statsManager, documents
    } = this.deps;

    if (!this.workspaceRoot) {
      connection.console.warn('[ServerInitializer] No workspace root found, skipping indexing');
      return;
    }

    connection.console.info(`[ServerInitializer] Initializing indexing for workspace: ${this.workspaceRoot}`);

    const config = configManager.getConfig();

    try {
      // Configure language router for text indexing
      languageRouter.setTextIndexingEnabled(config.textIndexingEnabled);
      connection.console.info(`[ServerInitializer] Text indexing ${config.textIndexingEnabled ? 'enabled' : 'disabled'}`);

      // Initialize background index
      await backgroundIndex.init(this.workspaceRoot, config.cacheDirectory);
      backgroundIndex.setMaxConcurrentJobs(config.maxConcurrentWorkers || config.maxConcurrentIndexJobs);
      backgroundIndex.setLanguageRouter(languageRouter);
      backgroundIndex.setConfigurationManager(configManager);
      
      // Set up progress notifications to the client
      backgroundIndex.setProgressCallback((progress) => {
        connection.sendNotification('smart-indexer/progress', progress);
      });
      
      connection.console.info(`[ServerInitializer] Background index initialized with ${config.maxConcurrentWorkers || config.maxConcurrentIndexJobs} concurrent jobs`);

      // Initialize dead code detector
      this.deadCodeDetector = new DeadCodeDetector(backgroundIndex);
      this.deadCodeDetector.setConfigurationManager(configManager);
      connection.console.info('[ServerInitializer] Dead code detector initialized');

      // Set language router for dynamic index too
      dynamicIndex.setLanguageRouter(languageRouter);

      fileScanner.configure({
        excludePatterns: config.excludePatterns,
        maxFileSize: configManager.getMaxFileSizeBytes(),
        configManager,
        folderHasher: folderHasher,
        useFolderHashing: config.useFolderHashing
      });
      connection.console.info(`[ServerInitializer] File scanner configured with excludePatterns: ${JSON.stringify(config.excludePatterns)}`);

      if (!config.enableBackgroundIndex) {
        connection.console.info('[ServerInitializer] Background indexing disabled by configuration');
        return;
      }

      if (config.enableGitIntegration) {
        await gitWatcher.init(this.workspaceRoot);
        const isRepo = await gitWatcher.isRepository();

        if (isRepo) {
          connection.console.info('[ServerInitializer] Git repository detected, performing incremental indexing...');
          await this.performGitAwareIndexing();

          // Watch for git changes
          gitWatcher.watchForChanges(async (gitChanges) => {
            connection.console.info('[ServerInitializer] Git HEAD changed, reindexing affected files...');
            try {
              for (const file of gitChanges.deleted) {
                await backgroundIndex.removeFile(file);
              }
              const filesToIndex = [...gitChanges.added, ...gitChanges.modified];
              if (filesToIndex.length > 0) {
                await this.indexFilesInBackground(filesToIndex);
                statsManager.recordIncrementalIndex();
              }
              
              await this.saveMetadata({
                version: 1,
                lastGitHash: gitChanges.currentHash,
                lastUpdatedAt: Date.now()
              });
              
              this.updateStats();
            } catch (error) {
              connection.console.error(`[ServerInitializer] Error handling git changes: ${error}`);
            }
          });
        } else {
          connection.console.info('[ServerInitializer] Not a Git repository, performing full background indexing');
          await this.performFullBackgroundIndexing();
        }
      } else {
        connection.console.info('[ServerInitializer] Git integration disabled, performing full background indexing');
        await this.performFullBackgroundIndexing();
      }

      this.updateStats();
      const stats = statsManager.getStats();
      connection.console.info(
        `[ServerInitializer] Indexing initialization complete: ${stats.totalFiles} files, ${stats.totalSymbols} symbols indexed`
      );

      // Initialize file watcher for live synchronization
      this.fileWatcher = new FileWatcher(
        connection,
        documents,
        backgroundIndex,
        configManager,
        this.workspaceRoot,
        600 // 600ms debounce delay
      );
      await this.fileWatcher.init();
      connection.console.info('[ServerInitializer] Live file synchronization enabled');
    } catch (error) {
      connection.console.error(`[ServerInitializer] Error initializing indexing: ${error}`);
      if (error instanceof Error) {
        connection.console.error(`[ServerInitializer] Stack trace: ${error.stack}`);
      }
    }
  }

  /**
   * Perform Git-aware incremental indexing.
   */
  private async performGitAwareIndexing(): Promise<void> {
    const { connection, gitWatcher, backgroundIndex, statsManager, profiler } = this.deps;

    try {
      const currentHash = await gitWatcher.getCurrentHash();
      const metadata = await this.loadMetadata();
      
      connection.console.info(`[ServerInitializer] Current git hash: ${currentHash}, cached hash: ${metadata.lastGitHash || '(none)'}`);

      const hasExistingCache = backgroundIndex.getAllFileUris().length > 0;

      if (!hasExistingCache) {
        connection.console.info('[ServerInitializer] No existing cache found. Performing full indexing...');
        await this.performFullBackgroundIndexing();
        statsManager.recordFullIndex();
        
        if (currentHash) {
          await this.saveMetadata({
            version: 1,
            lastGitHash: currentHash,
            lastUpdatedAt: Date.now()
          });
        }
      } else {
        const incrementalStart = Date.now();
        const changes = await gitWatcher.getChangesSince(metadata.lastGitHash);

        if (changes) {
          connection.console.info(
            `[ServerInitializer] Git changes detected: ${changes.added.length} added, ${changes.modified.length} modified, ${changes.deleted.length} deleted`
          );

          for (const file of changes.deleted) {
            await backgroundIndex.removeFile(file);
          }

          const filesToIndex = [...changes.added, ...changes.modified];
          if (filesToIndex.length > 0) {
            connection.console.info(`[ServerInitializer] Indexing ${filesToIndex.length} changed files...`);
            await this.indexFilesInBackground(filesToIndex);
            
            const incrementalDuration = Date.now() - incrementalStart;
            profiler.record('incrementalIndex', incrementalDuration);
            statsManager.updateProfilingMetrics({ 
              avgIncrementalIndexTimeMs: profiler.getAverageMs('incrementalIndex') 
            });
            statsManager.recordIncrementalIndex();
          } else {
            connection.console.info('[ServerInitializer] No files to index - cache is up to date');
          }

          await this.saveMetadata({
            version: 1,
            lastGitHash: changes.currentHash,
            lastUpdatedAt: Date.now()
          });
        }
      }
    } catch (error) {
      connection.console.error(`[ServerInitializer] Error in git-aware indexing: ${error}`);
      throw error;
    }
  }

  /**
   * Perform full workspace indexing.
   */
  private async performFullBackgroundIndexing(): Promise<void> {
    const { connection, fileScanner, statsManager } = this.deps;

    if (!this.workspaceRoot) {
      connection.console.warn('[ServerInitializer] No workspace root available - cannot perform full indexing');
      return;
    }

    try {
      connection.console.info('[ServerInitializer] Starting full workspace background indexing...');
      const allFiles = await fileScanner.scanWorkspace(this.workspaceRoot);
      connection.console.info(`[ServerInitializer] File scanner discovered ${allFiles.length} indexable files`);
      
      if (allFiles.length === 0) {
        connection.console.warn('[ServerInitializer] No files found to index. Check excludePatterns and file extensions.');
        return;
      }

      await this.indexFilesInBackground(allFiles);
      statsManager.recordFullIndex();
    } catch (error) {
      connection.console.error(`[ServerInitializer] Error performing full background indexing: ${error}`);
      if (error instanceof Error) {
        connection.console.error(`[ServerInitializer] Stack trace: ${error.stack}`);
      }
      throw error;
    }
  }

  /**
   * Index files in background with worker pool.
   */
  private async indexFilesInBackground(files: string[]): Promise<void> {
    const { connection, backgroundIndex, profiler, statsManager, configManager, fileSystem } = this.deps;

    if (files.length === 0) {
      return;
    }

    connection.console.info(`[ServerInitializer] ========== BACKGROUND INDEXING START ==========`);
    connection.console.info(`[ServerInitializer] Indexing ${files.length} files in background...`);

    const fullIndexStart = Date.now();

    try {
      const progress = await connection.window.createWorkDoneProgress();
      progress.begin('Indexing files', 0, `0/${files.length}`, true);

      const computeHash = async (uri: string): Promise<string> => {
        const content = await fileSystem.readFile(uri);
        return crypto.createHash('sha256').update(content).digest('hex');
      };

      // Use BackgroundIndex's built-in worker pool
      await backgroundIndex.ensureUpToDate(files, computeHash, (current, total) => {
        progress.report((current / total) * 100, `${current}/${total}`);
      });

      progress.done();

      // Record profiling metrics
      const fullIndexDuration = Date.now() - fullIndexStart;
      profiler.record('fullIndex', fullIndexDuration);
      
      // Update profiling metrics in stats
      statsManager.updateProfilingMetrics({
        avgFullIndexTimeMs: profiler.getAverageMs('fullIndex'),
        avgFileIndexTimeMs: fullIndexDuration / Math.max(1, files.length)
      });

      this.updateStats();
      const stats = statsManager.getStats();
      connection.console.info(`[ServerInitializer] ========== BACKGROUND INDEXING COMPLETE ==========`);
      connection.console.info(`[ServerInitializer] Total: ${stats.totalFiles} files, ${stats.totalSymbols} symbols indexed in ${fullIndexDuration}ms`);
      
      // Simple auto-tuning based on performance
      this.autoTuneIndexing(fullIndexDuration, files.length);
    } catch (error) {
      connection.console.error(`[ServerInitializer] Error in background indexing: ${error}`);
      if (error instanceof Error) {
        connection.console.error(`[ServerInitializer] Stack trace: ${error.stack}`);
      }
      throw error;
    }
  }

  /**
   * Auto-tune worker count based on indexing performance.
   */
  private autoTuneIndexing(durationMs: number, fileCount: number): void {
    const { connection, backgroundIndex, configManager } = this.deps;
    const config = configManager.getConfig();
    const currentWorkers = config.maxConcurrentWorkers || 4;
    
    if (fileCount === 0) {
      return;
    }
    
    const avgTimePerFile = durationMs / fileCount;
    
    if (avgTimePerFile > 500 && currentWorkers > 2) {
      const newWorkers = Math.max(2, currentWorkers - 1);
      backgroundIndex.setMaxConcurrentJobs(newWorkers);
      connection.console.info(`[ServerInitializer] Auto-tuning: Reduced workers from ${currentWorkers} to ${newWorkers} (avg ${avgTimePerFile.toFixed(0)}ms/file)`);
    } else if (avgTimePerFile < 100 && currentWorkers < 8) {
      const newWorkers = Math.min(8, currentWorkers + 1);
      backgroundIndex.setMaxConcurrentJobs(newWorkers);
      connection.console.info(`[ServerInitializer] Auto-tuning: Increased workers from ${currentWorkers} to ${newWorkers} (avg ${avgTimePerFile.toFixed(0)}ms/file)`);
    }
  }

  /**
   * Load metadata from disk.
   */
  private async loadMetadata(): Promise<IndexMetadata> {
    const { connection, configManager, folderHasher, fileSystem } = this.deps;

    try {
      const metadataPath = path.join(this.workspaceRoot, configManager.getConfig().cacheDirectory, 'metadata.json');
      try {
        const content = await fileSystem.readFile(metadataPath);
        const metadata = JSON.parse(content);
        
        // Load folder hashes if present
        if (metadata.folderHashes) {
          folderHasher.loadFromMetadata(metadata.folderHashes);
          connection.console.info(`[ServerInitializer] Loaded ${Object.keys(metadata.folderHashes).length} folder hashes from metadata`);
        }
        
        return metadata;
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    } catch (error) {
      connection.console.error(`[ServerInitializer] Error loading metadata: ${error}`);
    }
    return { version: 1, lastUpdatedAt: 0 };
  }

  /**
   * Save metadata to disk.
   */
  private async saveMetadata(metadata: IndexMetadata): Promise<void> {
    const { connection, configManager, folderHasher, fileSystem } = this.deps;

    try {
      const metadataPath = path.join(this.workspaceRoot, configManager.getConfig().cacheDirectory, 'metadata.json');
      
      // Include folder hashes in metadata
      const extendedMetadata = {
        ...metadata,
        folderHashes: folderHasher.exportToMetadata()
      };
      
      await fileSystem.writeFile(metadataPath, JSON.stringify(extendedMetadata, null, 2));
      connection.console.info(`[ServerInitializer] Saved metadata with ${Object.keys(extendedMetadata.folderHashes).length} folder hashes`);
    } catch (error) {
      connection.console.error(`[ServerInitializer] Error saving metadata: ${error}`);
    }
  }

  /**
   * Update stats from indexes.
   */
  private updateStats(): void {
    const { dynamicIndex, backgroundIndex, statsManager } = this.deps;
    const dynamicStats = dynamicIndex.getStats();
    const backgroundStats = backgroundIndex.getStats();
    
    statsManager.updateDynamicStats(dynamicStats.files, dynamicStats.symbols);
    statsManager.updateBackgroundStats(backgroundStats.files, backgroundStats.symbols, backgroundStats.shards);
  }
}
