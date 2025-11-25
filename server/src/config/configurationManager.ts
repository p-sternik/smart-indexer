export interface SmartIndexerConfig {
  cacheDirectory: string;
  enableGitIntegration: boolean;
  excludePatterns: string[];
  maxIndexedFileSize: number;
  maxFileSizeMB: number;
  maxCacheSizeMB: number;
  maxConcurrentIndexJobs: number;
  enableBackgroundIndex: boolean;
}

const DEFAULT_CONFIG: SmartIndexerConfig = {
  cacheDirectory: '.smart-index',
  enableGitIntegration: true,
  excludePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/out/**',
    '**/.git/**',
    '**/build/**',
    '**/*.min.js'
  ],
  maxIndexedFileSize: 1048576,
  maxFileSizeMB: 50,
  maxCacheSizeMB: 500,
  maxConcurrentIndexJobs: 4,
  enableBackgroundIndex: true
};

export class ConfigurationManager {
  private config: SmartIndexerConfig;

  constructor() {
    this.config = { ...DEFAULT_CONFIG };
  }

  getConfig(): SmartIndexerConfig {
    return { ...this.config };
  }

  updateFromInitializationOptions(opts: any): void {
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
  }

  updateFromSettings(settings: any): void {
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
  }

  getMaxFileSizeBytes(): number {
    return this.config.maxFileSizeMB * 1024 * 1024;
  }

  getMaxCacheSizeBytes(): number {
    return this.config.maxCacheSizeMB * 1024 * 1024;
  }

  shouldExcludePath(filePath: string): boolean {
    // Hardcoded exclusions for VS Code internal and Copilot caches
    const hardcodedExclusions = [
      'vscode-userdata:',
      'github.copilot-chat',
      'commandEmbeddings.json',
      '.vscode/extensions',
      'User/globalStorage',
      'User/workspaceStorage'
    ];

    const lowerPath = filePath.toLowerCase();
    for (const exclusion of hardcodedExclusions) {
      if (lowerPath.includes(exclusion.toLowerCase())) {
        return true;
      }
    }

    return false;
  }
}
