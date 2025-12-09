/**
 * RequestTracer - Forensic-level performance diagnostics for LSP operations.
 * 
 * Purpose:
 * When users report "It's slow", we need to distinguish between:
 * - Disk I/O bottlenecks (cache misses, slow reads)
 * - CPU bottlenecks (parsing, filtering)
 * - Memory pressure (GC pauses)
 * - Specific "poisonous" files causing outliers
 * - Indexing storm scenarios (heavy background tasks)
 * 
 * This tracer captures granular metrics to enable remote diagnosis.
 */

import { ILogger } from './Logger.js';

/**
 * Performance metrics for I/O operations.
 */
export interface IOMetrics {
  /** Number of shard loads served from memory cache */
  cacheHits: number;
  /** Number of shard loads requiring disk I/O */
  cacheMisses: number;
  /** Total time spent awaiting disk I/O (ms) */
  diskReadMs: number;
}

/**
 * Memory usage snapshot.
 */
export interface MemorySnapshot {
  /** Heap usage at start (MB) */
  startHeapMB: number;
  /** Heap usage at end (MB) */
  endHeapMB: number;
}

/**
 * Outlier file that took unusually long to process.
 */
export interface FileOutlier {
  /** File path (relative or basename for privacy) */
  file: string;
  /** Processing duration (ms) */
  durationMs: number;
}

/**
 * Environment/context information about system stress.
 */
export interface EnvironmentContext {
  /** Time since last file save event (ms) - detects indexing storms */
  lastSaveDeltaMs: number;
  /** Worker pool queue depth - detects backlog */
  pendingTasks: number;
}

/**
 * Complete performance trace for a search/lookup operation.
 */
export interface SearchTrace {
  /** Operation type (e.g., 'references', 'definition') */
  operation: string;
  /** File URI being queried */
  uri: string;
  /** Position in file (line:character) */
  position: string;
  /** Total duration (ms) */
  totalDurationMs: number;
  /** Number of results found */
  resultCount: number;
  
  /** Detailed performance breakdown */
  performance: {
    memory: MemorySnapshot;
    io: IOMetrics;
    /** Top 3 slowest files processed */
    outliers: FileOutlier[];
  };
  
  /** Environmental/contextual stress indicators */
  environment: EnvironmentContext;
}

/**
 * Helper for tracking I/O operations during a request.
 */
export class IOTracker {
  private cacheHits = 0;
  private cacheMisses = 0;
  private diskReadMs = 0;
  private outliers: FileOutlier[] = [];
  
  /** Threshold for considering a file an outlier (ms) */
  private readonly outlierThresholdMs: number;
  
  constructor(outlierThresholdMs: number = 10) {
    this.outlierThresholdMs = outlierThresholdMs;
  }
  
  /**
   * Record a cache hit (shard loaded from memory).
   */
  recordCacheHit(): void {
    this.cacheHits++;
  }
  
  /**
   * Record a cache miss (shard loaded from disk).
   * @param durationMs - Time spent reading from disk
   */
  recordCacheMiss(durationMs: number): void {
    this.cacheMisses++;
    this.diskReadMs += durationMs;
  }
  
  /**
   * Record processing time for a specific file.
   * If duration exceeds threshold, adds to outliers list.
   * @param file - File path (will be sanitized for privacy)
   * @param durationMs - Processing duration
   */
  recordFileProcessing(file: string, durationMs: number): void {
    if (durationMs >= this.outlierThresholdMs) {
      // Store only basename to avoid leaking full paths in logs
      const basename = file.split(/[\\/]/).pop() || file;
      this.outliers.push({ file: basename, durationMs });
    }
  }
  
  /**
   * Get final I/O metrics.
   * Sorts outliers by duration (slowest first), keeps top 3.
   */
  getMetrics(): { io: IOMetrics; outliers: FileOutlier[] } {
    const topOutliers = this.outliers
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 3);
    
    return {
      io: {
        cacheHits: this.cacheHits,
        cacheMisses: this.cacheMisses,
        diskReadMs: Math.round(this.diskReadMs)
      },
      outliers: topOutliers
    };
  }
}

/**
 * Main RequestTracer class for capturing complete traces.
 */
export class RequestTracer {
  private logger: ILogger;
  private lastSaveTimestamp: number = Date.now();
  
  constructor(logger: ILogger) {
    this.logger = logger;
  }
  
  /**
   * Update the timestamp of the last file save event.
   * Called by file watchers/change handlers.
   */
  recordFileSave(): void {
    this.lastSaveTimestamp = Date.now();
  }
  
  /**
   * Create an I/O tracker for a request.
   */
  createIOTracker(outlierThresholdMs: number = 10): IOTracker {
    return new IOTracker(outlierThresholdMs);
  }
  
  /**
   * Capture memory snapshot.
   */
  captureMemory(): number {
    const heapUsed = process.memoryUsage().heapUsed;
    return Math.round(heapUsed / 1024 / 1024); // Convert to MB
  }
  
  /**
   * Build a complete trace and log it.
   * 
   * @param operation - Operation type (e.g., 'references', 'definition')
   * @param uri - File URI
   * @param position - Position string (e.g., '10:5')
   * @param startMemoryMB - Memory at start
   * @param endMemoryMB - Memory at end
   * @param ioTracker - I/O tracker with collected metrics
   * @param totalDurationMs - Total duration
   * @param resultCount - Number of results
   * @param workerPoolStats - Worker pool statistics (if available)
   */
  logTrace(
    operation: string,
    uri: string,
    position: string,
    startMemoryMB: number,
    endMemoryMB: number,
    ioTracker: IOTracker,
    totalDurationMs: number,
    resultCount: number,
    workerPoolStats?: { queuedTasks: number }
  ): void {
    const { io, outliers } = ioTracker.getMetrics();
    
    const trace: SearchTrace = {
      operation,
      uri: this.sanitizeUri(uri),
      position,
      totalDurationMs: Math.round(totalDurationMs),
      resultCount,
      performance: {
        memory: {
          startHeapMB: startMemoryMB,
          endHeapMB: endMemoryMB
        },
        io,
        outliers
      },
      environment: {
        lastSaveDeltaMs: Date.now() - this.lastSaveTimestamp,
        pendingTasks: workerPoolStats?.queuedTasks || 0
      }
    };
    
    this.logger.info(`[RequestTrace] ${this.formatTrace(trace)}`);
    
    // Log diagnostic insights if issues detected
    this.logDiagnostics(trace);
  }
  
  /**
   * Sanitize URI to show only basename (privacy).
   */
  private sanitizeUri(uri: string): string {
    return uri.split(/[\\/]/).pop() || uri;
  }
  
  /**
   * Format trace as compact JSON.
   */
  private formatTrace(trace: SearchTrace): string {
    return JSON.stringify(trace);
  }
  
  /**
   * Log diagnostic insights based on trace patterns.
   */
  private logDiagnostics(trace: SearchTrace): void {
    const { performance, environment, totalDurationMs } = trace;
    const { io, memory, outliers } = performance;
    
    // Detect I/O bottleneck
    const ioPercentage = (io.diskReadMs / totalDurationMs) * 100;
    if (ioPercentage > 50) {
      this.logger.warn(
        `[RequestTrace] DISK BOTTLENECK: I/O consumed ${ioPercentage.toFixed(0)}% of time ` +
        `(${io.cacheMisses} misses, ${io.diskReadMs}ms total). ` +
        `Consider increasing cache size or reducing concurrent queries.`
      );
    }
    
    // Detect memory spike (potential GC pause)
    const memoryDeltaMB = memory.endHeapMB - memory.startHeapMB;
    if (memoryDeltaMB > 100) {
      this.logger.warn(
        `[RequestTrace] MEMORY SPIKE: +${memoryDeltaMB}MB during operation. ` +
        `Potential GC pause. Consider optimizing data structures or chunking.`
      );
    }
    
    // Detect outlier files
    if (outliers.length > 0) {
      const slowest = outliers[0];
      this.logger.warn(
        `[RequestTrace] OUTLIER FILES: ${outliers.length} file(s) took >10ms. ` +
        `Slowest: "${slowest.file}" (${slowest.durationMs}ms). ` +
        `Review file complexity or parser efficiency.`
      );
    }
    
    // Detect indexing storm
    if (environment.lastSaveDeltaMs < 500 && environment.pendingTasks > 10) {
      this.logger.warn(
        `[RequestTrace] INDEXING STORM: Recent file activity (${environment.lastSaveDeltaMs}ms ago) ` +
        `with ${environment.pendingTasks} pending tasks. ` +
        `Index may be catching up. Consider debouncing file saves.`
      );
    }
  }
}
