import * as fsPromises from 'fs/promises';
import * as path from 'path';

/**
 * Centralized async file system service.
 * All file I/O should go through this service to:
 * - Ensure consistent async behavior (no blocking event loop)
 * - Centralize error handling
 * - Enable easier testing/mocking
 */
export class FileSystemService {
  /**
   * Read file contents as UTF-8 string.
   * @throws Error with code 'ENOENT' if file doesn't exist
   */
  async readFile(filePath: string): Promise<string> {
    return fsPromises.readFile(filePath, 'utf-8');
  }

  /**
   * Read file contents as Buffer.
   * @throws Error with code 'ENOENT' if file doesn't exist
   */
  async readFileBuffer(filePath: string): Promise<Buffer> {
    return fsPromises.readFile(filePath);
  }

  /**
   * Write string content to file (creates parent directories if needed).
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await this.ensureDirectory(dir);
    await fsPromises.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Write buffer content to file (creates parent directories if needed).
   */
  async writeFileBuffer(filePath: string, content: Buffer | Uint8Array): Promise<void> {
    const dir = path.dirname(filePath);
    await this.ensureDirectory(dir);
    await fsPromises.writeFile(filePath, content);
  }

  /**
   * Check if a file or directory exists.
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file/directory stats.
   * @throws Error with code 'ENOENT' if path doesn't exist
   */
  async stat(filePath: string): Promise<{ size: number; mtimeMs: number; isDirectory: boolean; isFile: boolean }> {
    const stats = await fsPromises.stat(filePath);
    return {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile()
    };
  }

  /**
   * Ensure a directory exists (creates recursively if needed).
   */
  async ensureDirectory(dirPath: string): Promise<void> {
    await fsPromises.mkdir(dirPath, { recursive: true });
  }

  /**
   * Read directory contents.
   * @throws Error with code 'ENOENT' if directory doesn't exist
   */
  async readDirectory(dirPath: string): Promise<string[]> {
    return fsPromises.readdir(dirPath);
  }

  /**
   * Read directory with file type information.
   */
  async readDirectoryWithTypes(dirPath: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>> {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    return entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile()
    }));
  }

  /**
   * Delete a file.
   * @returns true if deleted, false if didn't exist
   */
  async deleteFile(filePath: string): Promise<boolean> {
    try {
      await fsPromises.unlink(filePath);
      return true;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Delete a directory recursively.
   * @returns true if deleted, false if didn't exist
   */
  async deleteDirectory(dirPath: string): Promise<boolean> {
    try {
      await fsPromises.rm(dirPath, { recursive: true, force: true });
      return true;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Copy a file.
   */
  async copyFile(src: string, dest: string): Promise<void> {
    const dir = path.dirname(dest);
    await this.ensureDirectory(dir);
    await fsPromises.copyFile(src, dest);
  }

  /**
   * Get directory size recursively.
   */
  async getDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0;

    try {
      const entries = await this.readDirectoryWithTypes(dirPath);
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory) {
          totalSize += await this.getDirectorySize(fullPath);
        } else if (entry.isFile) {
          const stats = await this.stat(fullPath);
          totalSize += stats.size;
        }
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.error(`[FileSystemService] Error calculating directory size for ${dirPath}: ${error}`);
      }
    }

    return totalSize;
  }
}

// Singleton instance for convenience
export const fileSystemService = new FileSystemService();
