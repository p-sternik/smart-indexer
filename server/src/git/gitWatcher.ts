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

      const diff = await this.git.diffSummary([lastHash, 'HEAD']);

      const added: string[] = [];
      const modified: string[] = [];
      const deleted: string[] = [];

      for (const file of diff.files) {
        const fullPath = path.join(this.workspaceRoot, file.file);
        
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
      const result = await this.git.raw(['ls-files']);
      const files = result
        .split('\n')
        .filter(f => f.trim().length > 0)
        .map(f => path.join(this.workspaceRoot, f));
      return files;
    } catch (error) {
      console.error(`[GitWatcher] Error getting tracked files: ${error}`);
      return [];
    }
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
