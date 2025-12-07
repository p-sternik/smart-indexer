/**
 * Smart Indexer Language Server - Bootstrap Module
 * 
 * This is a lightweight entry point that:
 * 1. Creates the LSP connection
 * 2. Instantiates core services
 * 3. Delegates to ServerInitializer for initialization
 * 4. Delegates to DocumentEventHandler for document events
 * 5. Registers LSP request handlers
 */

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  WorkspaceSymbol,
  WorkspaceSymbolParams,
  SymbolKind,
  CancellationToken,
  ResponseError
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { GitWatcher } from './git/gitWatcher.js';
import { FileScanner } from './indexer/fileScanner.js';
import { SymbolIndexer } from './indexer/symbolIndexer.js';
import { LanguageRouter } from './indexer/languageRouter.js';
import { ConfigurationManager } from './config/configurationManager.js';
import { DynamicIndex } from './index/dynamicIndex.js';
import { BackgroundIndex } from './index/backgroundIndex.js';
import { MergedIndex } from './index/mergedIndex.js';
import { StatsManager } from './index/statsManager.js';
import { SqlJsStorage } from './storage/SqlJsStorage.js';
import { NgRxLinkResolver } from './index/resolvers/NgRxLinkResolver.js';
import { WorkerPool } from './utils/workerPool.js';
import { Profiler } from './profiler/profiler.js';
import { FolderHasher } from './cache/folderHasher.js';
import { RankingContext } from './utils/fuzzySearch.js';
import { TypeScriptService } from './typescript/typeScriptService.js';
import { URI } from 'vscode-uri';
import * as path from 'path';

// Core module imports
import { ServerInitializer, DocumentEventHandler } from './core/index.js';
import { FileSystemService } from './utils/FileSystemService.js';
import { CancellationError } from './utils/asyncUtils.js';

// Plugin system initialization
import { initializeDefaultPlugins } from './plugins/index.js';

// Initialize framework plugins (Angular, NgRx, etc.)
initializeDefaultPlugins();

// Handler imports
import { 
  HandlerRegistry, 
  ServerServices, 
  ServerState,
  createDefinitionHandler,
  createReferencesHandler,
  createCompletionHandler,
  createDeadCodeHandler,
  createHoverHandler,
  createRenameHandler,
  DeadCodeHandler
} from './handlers/index.js';

// ============================================================================
// Create LSP Connection and Core Services
// ============================================================================

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Core services
const configManager = new ConfigurationManager();
const gitWatcher = new GitWatcher();
const fileScanner = new FileScanner();
const symbolIndexer = new SymbolIndexer();
const languageRouter = new LanguageRouter(symbolIndexer, false);
const profiler = new Profiler();
const folderHasher = new FolderHasher();
const typeScriptService = new TypeScriptService();
const fileSystem = new FileSystemService();

// Infrastructure components (injected into BackgroundIndex)
const storage = new SqlJsStorage(2000); // Auto-save every 2 seconds
const workerScriptPath = path.join(__dirname, 'indexer', 'worker.js');
const workerPool = new WorkerPool(workerScriptPath, 4);
const ngrxResolver = new NgRxLinkResolver(storage);

// Index architecture (clangd-inspired 3-tier)
const dynamicIndex = new DynamicIndex(symbolIndexer);
const backgroundIndex = new BackgroundIndex(symbolIndexer, storage, workerPool, ngrxResolver);
const mergedIndex = new MergedIndex(dynamicIndex, backgroundIndex);
const statsManager = new StatsManager();

// ============================================================================
// Server Initializer and Document Event Handler
// ============================================================================

const serverDeps = {
  connection,
  documents,
  configManager,
  dynamicIndex,
  backgroundIndex,
  mergedIndex,
  statsManager,
  typeScriptService,
  languageRouter,
  fileScanner,
  gitWatcher,
  folderHasher,
  profiler,
  fileSystem
};

const serverInitializer = new ServerInitializer(serverDeps);

// Document event handler (initialized after server initialization)
let documentEventHandler: DocumentEventHandler;

// Dead code handler instance
let deadCodeHandler: DeadCodeHandler | null = null;

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

const handlerRegistry = new HandlerRegistry(serverServices, serverState);

// Register core handlers
handlerRegistry.register(createDefinitionHandler);
handlerRegistry.register(createReferencesHandler);
handlerRegistry.register(createCompletionHandler);
handlerRegistry.register(createHoverHandler);
handlerRegistry.register(createRenameHandler);

// ============================================================================
// LSP Lifecycle Handlers
// ============================================================================

connection.onInitialize(async (params) => {
  const result = await serverInitializer.handleInitialize(params);
  
  // Sync initialization result with server state/services
  const initResult = serverInitializer.getResult();
  serverState.workspaceRoot = initResult.workspaceRoot;
  serverState.hasConfigurationCapability = initResult.hasConfigurationCapability;
  serverState.hasWorkspaceFolderCapability = initResult.hasWorkspaceFolderCapability;
  serverState.importResolver = initResult.importResolver;
  serverServices.workspaceRoot = initResult.workspaceRoot;
  serverServices.importResolver = initResult.importResolver;
  
  return result;
});

connection.onInitialized(async () => {
  await serverInitializer.handleInitialized();
  
  // Sync post-initialization results
  const initResult = serverInitializer.getResult();
  serverState.deadCodeDetector = initResult.deadCodeDetector;
  serverState.fileWatcher = initResult.fileWatcher;
  serverState.staticIndex = initResult.staticIndex;
  serverServices.deadCodeDetector = initResult.deadCodeDetector;
  serverServices.fileWatcher = initResult.fileWatcher;
  serverServices.staticIndex = initResult.staticIndex;
  
  // Initialize document event handler
  documentEventHandler = new DocumentEventHandler(
    connection,
    documents,
    dynamicIndex,
    backgroundIndex,
    configManager,
    typeScriptService,
    statsManager
  );
  
  // Register DeadCodeHandler now that detector is ready
  if (initResult.deadCodeDetector) {
    deadCodeHandler = createDeadCodeHandler(serverServices, serverState);
    deadCodeHandler.register();
    documentEventHandler.setDeadCodeHandler(deadCodeHandler);
    connection.console.info('[Server] DeadCodeHandler registered');
  }
  
  // Register document event handlers
  documentEventHandler.register();
});

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

// ============================================================================
// Workspace Symbol Handler
// ============================================================================

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

      const currentActiveUri = documentEventHandler?.getCurrentActiveDocumentUri();
      const context: RankingContext = {
        openFiles,
        currentFileUri: currentActiveUri
      };

      // Use fuzzy search with ranking
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

// ============================================================================
// Custom Request Handlers
// ============================================================================

connection.onRequest('smart-indexer/rebuildIndex', async () => {
  try {
    connection.console.info('[Server] ========== REBUILD INDEX COMMAND ==========');
    await backgroundIndex.clear();
    connection.console.info('[Server] Background index cleared');
    // Note: Full reindexing would need to be triggered separately
    const stats = statsManager.getStats();
    connection.console.info(`[Server] ========== REBUILD COMPLETE ==========`);
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
    const workspaceRoot = serverState.workspaceRoot;
    const cacheDir = path.join(workspaceRoot, config.cacheDirectory, 'index');
    
    // Collect per-folder breakdown
    const folderStats = new Map<string, { files: number; symbols: number; sizeBytes: number }>();
    
    try {
      const shardFiles = await fileSystem.readDirectory(cacheDir);
      
      for (const shardFile of shardFiles) {
        if (!shardFile.endsWith('.json')) {
          continue;
        }
        
        try {
          const shardPath = path.join(cacheDir, shardFile);
          const [stat, content] = await Promise.all([
            fileSystem.stat(shardPath),
            fileSystem.readFile(shardPath)
          ]);
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
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    
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

connection.onRequest('smart-indexer/findDeadCode', async (options: {
  excludePatterns?: string[];
  includeTests?: boolean;
} | undefined, token: CancellationToken) => {
  try {
    connection.console.info('[Server] ========== FIND DEAD CODE REQUEST ==========');
    
    const deadCodeDetector = serverState.deadCodeDetector;
    if (!deadCodeDetector) {
      throw new Error('Dead code detector not initialized');
    }
    
    // Create progress indicator
    const progress = await connection.window.createWorkDoneProgress();
    progress.begin('Finding Dead Code', 0, 'Preparing analysis...', true);
    
    const start = Date.now();
    
    try {
      const result = await deadCodeDetector.findDeadCode({
        ...options,
        cancellationToken: token,
        onProgress: (current, total, message) => {
          const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
          progress.report(percentage, message || `${current}/${total} files`);
        }
      });
      
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
    } finally {
      progress.done();
    }
  } catch (error) {
    // Handle cancellation specifically
    if (error instanceof CancellationError || token.isCancellationRequested) {
      connection.console.info('[Server] Dead code analysis cancelled by user');
      throw new ResponseError(-32800, 'Dead code analysis cancelled');
    }
    
    connection.console.error(`[Server] Error finding dead code: ${error}`);
    throw error;
  }
});

// ============================================================================
// Helper Functions
// ============================================================================

function updateStats(): void {
  const dynamicStats = dynamicIndex.getStats();
  const backgroundStats = backgroundIndex.getStats();
  
  statsManager.updateDynamicStats(dynamicStats.files, dynamicStats.symbols);
  statsManager.updateBackgroundStats(backgroundStats.files, backgroundStats.symbols, backgroundStats.shards);
}

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

// ============================================================================
// Server Lifecycle
// ============================================================================

documents.listen(connection);

connection.onShutdown(async () => {
  try {
    connection.console.info('[Server] Shutting down, closing resources...');
    
    // Dispose document event handler
    if (documentEventHandler) {
      documentEventHandler.dispose();
    }
    
    // Dispose file watcher
    const fileWatcher = serverState.fileWatcher;
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
