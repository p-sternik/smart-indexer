/**
 * Handler Types - Shared interfaces for LSP request handlers.
 * 
 * This module defines the dependency injection contracts used by all handlers.
 * Handlers receive services via constructor injection to avoid circular dependencies.
 */

import { Connection, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { MergedIndex } from '../index/mergedIndex.js';
import { DynamicIndex } from '../index/dynamicIndex.js';
import { BackgroundIndex } from '../index/backgroundIndex.js';
import { StaticIndex } from '../index/staticIndex.js';
import { ConfigurationManager } from '../config/configurationManager.js';
import { TypeScriptService } from '../typescript/typeScriptService.js';
import { ImportResolver } from '../indexer/importResolver.js';
import { LanguageRouter } from '../indexer/languageRouter.js';
import { FileScanner } from '../indexer/fileScanner.js';
import { GitWatcher } from '../git/gitWatcher.js';
import { Profiler } from '../profiler/profiler.js';
import { StatsManager } from '../index/statsManager.js';
import { FolderHasher } from '../cache/folderHasher.js';
import { DeadCodeDetector } from '../features/deadCode.js';
import { FileWatcher } from '../index/fileWatcher.js';
import { ILogger } from '../utils/Logger.js';

/**
 * Core services shared across all handlers.
 * These are the essential dependencies for LSP operations.
 */
export interface CoreServices {
  /** LSP connection for sending messages/notifications */
  connection: Connection;
  /** Document manager for open text documents */
  documents: TextDocuments<TextDocument>;
  /** Merged index (Dynamic + Background + Static) */
  mergedIndex: MergedIndex;
  /** Configuration manager for user settings */
  configManager: ConfigurationManager;
}

/**
 * Index-related services for handlers that need deep index access.
 */
export interface IndexServices {
  /** In-memory index for open files */
  dynamicIndex: DynamicIndex;
  /** Persistent disk-based index */
  backgroundIndex: BackgroundIndex;
  /** Pre-generated static index (optional) */
  staticIndex?: StaticIndex;
}

/**
 * Indexing infrastructure services.
 */
export interface IndexingInfrastructure {
  /** Language router for multi-language support */
  languageRouter: LanguageRouter;
  /** File scanner for workspace discovery */
  fileScanner: FileScanner;
  /** Git integration for incremental indexing */
  gitWatcher: GitWatcher;
  /** Folder hasher for cache validation */
  folderHasher: FolderHasher;
}

/**
 * Resolution and analysis services.
 */
export interface ResolutionServices {
  /** TypeScript service for semantic analysis */
  typeScriptService: TypeScriptService;
  /** Import path resolver */
  importResolver: ImportResolver | null;
  /** Dead code detector */
  deadCodeDetector: DeadCodeDetector | null;
}

/**
 * Monitoring and metrics services.
 */
export interface MonitoringServices {
  /** Performance profiler */
  profiler: Profiler;
  /** Statistics manager */
  statsManager: StatsManager;
}

/**
 * Complete services container for full handler access.
 * Use this for handlers that need everything (e.g., initialization).
 */
export interface ServerServices extends CoreServices, IndexServices, ResolutionServices, MonitoringServices {
  /** Workspace root path */
  workspaceRoot: string;
  /** Unified logger service */
  logger: ILogger;
  /** Indexing infrastructure */
  infrastructure: IndexingInfrastructure;
  /** File watcher for live sync */
  fileWatcher: FileWatcher | null;
}

/**
 * Mutable server state that can be updated by handlers.
 * Kept separate from services to make mutations explicit.
 */
export interface ServerState {
  /** Current workspace root (set during initialization) */
  workspaceRoot: string;
  /** Whether configuration capability is available */
  hasConfigurationCapability: boolean;
  /** Whether workspace folder capability is available */
  hasWorkspaceFolderCapability: boolean;
  /** Currently active document URI for ranking context */
  currentActiveDocumentUri?: string;
  /** Import resolver (created after workspace root is known) */
  importResolver: ImportResolver | null;
  /** Dead code detector (created after index is ready) */
  deadCodeDetector: DeadCodeDetector | null;
  /** Static index (optional, loaded from config) */
  staticIndex?: StaticIndex;
  /** File watcher for live sync */
  fileWatcher: FileWatcher | null;
}

/**
 * Base interface for all LSP handlers.
 * Handlers are responsible for a specific category of LSP operations.
 */
export interface IHandler {
  /** Handler name for logging/debugging */
  readonly name: string;
  
  /** 
   * Register this handler's operations with the LSP connection.
   * Called once during server startup.
   */
  register(): void;
  
  /**
   * Dispose of resources held by this handler.
   * Called during server shutdown.
   */
  dispose?(): Promise<void>;
}

/**
 * Factory function type for creating handlers.
 * Used by HandlerRegistry for lazy instantiation.
 */
export type HandlerFactory<T extends IHandler> = (
  services: ServerServices,
  state: ServerState
) => T;
