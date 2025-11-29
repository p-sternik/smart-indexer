import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  WorkspaceSymbol,
  WorkspaceSymbolParams,
  SymbolKind
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { GitWatcher } from './git/gitWatcher.js';
import { FileScanner } from './indexer/fileScanner.js';
import { SymbolIndexer } from './indexer/symbolIndexer.js';
import { LanguageRouter } from './indexer/languageRouter.js';
import { ImportResolver } from './indexer/importResolver.js';
import { matchSymbolById } from './indexer/symbolResolver.js';
import { ConfigurationManager } from './config/configurationManager.js';
import { DynamicIndex } from './index/dynamicIndex.js';
import { BackgroundIndex } from './index/backgroundIndex.js';
import { MergedIndex } from './index/mergedIndex.js';
import { StaticIndex } from './index/staticIndex.js';
import { StatsManager } from './index/statsManager.js';
import { FileWatcher } from './index/fileWatcher.js';
import { Profiler } from './profiler/profiler.js';
import { FolderHasher } from './cache/folderHasher.js';
import { RankingContext } from './utils/fuzzySearch.js';
import { TypeScriptService } from './typescript/typeScriptService.js';
import { DeadCodeDetector } from './features/deadCode.js';
import { URI } from 'vscode-uri';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';

// Handler imports
import { 
  HandlerRegistry, 
  ServerServices, 
  ServerState,
  createDefinitionHandler,
  createReferencesHandler,
  createCompletionHandler,
  createDeadCodeHandler,
  DeadCodeHandler
} from './handlers/index.js';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

// Track currently active document for context-aware ranking
let currentActiveDocumentUri: string | undefined;

const configManager = new ConfigurationManager();
const gitWatcher = new GitWatcher();
const fileScanner = new FileScanner();
const symbolIndexer = new SymbolIndexer();
const languageRouter = new LanguageRouter(symbolIndexer, false);
const profiler = new Profiler();
const folderHasher = new FolderHasher();

// Import resolver - initialized after workspace root is known
let importResolver: ImportResolver;

// TypeScript service for semantic intelligence
const typeScriptService = new TypeScriptService();

// Dead code detector
let deadCodeDetector: DeadCodeDetector;

// Dead code handler instance (for direct method calls from document events)
let deadCodeHandler: DeadCodeHandler | null = null;

// File watcher for live synchronization
let fileWatcher: FileWatcher | null = null;

// New clangd-inspired index architecture
const dynamicIndex = new DynamicIndex(symbolIndexer);
const backgroundIndex = new BackgroundIndex(symbolIndexer, 4);
let staticIndex: StaticIndex | undefined;
const mergedIndex = new MergedIndex(dynamicIndex, backgroundIndex);
const statsManager = new StatsManager();

let workspaceRoot: string = '';
let indexingDebounceTimer: NodeJS.Timeout | null = null;

// ============================================================================
// Handler Registry Setup
// ============================================================================

/**
 * Server state - mutable state that handlers can read/update.
 */
const serverState: ServerState = {
  workspaceRoot: '',
  hasConfigurationCapability: false,
  hasWorkspaceFolderCapability: false,
  currentActiveDocumentUri: undefined,
  importResolver: null,
  deadCodeDetector: null,
  staticIndex: undefined,
  fileWatcher: null
};

/**
 * Server services - dependencies injected into handlers.
 * Note: Some services are set lazily after initialization.
 */
const serverServices: ServerServices = {
  connection,
  documents,
  mergedIndex,
  configManager,
  dynamicIndex,
  backgroundIndex,
  staticIndex: undefined,
  typeScriptService,
  importResolver: null,
  deadCodeDetector: null,
  profiler,
  statsManager,
  workspaceRoot: '',
  infrastructure: {
    languageRouter,
    fileScanner,
    gitWatcher,
    folderHasher
  },
  fileWatcher: null
};

/**
 * Handler registry - manages all LSP request handlers.
 */
const handlerRegistry = new HandlerRegistry(serverServices, serverState);

// Register handlers
handlerRegistry.register(createDefinitionHandler);
handlerRegistry.register(createReferencesHandler);
handlerRegistry.register(createCompletionHandler);

// Note: DeadCodeHandler is registered later after initialization,
// because it needs deadCodeDetector to be created first.
// See the initialization section where deadCodeHandler is assigned.

// ============================================================================

interface ServerSettings {
  cacheDirectory: string;
  enableGitIntegration: boolean;
  excludePatterns: string[];
  maxIndexedFileSize: number;
  maxConcurrentIndexJobs: number;
  enableBackgroundIndex: boolean;
  textIndexingEnabled: boolean;
  staticIndexEnabled: boolean;
  staticIndexPath: string;
  maxConcurrentWorkers: number;
  batchSize: number;
  useFolderHashing: boolean;
}

const defaultSettings: ServerSettings = {
  cacheDirectory: '.smart-index',
  enableGitIntegration: true,
  excludePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/out/**',
    '**/.git/**',
    '**/build/**',
    '**/*.min.js'
  ],
  maxIndexedFileSize: 1048576,
  maxConcurrentIndexJobs: 4,
  enableBackgroundIndex: true,
  textIndexingEnabled: false,
  staticIndexEnabled: false,
  staticIndexPath: '',
  maxConcurrentWorkers: 4,
  batchSize: 50,
  useFolderHashing: true
};

let globalSettings: ServerSettings = defaultSettings;

connection.onInitialize(async (params: InitializeParams) => {
  try {
    connection.console.info('[Server] ========== INITIALIZATION START ==========');
    connection.console.info(`[Server] VS Code version: ${params.clientInfo?.name} ${params.clientInfo?.version}`);
    
    const capabilities = params.capabilities;

    hasConfigurationCapability = !!(
      capabilities.workspace && !!capabilities.workspace.configuration
    );
    hasWorkspaceFolderCapability = !!(
      capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );

    connection.console.info(`[Server] Configuration capability: ${hasConfigurationCapability}`);
    connection.console.info(`[Server] Workspace folder capability: ${hasWorkspaceFolderCapability}`);

    // Log initialization options
    if (params.initializationOptions) {
      connection.console.info(`[Server] Initialization options received: ${JSON.stringify(params.initializationOptions, null, 2)}`);
      configManager.updateFromInitializationOptions(params.initializationOptions);
    } else {
      connection.console.warn('[Server] No initialization options provided');
    }

    // Determine workspace root with detailed logging
    if (params.workspaceFolders && params.workspaceFolders.length > 0) {
      connection.console.info(`[Server] Workspace folders (${params.workspaceFolders.length}):`);
      params.workspaceFolders.forEach((folder, idx) => {
        connection.console.info(`  [${idx}] ${folder.uri} -> ${URI.parse(folder.uri).fsPath}`);
      });
      workspaceRoot = URI.parse(params.workspaceFolders[0].uri).fsPath;
      connection.console.info(`[Server] Selected workspace root: ${workspaceRoot}`);
    } else if (params.rootUri) {
      workspaceRoot = URI.parse(params.rootUri).fsPath;
      connection.console.info(`[Server] Using rootUri: ${workspaceRoot}`);
    } else if (params.rootPath) {
      workspaceRoot = params.rootPath;
      connection.console.info(`[Server] Using rootPath: ${workspaceRoot}`);
    } else {
      connection.console.warn('[Server] No workspace root found - indexing will be disabled');
    }

    // Initialize import resolver
    if (workspaceRoot) {
      importResolver = new ImportResolver(workspaceRoot);
      // Sync with handler services
      serverState.importResolver = importResolver;
      serverServices.importResolver = importResolver;
      serverState.workspaceRoot = workspaceRoot;
      serverServices.workspaceRoot = workspaceRoot;
      connection.console.info('[Server] Import resolver initialized');
      
      // Initialize TypeScript service for semantic intelligence
      await typeScriptService.init(workspaceRoot);
      connection.console.info('[Server] TypeScript service initialized');
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

    if (hasWorkspaceFolderCapability) {
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
});

connection.onInitialized(async () => {
  try {
    connection.console.info('[Server] ========== ON INITIALIZED FIRED ==========');
    
    if (hasConfigurationCapability) {
      connection.client.register(DidChangeConfigurationNotification.type, undefined);
      connection.console.info('[Server] Registered for configuration changes');
    }

    if (hasWorkspaceFolderCapability) {
      connection.workspace.onDidChangeWorkspaceFolders(_event => {
        connection.console.info('[Server] Workspace folder change event received');
      });
    }

    // Load static index if enabled
    await loadStaticIndexIfEnabled();

    connection.console.info('[Server] Starting automatic indexing...');
    await initializeIndexing();
    connection.console.info('[Server] ========== INDEXING INITIALIZATION COMPLETE ==========');
  } catch (error) {
    connection.console.error(`[Server] Fatal error in onInitialized: ${error}`);
    if (error instanceof Error) {
      connection.console.error(`[Server] Stack trace: ${error.stack}`);
    }
    connection.window.showErrorMessage(`Smart Indexer initialization failed: ${error}`);
  }
});

async function loadStaticIndexIfEnabled(): Promise<void> {
  const config = configManager.getConfig();
  
  if (!config.staticIndexEnabled || !config.staticIndexPath) {
    connection.console.info('[Server] Static index disabled');
    return;
  }

  try {
    connection.console.info(`[Server] Loading static index from: ${config.staticIndexPath}`);
    const start = Date.now();
    
    staticIndex = new StaticIndex();
    
    // Resolve path (relative to workspace or absolute)
    let indexPath = config.staticIndexPath;
    if (!path.isAbsolute(indexPath) && workspaceRoot) {
      indexPath = path.join(workspaceRoot, indexPath);
    }
    
    await staticIndex.load(indexPath);
    mergedIndex.setStaticIndex(staticIndex);
    
    const stats = staticIndex.getStats();
    statsManager.updateStaticStats(stats.files, stats.symbols);
    
    connection.console.info(`[Server] Static index loaded: ${stats.files} files, ${stats.symbols} symbols in ${Date.now() - start} ms`);
  } catch (error) {
    connection.console.warn(`[Server] Failed to load static index: ${error}`);
    connection.console.warn('[Server] Continuing without static index');
    staticIndex = undefined;
    mergedIndex.setStaticIndex(undefined);
  }
}

async function initializeIndexing(): Promise<void> {
  if (!workspaceRoot) {
    connection.console.warn('[Server] No workspace root found, skipping indexing');
    return;
  }

  connection.console.info(`[Server] Initializing indexing for workspace: ${workspaceRoot}`);

  const config = configManager.getConfig();

  try {
    // Configure language router for text indexing
    languageRouter.setTextIndexingEnabled(config.textIndexingEnabled);
    connection.console.info(`[Server] Text indexing ${config.textIndexingEnabled ? 'enabled' : 'disabled'}`);

    // Initialize background index
    await backgroundIndex.init(workspaceRoot, config.cacheDirectory);
    backgroundIndex.setMaxConcurrentJobs(config.maxConcurrentWorkers || config.maxConcurrentIndexJobs);
    backgroundIndex.setLanguageRouter(languageRouter);
    backgroundIndex.setConfigurationManager(configManager);
    
    // Set up progress notifications to the client
    backgroundIndex.setProgressCallback((progress) => {
      connection.sendNotification('smart-indexer/progress', progress);
    });
    
    connection.console.info(`[Server] Background index initialized with ${config.maxConcurrentWorkers || config.maxConcurrentIndexJobs} concurrent jobs`);

    // Initialize dead code detector
    deadCodeDetector = new DeadCodeDetector(backgroundIndex);
    deadCodeDetector.setConfigurationManager(configManager);
    // Sync with handler services
    serverState.deadCodeDetector = deadCodeDetector;
    serverServices.deadCodeDetector = deadCodeDetector;
    connection.console.info('[Server] Dead code detector initialized');

    // Register and store DeadCodeHandler (needs detector to be ready)
    deadCodeHandler = createDeadCodeHandler(serverServices, serverState);
    deadCodeHandler.register();
    connection.console.info('[Server] DeadCodeHandler registered');

    // Set language router for dynamic index too
    dynamicIndex.setLanguageRouter(languageRouter);

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

    if (config.enableGitIntegration) {
      await gitWatcher.init(workspaceRoot);
      const isRepo = await gitWatcher.isRepository();

      if (isRepo) {
        connection.console.info('[Server] Git repository detected, performing incremental indexing...');
        await performGitAwareIndexing();

        // Watch for git changes
        gitWatcher.watchForChanges(async (gitChanges) => {
          connection.console.info('[Server] Git HEAD changed, reindexing affected files...');
          try {
            for (const file of gitChanges.deleted) {
              await backgroundIndex.removeFile(file);
            }
            const filesToIndex = [...gitChanges.added, ...gitChanges.modified];
            if (filesToIndex.length > 0) {
              await indexFilesInBackground(filesToIndex);
              statsManager.recordIncrementalIndex();
            }
            
            await saveMetadata({
              version: 1,
              lastGitHash: gitChanges.currentHash,
              lastUpdatedAt: Date.now()
            });
            
            updateStats();
          } catch (error) {
            connection.console.error(`[Server] Error handling git changes: ${error}`);
          }
        });
      } else {
        connection.console.info('[Server] Not a Git repository, performing full background indexing');
        await performFullBackgroundIndexing();
      }
    } else {
      connection.console.info('[Server] Git integration disabled, performing full background indexing');
      await performFullBackgroundIndexing();
    }

    updateStats();
    const stats = statsManager.getStats();
    connection.console.info(
      `[Server] Indexing initialization complete: ${stats.totalFiles} files, ${stats.totalSymbols} symbols indexed`
    );

    // Initialize file watcher for live synchronization
    fileWatcher = new FileWatcher(
      connection,
      documents,
      backgroundIndex,
      configManager,
      workspaceRoot,
      600 // 600ms debounce delay
    );
    await fileWatcher.init();
    // Sync with handler services
    serverState.fileWatcher = fileWatcher;
    serverServices.fileWatcher = fileWatcher;
    connection.console.info('[Server] Live file synchronization enabled');
  } catch (error) {
    connection.console.error(`[Server] Error initializing indexing: ${error}`);
    if (error instanceof Error) {
      connection.console.error(`[Server] Stack trace: ${error.stack}`);
    }
  }
}

async function performGitAwareIndexing(): Promise<void> {
  try {
    const currentHash = await gitWatcher.getCurrentHash();
    const metadata = await loadMetadata();
    
    connection.console.info(`[Server] Current git hash: ${currentHash}, cached hash: ${metadata.lastGitHash || '(none)'}`);

    const hasExistingCache = backgroundIndex.getAllFileUris().length > 0;

    if (!hasExistingCache) {
      connection.console.info('[Server] No existing cache found. Performing full indexing...');
      await performFullBackgroundIndexing();
      statsManager.recordFullIndex();
      
      if (currentHash) {
        await saveMetadata({
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
          await indexFilesInBackground(filesToIndex);
          
          const incrementalDuration = Date.now() - incrementalStart;
          profiler.record('incrementalIndex', incrementalDuration);
          statsManager.updateProfilingMetrics({ 
            avgIncrementalIndexTimeMs: profiler.getAverageMs('incrementalIndex') 
          });
          statsManager.recordIncrementalIndex();
        } else {
          connection.console.info('[Server] No files to index - cache is up to date');
        }

        await saveMetadata({
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

async function performFullBackgroundIndexing(): Promise<void> {
  if (!workspaceRoot) {
    connection.console.warn('[Server] No workspace root available - cannot perform full indexing');
    return;
  }

  try {
    connection.console.info('[Server] Starting full workspace background indexing...');
    const allFiles = await fileScanner.scanWorkspace(workspaceRoot);
    connection.console.info(`[Server] File scanner discovered ${allFiles.length} indexable files`);
    
    if (allFiles.length === 0) {
      connection.console.warn('[Server] No files found to index. Check excludePatterns and file extensions.');
      return;
    }

    await indexFilesInBackground(allFiles);
    statsManager.recordFullIndex();
  } catch (error) {
    connection.console.error(`[Server] Error performing full background indexing: ${error}`);
    if (error instanceof Error) {
      connection.console.error(`[Server] Stack trace: ${error.stack}`);
    }
    throw error;
  }
}

async function indexFilesInBackground(files: string[]): Promise<void> {
  if (files.length === 0) {
    return;
  }

  connection.console.info(`[Server] ========== BACKGROUND INDEXING START ==========`);
  connection.console.info(`[Server] Indexing ${files.length} files in background...`);

  const fullIndexStart = Date.now();

  try {
    const progress = await connection.window.createWorkDoneProgress();
    progress.begin('Indexing files', 0, `0/${files.length}`, true);

    let processed = 0;
    const computeHash = async (uri: string): Promise<string> => {
      const content = fs.readFileSync(uri, 'utf-8');
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

    updateStats();
    const stats = statsManager.getStats();
    connection.console.info(`[Server] ========== BACKGROUND INDEXING COMPLETE ==========`);
    connection.console.info(`[Server] Total: ${stats.totalFiles} files, ${stats.totalSymbols} symbols indexed in ${fullIndexDuration}ms`);
    
    // Simple auto-tuning based on performance
    autoTuneIndexing(fullIndexDuration, files.length);
  } catch (error) {
    connection.console.error(`[Server] Error in background indexing: ${error}`);
    if (error instanceof Error) {
      connection.console.error(`[Server] Stack trace: ${error.stack}`);
    }
    throw error;
  }
}

function autoTuneIndexing(durationMs: number, fileCount: number): void {
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

connection.onDidChangeConfiguration(change => {
  try {
    connection.console.info('[Server] Configuration changed');
    if (change.settings?.smartIndexer) {
      configManager.updateFromSettings(change.settings.smartIndexer);
      const config = configManager.getConfig();
      
      fileScanner.configure({
        excludePatterns: config.excludePatterns,
        maxFileSize: configManager.getMaxFileSizeBytes(),
        configManager
      });
      
      backgroundIndex.setMaxConcurrentJobs(config.maxConcurrentIndexJobs);
      
      connection.console.info('[Server] Configuration updated and applied');
    }
  } catch (error) {
    connection.console.error(`[Server] Error updating configuration: ${error}`);
  }
});

// Helper functions for metadata persistence
async function loadMetadata(): Promise<{ version: number; lastGitHash?: string; lastUpdatedAt: number; folderHashes?: Record<string, any> }> {
  try {
    const metadataPath = path.join(workspaceRoot, configManager.getConfig().cacheDirectory, 'metadata.json');
    if (fs.existsSync(metadataPath)) {
      const content = fs.readFileSync(metadataPath, 'utf-8');
      const metadata = JSON.parse(content);
      
      // Load folder hashes if present
      if (metadata.folderHashes) {
        folderHasher.loadFromMetadata(metadata.folderHashes);
        connection.console.info(`[Server] Loaded ${Object.keys(metadata.folderHashes).length} folder hashes from metadata`);
      }
      
      return metadata;
    }
  } catch (error) {
    connection.console.error(`[Server] Error loading metadata: ${error}`);
  }
  return { version: 1, lastUpdatedAt: 0 };
}

async function saveMetadata(metadata: { version: number; lastGitHash?: string; lastUpdatedAt: number }): Promise<void> {
  try {
    const metadataPath = path.join(workspaceRoot, configManager.getConfig().cacheDirectory, 'metadata.json');
    const dir = path.dirname(metadataPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Include folder hashes in metadata
    const extendedMetadata = {
      ...metadata,
      folderHashes: folderHasher.exportToMetadata()
    };
    
    fs.writeFileSync(metadataPath, JSON.stringify(extendedMetadata, null, 2), 'utf-8');
    connection.console.info(`[Server] Saved metadata with ${Object.keys(extendedMetadata.folderHashes).length} folder hashes`);
  } catch (error) {
    connection.console.error(`[Server] Error saving metadata: ${error}`);
  }
}

function updateStats(): void {
  const dynamicStats = dynamicIndex.getStats();
  const backgroundStats = backgroundIndex.getStats();
  
  statsManager.updateDynamicStats(dynamicStats.files, dynamicStats.symbols);
  statsManager.updateBackgroundStats(backgroundStats.files, backgroundStats.symbols, backgroundStats.shards);
}

/**
 * Analyze a file for dead code and publish diagnostics.
 * Delegates to DeadCodeHandler for debounced analysis.
 */
async function analyzeDeadCode(uri: string): Promise<void> {
  if (deadCodeHandler) {
    await deadCodeHandler.analyzeFile(uri);
  }
}

/**
 * Clear dead code diagnostics for a file.
 * Delegates to DeadCodeHandler.
 */
function clearDeadCodeDiagnostics(uri: string): void {
  if (deadCodeHandler) {
    deadCodeHandler.clearDiagnostics(uri);
  }
}

documents.onDidOpen(async (change) => {
  try {
    const uri = URI.parse(change.document.uri).fsPath;

    if (!change.document.uri.startsWith('file:') || 
        configManager.shouldExcludePath(uri)) {
      return;
    }

    connection.console.info(`[Server] Document opened: ${uri}`);
    
    // Track as currently active document
    currentActiveDocumentUri = uri;
    
    const content = change.document.getText();
    
    // Self-healing: Validate and repair index if stale (e.g., missed file watcher events)
    const wasRepaired = await dynamicIndex.validateAndRepair(uri, content);
    if (wasRepaired) {
      connection.console.info(`[Server] Self-healing triggered for ${uri}`);
    } else {
      // No repair needed, but still update to ensure freshness
      await dynamicIndex.updateFile(uri, content);
    }
    
    // Update TypeScript service for semantic intelligence
    if (typeScriptService.isInitialized()) {
      typeScriptService.updateFile(uri, content);
    }
    
    // Analyze for dead code (debounced)
    await analyzeDeadCode(uri);
    
    updateStats();
  } catch (error) {
    connection.console.error(`[Server] Error in onDidOpen: ${error}`);
  }
});

documents.onDidChangeContent(change => {
  try {
    const uri = URI.parse(change.document.uri).fsPath;

    if (!change.document.uri.startsWith('file:') || 
        change.document.uri.startsWith('vscode-userdata:') || 
        configManager.shouldExcludePath(uri)) {
      return;
    }

    if (indexingDebounceTimer) {
      clearTimeout(indexingDebounceTimer);
    }

    indexingDebounceTimer = setTimeout(async () => {
      try {
        connection.console.info(`[Server] Document changed, updating dynamic index: ${uri}`);
        
        // Track as currently active document
        currentActiveDocumentUri = uri;
        
        const content = change.document.getText();
        
        // Self-healing: Validate and repair index if stale
        const wasRepaired = await dynamicIndex.validateAndRepair(uri, content);
        if (!wasRepaired) {
          // No repair needed, perform normal update
          await dynamicIndex.updateFile(uri, content);
        }
        
        // Update TypeScript service for semantic intelligence
        if (typeScriptService.isInitialized()) {
          typeScriptService.updateFile(uri, content);
        }
        
        updateStats();
        connection.console.info(`[Server] Dynamic index updated for: ${uri}`);
      } catch (error) {
        connection.console.error(`[Server] Error updating dynamic index for ${uri}: ${error}`);
      }
    }, 500);
  } catch (error) {
    connection.console.error(`[Server] Error in onDidChangeContent: ${error}`);
  }
});

documents.onDidClose(e => {
  try {
    const uri = URI.parse(e.document.uri).fsPath;
    
    if (!e.document.uri.startsWith('file:')) {
      return;
    }

    connection.console.info(`[Server] Document closed: ${uri}`);
    
    // Clear dead code diagnostics (also cancels pending analysis)
    clearDeadCodeDiagnostics(uri);
    
    // Keep in dynamic index for a while, or remove immediately
    // For now, we'll remove to keep memory usage low
    dynamicIndex.removeFile(uri);
    updateStats();
  } catch (error) {
    connection.console.error(`[Server] Error in onDidClose: ${error}`);
  }
});

// NOTE: connection.onDefinition is now handled by DefinitionHandler (registered via HandlerRegistry)
// NOTE: connection.onReferences is now handled by ReferencesHandler (registered via HandlerRegistry)

connection.onWorkspaceSymbol(
  async (params: WorkspaceSymbolParams): Promise<WorkspaceSymbol[]> => {
    const start = Date.now();
    const query = params.query;
    
    connection.console.log(`[Server] WorkspaceSymbol request: query="${query}"`);
    
    try {
      if (!query) {
        connection.console.log(`[Server] WorkspaceSymbol result: empty query, 0 results, ${Date.now() - start} ms`);
        return [];
      }

      // Build ranking context with open files and current file
      const openFiles = new Set<string>();
      for (const doc of documents.all()) {
        const uri = URI.parse(doc.uri).fsPath;
        openFiles.add(uri);
      }

      const context: RankingContext = {
        openFiles,
        currentFileUri: currentActiveDocumentUri
      };

      // Use fuzzy search with ranking (increased limit for better results)
      const symbols = await mergedIndex.searchSymbols(query, 200, context);

      const results = symbols.map(sym => ({
        name: sym.name,
        kind: mapSymbolKind(sym.kind),
        location: {
          uri: URI.file(sym.location.uri).toString(),
          range: {
            start: { line: sym.location.line, character: sym.location.character },
            end: { line: sym.location.line, character: sym.location.character + sym.name.length }
          }
        },
        containerName: sym.containerName
      }));

      connection.console.log(`[Server] WorkspaceSymbol result: query="${query}", ${results.length} symbols in ${Date.now() - start} ms`);
      return results;
    } catch (error) {
      connection.console.error(`[Server] WorkspaceSymbol error: ${error}, ${Date.now() - start} ms`);
      return [];
    }
  }
);

// NOTE: connection.onCompletion is now handled by CompletionHandler (registered via HandlerRegistry)

connection.onRequest('smart-indexer/rebuildIndex', async () => {
  try {
    connection.console.info('[Server] ========== REBUILD INDEX COMMAND ==========');
    await backgroundIndex.clear();
    connection.console.info('[Server] Background index cleared, starting full indexing...');
    await performFullBackgroundIndexing();
    updateStats();
    const stats = statsManager.getStats();
    connection.console.info(`[Server] ========== REBUILD COMPLETE ==========`);
    connection.console.info(`[Server] Index rebuild complete: ${stats.totalFiles} files, ${stats.totalSymbols} symbols`);
    return stats;
  } catch (error) {
    connection.console.error(`[Server] Error rebuilding index: ${error}`);
    throw error;
  }
});

connection.onRequest('smart-indexer/clearCache', async () => {
  try {
    connection.console.info('[Server] Clear cache command received');
    await backgroundIndex.clear();
    statsManager.reset();
    connection.console.info('[Server] Cache cleared successfully');
    return { success: true };
  } catch (error) {
    connection.console.error(`[Server] Error clearing cache: ${error}`);
    throw error;
  }
});

connection.onRequest('smart-indexer/getStats', async () => {
  try {
    connection.console.info('[Server] ========== GET STATS REQUEST ==========');
    updateStats();
    const stats = statsManager.getStats();
    connection.console.info(`[Server] Returning stats to client: totalFiles=${stats.totalFiles}, totalSymbols=${stats.totalSymbols}`);
    return stats;
  } catch (error) {
    connection.console.error(`[Server] Error getting stats: ${error}`);
    throw error;
  }
});

connection.onRequest('smart-indexer/inspectIndex', async () => {
  try {
    connection.console.info('[Server] ========== INSPECT INDEX REQUEST ==========');
    
    const config = configManager.getConfig();
    const cacheDir = path.join(workspaceRoot, config.cacheDirectory, 'index');
    
    // Collect per-folder breakdown
    const folderStats = new Map<string, { files: number; symbols: number; sizeBytes: number }>();
    
    if (fs.existsSync(cacheDir)) {
      const shardFiles = fs.readdirSync(cacheDir);
      
      for (const shardFile of shardFiles) {
        if (!shardFile.endsWith('.json')) {
          continue;
        }
        
        try {
          const shardPath = path.join(cacheDir, shardFile);
          const stat = fs.statSync(shardPath);
          const content = fs.readFileSync(shardPath, 'utf-8');
          const shard = JSON.parse(content);
          
          const fileUri = shard.uri;
          const folderPath = path.dirname(fileUri);
          
          let folderStat = folderStats.get(folderPath);
          if (!folderStat) {
            folderStat = { files: 0, symbols: 0, sizeBytes: 0 };
            folderStats.set(folderPath, folderStat);
          }
          
          folderStat.files++;
          folderStat.symbols += shard.symbols?.length || 0;
          folderStat.sizeBytes += stat.size;
        } catch (error) {
          // Skip problematic shards
        }
      }
    }
    
    // Convert to array for client
    const folderBreakdown = Array.from(folderStats.entries()).map(([folder, stats]) => ({
      folder,
      files: stats.files,
      symbols: stats.symbols,
      sizeBytes: stats.sizeBytes
    }));
    
    const stats = statsManager.getStats();
    
    connection.console.info(`[Server] Inspect index: ${folderBreakdown.length} folders analyzed`);
    
    return {
      totalFiles: stats.totalFiles,
      totalSymbols: stats.totalSymbols,
      totalShards: stats.totalShards,
      dynamicFiles: stats.dynamicFiles,
      dynamicSymbols: stats.dynamicSymbols,
      backgroundFiles: stats.backgroundFiles,
      backgroundSymbols: stats.backgroundSymbols,
      staticFiles: stats.staticFiles,
      staticSymbols: stats.staticSymbols,
      folderBreakdown
    };
  } catch (error) {
    connection.console.error(`[Server] Error inspecting index: ${error}`);
    throw error;
  }
});

function mapSymbolKind(kind: string): SymbolKind {
  switch (kind) {
    case 'function':
      return SymbolKind.Function;
    case 'class':
      return SymbolKind.Class;
    case 'interface':
      return SymbolKind.Interface;
    case 'type':
      return SymbolKind.TypeParameter;
    case 'enum':
      return SymbolKind.Enum;
    case 'variable':
      return SymbolKind.Variable;
    case 'constant':
      return SymbolKind.Constant;
    case 'method':
      return SymbolKind.Method;
    case 'property':
      return SymbolKind.Property;
    default:
      return SymbolKind.Variable;
  }
}

connection.onRequest('smart-indexer/findDeadCode', async (options?: {
  excludePatterns?: string[];
  includeTests?: boolean;
}) => {
  try {
    connection.console.info('[Server] ========== FIND DEAD CODE REQUEST ==========');
    
    if (!deadCodeDetector) {
      throw new Error('Dead code detector not initialized');
    }
    
    const start = Date.now();
    const result = await deadCodeDetector.findDeadCode(options);
    const duration = Date.now() - start;
    
    connection.console.info(
      `[Server] Dead code analysis complete: ${result.candidates.length} candidates found ` +
      `(${result.analyzedFiles} files analyzed, ${result.totalExports} exports checked) in ${duration}ms`
    );
    
    return {
      candidates: result.candidates.map(c => ({
        name: c.symbol.name,
        kind: c.symbol.kind,
        filePath: c.symbol.filePath,
        location: c.symbol.location,
        reason: c.reason,
        confidence: c.confidence
      })),
      totalExports: result.totalExports,
      analyzedFiles: result.analyzedFiles,
      duration
    };
  } catch (error) {
    connection.console.error(`[Server] Error finding dead code: ${error}`);
    throw error;
  }
});

documents.listen(connection);

connection.onShutdown(async () => {
  try {
    connection.console.info('[Server] Shutting down, closing resources...');
    
    // Dispose file watcher first
    if (fileWatcher) {
      await fileWatcher.dispose();
    }
    
    // Then dispose background index
    await backgroundIndex.dispose();
    
    connection.console.info('[Server] Resources closed successfully');
  } catch (error) {
    connection.console.error(`[Server] Error during shutdown: ${error}`);
  }
});

connection.listen();
