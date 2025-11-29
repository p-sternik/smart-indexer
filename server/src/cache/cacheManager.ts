import { SqlJsStorage } from './sqlJsStorage.js';
import { IndexedFileResult, FileInfo, Metadata, IndexedSymbol, IndexStats } from '../types.js';
import * as path from 'path';
import * as fsPromises from 'fs/promises';

export class CacheManager {
  private storage: SqlJsStorage;
  private stats: IndexStats = {
    totalFiles: 0,
    totalSymbols: 0,
    cacheHits: 0,
    cacheMisses: 0,
    lastUpdateTime: Date.now()
  };
  private cacheDirectory: string = '';
  private maxCacheSizeBytes: number = 500 * 1024 * 1024;
  private isClosed: boolean = false;

  constructor() {
    this.storage = new SqlJsStorage();
  }

  async init(workspaceRoot: string, cacheDir: string, maxCacheSizeBytes?: number): Promise<void> {
    this.cacheDirectory = path.join(workspaceRoot, cacheDir);
    if (maxCacheSizeBytes) {
      this.maxCacheSizeBytes = maxCacheSizeBytes;
    }
    
    const dbPath = path.join(this.cacheDirectory, 'index.sqlite');
    
    console.info(`[CacheManager] Initializing cache at: ${dbPath}`);
    
    try {
      await this.storage.init(dbPath);
      console.info('[CacheManager] Storage initialized successfully');
      this.isClosed = false;
      
      // Load stats using efficient COUNT queries (O(1) instead of O(N))
      this.stats.totalFiles = await this.storage.getFileCount();
      this.stats.totalSymbols = await this.storage.getSymbolCount();
      console.info(`[CacheManager] Stats loaded: ${this.stats.totalFiles} files, ${this.stats.totalSymbols} symbols`);
    } catch (error) {
      console.error(`[CacheManager] Error initializing cache storage: ${error}`);
      throw error;
    }
  }

  async loadMetadata(): Promise<Metadata> {
    const versionStr = await this.storage.getMetadata('version');
    const version = versionStr ? parseInt(versionStr) : 1;
    const lastGitHash = await this.storage.getMetadata('lastGitHash');
    const lastUpdatedAtStr = await this.storage.getMetadata('lastUpdatedAt');
    const lastUpdatedAt = lastUpdatedAtStr ? parseInt(lastUpdatedAtStr) : 0;

    return { version, lastGitHash, lastUpdatedAt };
  }

  async saveMetadata(meta: Metadata): Promise<void> {
    await this.storage.setMetadata('version', meta.version.toString());
    if (meta.lastGitHash) {
      await this.storage.setMetadata('lastGitHash', meta.lastGitHash);
    }
    await this.storage.setMetadata('lastUpdatedAt', meta.lastUpdatedAt.toString());
  }

  async getFileInfo(uri: string): Promise<FileInfo | undefined> {
    return await this.storage.getFileInfo(uri);
  }

  async upsertFileIndex(result: IndexedFileResult): Promise<void> {
    const now = Date.now();

    try {
      // Get old symbol count for this file BEFORE deleting (for incremental stats)
      const oldSymbolCount = await this.storage.getSymbolCountByUri(result.uri);
      const isNewFile = oldSymbolCount === -1;
      
      await this.storage.deleteSymbolsByUri(result.uri);

      await this.storage.upsertFile(result.uri, result.hash, now);

      if (result.symbols.length > 0) {
        const dbSymbols = result.symbols.map(s => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          uri: result.uri,
          line: s.location.line,
          character: s.location.character,
          startLine: s.range.startLine,
          startCharacter: s.range.startCharacter,
          endLine: s.range.endLine,
          endCharacter: s.range.endCharacter,
          containerName: s.containerName,
          containerKind: s.containerKind,
          fullContainerPath: s.fullContainerPath,
          isStatic: s.isStatic,
          parametersCount: s.parametersCount
        }));

        await this.storage.insertSymbols(dbSymbols);
      }

      const prevTotalFiles = this.stats.totalFiles;
      const prevTotalSymbols = this.stats.totalSymbols;

      // FIX N+1: Use O(1) COUNT queries instead of O(N) getAllFiles()/getAllSymbols()
      if (isNewFile) {
        this.stats.totalFiles++;
      }
      // Increment by new symbols, decrement by old symbols
      const symbolDelta = result.symbols.length - Math.max(0, oldSymbolCount);
      this.stats.totalSymbols += symbolDelta;
      this.stats.lastUpdateTime = now;

      console.info(`[CacheManager] File indexed: ${result.uri} (${result.symbols.length} symbols) | Stats: ${prevTotalFiles}->${this.stats.totalFiles} files, ${prevTotalSymbols}->${this.stats.totalSymbols} symbols`);

      await this.checkCacheSizeLimit();
    } catch (error) {
      console.error(`[CacheManager] Error upserting file index for ${result.uri}: ${error}`);
      throw error;
    }
  }

  async removeFile(uri: string): Promise<void> {
    try {
      const symbols = await this.storage.getSymbolsByUri(uri);
      const symbolCount = symbols.length;
      
      await this.storage.deleteFile(uri);

      // FIX N+1: Use incremental updates instead of O(N) full scans
      this.stats.totalFiles = Math.max(0, this.stats.totalFiles - 1);
      this.stats.totalSymbols = Math.max(0, this.stats.totalSymbols - symbolCount);
      this.stats.lastUpdateTime = Date.now();
    } catch (error) {
      console.error(`[CacheManager] Error removing file ${uri}: ${error}`);
      throw error;
    }
  }

  async findSymbolsByName(name: string): Promise<IndexedSymbol[]> {
    // Query storage directly - sql.js with prepared statements is fast enough
    const results = await this.storage.findSymbolsByName(name);
    if (results.length > 0) {
      this.stats.cacheHits++;
      return results.map(sym => ({
        id: sym.id || '',
        name: sym.name,
        kind: sym.kind,
        location: {
          uri: sym.uri,
          line: sym.line,
          character: sym.character
        },
        range: {
          startLine: sym.startLine || sym.line,
          startCharacter: sym.startCharacter || sym.character,
          endLine: sym.endLine || sym.line,
          endCharacter: sym.endCharacter || (sym.character + sym.name.length)
        },
        containerName: sym.containerName || undefined,
        containerKind: sym.containerKind || undefined,
        fullContainerPath: sym.fullContainerPath || undefined,
        isStatic: sym.isStatic || undefined,
        parametersCount: sym.parametersCount || undefined,
        filePath: sym.uri
      }));
    }

    this.stats.cacheMisses++;
    return [];
  }

  async findSymbolsByPrefix(prefix: string, limit: number): Promise<IndexedSymbol[]> {
    // Query storage directly using prepared statement
    const results = await this.storage.findSymbolsByPrefix(prefix, limit);
    return results.map(sym => ({
      id: sym.id || '',
      name: sym.name,
      kind: sym.kind,
      location: {
        uri: sym.uri,
        line: sym.line,
        character: sym.character
      },
      range: {
        startLine: sym.startLine || sym.line,
        startCharacter: sym.startCharacter || sym.character,
        endLine: sym.endLine || sym.line,
        endCharacter: sym.endCharacter || (sym.character + sym.name.length)
      },
      containerName: sym.containerName || undefined,
      containerKind: sym.containerKind || undefined,
      isStatic: sym.isStatic || undefined,
      filePath: sym.uri
    }));
  }

  async getAllFiles(): Promise<FileInfo[]> {
    return await this.storage.getAllFiles();
  }

  getStats(): IndexStats {
    console.info(`[CacheManager] getStats() called - returning: totalFiles=${this.stats.totalFiles}, totalSymbols=${this.stats.totalSymbols}, cacheHits=${this.stats.cacheHits}, cacheMisses=${this.stats.cacheMisses}, lastUpdate=${new Date(this.stats.lastUpdateTime).toISOString()}`);
    return { ...this.stats };
  }

  async clear(): Promise<void> {
    try {
      const allFiles = await this.storage.getAllFiles();
      for (const file of allFiles) {
        await this.storage.deleteFile(file.uri);
      }
      this.stats = {
        totalFiles: 0,
        totalSymbols: 0,
        cacheHits: 0,
        cacheMisses: 0,
        lastUpdateTime: Date.now()
      };
      console.info('[CacheManager] Cache cleared successfully - stats reset to zero');
    } catch (error) {
      console.error(`[CacheManager] Error clearing cache: ${error}`);
      throw error;
    }
  }

  private async checkCacheSizeLimit(): Promise<void> {
    try {
      if (!this.cacheDirectory) {
        return;
      }

      try {
        const totalSize = await this.getDirectorySize(this.cacheDirectory);
        const sizeMB = totalSize / (1024 * 1024);
        const limitMB = this.maxCacheSizeBytes / (1024 * 1024);

        if (totalSize > this.maxCacheSizeBytes) {
          console.warn(
            `[CacheManager] Cache size (${sizeMB.toFixed(2)}MB) exceeds limit (${limitMB.toFixed(2)}MB). Consider increasing smartIndexer.maxCacheSizeMB or clearing old data.`
          );
        }
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        // Directory doesn't exist yet, that's fine
      }
    } catch (error) {
      console.error(`[CacheManager] Error checking cache size: ${error}`);
    }
  }

  private async getDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0;

    try {
      const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          totalSize += await this.getDirectorySize(fullPath);
        } else if (entry.isFile()) {
          const stats = await fsPromises.stat(fullPath);
          totalSize += stats.size;
        }
      }
    } catch (error) {
      console.error(`[CacheManager] Error calculating directory size for ${dirPath}: ${error}`);
    }

    return totalSize;
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      console.warn('[CacheManager] Cache already closed');
      return;
    }
    
    try {
      await this.storage.close();
      this.isClosed = true;
      console.info('[CacheManager] Cache closed successfully');
    } catch (error) {
      console.error(`[CacheManager] Error closing storage: ${error}`);
    }
  }
}
