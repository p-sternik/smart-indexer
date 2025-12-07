import { simpleGit, SimpleGit } from 'simple-git';
import * as fsPromises from 'fs/promises';
import { watch } from 'fs';
import * as path from 'path';

export interface GitChanges {
  added: string[];
  modified: string[];
  deleted: string[];
  currentHash: string;
}

export class GitWatcher {
  private git: SimpleGit | null = null;
  private workspaceRoot: string = '';
  private isGitRepo: boolean = false;

  async init(workspaceRoot: string): Promise<void> {
    try {
      this.workspaceRoot = workspaceRoot;
      const gitDir = path.join(workspaceRoot, '.git');

      try {
        await fsPromises.access(gitDir);
        this.git = simpleGit(workspaceRoot);
        this.isGitRepo = true;
      } catch {
        this.isGitRepo = false;
      }
    } catch (error) {
      // Silent fail - git integration is optional
      this.isGitRepo = false;
    }
  }

  async isRepository(): Promise<boolean> {
    return this.isGitRepo;
  }

  async getCurrentHash(): Promise<string | undefined> {
    if (!this.git || !this.isGitRepo) {return undefined;}

    try {
      const log = await this.git.log({ maxCount: 1 });
      return log.latest?.hash;
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Check if a file exists asynchronously
   */
  private async fileExistsAsync(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async getChangesSince(lastHash: string | undefined): Promise<GitChanges | undefined> {
    if (!this.git || !this.isGitRepo) {return undefined;}

    try {
      const currentHash = await this.getCurrentHash();
      if (!currentHash) {return undefined;}

      if (!lastHash) {
        const files = await this.getAllTrackedFiles();
        return {
          added: files,
          modified: [],
          deleted: [],
          currentHash
        };
      }

      if (lastHash === currentHash) {
        return {
          added: [],
          modified: [],
          deleted: [],
          currentHash
        };
      }

      // Use raw() to pass -c core.quotePath=false properly (diffSummary doesn't support -c flag)
      const rawDiff = await this.git.raw(['-c', 'core.quotePath=false', 'diff', '--name-only', lastHash, 'HEAD']);
      const changedFiles = rawDiff
        .split('\n')
        .filter(f => f.trim().length > 0)
        .map(f => this.sanitizeGitPath(f));

      const added: string[] = [];
      const modified: string[] = [];
      const deleted: string[] = [];

      // Check file existence in parallel for better performance
      const fullPaths = changedFiles.map(f => path.join(this.workspaceRoot, f));
      const existsResults = await Promise.all(
        fullPaths.map(fp => this.fileExistsAsync(fp))
      );

      for (let i = 0; i < changedFiles.length; i++) {
        const fullPath = fullPaths[i];
        if (existsResults[i]) {
          // File exists - treat as added (will be re-indexed)
          added.push(fullPath);
        } else {
          // File doesn't exist - it was deleted
          deleted.push(fullPath);
        }
      }

      return { added, modified, deleted, currentHash };
    } catch (error) {
      return undefined;
    }
  }

  private async getAllTrackedFiles(): Promise<string[]> {
    if (!this.git) {return [];}

    try {
      // Use -c core.quotePath=false to output raw UTF-8 paths instead of quoted/escaped
      // This prevents paths like "Wspó\305\202" for "Współwłaściciele.svg"
      const result = await this.git.raw(['-c', 'core.quotePath=false', 'ls-files']);
      const files = result
        .split('\n')
        .filter(f => f.trim().length > 0)
        .map(f => this.sanitizeGitPath(f))
        .map(f => path.join(this.workspaceRoot, f));
      return files;
    } catch (error) {
      return [];
    }
  }

  /**
   * Sanitize a path returned by git to handle edge cases.
   * Even with core.quotePath=false, some git versions may still quote paths.
   */
  private sanitizeGitPath(filePath: string): string {
    let sanitized = filePath.trim();
    
    // Strip surrounding quotes if present (e.g., "path/to/file")
    if (sanitized.startsWith('"') && sanitized.endsWith('"')) {
      sanitized = sanitized.slice(1, -1);
    }
    
    // Decode octal escape sequences if present (e.g., \303\263 -> ó)
    // This handles legacy git output or misconfigured systems
    if (sanitized.includes('\\')) {
      try {
        sanitized = sanitized.replace(/\\([0-7]{3})/g, (_, octal) => {
          return String.fromCharCode(parseInt(octal, 8));
        });
        // Handle UTF-8 byte sequences: convert bytes to proper UTF-8 string
        const bytes = [];
        for (let i = 0; i < sanitized.length; i++) {
          bytes.push(sanitized.charCodeAt(i));
        }
        sanitized = Buffer.from(bytes).toString('utf-8');
      } catch (error) {
        // Skip paths that can't be decoded
      }
    }
    
    return sanitized;
  }

  async watchForChanges(callback: (changes: GitChanges) => void): Promise<void> {
    if (!this.isGitRepo) {return;}

    try {
      const headFile = path.join(this.workspaceRoot, '.git', 'HEAD');
      let lastHash = await this.getCurrentHash();

      watch(headFile, async () => {
        try {
          const currentHash = await this.getCurrentHash();
          if (currentHash && currentHash !== lastHash) {
            const changes = await this.getChangesSince(lastHash);
            if (changes) {
              lastHash = currentHash;
              callback(changes);
            }
          }
        } catch (error) {
          // Ignore errors in git watch callback
        }
      });
    } catch (error) {
      // Git watching is optional
    }
  }
}
