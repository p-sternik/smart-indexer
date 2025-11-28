import { simpleGit, SimpleGit } from 'simple-git';
import * as fs from 'fs';
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

      if (fs.existsSync(gitDir)) {
        this.git = simpleGit(workspaceRoot);
        this.isGitRepo = true;
      }
    } catch (error) {
      console.error(`[GitWatcher] Error initializing git watcher: ${error}`);
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
      console.error(`[GitWatcher] Error getting current git hash: ${error}`);
      return undefined;
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

      const diff = await this.git.diffSummary(['-c', 'core.quotePath=false', lastHash, 'HEAD']);

      const added: string[] = [];
      const modified: string[] = [];
      const deleted: string[] = [];

      for (const file of diff.files) {
        // Sanitize the file path to handle non-ASCII characters
        const sanitizedPath = this.sanitizeGitPath(file.file);
        const fullPath = path.join(this.workspaceRoot, sanitizedPath);
        
        if (file.binary) {continue;}

        if (fs.existsSync(fullPath)) {
          if (file.insertions > 0 && file.deletions === 0) {
            added.push(fullPath);
          } else {
            modified.push(fullPath);
          }
        } else {
          deleted.push(fullPath);
        }
      }

      return { added, modified, deleted, currentHash };
    } catch (error) {
      console.error(`[GitWatcher] Error getting git changes: ${error}`);
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
      console.error(`[GitWatcher] Error getting tracked files: ${error}`);
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
        console.warn(`[GitWatcher] Failed to decode path: ${filePath}`);
      }
    }
    
    return sanitized;
  }

  async watchForChanges(callback: (changes: GitChanges) => void): Promise<void> {
    if (!this.isGitRepo) {return;}

    try {
      const headFile = path.join(this.workspaceRoot, '.git', 'HEAD');
      let lastHash = await this.getCurrentHash();

      fs.watch(headFile, async () => {
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
          console.error(`[GitWatcher] Error in git watch callback: ${error}`);
        }
      });
    } catch (error) {
      console.error(`[GitWatcher] Error setting up git watcher: ${error}`);
    }
  }
}
