import { TextDocuments, Connection } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { DynamicIndex } from '../index/dynamicIndex.js';
import { ConfigurationManager } from '../config/configurationManager.js';
import { TypeScriptService } from '../typescript/typeScriptService.js';
import { StatsManager } from '../index/statsManager.js';
import { BackgroundIndex } from '../index/backgroundIndex.js';
import { DeadCodeHandler } from '../handlers/deadCodeHandler.js';
import { ILogger } from '../utils/Logger.js';

/**
 * Handles document lifecycle events (open, change, close).
 * Extracted from server.ts for single-responsibility.
 */
export class DocumentEventHandler {
  private indexingDebounceTimer: NodeJS.Timeout | null = null;
  private currentActiveDocumentUri: string | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly documents: TextDocuments<TextDocument>,
    private readonly dynamicIndex: DynamicIndex,
    private readonly backgroundIndex: BackgroundIndex,
    private readonly configManager: ConfigurationManager,
    private readonly typeScriptService: TypeScriptService,
    private readonly statsManager: StatsManager,
    private readonly logger: ILogger,
    private deadCodeHandler: DeadCodeHandler | null = null
  ) {}

  /**
   * Set the dead code handler (set after initialization).
   */
  setDeadCodeHandler(handler: DeadCodeHandler): void {
    this.deadCodeHandler = handler;
  }

  /**
   * Get the currently active document URI (for context-aware ranking).
   */
  getCurrentActiveDocumentUri(): string | undefined {
    return this.currentActiveDocumentUri;
  }

  /**
   * Register document event handlers.
   */
  register(): void {
    this.documents.onDidOpen(this.handleDidOpen.bind(this));
    this.documents.onDidChangeContent(this.handleDidChangeContent.bind(this));
    this.documents.onDidClose(this.handleDidClose.bind(this));
  }

  /**
   * Handle document open event.
   */
  private async handleDidOpen(change: { document: TextDocument }): Promise<void> {
    try {
      const uri = URI.parse(change.document.uri).fsPath;

      if (!change.document.uri.startsWith('file:') || 
          this.configManager.shouldExcludePath(uri)) {
        return;
      }

      this.connection.console.info(`[DocumentEventHandler] Document opened: ${uri}`);
      
      // Track as currently active document
      this.currentActiveDocumentUri = uri;
      
      const content = change.document.getText();
      
      // Self-healing: Validate and repair index if stale
      const wasRepaired = await this.dynamicIndex.validateAndRepair(uri, content);
      if (wasRepaired) {
        this.connection.console.info(`[DocumentEventHandler] Self-healing triggered for ${uri}`);
      } else {
        await this.dynamicIndex.updateFile(uri, content);
      }
      
      // Update TypeScript service for semantic intelligence
      if (this.typeScriptService.isInitialized()) {
        this.typeScriptService.updateFile(uri, content);
      }
      
      // Analyze for dead code (fire-and-forget, non-blocking)
      if (this.deadCodeHandler) {
        this.deadCodeHandler.analyzeFile(uri).catch(error => {
          this.logger.error(`[DocumentEventHandler] Dead code analysis error for ${uri}: ${error}`);
        });
      }
      
      this.updateStats();
    } catch (error) {
      this.logger.error(`[DocumentEventHandler] Error in onDidOpen: ${error}`);
    }
  }

  /**
   * Handle document content change event.
   */
  private handleDidChangeContent(change: { document: TextDocument }): void {
    try {
      const uri = URI.parse(change.document.uri).fsPath;

      if (!change.document.uri.startsWith('file:') || 
          change.document.uri.startsWith('vscode-userdata:') || 
          this.configManager.shouldExcludePath(uri)) {
        return;
      }

      if (this.indexingDebounceTimer) {
        clearTimeout(this.indexingDebounceTimer);
      }

      this.indexingDebounceTimer = setTimeout(async () => {
        try {
          this.connection.console.info(`[DocumentEventHandler] Document changed, updating dynamic index: ${uri}`);
          
          // Track as currently active document
          this.currentActiveDocumentUri = uri;
          
          const content = change.document.getText();
          
          // Self-healing: Validate and repair index if stale
          const wasRepaired = await this.dynamicIndex.validateAndRepair(uri, content);
          if (!wasRepaired) {
            await this.dynamicIndex.updateFile(uri, content);
          }
          
          // Update TypeScript service for semantic intelligence
          if (this.typeScriptService.isInitialized()) {
            this.typeScriptService.updateFile(uri, content);
          }
          
          this.updateStats();
          this.connection.console.info(`[DocumentEventHandler] Dynamic index updated for: ${uri}`);
        } catch (error) {
          this.logger.error(`[DocumentEventHandler] Error updating dynamic index for ${uri}: ${error}`);
        }
      }, 500);
    } catch (error) {
      this.logger.error(`[DocumentEventHandler] Error in onDidChangeContent: ${error}`);
    }
  }

  /**
   * Handle document close event.
   */
  private handleDidClose(e: { document: TextDocument }): void {
    try {
      const uri = URI.parse(e.document.uri).fsPath;
      
      if (!e.document.uri.startsWith('file:')) {
        return;
      }

      this.connection.console.info(`[DocumentEventHandler] Document closed: ${uri}`);
      
      // Clear dead code diagnostics (also cancels pending analysis)
      if (this.deadCodeHandler) {
        this.deadCodeHandler.clearDiagnostics(uri);
      }
      
      // Remove from dynamic index to keep memory usage low
      this.dynamicIndex.removeFile(uri);
      this.updateStats();
    } catch (error) {
      this.logger.error(`[DocumentEventHandler] Error in onDidClose: ${error}`);
    }
  }

  /**
   * Update stats from dynamic and background indexes.
   */
  private updateStats(): void {
    const dynamicStats = this.dynamicIndex.getStats();
    const backgroundStats = this.backgroundIndex.getStats();
    
    this.statsManager.updateDynamicStats(dynamicStats.files, dynamicStats.symbols);
    this.statsManager.updateBackgroundStats(backgroundStats.files, backgroundStats.symbols, backgroundStats.shards);
  }

  /**
   * Dispose resources.
   */
  dispose(): void {
    if (this.indexingDebounceTimer) {
      clearTimeout(this.indexingDebounceTimer);
      this.indexingDebounceTimer = null;
    }
  }
}
