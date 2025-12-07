export interface SmartIndexerConfig {
  cacheDirectory: string;
  enableGitIntegration: boolean;
  excludePatterns: string[];
  maxIndexedFileSize: number;
  maxFileSizeMB: number;
  maxCacheSizeMB: number;
  maxConcurrentIndexJobs: number;
  enableBackgroundIndex: boolean;
  textIndexingEnabled: boolean;
  staticIndexEnabled: boolean;
  staticIndexPath: string;
  maxConcurrentWorkers: number;
  batchSize: number;
  useFolderHashing: boolean;
  deadCode?: DeadCodeConfig;
}

export interface DeadCodeConfig {
  enabled: boolean;
  entryPoints: string[];
  excludePatterns: string[];
  checkBarrierFiles: boolean;
  debounceMs: number;
}

const DEFAULT_DEAD_CODE_CONFIG: DeadCodeConfig = {
  enabled: true,
  entryPoints: [
    '**/main.ts',
    '**/public-api.ts',
    '**/index.ts',
    '**/*.stories.ts',
    '**/*.spec.ts',
    '**/*.test.ts',
    '**/test/**',
    '**/tests/**'
  ],
  excludePatterns: [],
  checkBarrierFiles: false, // Expensive, opt-in
  debounceMs: 1500
};

const DEFAULT_CONFIG: SmartIndexerConfig = {
  cacheDirectory: '.smart-index',
  enableGitIntegration: true,
  excludePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/out/**',
    '**/.git/**',
    '**/build/**',
    '**/*.min.js',
    '**/.angular/**',
    '**/.nx/**',
    '**/coverage/**',
    '**/.vscode-test/**'
  ],
  maxIndexedFileSize: 1048576,
  maxFileSizeMB: 50,
  maxCacheSizeMB: 500,
  maxConcurrentIndexJobs: 4,
  enableBackgroundIndex: true,
  textIndexingEnabled: false,
  staticIndexEnabled: false,
  staticIndexPath: '',
  maxConcurrentWorkers: 4,
  batchSize: 50,
  useFolderHashing: true,
  deadCode: DEFAULT_DEAD_CODE_CONFIG
};

/**
 * Settings interface matching VS Code extension configuration.
 * Used for type-safe settings updates from the client.
 */
export interface ISmartIndexerSettings {
  cacheDirectory?: string;
  enableGitIntegration?: boolean;
  excludePatterns?: string[];
  maxIndexedFileSize?: number;
  maxFileSizeMB?: number;
  maxCacheSizeMB?: number;
  maxConcurrentIndexJobs?: number;
  enableBackgroundIndex?: boolean;
  textIndexingEnabled?: boolean;
  staticIndexEnabled?: boolean;
  staticIndexPath?: string;
  maxConcurrentWorkers?: number;
  batchSize?: number;
  useFolderHashing?: boolean;
  deadCode?: Partial<DeadCodeConfig>;
}

export class ConfigurationManager {
  private config: SmartIndexerConfig;

  constructor() {
    this.config = { ...DEFAULT_CONFIG };
  }

  getConfig(): SmartIndexerConfig {
    return { ...this.config };
  }

  updateFromInitializationOptions(opts: Partial<ISmartIndexerSettings> | null | undefined): void {
    if (!opts) {return;}

    if (typeof opts.cacheDirectory === 'string') {
      this.config.cacheDirectory = opts.cacheDirectory;
    }
    if (typeof opts.enableGitIntegration === 'boolean') {
      this.config.enableGitIntegration = opts.enableGitIntegration;
    }
    if (Array.isArray(opts.excludePatterns)) {
      this.config.excludePatterns = opts.excludePatterns;
    }
    if (typeof opts.maxIndexedFileSize === 'number') {
      this.config.maxIndexedFileSize = opts.maxIndexedFileSize;
    }
    if (typeof opts.maxFileSizeMB === 'number') {
      this.config.maxFileSizeMB = Math.max(1, opts.maxFileSizeMB);
    }
    if (typeof opts.maxCacheSizeMB === 'number') {
      this.config.maxCacheSizeMB = Math.max(10, opts.maxCacheSizeMB);
    }
    if (typeof opts.maxConcurrentIndexJobs === 'number') {
      this.config.maxConcurrentIndexJobs = Math.max(1, Math.min(16, opts.maxConcurrentIndexJobs));
    }
    if (typeof opts.enableBackgroundIndex === 'boolean') {
      this.config.enableBackgroundIndex = opts.enableBackgroundIndex;
    }
    if (typeof opts.textIndexingEnabled === 'boolean') {
      this.config.textIndexingEnabled = opts.textIndexingEnabled;
    }
    if (typeof opts.staticIndexEnabled === 'boolean') {
      this.config.staticIndexEnabled = opts.staticIndexEnabled;
    }
    if (typeof opts.staticIndexPath === 'string') {
      this.config.staticIndexPath = opts.staticIndexPath;
    }
    if (typeof opts.maxConcurrentWorkers === 'number') {
      this.config.maxConcurrentWorkers = Math.max(1, Math.min(16, opts.maxConcurrentWorkers));
    }
    if (typeof opts.batchSize === 'number') {
      this.config.batchSize = Math.max(1, opts.batchSize);
    }
    if (typeof opts.useFolderHashing === 'boolean') {
      this.config.useFolderHashing = opts.useFolderHashing;
    }
    if (opts.deadCode) {
      this.config.deadCode = { ...DEFAULT_DEAD_CODE_CONFIG, ...opts.deadCode };
    }
  }

  updateFromSettings(settings: Partial<ISmartIndexerSettings> | null | undefined): void {
    if (!settings) {return;}

    if (typeof settings.cacheDirectory === 'string') {
      this.config.cacheDirectory = settings.cacheDirectory;
    }
    if (typeof settings.enableGitIntegration === 'boolean') {
      this.config.enableGitIntegration = settings.enableGitIntegration;
    }
    if (Array.isArray(settings.excludePatterns)) {
      this.config.excludePatterns = settings.excludePatterns;
    }
    if (typeof settings.maxIndexedFileSize === 'number') {
      this.config.maxIndexedFileSize = settings.maxIndexedFileSize;
    }
    if (typeof settings.maxFileSizeMB === 'number') {
      this.config.maxFileSizeMB = Math.max(1, settings.maxFileSizeMB);
    }
    if (typeof settings.maxCacheSizeMB === 'number') {
      this.config.maxCacheSizeMB = Math.max(10, settings.maxCacheSizeMB);
    }
    if (typeof settings.maxConcurrentIndexJobs === 'number') {
      this.config.maxConcurrentIndexJobs = Math.max(1, Math.min(16, settings.maxConcurrentIndexJobs));
    }
    if (typeof settings.enableBackgroundIndex === 'boolean') {
      this.config.enableBackgroundIndex = settings.enableBackgroundIndex;
    }
    if (typeof settings.textIndexingEnabled === 'boolean') {
      this.config.textIndexingEnabled = settings.textIndexingEnabled;
    }
    if (typeof settings.staticIndexEnabled === 'boolean') {
      this.config.staticIndexEnabled = settings.staticIndexEnabled;
    }
    if (typeof settings.staticIndexPath === 'string') {
      this.config.staticIndexPath = settings.staticIndexPath;
    }
    if (typeof settings.maxConcurrentWorkers === 'number') {
      this.config.maxConcurrentWorkers = Math.max(1, Math.min(16, settings.maxConcurrentWorkers));
    }
    if (typeof settings.batchSize === 'number') {
      this.config.batchSize = Math.max(1, settings.batchSize);
    }
    if (typeof settings.useFolderHashing === 'boolean') {
      this.config.useFolderHashing = settings.useFolderHashing;
    }
    if (settings.deadCode) {
      this.config.deadCode = { ...DEFAULT_DEAD_CODE_CONFIG, ...settings.deadCode };
    }
  }

  getMaxFileSizeBytes(): number {
    return this.config.maxFileSizeMB * 1024 * 1024;
  }

  getMaxCacheSizeBytes(): number {
    return this.config.maxCacheSizeMB * 1024 * 1024;
  }

  getDeadCodeConfig(): DeadCodeConfig {
    return this.config.deadCode || DEFAULT_DEAD_CODE_CONFIG;
  }

  isDeadCodeEnabled(): boolean {
    return this.config.deadCode?.enabled ?? DEFAULT_DEAD_CODE_CONFIG.enabled;
  }

  shouldExcludePath(filePath: string): boolean {
    // Hardcoded exclusions for VS Code internal, Copilot caches, and build artifacts
    const hardcodedExclusions = [
      'vscode-userdata:',
      'github.copilot-chat',
      'commandEmbeddings.json',
      '.vscode/extensions',
      '.vscode-test',
      'User/globalStorage',
      'User/workspaceStorage',
      // Angular/Nx build artifacts
      '/.angular/',
      '\\.angular\\',
      '/.nx/',
      '\\.nx\\',
      '/dist/',
      '\\dist\\',
      '/coverage/',
      '\\coverage\\',
      '/node_modules/',
      '\\node_modules\\',
      '/.smart-index/',
      '\\.smart-index\\'
    ];

    const normalizedPath = filePath.replace(/\\/g, '/');
    for (const exclusion of hardcodedExclusions) {
      const normalizedExclusion = exclusion.replace(/\\/g, '/');
      if (normalizedPath.includes(normalizedExclusion)) {
        return true;
      }
    }

    return false;
  }
}
