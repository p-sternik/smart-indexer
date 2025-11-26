/**
 * Lightweight profiler for tracking performance metrics.
 */

export interface ProfileMetrics {
  count: number;
  totalTimeMs: number;
  minMs: number;
  maxMs: number;
  samples: number[];
}

export class Profiler {
  private metrics = new Map<string, ProfileMetrics>();

  record(key: string, durationMs: number): void {
    let metric = this.metrics.get(key);
    if (!metric) {
      metric = {
        count: 0,
        totalTimeMs: 0,
        minMs: Number.MAX_VALUE,
        maxMs: 0,
        samples: []
      };
      this.metrics.set(key, metric);
    }

    metric.count++;
    metric.totalTimeMs += durationMs;
    metric.minMs = Math.min(metric.minMs, durationMs);
    metric.maxMs = Math.max(metric.maxMs, durationMs);
    
    // Keep last 100 samples for percentile calculation
    metric.samples.push(durationMs);
    if (metric.samples.length > 100) {
      metric.samples.shift();
    }
  }

  getMetrics(key: string): ProfileMetrics | undefined {
    return this.metrics.get(key);
  }

  getAverageMs(key: string): number {
    const metric = this.metrics.get(key);
    if (!metric || metric.count === 0) {
      return 0;
    }
    return metric.totalTimeMs / metric.count;
  }

  getP50Ms(key: string): number {
    return this.getPercentile(key, 50);
  }

  getP95Ms(key: string): number {
    return this.getPercentile(key, 95);
  }

  private getPercentile(key: string, percentile: number): number {
    const metric = this.metrics.get(key);
    if (!metric || metric.samples.length === 0) {
      return 0;
    }

    const sorted = [...metric.samples].sort((a, b) => a - b);
    const index = Math.floor((percentile / 100) * sorted.length);
    return sorted[Math.min(index, sorted.length - 1)];
  }

  getAllMetrics(): Map<string, ProfileMetrics> {
    return new Map(this.metrics);
  }

  reset(): void {
    this.metrics.clear();
  }
}
