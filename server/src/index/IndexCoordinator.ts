import * as fsPromises from 'fs/promises';
import { IndexedFileResult } from '../types.js';
import { SymbolIndexer } from '../indexer/symbolIndexer.js';
import { LanguageRouter } from '../indexer/languageRouter.js';
import { ConfigurationManager } from '../config/configurationManager.js';
import { WorkerPool, IWorkerPool } from '../utils/workerPool.js';
import { sanitizeFilePath } from '../utils/stringUtils.js';
import { ProgressCallback } from './IndexScheduler.js';

/**
 * File metadata for tracking indexed files.
 */
export interface FileMetadata {
  hash: string;
  lastIndexedAt: number;
  symbolCount: number;
  mtime?: number;
}

/**
 * IndexCoordinator - Orchestrates file indexing operations.
 * Extracted from BackgroundIndex for single-responsibility.
 * 
 * Responsibilities:
 * - Determine which files need indexing (mtime-based check)
 * - Coordinate parallel indexing with worker pool
 * - Handle progress reporting
 * - Purge excluded files
 */
export class IndexCoordinator {
  private workerPool: IWorkerPool | null = null;
  private maxConcurrentJobs: number;
  private isBulkIndexing: boolean = false;
  private progressCallback: ProgressCallback | null = null;

  constructor(
    private readonly symbolIndexer: SymbolIndexer,
    private readonly fileMetadata: Map<string, FileMetadata>,
    maxConcurrentJobs: number = 4
  ) {
    this.maxConcurrentJobs = maxConcurrentJobs;
  }

  private languageRouter: LanguageRouter | null = null;
  private configManager: ConfigurationManager | null = null;

  /**
   * Set the language router for multi-language indexing.
   */
  setLanguageRouter(router: LanguageRouter): void {
    this.languageRouter = router;
  }

  /**
   * Set the configuration manager for exclusion filtering.
   */
  setConfigurationManager(configManager: ConfigurationManager): void {
    this.configManager = configManager;
  }

  /**
   * Set progress callback for UI updates.
   */
  setProgressCallback(callback: ProgressCallback): void {
    this.progressCallback = callback;
  }

  /**
   * Update the maximum number of concurrent indexing jobs.
   */
  setMaxConcurrentJobs(max: number): void {
    this.maxConcurrentJobs = Math.max(1, Math.min(16, max));
    if (this.workerPool) {
      // Worker pool doesn't support dynamic resizing, but we store for next init
    }
  }

  /**
   * Initialize the worker pool.
   */
  initWorkerPool(workerScriptPath: string): void {
    this.workerPool = new WorkerPool(workerScriptPath, this.maxConcurrentJobs);
    console.info(`[IndexCoordinator] Initialized worker pool with ${this.maxConcurrentJobs} workers`);
  }

  /**
   * Get the worker pool (for stats, validation, etc.).
   */
  getWorkerPool(): IWorkerPool | null {
    return this.workerPool;
  }

  /**
   * Check if bulk indexing is in progress.
   */
  isBulkIndexingActive(): boolean {
    return this.isBulkIndexing;
  }

  /**
   * Check if file needs reindexing based on mtime.
   * Returns true if file should be indexed (cache miss or stale).
   */
  async needsReindexing(uri: string): Promise<boolean> {
    const metadata = this.fileMetadata.get(uri);
    if (!metadata) {
      return true; // No cache entry
    }

    // If no mtime stored, fall back to hash-based check
    if (!metadata.mtime) {
      return true;
    }

    try {
      const stats = await fsPromises.stat(uri);
      const currentMtime = stats.mtimeMs;
      
      // If mtime matches, file is unchanged
      if (currentMtime === metadata.mtime) {
        return false;
      }
      
      return true;
    } catch (error) {
      // File might not exist anymore
      return true;
    }
  }

  /**
   * Ensure all files are up to date.
   * Main entry point for incremental background indexing.
   */
  async ensureUpToDate(
    allFiles: string[],
    _computeHash: (uri: string) => Promise<string>,
    onFileIndexed: (uri: string, result: IndexedFileResult) => Promise<void>,
    onFileRemoved: (uri: string) => Promise<void>,
    onProgress?: (current: number, total: number) => void
  ): Promise<void> {
    const filesToIndex: string[] = [];
    let checked = 0;
    let excluded = 0;

    // Check which files need indexing
    for (const uri of allFiles) {
      try {
        // STEP 1: Apply exclusion filters BEFORE any processing
        if (this.configManager && this.configManager.shouldExcludePath(uri)) {
          excluded++;
          checked++;
          if (onProgress) {
            onProgress(checked, allFiles.length);
          }
          continue;
        }

        // STEP 2: Check mtime-based cache (fast path)
        if (!(await this.needsReindexing(uri))) {
          // File is unchanged based on mtime - skip indexing
          checked++;
          if (onProgress) {
            onProgress(checked, allFiles.length);
          }
          continue;
        }

        // STEP 3: File needs indexing (mtime changed or no cache)
        filesToIndex.push(uri);

        checked++;
        if (onProgress) {
          onProgress(checked, allFiles.length);
        }
      } catch (error) {
        console.error(`[IndexCoordinator] Error checking file ${uri}: ${error}`);
      }
    }

    if (excluded > 0) {
      console.info(`[IndexCoordinator] Excluded ${excluded} files from indexing (build artifacts, node_modules, etc.)`);
    }

    // Remove stale shards (files that no longer exist)
    const currentFileSet = new Set(allFiles);
    const staleFiles = Array.from(this.fileMetadata.keys()).filter(uri => !currentFileSet.has(uri));
    for (const uri of staleFiles) {
      await onFileRemoved(uri);
    }

    // Clean up previously indexed excluded files (purge .angular, dist, etc.)
    await this.purgeExcludedFiles(onFileRemoved);

    // Index files in parallel using worker pool
    if (filesToIndex.length > 0) {
      console.info(`[IndexCoordinator] Indexing ${filesToIndex.length} files with ${this.maxConcurrentJobs} concurrent jobs`);
      await this.indexFilesParallel(filesToIndex, onFileIndexed, onProgress ? 
        (current) => onProgress(checked - filesToIndex.length + current, allFiles.length) : 
        undefined
      );
    } else {
      console.info(`[IndexCoordinator] All files up to date (mtime-based check)`);
    }
  }

  /**
   * Purge previously indexed files that should now be excluded.
   */
  private async purgeExcludedFiles(onFileRemoved: (uri: string) => Promise<void>): Promise<void> {
    if (!this.configManager) {
      return;
    }

    const filesToPurge: string[] = [];
    
    for (const uri of this.fileMetadata.keys()) {
      if (this.configManager.shouldExcludePath(uri)) {
        filesToPurge.push(uri);
      }
    }

    if (filesToPurge.length > 0) {
      console.info(`[IndexCoordinator] Purging ${filesToPurge.length} excluded files from cache`);
      for (const uri of filesToPurge) {
        await onFileRemoved(uri);
      }
    }
  }

  /**
   * Index multiple files in parallel using a worker pool.
   */
  async indexFilesParallel(
    files: string[],
    onFileIndexed: (uri: string, result: IndexedFileResult) => Promise<void>,
    onProgress?: (current: number) => void
  ): Promise<void> {
    // PRE-QUEUE VALIDATION: Sanitize paths and filter out non-existent files
    const validFiles: string[] = [];
    const skippedFiles: string[] = [];
    
    for (const rawUri of files) {
      const uri = sanitizeFilePath(rawUri);
      
      try {
        await fsPromises.access(uri);
        validFiles.push(uri);
      } catch {
        skippedFiles.push(rawUri);
      }
    }
    
    if (skippedFiles.length > 0) {
      console.warn(
        `[IndexCoordinator] Skipping ${skippedFiles.length} non-existent files (possible path encoding issue)`
      );
      for (const skipped of skippedFiles.slice(0, 5)) {
        console.warn(`[IndexCoordinator]   - ${skipped}`);
      }
      if (skippedFiles.length > 5) {
        console.warn(`[IndexCoordinator]   ... and ${skippedFiles.length - 5} more`);
      }
    }

    let processed = 0;
    const total = validFiles.length;
    const startTime = Date.now();
    let lastProgressTime = startTime;

    // Enable bulk indexing mode to defer NgRx resolution
    this.isBulkIndexing = true;

    // Emit initial busy state
    if (this.progressCallback) {
      this.progressCallback({
        state: 'busy',
        processed: 0,
        total,
        currentFile: validFiles[0]
      });
    }

    const indexFile = async (uri: string): Promise<void> => {
      console.info(`[Debug] Starting task for: ${uri}`);
      try {
        let result: IndexedFileResult;
        
        if (this.workerPool) {
          result = await this.workerPool.runTask({ uri });
        } else {
          const indexer = this.languageRouter || this.symbolIndexer;
          result = await indexer.indexFile(uri);
        }
        
        if (result.isSkipped) {
          console.info(`[Debug] Task skipped for: ${uri} with reason: ${result.skipReason}`);
          console.warn(`[IndexCoordinator] Skipping file (${result.skipReason}): ${uri}`);
        } else {
          console.info(`[Debug] Task success for: ${uri}`);
          await onFileIndexed(uri, result);
        }
      } catch (error) {
        console.error(`[Debug] Task CRASHED for: ${uri}: ${error}`);
        console.error(`[IndexCoordinator] Error indexing file ${uri}: ${error}`);
      } finally {
        processed++;
        console.info(`[Debug] Counter incremented: ${processed}/${total}`);
        if (onProgress) {
          onProgress(processed);
        }

        // Emit progress notification (throttled)
        const now = Date.now();
        if (this.progressCallback && (now - lastProgressTime >= 500 || processed % 10 === 0 || processed === total)) {
          lastProgressTime = now;
          this.progressCallback({
            state: 'busy',
            processed,
            total,
            currentFile: uri
          });
        }
      }
    };

    await Promise.allSettled(validFiles.map(indexFile));

    // Disable bulk indexing mode
    this.isBulkIndexing = false;

    // Emit finalizing state
    if (this.progressCallback) {
      this.progressCallback({
        state: 'finalizing',
        processed: total,
        total
      });
    }
    console.info('[IndexCoordinator] Starting finalization phase...');

    // Validate and reset worker pool counters
    if (this.workerPool) {
      this.workerPool.validateCounters();
      if (processed === total) {
        this.workerPool.reset();
      }
    }

    // Emit idle state
    if (this.progressCallback) {
      this.progressCallback({
        state: 'idle',
        processed: total,
        total
      });
    }
    console.info('[IndexCoordinator] Background indexing completed successfully.');
    
    const duration = Date.now() - startTime;
    const filesPerSecond = (total / (duration / 1000)).toFixed(2);
    
    if (this.workerPool) {
      const stats = this.workerPool.getStats();
      console.info(
        `[IndexCoordinator] Completed indexing ${total} files in ${duration}ms (${filesPerSecond} files/sec) - ` +
        `Pool stats: ${stats.totalProcessed} processed, ${stats.totalErrors} errors, active=${stats.activeTasks}`
      );
    } else {
      console.info(`[IndexCoordinator] Completed indexing ${total} files in ${duration}ms (${filesPerSecond} files/sec)`);
    }
  }

  /**
   * Index a single file (for live synchronization).
   */
  async indexSingleFile(
    filePath: string,
    onFileIndexed: (uri: string, result: IndexedFileResult) => Promise<void>
  ): Promise<void> {
    const sanitizedPath = sanitizeFilePath(filePath);
    
    try {
      try {
        await fsPromises.access(sanitizedPath);
      } catch {
        console.warn(`[IndexCoordinator] Skipping non-existent file: ${sanitizedPath}`);
        return;
      }

      let result: IndexedFileResult;
      
      if (this.workerPool) {
        result = await this.workerPool.runTask({ uri: sanitizedPath });
      } else {
        const indexer = this.languageRouter || this.symbolIndexer;
        result = await indexer.indexFile(sanitizedPath);
      }

      if (!result.isSkipped) {
        await onFileIndexed(sanitizedPath, result);
      }
    } catch (error) {
      console.error(`[IndexCoordinator] Error indexing single file ${sanitizedPath}: ${error}`);
      throw error;
    }
  }

  /**
   * Terminate the worker pool.
   */
  async dispose(): Promise<void> {
    if (this.workerPool) {
      await this.workerPool.terminate();
      this.workerPool = null;
    }
  }
}
