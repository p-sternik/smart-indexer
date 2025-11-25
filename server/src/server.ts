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
import { ConfigurationManager } from './config/configurationManager.js';
import { DynamicIndex } from './index/dynamicIndex.js';
import { BackgroundIndex } from './index/backgroundIndex.js';
import { MergedIndex } from './index/mergedIndex.js';
import { StatsManager } from './index/statsManager.js';
import { URI } from 'vscode-uri';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

const configManager = new ConfigurationManager();
const gitWatcher = new GitWatcher();
const fileScanner = new FileScanner();
const symbolIndexer = new SymbolIndexer();

// New clangd-inspired index architecture
const dynamicIndex = new DynamicIndex(symbolIndexer);
const backgroundIndex = new BackgroundIndex(symbolIndexer, 4); // Default 4 concurrent jobs
const mergedIndex = new MergedIndex(dynamicIndex, backgroundIndex);
const statsManager = new StatsManager();

let workspaceRoot: string = '';
let indexingDebounceTimer: NodeJS.Timeout | null = null;

interface ServerSettings {
  cacheDirectory: string;
  enableGitIntegration: boolean;
  excludePatterns: string[];
  maxIndexedFileSize: number;
  maxConcurrentIndexJobs: number;
  enableBackgroundIndex: boolean;
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
  enableBackgroundIndex: true
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

async function initializeIndexing(): Promise<void> {
  if (!workspaceRoot) {
    connection.console.warn('[Server] No workspace root found, skipping indexing');
    return;
  }

  connection.console.info(`[Server] Initializing indexing for workspace: ${workspaceRoot}`);

  const config = configManager.getConfig();

  try {
    // Initialize background index
    await backgroundIndex.init(workspaceRoot, config.cacheDirectory);
    backgroundIndex.setMaxConcurrentJobs(config.maxConcurrentIndexJobs);
    connection.console.info(`[Server] Background index initialized with ${config.maxConcurrentIndexJobs} concurrent jobs`);

    fileScanner.configure({
      excludePatterns: config.excludePatterns,
      maxFileSize: configManager.getMaxFileSizeBytes(),
      configManager
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

    updateStats();
    const stats = statsManager.getStats();
    connection.console.info(`[Server] ========== BACKGROUND INDEXING COMPLETE ==========`);
    connection.console.info(`[Server] Total: ${stats.totalFiles} files, ${stats.totalSymbols} symbols indexed`);
  } catch (error) {
    connection.console.error(`[Server] Error in background indexing: ${error}`);
    if (error instanceof Error) {
      connection.console.error(`[Server] Stack trace: ${error.stack}`);
    }
    throw error;
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
async function loadMetadata(): Promise<{ version: number; lastGitHash?: string; lastUpdatedAt: number }> {
  try {
    const metadataPath = path.join(workspaceRoot, configManager.getConfig().cacheDirectory, 'metadata.json');
    if (fs.existsSync(metadataPath)) {
      const content = fs.readFileSync(metadataPath, 'utf-8');
      return JSON.parse(content);
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
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
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

documents.onDidOpen(async (change) => {
  try {
    const uri = URI.parse(change.document.uri).fsPath;

    if (!change.document.uri.startsWith('file:') || 
        configManager.shouldExcludePath(uri)) {
      return;
    }

    connection.console.info(`[Server] Document opened: ${uri}`);
    const content = change.document.getText();
    await dynamicIndex.updateFile(uri, content);
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
        const content = change.document.getText();
        await dynamicIndex.updateFile(uri, content);
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

      const offset = document.offsetAt(params.position);
      const text = document.getText();
      const wordRange = getWordRangeAtPosition(text, offset);
      if (!wordRange) {
        connection.console.log(`[Server] Definition result: no word at position, ${Date.now() - start} ms`);
        return null;
      }

      const word = text.substring(wordRange.start, wordRange.end);
      const symbols = await mergedIndex.findDefinitions(word);

      const results = symbols.length === 0 ? null : symbols.map(sym => ({
        uri: URI.file(sym.location.uri).toString(),
        range: {
          start: { line: sym.location.line, character: sym.location.character },
          end: { line: sym.location.line, character: sym.location.character + word.length }
        }
      }));

      connection.console.log(`[Server] Definition result: symbol="${word}", ${symbols.length} locations in ${Date.now() - start} ms`);
      return results;
    } catch (error) {
      connection.console.error(`[Server] Definition error: ${error}, ${Date.now() - start} ms`);
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

      const offset = document.offsetAt(params.position);
      const text = document.getText();
      const wordRange = getWordRangeAtPosition(text, offset);
      if (!wordRange) {
        connection.console.log(`[Server] References result: no word at position, ${Date.now() - start} ms`);
        return null;
      }

      const word = text.substring(wordRange.start, wordRange.end);
      const symbols = await mergedIndex.findReferences(word);

      const results = symbols.length === 0 ? null : symbols.map(sym => ({
        uri: URI.file(sym.location.uri).toString(),
        range: {
          start: { line: sym.location.line, character: sym.location.character },
          end: { line: sym.location.line, character: sym.location.character + word.length }
        }
      }));

      connection.console.log(`[Server] References result: symbol="${word}", ${symbols.length} locations in ${Date.now() - start} ms`);
      return results;
    } catch (error) {
      connection.console.error(`[Server] References error: ${error}, ${Date.now() - start} ms`);
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

      const symbols = await mergedIndex.searchSymbols(query, 100);

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

documents.listen(connection);

connection.onShutdown(async () => {
  try {
    connection.console.info('[Server] Shutting down, closing resources...');
    connection.console.info('[Server] Resources closed successfully');
  } catch (error) {
    connection.console.error(`[Server] Error during shutdown: ${error}`);
  }
});

connection.listen();
