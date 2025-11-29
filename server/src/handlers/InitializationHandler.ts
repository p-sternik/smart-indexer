/**
 * InitializationHandler - Handles LSP initialization lifecycle.
 * 
 * Responsibilities:
 * - Process `initialize` request (LSP handshake)
 * - Process `initialized` notification (start indexing)
 * - Manage capability negotiation
 * - Initialize core services (TypeScript, ImportResolver)
 * 
 * This handler is the first to be registered and sets up the server state
 * that other handlers depend on.
 */

import {
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  DidChangeConfigurationNotification
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';

import { IHandler, ServerServices, ServerState } from './types.js';
import { ImportResolver } from '../indexer/importResolver.js';
import { StaticIndex } from '../index/staticIndex.js';
import { DeadCodeDetector } from '../features/deadCode.js';
import { FileWatcher } from '../index/fileWatcher.js';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fsPromises from 'fs/promises';

/**
 * Handler for LSP initialization events.
 */
export class InitializationHandler implements IHandler {
  readonly name = 'InitializationHandler';
  
  private services: ServerServices;
  private state: ServerState;

  constructor(services: ServerServices, state: ServerState) {
    this.services = services;
    this.state = state;
  }

  register(): void {
    const { connection } = this.services;
    
    connection.onInitialize(this.handleInitialize.bind(this));
    connection.onInitialized(this.handleInitialized.bind(this));
  }

  /**
   * Handle LSP initialize request.
   * This is the first message from the client - negotiates capabilities.
   */
  private async handleInitialize(params: InitializeParams): Promise<InitializeResult> {
    const { connection } = this.services;
    
    try {
      connection.console.info('[Server] ========== INITIALIZATION START ==========');
      connection.console.info(`[Server] VS Code version: ${params.clientInfo?.name} ${params.clientInfo?.version}`);
      
      const capabilities = params.capabilities;

      // Determine available capabilities
      this.state.hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
      );
      this.state.hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
      );

      connection.console.info(`[Server] Configuration capability: ${this.state.hasConfigurationCapability}`);
      connection.console.info(`[Server] Workspace folder capability: ${this.state.hasWorkspaceFolderCapability}`);

      // Process initialization options
      if (params.initializationOptions) {
        connection.console.info(`[Server] Initialization options received: ${JSON.stringify(params.initializationOptions, null, 2)}`);
        this.services.configManager.updateFromInitializationOptions(params.initializationOptions);
      } else {
        connection.console.warn('[Server] No initialization options provided');
      }

      // Determine workspace root
      this.state.workspaceRoot = this.extractWorkspaceRoot(params);
      
      // Update services reference to workspace root
      (this.services as any).workspaceRoot = this.state.workspaceRoot;

      // Initialize import resolver if workspace is available
      if (this.state.workspaceRoot) {
        this.state.importResolver = new ImportResolver(this.state.workspaceRoot);
        await this.state.importResolver.init();
        connection.console.info('[Server] Import resolver initialized');
        
        // Initialize TypeScript service for semantic intelligence
        await this.services.typeScriptService.init(this.state.workspaceRoot);
        connection.console.info('[Server] TypeScript service initialized');
      }

      // Build capabilities result
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

      if (this.state.hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
          workspaceFolders: {
            supported: true
          }
        };
      }

      connection.console.info('[Server] ========== INITIALIZATION COMPLETE ==========');
      return result;
    } catch (error) {
      connection.console.error(`[Server] Error during initialization: ${error}`);
      throw error;
    }
  }

  /**
   * Handle LSP initialized notification.
   * This is sent after the client receives the initialize result.
   * Safe to start background work here.
   */
  private async handleInitialized(): Promise<void> {
    const { connection } = this.services;
    
    try {
      connection.console.info('[Server] ========== ON INITIALIZED FIRED ==========');
      
      // Register for configuration changes
      if (this.state.hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
        connection.console.info('[Server] Registered for configuration changes');
      }

      // Register for workspace folder changes
      if (this.state.hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
          connection.console.info('[Server] Workspace folder change event received');
        });
      }

      // Load static index if enabled
      await this.loadStaticIndexIfEnabled();

      // Start background indexing
      connection.console.info('[Server] Starting automatic indexing...');
      await this.initializeIndexing();
      connection.console.info('[Server] ========== INDEXING INITIALIZATION COMPLETE ==========');
    } catch (error) {
      connection.console.error(`[Server] Fatal error in onInitialized: ${error}`);
      if (error instanceof Error) {
        connection.console.error(`[Server] Stack trace: ${error.stack}`);
      }
      connection.window.showErrorMessage(`Smart Indexer initialization failed: ${error}`);
    }
  }

  /**
   * Extract workspace root from initialization params.
   */
  private extractWorkspaceRoot(params: InitializeParams): string {
    const { connection } = this.services;
    
    if (params.workspaceFolders && params.workspaceFolders.length > 0) {
      connection.console.info(`[Server] Workspace folders (${params.workspaceFolders.length}):`);
      params.workspaceFolders.forEach((folder, idx) => {
        connection.console.info(`  [${idx}] ${folder.uri} -> ${URI.parse(folder.uri).fsPath}`);
      });
      const root = URI.parse(params.workspaceFolders[0].uri).fsPath;
      connection.console.info(`[Server] Selected workspace root: ${root}`);
      return root;
    } else if (params.rootUri) {
      const root = URI.parse(params.rootUri).fsPath;
      connection.console.info(`[Server] Using rootUri: ${root}`);
      return root;
    } else if (params.rootPath) {
      connection.console.info(`[Server] Using rootPath: ${params.rootPath}`);
      return params.rootPath;
    } else {
      connection.console.warn('[Server] No workspace root found - indexing will be disabled');
      return '';
    }
  }

  /**
   * Load static index if enabled in configuration.
   */
  private async loadStaticIndexIfEnabled(): Promise<void> {
    const { connection, configManager, mergedIndex, statsManager } = this.services;
    const config = configManager.getConfig();
    
    if (!config.staticIndexEnabled || !config.staticIndexPath) {
      connection.console.info('[Server] Static index disabled');
      return;
    }

    try {
      connection.console.info(`[Server] Loading static index from: ${config.staticIndexPath}`);
      const start = Date.now();
      
      const staticIndex = new StaticIndex();
      
      // Resolve path (relative to workspace or absolute)
      let indexPath = config.staticIndexPath;
      if (!path.isAbsolute(indexPath) && this.state.workspaceRoot) {
        indexPath = path.join(this.state.workspaceRoot, indexPath);
      }
      
      await staticIndex.load(indexPath);
      this.state.staticIndex = staticIndex;
      mergedIndex.setStaticIndex(staticIndex);
      
      const stats = staticIndex.getStats();
      statsManager.updateStaticStats(stats.files, stats.symbols);
      
      connection.console.info(`[Server] Static index loaded: ${stats.files} files, ${stats.symbols} symbols in ${Date.now() - start} ms`);
    } catch (error) {
      connection.console.warn(`[Server] Failed to load static index: ${error}`);
      connection.console.warn('[Server] Continuing without static index');
      this.state.staticIndex = undefined;
      mergedIndex.setStaticIndex(undefined);
    }
  }

  /**
   * Initialize the indexing system.
   * Sets up background index, file scanner, and git integration.
   */
  private async initializeIndexing(): Promise<void> {
    const { 
      connection, 
      configManager, 
      dynamicIndex, 
      backgroundIndex,
      documents,
      statsManager
    } = this.services;
    const { languageRouter, fileScanner, gitWatcher, folderHasher } = this.services.infrastructure;
    
    if (!this.state.workspaceRoot) {
      connection.console.warn('[Server] No workspace root found, skipping indexing');
      return;
    }

    connection.console.info(`[Server] Initializing indexing for workspace: ${this.state.workspaceRoot}`);

    const config = configManager.getConfig();

    try {
      // Configure language router for text indexing
      languageRouter.setTextIndexingEnabled(config.textIndexingEnabled);
      connection.console.info(`[Server] Text indexing ${config.textIndexingEnabled ? 'enabled' : 'disabled'}`);

      // Initialize background index
      await backgroundIndex.init(this.state.workspaceRoot, config.cacheDirectory);
      backgroundIndex.setMaxConcurrentJobs(config.maxConcurrentWorkers || config.maxConcurrentIndexJobs);
      backgroundIndex.setLanguageRouter(languageRouter);
      backgroundIndex.setConfigurationManager(configManager);
      
      // Set up progress notifications to the client
      backgroundIndex.setProgressCallback((progress) => {
        connection.sendNotification('smart-indexer/progress', progress);
      });
      
      connection.console.info(`[Server] Background index initialized with ${config.maxConcurrentWorkers || config.maxConcurrentIndexJobs} concurrent jobs`);

      // Initialize dead code detector
      this.state.deadCodeDetector = new DeadCodeDetector(backgroundIndex);
      this.state.deadCodeDetector.setConfigurationManager(configManager);
      connection.console.info('[Server] Dead code detector initialized');

      // Set language router for dynamic index too
      dynamicIndex.setLanguageRouter(languageRouter);

      // Configure file scanner
      fileScanner.configure({
        excludePatterns: config.excludePatterns,
        maxFileSize: configManager.getMaxFileSizeBytes(),
        configManager,
        folderHasher: folderHasher,
        useFolderHashing: config.useFolderHashing
      });
      connection.console.info(`[Server] File scanner configured with excludePatterns: ${JSON.stringify(config.excludePatterns)}`);

      if (!config.enableBackgroundIndex) {
        connection.console.info('[Server] Background indexing disabled by configuration');
        return;
      }

      // Perform indexing based on git integration setting
      if (config.enableGitIntegration) {
        await gitWatcher.init(this.state.workspaceRoot);
        const isRepo = await gitWatcher.isRepository();

        if (isRepo) {
          connection.console.info('[Server] Git repository detected, performing incremental indexing...');
          await this.performGitAwareIndexing();

          // Watch for git changes
          gitWatcher.watchForChanges(async (gitChanges) => {
            connection.console.info('[Server] Git HEAD changed, reindexing affected files...');
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
              connection.console.error(`[Server] Error handling git changes: ${error}`);
            }
          });
        } else {
          connection.console.info('[Server] Not a Git repository, performing full background indexing');
          await this.performFullBackgroundIndexing();
        }
      } else {
        connection.console.info('[Server] Git integration disabled, performing full background indexing');
        await this.performFullBackgroundIndexing();
      }

      this.updateStats();
      const stats = statsManager.getStats();
      connection.console.info(
        `[Server] Indexing initialization complete: ${stats.totalFiles} files, ${stats.totalSymbols} symbols indexed`
      );

      // Initialize file watcher for live synchronization
      this.state.fileWatcher = new FileWatcher(
        connection,
        documents,
        backgroundIndex,
        configManager,
        this.state.workspaceRoot,
        600 // 600ms debounce delay
      );
      await this.state.fileWatcher.init();
      connection.console.info('[Server] Live file synchronization enabled');
    } catch (error) {
      connection.console.error(`[Server] Error initializing indexing: ${error}`);
      if (error instanceof Error) {
        connection.console.error(`[Server] Stack trace: ${error.stack}`);
      }
    }
  }

  /**
   * Perform git-aware incremental indexing.
   */
  private async performGitAwareIndexing(): Promise<void> {
    const { connection, backgroundIndex, statsManager, profiler } = this.services;
    const { gitWatcher } = this.services.infrastructure;
    
    try {
      const currentHash = await gitWatcher.getCurrentHash();
      const metadata = await this.loadMetadata();
      
      connection.console.info(`[Server] Current git hash: ${currentHash}, cached hash: ${metadata.lastGitHash || '(none)'}`);

      const hasExistingCache = backgroundIndex.getAllFileUris().length > 0;

      if (!hasExistingCache) {
        connection.console.info('[Server] No existing cache found. Performing full indexing...');
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
            `[Server] Git changes detected: ${changes.added.length} added, ${changes.modified.length} modified, ${changes.deleted.length} deleted`
          );

          for (const file of changes.deleted) {
            await backgroundIndex.removeFile(file);
          }

          const filesToIndex = [...changes.added, ...changes.modified];
          if (filesToIndex.length > 0) {
            connection.console.info(`[Server] Indexing ${filesToIndex.length} changed files...`);
            await this.indexFilesInBackground(filesToIndex);
            
            const incrementalDuration = Date.now() - incrementalStart;
            profiler.record('incrementalIndex', incrementalDuration);
            statsManager.updateProfilingMetrics({ 
              avgIncrementalIndexTimeMs: profiler.getAverageMs('incrementalIndex') 
            });
            statsManager.recordIncrementalIndex();
          } else {
            connection.console.info('[Server] No files to index - cache is up to date');
          }

          await this.saveMetadata({
            version: 1,
            lastGitHash: changes.currentHash,
            lastUpdatedAt: Date.now()
          });
        }
      }
    } catch (error) {
      connection.console.error(`[Server] Error in git-aware indexing: ${error}`);
      throw error;
    }
  }

  /**
   * Perform full background indexing of the workspace.
   */
  private async performFullBackgroundIndexing(): Promise<void> {
    const { connection, statsManager } = this.services;
    const { fileScanner } = this.services.infrastructure;
    
    if (!this.state.workspaceRoot) {
      connection.console.warn('[Server] No workspace root available - cannot perform full indexing');
      return;
    }

    try {
      connection.console.info('[Server] Starting full workspace background indexing...');
      const allFiles = await fileScanner.scanWorkspace(this.state.workspaceRoot);
      connection.console.info(`[Server] File scanner discovered ${allFiles.length} indexable files`);
      
      if (allFiles.length === 0) {
        connection.console.warn('[Server] No files found to index. Check excludePatterns and file extensions.');
        return;
      }

      await this.indexFilesInBackground(allFiles);
      statsManager.recordFullIndex();
    } catch (error) {
      connection.console.error(`[Server] Error performing full background indexing: ${error}`);
      if (error instanceof Error) {
        connection.console.error(`[Server] Stack trace: ${error.stack}`);
      }
      throw error;
    }
  }

  /**
   * Index a list of files in the background with progress reporting.
   */
  private async indexFilesInBackground(files: string[]): Promise<void> {
    if (files.length === 0) {
      return;
    }

    const { connection, backgroundIndex, configManager, profiler, statsManager } = this.services;

    connection.console.info(`[Server] ========== BACKGROUND INDEXING START ==========`);
    connection.console.info(`[Server] Indexing ${files.length} files in background...`);

    const fullIndexStart = Date.now();

    try {
      const progress = await connection.window.createWorkDoneProgress();
      progress.begin('Indexing files', 0, `0/${files.length}`, true);

      let processed = 0;
      const computeHash = async (uri: string): Promise<string> => {
        // Use async I/O to avoid blocking the event loop during indexing
        const content = await fsPromises.readFile(uri, 'utf-8');
        return crypto.createHash('sha256').update(content).digest('hex');
      };

      // Use BackgroundIndex's built-in worker pool
      await backgroundIndex.ensureUpToDate(files, computeHash, (current, total) => {
        processed = current;
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
      connection.console.info(`[Server] ========== BACKGROUND INDEXING COMPLETE ==========`);
      connection.console.info(`[Server] Total: ${stats.totalFiles} files, ${stats.totalSymbols} symbols indexed in ${fullIndexDuration}ms`);
      
      // Simple auto-tuning based on performance
      this.autoTuneIndexing(fullIndexDuration, files.length);
    } catch (error) {
      connection.console.error(`[Server] Error in background indexing: ${error}`);
      if (error instanceof Error) {
        connection.console.error(`[Server] Stack trace: ${error.stack}`);
      }
      throw error;
    }
  }

  /**
   * Auto-tune indexing parameters based on performance.
   */
  private autoTuneIndexing(durationMs: number, fileCount: number): void {
    const { connection, configManager, backgroundIndex } = this.services;
    const config = configManager.getConfig();
    const currentWorkers = config.maxConcurrentWorkers || 4;
    
    if (fileCount === 0) {
      return;
    }
    
    const avgTimePerFile = durationMs / fileCount;
    
    // Conservative auto-tuning: if average time is high and we have many workers, reduce
    if (avgTimePerFile > 500 && currentWorkers > 2) {
      const newWorkers = Math.max(2, currentWorkers - 1);
      backgroundIndex.setMaxConcurrentJobs(newWorkers);
      connection.console.info(`[Server] Auto-tuning: Reduced workers from ${currentWorkers} to ${newWorkers} (avg ${avgTimePerFile.toFixed(0)}ms/file)`);
    }
    // If indexing is fast and we have few workers, consider increasing
    else if (avgTimePerFile < 100 && currentWorkers < 8) {
      const newWorkers = Math.min(8, currentWorkers + 1);
      backgroundIndex.setMaxConcurrentJobs(newWorkers);
      connection.console.info(`[Server] Auto-tuning: Increased workers from ${currentWorkers} to ${newWorkers} (avg ${avgTimePerFile.toFixed(0)}ms/file)`);
    }
  }

  /**
   * Update stats manager with current index statistics.
   */
  private updateStats(): void {
    const { dynamicIndex, backgroundIndex, statsManager } = this.services;
    
    const dynamicStats = dynamicIndex.getStats();
    const backgroundStats = backgroundIndex.getStats();
    
    statsManager.updateDynamicStats(dynamicStats.files, dynamicStats.symbols);
    statsManager.updateBackgroundStats(backgroundStats.files, backgroundStats.symbols, backgroundStats.shards);
  }

  /**
   * Load metadata from disk.
   * Uses async I/O to avoid blocking the event loop.
   */
  private async loadMetadata(): Promise<{ version: number; lastGitHash?: string; lastUpdatedAt: number; folderHashes?: Record<string, any> }> {
    const { connection, configManager } = this.services;
    const { folderHasher } = this.services.infrastructure;
    
    try {
      const metadataPath = path.join(this.state.workspaceRoot, configManager.getConfig().cacheDirectory, 'metadata.json');
      
      try {
        const content = await fsPromises.readFile(metadataPath, 'utf-8');
        const metadata = JSON.parse(content);
        
        // Load folder hashes if present
        if (metadata.folderHashes) {
          folderHasher.loadFromMetadata(metadata.folderHashes);
          connection.console.info(`[Server] Loaded ${Object.keys(metadata.folderHashes).length} folder hashes from metadata`);
        }
        
        return metadata;
      } catch (readError: any) {
        // File doesn't exist - return default metadata
        if (readError.code === 'ENOENT') {
          return { version: 1, lastUpdatedAt: 0 };
        }
        throw readError;
      }
    } catch (error) {
      connection.console.error(`[Server] Error loading metadata: ${error}`);
    }
    return { version: 1, lastUpdatedAt: 0 };
  }

  /**
   * Save metadata to disk.
   * Uses async I/O to avoid blocking the event loop.
   */
  private async saveMetadata(metadata: { version: number; lastGitHash?: string; lastUpdatedAt: number }): Promise<void> {
    const { connection, configManager } = this.services;
    const { folderHasher } = this.services.infrastructure;
    
    try {
      const metadataPath = path.join(this.state.workspaceRoot, configManager.getConfig().cacheDirectory, 'metadata.json');
      const dir = path.dirname(metadataPath);
      
      // Ensure directory exists (async)
      await fsPromises.mkdir(dir, { recursive: true });
      
      // Include folder hashes in metadata
      const extendedMetadata = {
        ...metadata,
        folderHashes: folderHasher.exportToMetadata()
      };
      
      await fsPromises.writeFile(metadataPath, JSON.stringify(extendedMetadata, null, 2), 'utf-8');
      connection.console.info(`[Server] Saved metadata with ${Object.keys(extendedMetadata.folderHashes).length} folder hashes`);
    } catch (error) {
      connection.console.error(`[Server] Error saving metadata: ${error}`);
    }
  }

  /**
   * Dispose of resources.
   */
  async dispose(): Promise<void> {
    const { connection } = this.services;
    
    connection.console.info('[InitializationHandler] Disposing...');
    
    // Dispose file watcher
    if (this.state.fileWatcher) {
      await this.state.fileWatcher.dispose();
      this.state.fileWatcher = null;
    }
    
    connection.console.info('[InitializationHandler] Disposed');
  }
}

/**
 * Factory function for creating InitializationHandler.
 * Used with HandlerRegistry.register().
 */
export function createInitializationHandler(
  services: ServerServices,
  state: ServerState
): InitializationHandler {
  return new InitializationHandler(services, state);
}
