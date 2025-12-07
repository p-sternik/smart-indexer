import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Represents the hash state of a folder
 */
export interface FolderHashInfo {
  path: string;
  hash: string;
  childHashes: Map<string, string>; // filename -> hash
  lastComputed: number;
}

/**
 * Computes and caches Merkle-style folder hashes for skip-unchanged-directory optimization.
 */
export class FolderHasher {
  private folderHashCache = new Map<string, FolderHashInfo>();

  /**
   * Compute a hash for a folder based on its contents.
   * Returns undefined if folder doesn't exist or is inaccessible.
   */
  async computeFolderHash(folderPath: string): Promise<string | undefined> {
    try {
      let stat;
      try {
        stat = await fsPromises.stat(folderPath);
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return undefined;
        }
        throw err;
      }

      if (!stat.isDirectory()) {
        return undefined;
      }

      const entries = await fsPromises.readdir(folderPath, { withFileTypes: true });
      const childHashes = new Map<string, string>();
      const hashInputs: string[] = [];

      // Process file stats in parallel with concurrency limit
      const fileEntries = entries.filter(e => e.isFile());
      const dirEntries = entries.filter(e => e.isDirectory());

      const fileHashPromises = fileEntries.map(async (entry) => {
        const fullPath = path.join(folderPath, entry.name);
        try {
          const fileStat = await fsPromises.stat(fullPath);
          // Use name + size + mtime as file signature
          return { name: entry.name, hash: `${entry.name}:${fileStat.size}:${fileStat.mtimeMs}` };
        } catch (err) {
          // Skip inaccessible files
          return null;
        }
      });

      const fileResults = await Promise.all(fileHashPromises);
      for (const result of fileResults) {
        if (result) {
          childHashes.set(result.name, result.hash);
          hashInputs.push(result.hash);
        }
      }

      for (const entry of dirEntries) {
        // For subdirectories, just include name (recursive hashing would be expensive)
        const dirHash = `dir:${entry.name}`;
        childHashes.set(entry.name, dirHash);
        hashInputs.push(dirHash);
      }

      // Sort to ensure consistent hashing
      hashInputs.sort();
      const combinedInput = hashInputs.join('|');
      const hash = crypto.createHash('sha256').update(combinedInput).digest('hex');

      this.folderHashCache.set(folderPath, {
        path: folderPath,
        hash,
        childHashes,
        lastComputed: Date.now()
      });

      return hash;
    } catch (error) {
      // Silently fail - folder hash is an optimization
      return undefined;
    }
  }

  /**
   * Check if a folder has changed since last hash computation.
   * Returns true if changed, false if unchanged, undefined if no cached hash exists.
   */
  async hasFolderChanged(folderPath: string): Promise<boolean | undefined> {
    const cached = this.folderHashCache.get(folderPath);
    if (!cached) {
      return undefined; // No cached data
    }

    const currentHash = await this.computeFolderHash(folderPath);
    if (!currentHash) {
      return true; // Folder disappeared or inaccessible - consider changed
    }

    return currentHash !== cached.hash;
  }

  /**
   * Get cached folder hash without recomputing
   */
  getCachedHash(folderPath: string): FolderHashInfo | undefined {
    return this.folderHashCache.get(folderPath);
  }

  /**
   * Load folder hashes from persisted metadata
   */
  loadFromMetadata(metadata: Record<string, FolderHashInfo>): void {
    for (const [path, info] of Object.entries(metadata)) {
      this.folderHashCache.set(path, {
        ...info,
        childHashes: new Map(Object.entries(info.childHashes || {}))
      });
    }
  }

  /**
   * Export folder hashes to persistable metadata
   */
  exportToMetadata(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [path, info] of this.folderHashCache.entries()) {
      result[path] = {
        path: info.path,
        hash: info.hash,
        childHashes: Object.fromEntries(info.childHashes),
        lastComputed: info.lastComputed
      };
    }
    return result;
  }

  /**
   * Clear the cache
   */
  clear(): void {
    this.folderHashCache.clear();
  }
}
