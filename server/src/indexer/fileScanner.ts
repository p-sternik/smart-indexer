import * as fs from 'fs';
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

export class FileScanner {
  private excludePatterns: string[] = [];
  private maxFileSize: number = 1048576;
  private configManager: ConfigurationManager | null = null;
  private folderHasher: FolderHasher | null = null;
  private useFolderHashing: boolean = true;

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
    await this.scanDirectory(workspaceRoot, files);
    console.info(`[FileScanner] Workspace scan complete. Found ${files.length} indexable files`);
    return files;
  }

  private async scanDirectory(dir: string, files: string[]): Promise<void> {
    try {
      // Check folder hash early exit if enabled
      if (this.useFolderHashing && this.folderHasher) {
        const changed = this.folderHasher.hasFolderChanged(dir);
        if (changed === false) {
          console.info(`[FileScanner] Skipping unchanged folder: ${dir} (hash unchanged)`);
          return;
        }
      }

      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (this.shouldExclude(fullPath)) {
          continue;
        }

        if (entry.isDirectory()) {
          await this.scanDirectory(fullPath, files);
        } else if (entry.isFile()) {
          if (this.isIndexableFile(fullPath)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      console.error(`[FileScanner] Error scanning directory ${dir}: ${error}`);
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

  private isIndexableFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    const indexableExtensions = [
      '.ts', '.tsx', '.js', '.jsx',
      '.mts', '.cts', '.mjs', '.cjs',
      '.json', '.md', '.txt', '.yml', '.yaml',
      // Text indexable languages
      '.java', '.go', '.cs', '.py', '.rs',
      '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp'
    ];

    if (!indexableExtensions.includes(ext)) {
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
