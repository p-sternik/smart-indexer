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
  DefinitionParams,
  Location,
  ReferenceParams,
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
import { findSymbolAtPosition, matchSymbolById } from './indexer/symbolResolver.js';
import { parseMemberAccess, resolvePropertyRecursively } from './indexer/recursiveResolver.js';
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
import { disambiguateSymbols } from './utils/disambiguation.js';
import { IndexedSymbol } from './types.js';
import { TypeScriptService } from './typescript/typeScriptService.js';
import { DeadCodeDetector } from './features/deadCode.js';
import { URI } from 'vscode-uri';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';

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

// Diagnostic collection for dead code warnings
const deadCodeDiagnostics = new Map<string, any[]>(); // URI -> Diagnostics
let deadCodeDebounceTimers = new Map<string, NodeJS.Timeout>(); // URI -> Timer

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

/**
 * Recursively resolve re-exports to find the actual symbol definition.
 * Implements a depth-limited search to prevent infinite loops.
 */
async function resolveReExport(
  symbolName: string,
  targetModulePath: string,
  fromFile: string,
  depth: number = 0,
  visited: Set<string> = new Set()
): Promise<IndexedSymbol[]> {
  const MAX_DEPTH = 5;
  
  if (depth >= MAX_DEPTH) {
    connection.console.warn(`[Server] Re-export recursion limit reached for ${symbolName}`);
    return [];
  }
  
  if (visited.has(targetModulePath)) {
    connection.console.warn(`[Server] Circular re-export detected: ${targetModulePath}`);
    return [];
  }
  
  visited.add(targetModulePath);
  
  // Resolve the module path to an actual file
  if (!importResolver) {
    return [];
  }
  
  const resolvedPath = importResolver.resolveImport(targetModulePath, fromFile);
  if (!resolvedPath) {
    connection.console.log(`[Server] Could not resolve re-export module: ${targetModulePath}`);
    return [];
  }
  
  connection.console.log(`[Server] Following re-export to: ${resolvedPath} (depth ${depth})`);
  
  // Get symbols from the target file
  const targetSymbols = await mergedIndex.getFileSymbols(resolvedPath);
  const matchingSymbols = targetSymbols.filter(sym => sym.name === symbolName);
  
  if (matchingSymbols.length > 0) {
    connection.console.log(`[Server] Found ${matchingSymbols.length} symbols in re-export target`);
    return matchingSymbols;
  }
  
  // If not found, check if the target file also re-exports the symbol
  const targetReExports = await mergedIndex.getFileReExports(resolvedPath);
  for (const reExport of targetReExports) {
    if (reExport.isAll || (reExport.exportedNames && reExport.exportedNames.includes(symbolName))) {
      const nestedResults = await resolveReExport(
        symbolName,
        reExport.moduleSpecifier,
        resolvedPath,
        depth + 1,
        visited
      );
      if (nestedResults.length > 0) {
        return nestedResults;
      }
    }
  }
  
  return [];
}

/**
 * Use TypeScript service to disambiguate when multiple candidates exist.
 * Returns filtered candidates based on semantic analysis.
 */
async function disambiguateWithTypeScript(
  candidates: IndexedSymbol[],
  fileName: string,
  content: string,
  line: number,
  character: number,
  timeoutMs: number = 200
): Promise<IndexedSymbol[]> {
  if (!typeScriptService.isInitialized()) {
    connection.console.log('[Server] TypeScript service not initialized, skipping disambiguation');
    return candidates;
  }

  try {
    // Calculate offset from line/character
    const lines = content.split('\n');
    let offset = 0;
    for (let i = 0; i < line && i < lines.length; i++) {
      offset += lines[i].length + 1; // +1 for newline
    }
    offset += character;

    // Race the TS service call against a timeout
    const disambiguationPromise = new Promise<IndexedSymbol[]>((resolve) => {
      (async () => {
        // Get semantic details from TypeScript
        const symbolDetails = typeScriptService.getSymbolDetails(fileName, offset);
        
        if (!symbolDetails) {
          connection.console.log('[Server] TypeScript service could not resolve symbol details');
          resolve(candidates);
          return;
        }

        connection.console.log(
          `[Server] TS symbol details: name="${symbolDetails.name}", kind="${symbolDetails.kind}", ` +
          `container="${symbolDetails.containerName || '<none>'}", containerKind="${symbolDetails.containerKind || '<none>'}"`
        );

        // Filter candidates based on semantic information
        const filtered = candidates.filter(candidate => {
          // Name must match
          if (candidate.name !== symbolDetails.name) {
            return false;
          }

          // If TS found a container, filter by it
          if (symbolDetails.containerName) {
            // Exact container match
            if (candidate.containerName === symbolDetails.containerName) {
              return true;
            }
            // Check if full container path matches
            if (candidate.fullContainerPath && 
                candidate.fullContainerPath.endsWith(symbolDetails.containerName)) {
              return true;
            }
            // No container match
            return false;
          }

          // If no container from TS, prefer candidates without container (global scope)
          if (!symbolDetails.containerName && !candidate.containerName) {
            return true;
          }

          // Kind matching as secondary filter
          if (candidate.kind === symbolDetails.kind) {
            return true;
          }

          return false;
        });

        if (filtered.length > 0) {
          connection.console.log(`[Server] TypeScript disambiguation: ${candidates.length} → ${filtered.length} candidates`);
          resolve(filtered);
        } else {
          connection.console.log('[Server] TypeScript disambiguation filtered all candidates, keeping original set');
          resolve(candidates);
        }
      })();
    });

    const timeoutPromise = new Promise<IndexedSymbol[]>((resolve) => {
      setTimeout(() => {
        connection.console.warn(`[Server] TypeScript disambiguation timed out after ${timeoutMs}ms`);
        resolve(candidates);
      }, timeoutMs);
    });

    return await Promise.race([disambiguationPromise, timeoutPromise]);
  } catch (error) {
    connection.console.error(`[Server] Error in TypeScript disambiguation: ${error}`);
    return candidates;
  }
}


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
    connection.console.info(`[Server] Background index initialized with ${config.maxConcurrentWorkers || config.maxConcurrentIndexJobs} concurrent jobs`);

    // Initialize dead code detector
    deadCodeDetector = new DeadCodeDetector(backgroundIndex);
    deadCodeDetector.setConfigurationManager(configManager);
    connection.console.info('[Server] Dead code detector initialized');

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
 * Analyze a file for dead code and publish diagnostics
 * Uses debouncing to avoid excessive analysis on every keystroke
 */
async function analyzeDeadCode(uri: string): Promise<void> {
  if (!deadCodeDetector || !configManager.isDeadCodeEnabled()) {
    return;
  }

  try {
    // Clear existing timer for this file
    const existingTimer = deadCodeDebounceTimers.get(uri);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const deadCodeConfig = configManager.getDeadCodeConfig();
    
    // Debounce the analysis
    const timer = setTimeout(async () => {
      try {
        connection.console.log(`[DeadCode] Analyzing ${uri}`);
        
        const candidates = await deadCodeDetector.analyzeFile(uri, {
          entryPoints: deadCodeConfig.entryPoints,
          excludePatterns: deadCodeConfig.excludePatterns,
          checkBarrierFiles: deadCodeConfig.checkBarrierFiles
        });

        // Convert candidates to diagnostics
        const diagnostics: any[] = [];
        
        for (const candidate of candidates) {
          const diagnostic = {
            severity: 4, // Hint (faded text, not intrusive)
            range: {
              start: {
                line: candidate.symbol.range.startLine,
                character: candidate.symbol.range.startCharacter
              },
              end: {
                line: candidate.symbol.range.endLine,
                character: candidate.symbol.range.endCharacter
              }
            },
            message: `Unused export: '${candidate.symbol.name}' (${candidate.reason})`,
            source: 'smart-indexer',
            code: 'unused-export',
            tags: [1] // Unnecessary tag (grays out the code)
          };

          diagnostics.push(diagnostic);
        }

        // Store diagnostics
        deadCodeDiagnostics.set(uri, diagnostics);

        // Send diagnostics to client
        connection.sendDiagnostics({
          uri: URI.file(uri).toString(),
          diagnostics
        });

        if (candidates.length > 0) {
          connection.console.log(`[DeadCode] Found ${candidates.length} unused exports in ${uri}`);
        }
      } catch (error) {
        connection.console.error(`[DeadCode] Error analyzing ${uri}: ${error}`);
      } finally {
        deadCodeDebounceTimers.delete(uri);
      }
    }, deadCodeConfig.debounceMs);

    deadCodeDebounceTimers.set(uri, timer);
  } catch (error) {
    connection.console.error(`[DeadCode] Error setting up analysis for ${uri}: ${error}`);
  }
}

/**
 * Clear dead code diagnostics for a file
 */
function clearDeadCodeDiagnostics(uri: string): void {
  deadCodeDiagnostics.delete(uri);
  connection.sendDiagnostics({
    uri: URI.file(uri).toString(),
    diagnostics: []
  });
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
    await dynamicIndex.updateFile(uri, content);
    
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
        await dynamicIndex.updateFile(uri, content);
        
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
    
    // Clear dead code diagnostics
    clearDeadCodeDiagnostics(uri);
    
    // Cancel pending dead code analysis
    const timer = deadCodeDebounceTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      deadCodeDebounceTimers.delete(uri);
    }
    
    // Keep in dynamic index for a while, or remove immediately
    // For now, we'll remove to keep memory usage low
    dynamicIndex.removeFile(uri);
    updateStats();
  } catch (error) {
    connection.console.error(`[Server] Error in onDidClose: ${error}`);
  }
});

connection.onDefinition(
  async (params: DefinitionParams): Promise<Location | Location[] | null> => {
    const uri = URI.parse(params.textDocument.uri).fsPath;
    const { line, character } = params.position;
    const start = Date.now();
    
    connection.console.log(`[Server] Definition request: ${uri}:${line}:${character}`);
    
    try {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        connection.console.log(`[Server] Definition result: document not found, 0 ms`);
        return null;
      }

      const text = document.getText();

      // NEW: Check if this is a member expression (e.g., myStore.actions.opened)
      const memberAccess = parseMemberAccess(text, line, character);
      if (memberAccess && memberAccess.propertyChain.length > 0) {
        connection.console.log(
          `[Server] Detected member expression: ${memberAccess.baseName}.${memberAccess.propertyChain.join('.')}`
        );

        // Step 1: Find the base object definition
        const baseCandidates = await mergedIndex.findDefinitions(memberAccess.baseName);
        
        if (baseCandidates.length > 0) {
          // Use the first candidate (or disambiguate if needed)
          let baseSymbol = baseCandidates[0];
          if (baseCandidates.length > 1) {
            const ranked = disambiguateSymbols(baseCandidates, uri);
            baseSymbol = ranked[0];
          }

          connection.console.log(
            `[Server] Found base symbol: ${baseSymbol.name} at ${baseSymbol.location.uri}:${baseSymbol.location.line}`
          );

          // Step 2: Recursively resolve the property chain
          const fileResolver = async (fileUri: string) => {
            try {
              return fs.readFileSync(fileUri, 'utf-8');
            } catch {
              return '';
            }
          };

          const symbolFinder = async (name: string, fileUri?: string) => {
            if (fileUri) {
              const fileSymbols = await mergedIndex.getFileSymbols(fileUri);
              return fileSymbols.filter(sym => sym.name === name);
            }
            return await mergedIndex.findDefinitions(name);
          };

          const resolved = await resolvePropertyRecursively(
            baseSymbol,
            memberAccess.propertyChain,
            fileResolver,
            symbolFinder,
            typeScriptService.isInitialized() ? typeScriptService : undefined
          );

          if (resolved) {
            const duration = Date.now() - start;
            profiler.record('definition', duration);
            statsManager.updateProfilingMetrics({ avgDefinitionTimeMs: profiler.getAverageMs('definition') });
            
            connection.console.log(
              `[Server] Recursive resolution succeeded: ${memberAccess.baseName}.${memberAccess.propertyChain.join('.')} ` +
              `-> ${resolved.location.uri}:${resolved.location.line} in ${duration} ms`
            );

            return {
              uri: URI.file(resolved.location.uri).toString(),
              range: {
                start: { line: resolved.range.startLine, character: resolved.range.startCharacter },
                end: { line: resolved.range.endLine, character: resolved.range.endCharacter }
              }
            };
          } else {
            connection.console.log(`[Server] Recursive resolution failed, falling back to standard resolution`);
          }
        }
      }

      // Try to resolve the exact symbol at the cursor position
      const symbolAtCursor = findSymbolAtPosition(uri, text, line, character);
      
      if (symbolAtCursor) {
        connection.console.log(
          `[Server] Resolved symbol: name="${symbolAtCursor.name}", kind="${symbolAtCursor.kind}", ` +
          `container="${symbolAtCursor.containerName || '<none>'}", isStatic=${symbolAtCursor.isStatic}`
        );

        // NEW: Check if this symbol is an import - if so, resolve it
        if (importResolver) {
          const imports = await mergedIndex.getFileImports(uri);
          const importInfo = importResolver.findImportForSymbol(symbolAtCursor.name, imports);
          
          if (importInfo) {
            connection.console.log(`[Server] Symbol is imported from: ${importInfo.moduleSpecifier}`);
            
            // Resolve the module to a file path
            const resolvedPath = importResolver.resolveImport(importInfo.moduleSpecifier, uri);
            
            if (resolvedPath) {
              connection.console.log(`[Server] Resolved import to: ${resolvedPath}`);
              
              // Search only in the resolved file
              let targetSymbols = await mergedIndex.getFileSymbols(resolvedPath);
              let matchingSymbols = targetSymbols.filter(sym => sym.name === symbolAtCursor.name);
              
              // If not found, check if it's a re-export (barrel file)
              if (matchingSymbols.length === 0) {
                connection.console.log(`[Server] Symbol not found in ${resolvedPath}, checking re-exports...`);
                const reExports = await mergedIndex.getFileReExports(resolvedPath);
                
                for (const reExport of reExports) {
                  // Check if this re-export includes our symbol
                  if (reExport.isAll || (reExport.exportedNames && reExport.exportedNames.includes(symbolAtCursor.name))) {
                    connection.console.log(`[Server] Found re-export for ${symbolAtCursor.name} from ${reExport.moduleSpecifier}`);
                    const reExportResults = await resolveReExport(
                      symbolAtCursor.name,
                      reExport.moduleSpecifier,
                      resolvedPath
                    );
                    if (reExportResults.length > 0) {
                      matchingSymbols = reExportResults;
                      break;
                    }
                  }
                }
              }
              
              if (matchingSymbols.length > 0) {
                const results = matchingSymbols.map(sym => ({
                  uri: URI.file(sym.location.uri).toString(),
                  range: {
                    start: { line: sym.range.startLine, character: sym.range.startCharacter },
                    end: { line: sym.range.endLine, character: sym.range.endCharacter }
                  }
                }));
                
                const duration = Date.now() - start;
                profiler.record('definition', duration);
                statsManager.updateProfilingMetrics({ avgDefinitionTimeMs: profiler.getAverageMs('definition') });
                
                connection.console.log(`[Server] Definition result (import-resolved): ${results.length} locations in ${duration} ms`);
                return results;
              }
            } else {
              connection.console.log(`[Server] Could not resolve import path for: ${importInfo.moduleSpecifier}`);
            }
          }
        }

        // Standard resolution: get all candidates by name
        const candidates = await mergedIndex.findDefinitions(symbolAtCursor.name);
        connection.console.log(`[Server] Found ${candidates.length} candidates by name`);

        // Filter candidates to match the exact symbol
        const filtered = candidates.filter(candidate => {
          const nameMatch = candidate.name === symbolAtCursor.name;
          const kindMatch = candidate.kind === symbolAtCursor.kind || 
                           (symbolAtCursor.kind === 'function' && candidate.kind === 'method') ||
                           (symbolAtCursor.kind === 'property' && candidate.kind === 'method');
          const containerMatch = !symbolAtCursor.containerName || 
                                candidate.containerName === symbolAtCursor.containerName;
          const staticMatch = symbolAtCursor.isStatic === undefined || 
                             candidate.isStatic === symbolAtCursor.isStatic;
          
          return nameMatch && kindMatch && containerMatch && staticMatch;
        });

        connection.console.log(`[Server] Filtered to ${filtered.length} exact matches`);

        if (filtered.length > 0) {
          // NEW: If multiple candidates remain, use TypeScript for semantic disambiguation
          let finalCandidates = filtered;
          if (filtered.length > 1) {
            connection.console.log(`[Server] Multiple candidates detected, attempting TypeScript disambiguation...`);
            finalCandidates = await disambiguateWithTypeScript(
              filtered,
              uri,
              text,
              line,
              character,
              200 // 200ms timeout
            );
          }
          
          // Apply disambiguation heuristics as final ranking
          const ranked = disambiguateSymbols(finalCandidates, uri, symbolAtCursor.containerName);
          
          const results = ranked.map(sym => ({
            uri: URI.file(sym.location.uri).toString(),
            range: {
              start: { line: sym.range.startLine, character: sym.range.startCharacter },
              end: { line: sym.range.endLine, character: sym.range.endCharacter }
            }
          }));

          const duration = Date.now() - start;
          profiler.record('definition', duration);
          statsManager.updateProfilingMetrics({ avgDefinitionTimeMs: profiler.getAverageMs('definition') });
          
          connection.console.log(`[Server] Definition result: ${results.length} locations (ranked) in ${duration} ms`);
          return results;
        }
      }

      // Fallback: use simple word-based lookup
      const offset = document.offsetAt(params.position);
      const wordRange = getWordRangeAtPosition(text, offset);
      if (!wordRange) {
        connection.console.log(`[Server] Definition result: no word at position, ${Date.now() - start} ms`);
        return null;
      }

      const word = text.substring(wordRange.start, wordRange.end);
      let symbols = await mergedIndex.findDefinitions(word);

      // Apply ranking heuristics even for fallback
      if (symbols.length > 1) {
        symbols = disambiguateSymbols(symbols, uri);
      }

      const results = symbols.length === 0 ? null : symbols.map(sym => ({
        uri: URI.file(sym.location.uri).toString(),
        range: {
          start: { line: sym.range.startLine, character: sym.range.startCharacter },
          end: { line: sym.range.endLine, character: sym.range.endCharacter }
        }
      }));

      const duration = Date.now() - start;
      profiler.record('definition', duration);
      statsManager.updateProfilingMetrics({ avgDefinitionTimeMs: profiler.getAverageMs('definition') });
      
      connection.console.log(`[Server] Definition result (fallback): symbol="${word}", ${symbols.length} locations in ${duration} ms`);
      return results;
    } catch (error) {
      const duration = Date.now() - start;
      connection.console.error(`[Server] Definition error: ${error}, ${duration} ms`);
      return null;
    }
  }
);

connection.onReferences(
  async (params: ReferenceParams): Promise<Location[] | null> => {
    const uri = URI.parse(params.textDocument.uri).fsPath;
    const { line, character } = params.position;
    const start = Date.now();
    
    connection.console.log(`[Server] References request: ${uri}:${line}:${character}`);
    
    try {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        connection.console.log(`[Server] References result: document not found, 0 ms`);
        return null;
      }

      const text = document.getText();

      // Try to resolve the exact symbol at the cursor position
      const symbolAtCursor = findSymbolAtPosition(uri, text, line, character);
      
      if (symbolAtCursor) {
        connection.console.log(
          `[Server] Resolved symbol: name="${symbolAtCursor.name}", kind="${symbolAtCursor.kind}", ` +
          `container="${symbolAtCursor.containerName || '<none>'}", isStatic=${symbolAtCursor.isStatic}`
        );

        // NEW: Query actual references (usages) instead of definitions
        const references = await mergedIndex.findReferencesByName(symbolAtCursor.name);
        connection.console.log(`[Server] Found ${references.length} references by name`);

        // Filter references to match the exact symbol (by container if available)
        let filtered = references;
        if (symbolAtCursor.containerName) {
          filtered = references.filter(ref => 
            ref.containerName === symbolAtCursor.containerName || !ref.containerName
          );
        }

        connection.console.log(`[Server] Filtered to ${filtered.length} references`);

        // Also include the definition itself if requested
        if (params.context.includeDeclaration) {
          const definitions = await mergedIndex.findDefinitions(symbolAtCursor.name);
          const matchingDef = definitions.filter(def => {
            const nameMatch = def.name === symbolAtCursor.name;
            const containerMatch = !symbolAtCursor.containerName || 
                                  def.containerName === symbolAtCursor.containerName;
            return nameMatch && containerMatch;
          });
          
          // Convert definitions to reference format and add them
          for (const def of matchingDef) {
            filtered.push({
              symbolName: def.name,
              location: def.location,
              range: def.range,
              containerName: def.containerName
            });
          }
        }

        const results = filtered.map(ref => ({
          uri: URI.file(ref.location.uri).toString(),
          range: {
            start: { line: ref.range.startLine, character: ref.range.startCharacter },
            end: { line: ref.range.endLine, character: ref.range.endCharacter }
          }
        }));

        const duration = Date.now() - start;
        profiler.record('references', duration);
        statsManager.updateProfilingMetrics({ avgReferencesTimeMs: profiler.getAverageMs('references') });

        connection.console.log(`[Server] References result: ${results.length} locations in ${duration} ms`);
        return results.length > 0 ? results : null;
      }

      // Fallback: use simple word-based lookup
      const offset = document.offsetAt(params.position);
      const wordRange = getWordRangeAtPosition(text, offset);
      if (!wordRange) {
        connection.console.log(`[Server] References result: no word at position, ${Date.now() - start} ms`);
        return null;
      }

      const word = text.substring(wordRange.start, wordRange.end);
      const references = await mergedIndex.findReferencesByName(word);

      const results = references.length === 0 ? null : references.map(ref => ({
        uri: URI.file(ref.location.uri).toString(),
        range: {
          start: { line: ref.range.startLine, character: ref.range.startCharacter },
          end: { line: ref.range.endLine, character: ref.range.endCharacter }
        }
      }));

      const duration = Date.now() - start;
      profiler.record('references', duration);
      statsManager.updateProfilingMetrics({ avgReferencesTimeMs: profiler.getAverageMs('references') });

      connection.console.log(`[Server] References result (fallback): symbol="${word}", ${references.length} locations in ${duration} ms`);
      return results;
    } catch (error) {
      const duration = Date.now() - start;
      connection.console.error(`[Server] References error: ${error}, ${duration} ms`);
      return null;
    }
  }
);

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

connection.onCompletion(
  async (params: TextDocumentPositionParams): Promise<CompletionItem[]> => {
    const uri = URI.parse(params.textDocument.uri).fsPath;
    const { line, character } = params.position;
    const start = Date.now();
    
    connection.console.log(`[Server] Completion request: ${uri}:${line}:${character}`);
    
    try {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        connection.console.log(`[Server] Completion result: document not found, 0 items, 0 ms`);
        return [];
      }

      const offset = document.offsetAt(params.position);
      const text = document.getText();
      const wordRange = getWordRangeAtPosition(text, offset);
      
      let prefix = '';
      if (wordRange) {
        prefix = text.substring(wordRange.start, offset);
      }

      const symbols = await mergedIndex.searchSymbols(prefix, 50);

      const seen = new Set<string>();
      const items: CompletionItem[] = [];

      for (const sym of symbols) {
        if (!seen.has(sym.name)) {
          seen.add(sym.name);
          items.push({
            label: sym.name,
            kind: mapCompletionItemKind(sym.kind),
            detail: sym.kind,
            data: sym
          });
        }
      }

      connection.console.log(`[Server] Completion result: prefix="${prefix}", ${items.length} items in ${Date.now() - start} ms`);
      return items;
    } catch (error) {
      connection.console.error(`[Server] Completion error: ${error}, ${Date.now() - start} ms`);
      return [];
    }
  }
);

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

function getWordRangeAtPosition(
  text: string,
  offset: number
): { start: number; end: number } | null {
  const wordPattern = /[a-zA-Z_][a-zA-Z0-9_]*/g;
  let match;

  while ((match = wordPattern.exec(text)) !== null) {
    if (match.index <= offset && offset <= match.index + match[0].length) {
      return {
        start: match.index,
        end: match.index + match[0].length
      };
    }
  }

  return null;
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

function mapCompletionItemKind(kind: string): CompletionItemKind {
  switch (kind) {
    case 'function':
      return CompletionItemKind.Function;
    case 'class':
      return CompletionItemKind.Class;
    case 'interface':
      return CompletionItemKind.Interface;
    case 'type':
      return CompletionItemKind.TypeParameter;
    case 'enum':
      return CompletionItemKind.Enum;
    case 'variable':
      return CompletionItemKind.Variable;
    case 'constant':
      return CompletionItemKind.Constant;
    case 'method':
      return CompletionItemKind.Method;
    case 'property':
      return CompletionItemKind.Property;
    default:
      return CompletionItemKind.Text;
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
