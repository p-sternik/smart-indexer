import { IndexStats } from '../types.js';

/**
 * Manages statistics for the indexing system.
 * Tracks metrics from both dynamic and background indices.
 */
export class StatsManager {
  private stats: IndexStats = {
    totalFiles: 0,
    totalSymbols: 0,
    cacheHits: 0,
    cacheMisses: 0,
    lastUpdateTime: Date.now()
  };

  private dynamicStats = { files: 0, symbols: 0 };
  private backgroundStats = { files: 0, symbols: 0, shards: 0 };
  private staticStats = { files: 0, symbols: 0 };
  private lastFullIndexTime: number = 0;
  private lastIncrementalIndexTime: number = 0;
  
  // Profiling metrics
  private profilingMetrics = {
    avgDefinitionTimeMs: 0,
    avgReferencesTimeMs: 0,
    avgFileIndexTimeMs: 0,
    avgFullIndexTimeMs: 0,
    avgIncrementalIndexTimeMs: 0
  };

  updateDynamicStats(files: number, symbols: number): void {
    this.dynamicStats = { files, symbols };
    this.recomputeStats();
  }

  updateBackgroundStats(files: number, symbols: number, shards: number): void {
    this.backgroundStats = { files, symbols, shards };
    this.recomputeStats();
  }

  updateStaticStats(files: number, symbols: number): void {
    this.staticStats = { files, symbols };
    this.recomputeStats();
  }

  recordCacheHit(): void {
    this.stats.cacheHits++;
  }

  recordCacheMiss(): void {
    this.stats.cacheMisses++;
  }

  recordFullIndex(): void {
    this.lastFullIndexTime = Date.now();
    this.stats.lastUpdateTime = this.lastFullIndexTime;
  }

  recordIncrementalIndex(): void {
    this.lastIncrementalIndexTime = Date.now();
    this.stats.lastUpdateTime = this.lastIncrementalIndexTime;
  }

  private recomputeStats(): void {
    // Merge dynamic, background, and static stats
    // Note: files may overlap, but we count unique files
    this.stats.totalFiles = this.backgroundStats.files + this.dynamicStats.files + this.staticStats.files;
    this.stats.totalSymbols = this.backgroundStats.symbols + this.dynamicStats.symbols + this.staticStats.symbols;
  }

  updateProfilingMetrics(metrics: {
    avgDefinitionTimeMs?: number;
    avgReferencesTimeMs?: number;
    avgFileIndexTimeMs?: number;
    avgFullIndexTimeMs?: number;
    avgIncrementalIndexTimeMs?: number;
  }): void {
    this.profilingMetrics = { ...this.profilingMetrics, ...metrics };
  }

  getStats(): IndexStats & { 
    totalShards: number; 
    lastFullIndexTime: number; 
    lastIncrementalIndexTime: number;
    dynamicFiles: number;
    dynamicSymbols: number;
    backgroundFiles: number;
    backgroundSymbols: number;
    staticFiles: number;
    staticSymbols: number;
    avgDefinitionTimeMs: number;
    avgReferencesTimeMs: number;
    avgFileIndexTimeMs: number;
    avgFullIndexTimeMs: number;
    avgIncrementalIndexTimeMs: number;
  } {
    return {
      ...this.stats,
      totalShards: this.backgroundStats.shards,
      lastFullIndexTime: this.lastFullIndexTime,
      lastIncrementalIndexTime: this.lastIncrementalIndexTime,
      dynamicFiles: this.dynamicStats.files,
      dynamicSymbols: this.dynamicStats.symbols,
      backgroundFiles: this.backgroundStats.files,
      backgroundSymbols: this.backgroundStats.symbols,
      staticFiles: this.staticStats.files,
      staticSymbols: this.staticStats.symbols,
      ...this.profilingMetrics
    };
  }

  reset(): void {
    this.stats = {
      totalFiles: 0,
      totalSymbols: 0,
      cacheHits: 0,
      cacheMisses: 0,
      lastUpdateTime: Date.now()
    };
    this.dynamicStats = { files: 0, symbols: 0 };
    this.backgroundStats = { files: 0, symbols: 0, shards: 0 };
    this.staticStats = { files: 0, symbols: 0 };
    this.lastFullIndexTime = 0;
    this.lastIncrementalIndexTime = 0;
    this.profilingMetrics = {
      avgDefinitionTimeMs: 0,
      avgReferencesTimeMs: 0,
      avgFileIndexTimeMs: 0,
      avgFullIndexTimeMs: 0,
      avgIncrementalIndexTimeMs: 0
    };
  }
}
