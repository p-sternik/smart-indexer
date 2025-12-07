/**
 * Application-wide constants and configuration values.
 */

/**
 * Worker pool configuration
 */
export const WORKER_CONFIG = {
  DEFAULT_MAX_CONCURRENT_JOBS: 4,
  MIN_CONCURRENT_JOBS: 1,
  MAX_CONCURRENT_JOBS: 16,
  TASK_TIMEOUT_MS: 60000
} as const;

/**
 * Storage and caching configuration
 */
export const STORAGE_CONFIG = {
  MAX_LRU_CACHE_SIZE: 50,
  METADATA_BATCH_SIZE: 100,
  WRITE_DEBOUNCE_MS: 100,
  FINALIZATION_TIMEOUT_MS: 5000
} as const;

/**
 * Progress reporting configuration
 */
export const PROGRESS_CONFIG = {
  THROTTLE_INTERVAL_MS: 500,
  BATCH_UPDATE_SIZE: 10
} as const;

/**
 * Indexing states
 */
export const INDEXING_STATE = {
  BUSY: 'busy' as const,
  IDLE: 'idle' as const,
  FINALIZING: 'finalizing' as const
};

/**
 * Task priorities
 */
export const TASK_PRIORITY = {
  HIGH: 'high' as const,
  NORMAL: 'normal' as const
};

/**
 * Log message prefixes
 */
export const LOG_PREFIX = {
  BACKGROUND_INDEX: '[BackgroundIndex]',
  INDEX_SCHEDULER: '[IndexScheduler]',
  FINALIZE: '[Finalize]'
} as const;
