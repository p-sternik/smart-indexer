/**
 * RequestTracer - Forensic-level observability system for LSP operations.
 * 
 * This is a "Flight Recorder" system that captures:
 * - Performance metrics (I/O, CPU, memory)
 * - Logic decisions (filters applied, rejections)
 * - Outlier files causing slowdowns
 * 
 * Maintains a rolling history of last 15 traces for debugging.
 */

import { ILogger } from './Logger.js';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';

/**
 * Performance metrics for I/O operations.
 */
export interface IOMetrics {
  cacheHits: number;
  cacheMisses: number;
  diskReadMs: number;
}

/**
 * Memory usage snapshot.
 */
export interface MemorySnapshot {
  startHeapMB: number;
  endHeapMB: number;
}

/**
 * Outlier file that took unusually long to process.
 */
export interface FileOutlier {
  file: string;
  durationMs: number;
  reason?: string;
}

/**
 * Complete forensic trace for a search/lookup operation.
 */
export interface SearchTrace {
  id: string;
  timestamp: string;
  operation: 'definition' | 'references';
  query: {
    symbol: string;
    uri: string;
    position: string;
    isNgRx: boolean;
  };
  timings: {
    totalMs: number;
    dbQueryMs: number;
    processingMs: number;
  };
  stats: {
    candidates: number;
    filesChecked: number;
    results: number;
  };
  performance: {
    memory: MemorySnapshot;
    io: IOMetrics;
    outliers: FileOutlier[];
  };
  decisions: {
    activeFilters: string[];
    rejections: Record<string, number>;
  };
  errors: string[];
}

/**
 * Active trace session for a single request.
 */
export class TraceSession {
  private trace: SearchTrace;
  private startTime: number;
  private dbQueryStartTime?: number;
  private processingStartTime?: number;
  private outliers: FileOutlier[] = [];
  private cacheHits = 0;
  private cacheMisses = 0;
  private diskReadMs = 0;
  private filesChecked = 0;
  private rejections: Record<string, number> = {};
  private errors: string[] = [];
  
  constructor(
    id: string,
    operation: 'definition' | 'references',
    symbol: string,
    uri: string,
    position: string,
    isNgRx: boolean
  ) {
    this.startTime = performance.now();
    this.trace = {
      id,
      timestamp: new Date().toISOString(),
      operation,
      query: { symbol, uri: this.sanitizePath(uri), position, isNgRx },
      timings: { totalMs: 0, dbQueryMs: 0, processingMs: 0 },
      stats: { candidates: 0, filesChecked: 0, results: 0 },
      performance: {
        memory: {
          startHeapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          endHeapMB: 0
        },
        io: { cacheHits: 0, cacheMisses: 0, diskReadMs: 0 },
        outliers: []
      },
      decisions: { activeFilters: [], rejections: {} },
      errors: []
    };
  }
  
  /** Start DB query timing */
  startDbQuery(): void {
    this.dbQueryStartTime = performance.now();
  }
  
  /** End DB query timing */
  endDbQuery(candidates: number): void {
    if (this.dbQueryStartTime) {
      this.trace.timings.dbQueryMs = Math.round(performance.now() - this.dbQueryStartTime);
      this.trace.stats.candidates = candidates;
    }
  }
  
  /** Start processing timing */
  startProcessing(): void {
    this.processingStartTime = performance.now();
  }
  
  /** End processing timing */
  endProcessing(): void {
    if (this.processingStartTime) {
      this.trace.timings.processingMs = Math.round(performance.now() - this.processingStartTime);
    }
  }
  
  /** Record cache hit */
  recordCacheHit(): void {
    this.cacheHits++;
  }
  
  /** Record cache miss with duration */
  recordCacheMiss(durationMs: number): void {
    this.cacheMisses++;
    this.diskReadMs += durationMs;
  }
  
  /** Record file processing (tracks outliers >10ms) */
  recordFileProcessing(file: string, durationMs: number, reason?: string): void {
    this.filesChecked++;
    if (durationMs >= 10) {
      this.outliers.push({
        file: this.sanitizePath(file),
        durationMs: Math.round(durationMs),
        reason
      });
    }
  }
  
  /** Log a rejection by a filter */
  logRejection(filterName: string): void {
    this.rejections[filterName] = (this.rejections[filterName] || 0) + 1;
  }
  
  /** Add an active filter */
  addFilter(filterName: string): void {
    if (!this.trace.decisions.activeFilters.includes(filterName)) {
      this.trace.decisions.activeFilters.push(filterName);
    }
  }
  
  /** Log an error */
  logError(error: string): void {
    this.errors.push(error);
  }
  
  /** Complete the trace and return it */
  end(resultCount: number): SearchTrace {
    this.trace.timings.totalMs = Math.round(performance.now() - this.startTime);
    this.trace.stats.filesChecked = this.filesChecked;
    this.trace.stats.results = resultCount;
    this.trace.performance.memory.endHeapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    this.trace.performance.io = {
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      diskReadMs: Math.round(this.diskReadMs)
    };
    this.trace.performance.outliers = this.outliers
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5); // Top 5 outliers
    this.trace.decisions.rejections = this.rejections;
    this.trace.errors = this.errors;
    
    return this.trace;
  }
  
  /** Sanitize file path to basename for privacy */
  private sanitizePath(path: string): string {
    return path.split(/[\\/]/).pop() || path;
  }
}

/**
 * Main RequestTracer class - Flight Recorder for LSP operations.
 */
export class RequestTracer {
  private static readonly MAX_HISTORY = 15;
  private static history: SearchTrace[] = [];
  private logger: ILogger;
  
  constructor(logger: ILogger) {
    this.logger = logger;
  }
  
  /**
   * Start a new trace session.
   */
  start(
    operation: 'definition' | 'references',
    symbol: string,
    uri: string,
    position: string,
    isNgRx: boolean = false
  ): TraceSession {
    const id = randomUUID();
    return new TraceSession(id, operation, symbol, uri, position, isNgRx);
  }
  
  /**
   * Store a completed trace in history.
   */
  recordTrace(trace: SearchTrace): void {
    // Add to history FIRST (before file I/O or logging that might fail)
    RequestTracer.history.push(trace);
    
    // Safety log to confirm storage
    this.logger.info(`[Tracer] Trace stored. History size: ${RequestTracer.history.length}`);
    
    // Enforce rolling window
    if (RequestTracer.history.length > RequestTracer.MAX_HISTORY) {
      RequestTracer.history.shift();
    }
    
    // Log compact summary
    this.logger.info(`[RequestTrace] ${JSON.stringify(this.formatCompactTrace(trace))}`);
    
    // Log diagnostics if issues detected
    this.logDiagnostics(trace);
  }
  
  /**
   * Get trace history for debugging.
   */
  static getHistory(): SearchTrace[] {
    return [...RequestTracer.history];
  }
  
  /**
   * Clear trace history.
   */
  static clearHistory(): void {
    RequestTracer.history = [];
  }
  
  /**
   * Format trace as compact summary for logs.
   */
  private formatCompactTrace(trace: SearchTrace): object {
    return {
      id: trace.id.substring(0, 8),
      op: trace.operation,
      symbol: trace.query.symbol,
      total: `${trace.timings.totalMs}ms`,
      results: trace.stats.results,
      io: `${trace.performance.io.cacheHits}H/${trace.performance.io.cacheMisses}M`,
      mem: `${trace.performance.memory.startHeapMB}→${trace.performance.memory.endHeapMB}MB`
    };
  }
  
  /**
   * Log diagnostic insights based on trace patterns.
   */
  private logDiagnostics(trace: SearchTrace): void {
    const { timings, performance, decisions, stats, errors } = trace;
    
    // Detect I/O bottleneck
    const ioPercentage = (performance.io.diskReadMs / timings.totalMs) * 100;
    if (ioPercentage > 50) {
      this.logger.warn(
        `[RequestTrace] DISK BOTTLENECK: I/O consumed ${ioPercentage.toFixed(0)}% of time ` +
        `(${performance.io.cacheMisses} misses, ${performance.io.diskReadMs}ms total). ` +
        `Consider increasing cache size.`
      );
    }
    
    // Detect memory spike (potential GC pause)
    const memoryDeltaMB = performance.memory.endHeapMB - performance.memory.startHeapMB;
    if (memoryDeltaMB > 100) {
      this.logger.warn(
        `[RequestTrace] MEMORY SPIKE: +${memoryDeltaMB}MB during operation. ` +
        `Potential GC pause. Consider optimizing data structures.`
      );
    }
    
    // Detect outlier files
    if (performance.outliers.length > 0) {
      const slowest = performance.outliers[0];
      this.logger.warn(
        `[RequestTrace] OUTLIER FILES: ${performance.outliers.length} file(s) took >10ms. ` +
        `Slowest: "${slowest.file}" (${slowest.durationMs}ms${slowest.reason ? `, ${slowest.reason}` : ''}). ` +
        `Review file complexity or add to exclusion list.`
      );
    }
    
    // Log rejection statistics
    const totalRejections = Object.values(decisions.rejections).reduce((sum, count) => sum + count, 0);
    if (totalRejections > stats.results * 2) {
      this.logger.warn(
        `[RequestTrace] HIGH REJECTION RATE: ${totalRejections} files rejected vs ${stats.results} results. ` +
        `Filters: ${Object.entries(decisions.rejections).map(([k, v]) => `${k}(${v})`).join(', ')}`
      );
    }
    
    // Log errors
    if (errors.length > 0) {
      this.logger.error(
        `[RequestTrace] ERRORS: ${errors.length} error(s) during operation: ${errors.join('; ')}`
      );
    }
    
    // Detect slow operations
    if (timings.totalMs > 2000) {
      this.logger.warn(
        `[RequestTrace] SLOW OPERATION: ${timings.totalMs}ms total ` +
        `(DB: ${timings.dbQueryMs}ms, Processing: ${timings.processingMs}ms). ` +
        `Checked ${stats.filesChecked} files for ${stats.results} results.`
      );
    }
  }
}
