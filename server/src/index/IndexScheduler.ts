import { IWorkerPool } from '../utils/workerPool.js';
import { IndexedFileResult } from '../types.js';
import { sanitizeFilePath } from '../utils/stringUtils.js';
import { PROGRESS_CONFIG, LOG_PREFIX } from '../constants.js';
import * as fsPromises from 'fs/promises';

/**
 * Progress callback for indexing operations.
 */
export type ProgressCallback = (progress: {
  state: 'busy' | 'idle' | 'finalizing';
  processed: number;
  total: number;
  currentFile?: string;
}) => void;

/**
 * Result handler for completed indexing tasks.
 */
export type IndexResultHandler = (uri: string, result: IndexedFileResult) => Promise<void>;

/**
 * Validation function to check if file needs reindexing.
 */
export type FileValidator = (uri: string) => Promise<boolean>;

/**
 * File removal handler for deleted files.
 */
export type FileRemovalHandler = (uri: string) => Promise<void>;

/**
 * IndexScheduler - Orchestrates the indexing queue and concurrency.
 * 
 * Responsibilities:
 * - Manage the queue of files to be indexed
 * - Handle debouncing logic (bulk vs incremental indexing)
 * - Coordinate worker pool execution
 * - Track progress and notify subscribers
 * 
 * This class extracts the orchestration logic from BackgroundIndex,
 * following the Single Responsibility Principle.
 */
export class IndexScheduler {
  private workerPool: IWorkerPool;
  private progressCallback: ProgressCallback | null = null;
  private isBulkMode: boolean = false;
  
  /**
   * Create an IndexScheduler.
   * 
   * @param workerPool - Worker pool for parallel indexing
   */
  constructor(workerPool: IWorkerPool) {
    this.workerPool = workerPool;
  }

  /**
   * Set the progress callback for indexing operations.
   */
  setProgressCallback(callback: ProgressCallback): void {
    this.progressCallback = callback;
  }

  /**
   * Get whether scheduler is in bulk indexing mode.
   */
  isBulkIndexing(): boolean {
    return this.isBulkMode;
  }

  /**
   * Schedule a single file for indexing (incremental update).
   * 
   * @param uri - File URI to index
   * @param handler - Result handler to process indexed data
   */
  async scheduleSingle(
    uri: string,
    handler: IndexResultHandler
  ): Promise<void> {
    const sanitizedUri = sanitizeFilePath(uri);
    
    try {
      // Validate file exists
      await fsPromises.access(sanitizedUri);
      
      // Index the file using worker pool
      const result = await this.workerPool.runTask({ uri: sanitizedUri });
      
      // Handle the result
      if (result.isSkipped) {
        console.warn(`[IndexScheduler] Skipping file (${result.skipReason}): ${sanitizedUri}`);
      } else {
        await handler(sanitizedUri, result);
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.warn(`${LOG_PREFIX.INDEX_SCHEDULER} Skipping non-existent file: ${sanitizedUri}`);
      } else {
        console.error(`${LOG_PREFIX.INDEX_SCHEDULER} Error scheduling single file ${sanitizedUri}: ${error}`);
        throw error;
      }
    }
  }

  /**
   * Schedule a file for deletion from the index.
   * 
   * @param uri - File URI to remove
   * @param handler - Removal handler to clean up indexed data
   */
  async scheduleDeleted(
    uri: string,
    handler: FileRemovalHandler
  ): Promise<void> {
    const sanitizedUri = sanitizeFilePath(uri);
    await handler(sanitizedUri);
  }

  /**
   * Schedule bulk indexing of multiple files (initial/full indexing).
   * 
   * This method:
   * 1. Filters files that need indexing using the validator
   * 2. Processes files in parallel using the worker pool
   * 3. Reports progress to the callback
   * 4. Returns when all files are processed
   * 
   * @param files - Array of file URIs to potentially index
   * @param validator - Function to check if file needs indexing
   * @param handler - Result handler to process indexed data
   * @param onProgress - Optional progress callback
   */
  async scheduleBulk(
    files: string[],
    validator: FileValidator,
    handler: IndexResultHandler,
    onProgress?: (current: number, total: number) => void
  ): Promise<void> {
    // Filter files that need indexing
    const filesToIndex: string[] = [];
    let checked = 0;
    
    for (const uri of files) {
      const needsIndexing = await validator(uri);
      if (needsIndexing) {
        filesToIndex.push(uri);
      }
      
      checked++;
      if (onProgress) {
        onProgress(checked, files.length);
      }
    }
    
    if (filesToIndex.length === 0) {
      console.info(`${LOG_PREFIX.INDEX_SCHEDULER} All files up to date`);
      return;
    }
    
    console.info(`${LOG_PREFIX.INDEX_SCHEDULER} Scheduling ${filesToIndex.length} files for bulk indexing`);
    
    // Enable bulk mode to defer cross-file resolution
    this.isBulkMode = true;
    
    try {
      await this.processQueue(filesToIndex, handler, onProgress ? 
        (current) => onProgress(checked - filesToIndex.length + current, files.length) :
        undefined
      );
    } finally {
      // Always disable bulk mode
      this.isBulkMode = false;
    }
  }

  /**
   * Process the queue of files for indexing.
   * 
   * This is the core execution loop that:
   * - Pre-validates all files (filters non-existent files)
   * - Submits tasks to the worker pool
   * - Tracks progress and reports updates
   * - Handles errors gracefully
   * 
   * @param files - Array of file URIs to index
   * @param handler - Result handler to process indexed data
   * @param onProgress - Optional progress callback
   */
  private async processQueue(
    files: string[],
    handler: IndexResultHandler,
    onProgress?: (current: number) => void
  ): Promise<void> {
    // Pre-validate: sanitize paths and filter non-existent files
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
        `${LOG_PREFIX.INDEX_SCHEDULER} Skipping ${skippedFiles.length} non-existent files`
      );
      if (skippedFiles.length <= 5) {
        for (const skipped of skippedFiles) {
          console.warn(`${LOG_PREFIX.INDEX_SCHEDULER}   - ${skipped}`);
        }
      } else {
        for (const skipped of skippedFiles.slice(0, 5)) {
          console.warn(`${LOG_PREFIX.INDEX_SCHEDULER}   - ${skipped}`);
        }
        console.warn(`${LOG_PREFIX.INDEX_SCHEDULER}   ... and ${skippedFiles.length - 5} more`);
      }
    }
    
    let processed = 0;
    const total = validFiles.length;
    const startTime = Date.now();
    let lastProgressTime = startTime;
    
    // Emit initial busy state
    if (this.progressCallback) {
      this.progressCallback({
        state: 'busy',
        processed: 0,
        total,
        currentFile: validFiles[0]
      });
    }
    
    // Process all files in parallel (worker pool handles concurrency limits)
    const indexFile = async (uri: string): Promise<void> => {
      try {
        const result = await this.workerPool.runTask({ uri });
        
        if (result.isSkipped) {
          console.warn(`${LOG_PREFIX.INDEX_SCHEDULER} Skipping file (${result.skipReason}): ${uri}`);
        } else {
          await handler(uri, result);
        }
      } catch (error) {
        console.error(`${LOG_PREFIX.INDEX_SCHEDULER} Error indexing file ${uri}: ${error}`);
      } finally {
        processed++;
        if (onProgress) {
          onProgress(processed);
        }
        
        // Throttled progress reporting
        const now = Date.now();
        const shouldReport = 
          this.progressCallback && 
          (now - lastProgressTime >= PROGRESS_CONFIG.THROTTLE_INTERVAL_MS || 
           processed % PROGRESS_CONFIG.BATCH_UPDATE_SIZE === 0 || 
           processed === total);
        
        if (shouldReport) {
          lastProgressTime = now;
          this.progressCallback!({
            state: 'busy',
            processed,
            total,
            currentFile: uri
          });
        }
      }
    };
    
    // Execute all tasks in parallel
    await Promise.allSettled(validFiles.map(indexFile));
    
    const duration = Date.now() - startTime;
    const filesPerSecond = (total / (duration / 1000)).toFixed(2);
    const stats = this.workerPool.getStats();
    
    console.info(
      `${LOG_PREFIX.INDEX_SCHEDULER} Completed ${total} files in ${duration}ms (${filesPerSecond} files/sec) - ` +
      `Pool stats: ${stats.totalProcessed} processed, ${stats.totalErrors} errors, active=${stats.activeTasks}`
    );
  }

  /**
   * Emit progress state to subscribers.
   */
  emitProgress(state: 'busy' | 'idle' | 'finalizing', processed: number, total: number): void {
    if (this.progressCallback) {
      this.progressCallback({ state, processed, total });
    }
  }

  /**
   * Get worker pool statistics.
   */
  getStats() {
    return this.workerPool.getStats();
  }

  /**
   * Validate and reset worker pool counters.
   */
  validateCounters(): void {
    this.workerPool.validateCounters();
  }

  /**
   * Force reset worker pool state.
   */
  reset(): void {
    this.workerPool.reset();
  }
}
