/**
 * StringInterner - Deduplicates repeated strings to save memory.
 * Common strings like 'Component', 'Injectable', import names, etc. are interned
 * so only one instance exists per unique string value.
 * 
 * Implements LRU-style eviction to prevent unbounded memory growth.
 * When the pool exceeds maxSize, the oldest entries are evicted.
 */
export class StringInterner {
  private pool = new Map<string, string>();
  private readonly maxSize: number;

  constructor(maxSize: number = 10000) {
    this.maxSize = maxSize;
  }

  intern(s: string): string {
    let cached = this.pool.get(s);
    if (cached) {
      // Move to end (most recently used) by re-inserting
      this.pool.delete(s);
      this.pool.set(s, cached);
      return cached;
    }

    // Evict oldest entries if at capacity
    if (this.pool.size >= this.maxSize) {
      // Delete oldest 10% to avoid frequent evictions
      const evictCount = Math.max(1, Math.floor(this.maxSize * 0.1));
      const keysIterator = this.pool.keys();
      for (let i = 0; i < evictCount; i++) {
        const oldestKey = keysIterator.next().value;
        if (oldestKey !== undefined) {
          this.pool.delete(oldestKey);
        }
      }
    }

    this.pool.set(s, s);
    return s;
  }

  clear(): void {
    this.pool.clear();
  }

  get size(): number {
    return this.pool.size;
  }
}
