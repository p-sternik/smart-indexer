import { Connection, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { BackgroundIndex } from './backgroundIndex.js';
import { ConfigurationManager } from '../config/configurationManager.js';
import { ILogger } from '../utils/Logger.js';
import { URI } from 'vscode-uri';
import * as chokidar from 'chokidar';
import * as path from 'path';

/**
 * FileWatcher with per-file debouncing for live index synchronization.
 * 
 * Listens to:
 * - LSP text document changes (onDidChangeTextDocument)
 * - File system changes via chokidar (external changes like git pull)
 * - File creation/deletion events
 * 
 * Uses a debounce map to prevent re-indexing on every keystroke.
 */
export class FileWatcher {
  private connection: Connection;
  private documents: TextDocuments<TextDocument>;
  private backgroundIndex: BackgroundIndex;
  private configManager: ConfigurationManager;
  private workspaceRoot: string;
  private logger: ILogger;
  
  // Per-file debounce timers
  private debounceMap: Map<string, NodeJS.Timeout> = new Map();
  private debounceDelayMs: number = 600;
  
  // Chokidar watcher for external file changes
  private fsWatcher: chokidar.FSWatcher | null = null;
  
  // Track files currently being indexed to avoid duplicate jobs
  private indexingInProgress: Set<string> = new Set();

  constructor(
    connection: Connection,
    documents: TextDocuments<TextDocument>,
    backgroundIndex: BackgroundIndex,
    configManager: ConfigurationManager,
    workspaceRoot: string,
    logger: ILogger,
    debounceDelayMs: number = 600
  ) {
    this.connection = connection;
    this.documents = documents;
    this.backgroundIndex = backgroundIndex;
    this.configManager = configManager;
    this.workspaceRoot = workspaceRoot;
    this.logger = logger;
    this.debounceDelayMs = debounceDelayMs;
  }

  /**
   * Initialize the file watcher and register all listeners.
   */
  async init(): Promise<void> {
    this.connection.console.info('[FileWatcher] Initializing file watcher...');
    
    // Listen to LSP text document changes
    this.documents.onDidChangeContent(this.onDocumentChanged.bind(this));
    this.documents.onDidSave(this.onDocumentSaved.bind(this));
    
    // Setup external file system watcher with chokidar
    await this.setupFileSystemWatcher();
    
    this.connection.console.info(
      `[FileWatcher] File watcher initialized with ${this.debounceDelayMs}ms debounce delay`
    );
  }

  /**
   * Setup chokidar to watch for external file changes (git pull, external editors, etc.)
   */
  private async setupFileSystemWatcher(): Promise<void> {
    try {
      const config = this.configManager.getConfig();
      
      // Watch workspace for file changes
      this.fsWatcher = chokidar.watch(this.workspaceRoot, {
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/out/**',
          '**/build/**',
          '**/.smart-index/**',
          ...config.excludePatterns.map(p => p.replace(/\*\*/g, '*'))
        ],
        persistent: true,
        ignoreInitial: true, // Don't fire events for existing files
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100
        }
      });

      // External file change
      this.fsWatcher.on('change', (filePath: string) => {
        const fullPath = path.resolve(filePath);
        if (this.shouldIndex(fullPath)) {
          this.connection.console.info(`[FileWatcher] External change detected: ${fullPath}`);
          this.scheduleReindex(fullPath, 'external-change');
        }
      });

      // File added
      this.fsWatcher.on('add', (filePath: string) => {
        const fullPath = path.resolve(filePath);
        if (this.shouldIndex(fullPath)) {
          this.connection.console.info(`[FileWatcher] File created: ${fullPath}`);
          this.scheduleReindex(fullPath, 'file-created');
        }
      });

      // File deleted
      this.fsWatcher.on('unlink', (filePath: string) => {
        const fullPath = path.resolve(filePath);
        this.connection.console.info(`[FileWatcher] File deleted: ${fullPath}`);
        this.handleFileDeletion(fullPath);
      });

      this.connection.console.info('[FileWatcher] External file system watcher (chokidar) initialized');
    } catch (error) {
      this.logger.error(`[FileWatcher] Error setting up file system watcher: ${error}`);
    }
  }

  /**
   * Handle text document changes from LSP.
   */
  private onDocumentChanged(event: { document: TextDocument }): void {
    try {
      const uri = URI.parse(event.document.uri).fsPath;
      
      if (!this.shouldIndex(uri)) {
        return;
      }
      
      // Don't log every keystroke, only when scheduling
      this.scheduleReindex(uri, 'document-change');
    } catch (error) {
      this.logger.error(`[FileWatcher] Error in onDocumentChanged: ${error}`);
    }
  }

  /**
   * Handle document save events - trigger immediate re-index and persist to cache.
   */
  private onDocumentSaved(event: { document: TextDocument }): void {
    try {
      const uri = URI.parse(event.document.uri).fsPath;
      
      if (!this.shouldIndex(uri)) {
        return;
      }
      
      this.connection.console.info(`[FileWatcher] File saved: ${uri}`);
      
      // Cancel pending debounced re-index
      this.cancelDebounce(uri);
      
      // Trigger immediate re-index on save (user explicitly saved, so update cache)
      this.reindexFile(uri, 'file-saved').catch(error => {
        this.logger.error(`[FileWatcher] Error re-indexing saved file ${uri}: ${error}`);
      });
    } catch (error) {
      this.logger.error(`[FileWatcher] Error in onDocumentSaved: ${error}`);
    }
  }

  /**
   * Schedule a re-index for a file with per-file debouncing.
   * 
   * @param filePath - Absolute file path
   * @param trigger - What triggered the re-index (for logging)
   */
  private scheduleReindex(filePath: string, trigger: string): void {
    // Clear existing timer for this file
    this.cancelDebounce(filePath);
    
    // Set new timer
    const timer = setTimeout(() => {
      this.debounceMap.delete(filePath);
      this.connection.console.info(
        `[FileWatcher] Debounce timer fired for ${path.basename(filePath)} (trigger: ${trigger})`
      );
      this.reindexFile(filePath, trigger).catch(error => {
        this.logger.error(`[FileWatcher] Error re-indexing file ${filePath}: ${error}`);
      });
    }, this.debounceDelayMs);
    
    this.debounceMap.set(filePath, timer);
  }

  /**
   * Cancel the debounce timer for a specific file.
   */
  private cancelDebounce(filePath: string): void {
    const existingTimer = this.debounceMap.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.debounceMap.delete(filePath);
    }
  }

  /**
   * Re-index a single file and update the background index.
   * 
   * Steps:
   * 1. Check if already indexing (avoid duplicate work)
   * 2. Call backgroundIndex.updateSingleFile()
   * 3. Update in-memory index
   */
  private async reindexFile(filePath: string, trigger: string): Promise<void> {
    // Prevent duplicate indexing jobs for the same file
    if (this.indexingInProgress.has(filePath)) {
      this.logger.warn(
        `[FileWatcher] Skipping re-index of ${path.basename(filePath)} - already in progress`
      );
      return;
    }
    
    try {
      this.indexingInProgress.add(filePath);
      
      const startTime = Date.now();
      await this.backgroundIndex.updateSingleFile(filePath);
      const duration = Date.now() - startTime;
      
      this.connection.console.info(
        `[FileWatcher] Re-indexed ${path.basename(filePath)} in ${duration}ms (trigger: ${trigger})`
      );
    } finally {
      this.indexingInProgress.delete(filePath);
    }
  }

  /**
   * Handle file deletion - immediately purge from index.
   */
  private async handleFileDeletion(filePath: string): Promise<void> {
    try {
      // Cancel any pending re-index for this file
      this.cancelDebounce(filePath);
      
      // Remove from indexing queue if present
      this.indexingInProgress.delete(filePath);
      
      // Purge from background index
      await this.backgroundIndex.removeFile(filePath);
      
      this.connection.console.info(
        `[FileWatcher] Removed deleted file from index: ${path.basename(filePath)}`
      );
    } catch (error) {
      this.logger.error(`[FileWatcher] Error handling file deletion ${filePath}: ${error}`);
    }
  }

  /**
   * Check if a file should be indexed (exclude patterns, file type, etc.)
   */
  private shouldIndex(filePath: string): boolean {
    // Check exclusion patterns
    if (this.configManager.shouldExcludePath(filePath)) {
      return false;
    }
    
    // Only index supported file types
    const ext = path.extname(filePath).toLowerCase();
    const supportedExtensions = [
      '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
      '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp'
    ];
    
    if (!supportedExtensions.includes(ext)) {
      return false;
    }
    
    return true;
  }

  /**
   * Update the debounce delay (in milliseconds).
   */
  setDebounceDelay(delayMs: number): void {
    this.debounceDelayMs = Math.max(100, Math.min(5000, delayMs));
    this.connection.console.info(`[FileWatcher] Debounce delay updated to ${this.debounceDelayMs}ms`);
  }

  /**
   * Get statistics about the file watcher.
   */
  getStats(): {
    pendingDebounces: number;
    activeIndexing: number;
    debounceDelayMs: number;
  } {
    return {
      pendingDebounces: this.debounceMap.size,
      activeIndexing: this.indexingInProgress.size,
      debounceDelayMs: this.debounceDelayMs
    };
  }

  /**
   * Dispose resources and cleanup.
   */
  async dispose(): Promise<void> {
    this.connection.console.info('[FileWatcher] Disposing file watcher...');
    
    // Clear all pending debounce timers
    for (const [_filePath, timer] of this.debounceMap) {
      clearTimeout(timer);
    }
    this.debounceMap.clear();
    
    // Stop chokidar watcher
    if (this.fsWatcher) {
      await this.fsWatcher.close();
      this.fsWatcher = null;
    }
    
    this.indexingInProgress.clear();
    
    this.connection.console.info('[FileWatcher] File watcher disposed');
  }
}
