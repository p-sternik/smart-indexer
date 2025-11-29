import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { ConfigurationManager } from '../config/configurationManager.js';
import { FolderHasher } from '../cache/folderHasher.js';

export interface ScanOptions {
  excludePatterns: string[];
  maxFileSize: number;
  configManager: ConfigurationManager;
  folderHasher?: FolderHasher;
  useFolderHashing?: boolean;
}

/**
 * Concurrency limiter for parallel async operations.
 * Prevents blowing up file descriptors when scanning large directories.
 */
class ConcurrencyLimiter {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }
}

export class FileScanner {
  private excludePatterns: string[] = [];
  private maxFileSize: number = 1048576;
  private configManager: ConfigurationManager | null = null;
  private folderHasher: FolderHasher | null = null;
  private useFolderHashing: boolean = true;
  
  /** Concurrency limit for parallel stat operations */
  private static readonly STAT_CONCURRENCY = 50;

  configure(options: ScanOptions): void {
    this.excludePatterns = options.excludePatterns;
    this.maxFileSize = options.maxFileSize;
    this.configManager = options.configManager;
    this.folderHasher = options.folderHasher || null;
    this.useFolderHashing = options.useFolderHashing !== undefined ? options.useFolderHashing : true;
  }

  async scanWorkspace(workspaceRoot: string): Promise<string[]> {
    const files: string[] = [];
    console.info(`[FileScanner] Starting workspace scan from: ${workspaceRoot}`);
    const limiter = new ConcurrencyLimiter(FileScanner.STAT_CONCURRENCY);
    await this.scanDirectory(workspaceRoot, files, limiter);
    console.info(`[FileScanner] Workspace scan complete. Found ${files.length} indexable files`);
    return files;
  }

  private async scanDirectory(dir: string, files: string[], limiter: ConcurrencyLimiter): Promise<void> {
    try {
      // Check folder hash early exit if enabled
      if (this.useFolderHashing && this.folderHasher) {
        const changed = this.folderHasher.hasFolderChanged(dir);
        if (changed === false) {
          console.info(`[FileScanner] Skipping unchanged folder: ${dir} (hash unchanged)`);
          return;
        }
      }

      const entries = await fsPromises.readdir(dir, { withFileTypes: true });

      // Separate directories and files for parallel processing
      const subdirs: string[] = [];
      const filePaths: string[] = [];

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (this.shouldExclude(fullPath)) {
          continue;
        }

        if (entry.isDirectory()) {
          subdirs.push(fullPath);
        } else if (entry.isFile()) {
          if (this.hasIndexableExtension(fullPath)) {
            filePaths.push(fullPath);
          }
        }
      }

      // Check file sizes in parallel with concurrency limit
      const fileCheckResults = await Promise.all(
        filePaths.map(filePath => 
          limiter.run(() => this.isIndexableFileAsync(filePath))
        )
      );

      // Collect valid files
      for (let i = 0; i < filePaths.length; i++) {
        if (fileCheckResults[i]) {
          files.push(filePaths[i]);
        }
      }

      // Recurse into subdirectories (sequentially to avoid excessive parallelism)
      for (const subdir of subdirs) {
        await this.scanDirectory(subdir, files, limiter);
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') {
        console.error(`[FileScanner] Error scanning directory ${dir}: ${error}`);
      }
    }
  }

  private shouldExclude(filePath: string): boolean {
    // Check hardcoded exclusions via config manager
    if (this.configManager && this.configManager.shouldExcludePath(filePath)) {
      return true;
    }

    // Check user-configured patterns
    for (const pattern of this.excludePatterns) {
      if (minimatch(filePath, pattern, { dot: true })) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Check if file has an indexable extension (fast, no I/O).
   */
  private hasIndexableExtension(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    const indexableExtensions = [
      '.ts', '.tsx', '.js', '.jsx',
      '.mts', '.cts', '.mjs', '.cjs',
      '.json', '.md', '.txt', '.yml', '.yaml',
      // Text indexable languages
      '.java', '.go', '.cs', '.py', '.rs',
      '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp'
    ];
    return indexableExtensions.includes(ext);
  }

  /**
   * Async check if file is indexable (checks size via async stat).
   */
  private async isIndexableFileAsync(filePath: string): Promise<boolean> {
    try {
      const stats = await fsPromises.stat(filePath);
      
      if (stats.size > this.maxFileSize) {
        const sizeInMB = stats.size / (1024 * 1024);
        const maxSizeMB = this.maxFileSize / (1024 * 1024);
        console.info(
          `[FileScanner] Skipping large file ${filePath} (${sizeInMB.toFixed(2)}MB > ${maxSizeMB.toFixed(2)}MB)`
        );
        return false;
      }
      
      return true;
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.error(`[FileScanner] Error checking file ${filePath}: ${error}`);
      }
      return false;
    }
  }

  /**
   * Synchronous check (kept for backwards compatibility).
   * @deprecated Use isIndexableFileAsync for non-blocking I/O.
   */
  private isIndexableFile(filePath: string): boolean {
    if (!this.hasIndexableExtension(filePath)) {
      return false;
    }

    try {
      const stats = fs.statSync(filePath);
      
      if (stats.size > this.maxFileSize) {
        const sizeInMB = stats.size / (1024 * 1024);
        const maxSizeMB = this.maxFileSize / (1024 * 1024);
        console.info(
          `[FileScanner] Skipping large file ${filePath} (${sizeInMB.toFixed(2)}MB > ${maxSizeMB.toFixed(2)}MB)`
        );
        return false;
      }
      
      return true;
    } catch (error) {
      console.error(`[FileScanner] Error checking file ${filePath}: ${error}`);
      return false;
    }
  }

  isCodeFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(ext);
  }
}
