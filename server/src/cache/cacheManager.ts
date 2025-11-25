import { SqlJsStorage } from './sqlJsStorage.js';
import { IndexedFileResult, FileInfo, Metadata, IndexedSymbol, IndexStats } from '../types.js';
import * as path from 'path';
import * as fs from 'fs';

export class CacheManager {
  private storage: SqlJsStorage;
  private symbolCache: Map<string, IndexedSymbol[]> = new Map();
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
      await this.loadInMemoryCache();
      console.info(`[CacheManager] In-memory cache loaded: ${this.stats.totalFiles} files, ${this.stats.totalSymbols} symbols`);
    } catch (error) {
      console.error(`[CacheManager] Error initializing cache storage: ${error}`);
      throw error;
    }
  }

  private async loadInMemoryCache(): Promise<void> {
    try {
      const allSymbols = await this.storage.getAllSymbols();
      this.symbolCache.clear();

      console.info(`[CacheManager] Loading ${allSymbols.length} symbols into memory cache...`);

      for (const sym of allSymbols) {
        const existing = this.symbolCache.get(sym.name) || [];
        existing.push({
          name: sym.name,
          kind: sym.kind,
          location: {
            uri: sym.uri,
            line: sym.line,
            character: sym.character
          },
          containerName: sym.containerName || undefined
        });
        this.symbolCache.set(sym.name, existing);
      }

      const allFiles = await this.storage.getAllFiles();
      this.stats.totalFiles = allFiles.length;
      this.stats.totalSymbols = allSymbols.length;
      
      console.info(`[CacheManager] In-memory cache loaded: ${this.stats.totalFiles} files, ${this.stats.totalSymbols} symbols`);
    } catch (error) {
      console.error(`[CacheManager] Error loading in-memory cache: ${error}`);
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
      await this.storage.deleteSymbolsByUri(result.uri);

      await this.storage.upsertFile(result.uri, result.hash, now);

      if (result.symbols.length > 0) {
        const dbSymbols = result.symbols.map(s => ({
          name: s.name,
          kind: s.kind,
          uri: result.uri,
          line: s.location.line,
          character: s.location.character,
          containerName: s.containerName
        }));

        await this.storage.insertSymbols(dbSymbols);
      }

      for (const sym of result.symbols) {
        const existing = this.symbolCache.get(sym.name) || [];
        const filtered = existing.filter(e => e.location.uri !== result.uri);
        filtered.push(sym);
        this.symbolCache.set(sym.name, filtered);
      }

      const prevTotalFiles = this.stats.totalFiles;
      const prevTotalSymbols = this.stats.totalSymbols;

      const allFiles = await this.storage.getAllFiles();
      const allSymbols = await this.storage.getAllSymbols();
      this.stats.totalFiles = allFiles.length;
      this.stats.totalSymbols = allSymbols.length;
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
      
      await this.storage.deleteFile(uri);

      for (const sym of symbols) {
        const existing = this.symbolCache.get(sym.name);
        if (existing) {
          const filtered = existing.filter(e => e.location.uri !== uri);
          if (filtered.length > 0) {
            this.symbolCache.set(sym.name, filtered);
          } else {
            this.symbolCache.delete(sym.name);
          }
        }
      }

      const allFiles = await this.storage.getAllFiles();
      const allSymbols = await this.storage.getAllSymbols();
      this.stats.totalFiles = allFiles.length;
      this.stats.totalSymbols = allSymbols.length;
      this.stats.lastUpdateTime = Date.now();
    } catch (error) {
      console.error(`[CacheManager] Error removing file ${uri}: ${error}`);
      throw error;
    }
  }

  async findSymbolsByName(name: string): Promise<IndexedSymbol[]> {
    const cached = this.symbolCache.get(name);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }

    this.stats.cacheMisses++;
    return [];
  }

  async findSymbolsByPrefix(prefix: string, limit: number): Promise<IndexedSymbol[]> {
    const results: IndexedSymbol[] = [];
    const seen = new Set<string>();

    for (const [name, symbols] of this.symbolCache.entries()) {
      if (name.startsWith(prefix) && !seen.has(name)) {
        results.push(...symbols);
        seen.add(name);
        if (results.length >= limit) { break; }
      }
    }

    return results.slice(0, limit);
  }

  getAllFiles(): FileInfo[] {
    // This is synchronous for compatibility, but internally we need async
    // We'll keep the cached count accurate via loadInMemoryCache
    return [];
  }

  async getAllFilesAsync(): Promise<FileInfo[]> {
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
      this.symbolCache.clear();
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
      if (!this.cacheDirectory || !fs.existsSync(this.cacheDirectory)) {
        return;
      }

      const totalSize = await this.getDirectorySize(this.cacheDirectory);
      const sizeMB = totalSize / (1024 * 1024);
      const limitMB = this.maxCacheSizeBytes / (1024 * 1024);

      if (totalSize > this.maxCacheSizeBytes) {
        console.warn(
          `[CacheManager] Cache size (${sizeMB.toFixed(2)}MB) exceeds limit (${limitMB.toFixed(2)}MB). Consider increasing smartIndexer.maxCacheSizeMB or clearing old data.`
        );
      }
    } catch (error) {
      console.error(`[CacheManager] Error checking cache size: ${error}`);
    }
  }

  private async getDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0;

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          totalSize += await this.getDirectorySize(fullPath);
        } else if (entry.isFile()) {
          const stats = fs.statSync(fullPath);
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
