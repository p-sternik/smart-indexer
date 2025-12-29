import { Worker } from 'worker_threads';
import * as path from 'path';
import { 
  IIndexStorage, 
  FileIndexData, 
  FileMetadata, 
  StorageStats 
} from './IIndexStorage.js';
import { IndexedSymbol, IndexedReference } from '../types.js';
import { decode } from '@msgpack/msgpack';

// Note: __dirname is available in CommonJS context.
// In the bundled output, esbuild handles this correctly.

/**
 * SqlWorkerProxy - Offloads SQLite storage operations to a worker thread.
 * 
 * This class implements IIndexStorage by forwarding all calls to a background
 * worker thread. This prevents heavy database I/O or large WASM exports from
 * blocking the main LSP thread, improving overall responsiveness.
 */
export class SqlWorkerProxy implements IIndexStorage {
  private worker: Worker | null = null;
  private messageIdCounter = 0;
  private pendingRequests = new Map<number, { resolve: (val: any) => void, reject: (err: any) => void }>();
  private cacheDirectory: string = '';
  private autoSaveDelay: number;

  constructor(autoSaveDelay: number = 2000) {
    this.autoSaveDelay = autoSaveDelay;
  }

  async init(workspaceRoot: string, cacheDirectory: string): Promise<void> {
    this.cacheDirectory = cacheDirectory;

    // Use absolute path to the worker script in the 'out' directory
    const workerPath = path.join(__dirname, 'SqlWorker.js');
    
    this.worker = new Worker(workerPath);
    
    this.worker.on('message', (message) => {
      const { id, success, result, error, isPacked } = message;
      const request = this.pendingRequests.get(id);
      
      if (request) {
        this.pendingRequests.delete(id);
        if (success) {
          let finalResult = result;
          if (isPacked && result instanceof ArrayBuffer) {
            finalResult = decode(new Uint8Array(result));
          }
          request.resolve(finalResult);
        } else {
          request.reject(new Error(error));
        }
      }
    });

    this.worker.on('error', (err) => {
      console.error('[SqlWorkerProxy] Worker error:', err);
      // Fail all pending requests
      for (const [id, request] of this.pendingRequests) {
        request.reject(err);
        this.pendingRequests.delete(id);
      }
    });

    // Initialize storage in worker
    await this.sendRequest('init', { 
      workspaceRoot, 
      cacheDirectory, 
      autoSaveDelay: this.autoSaveDelay 
    });
  }

  private sendRequest(type: string, payload?: any): Promise<any> {
    if (!this.worker) {
      return Promise.reject(new Error('Worker not initialized'));
    }

    const id = ++this.messageIdCounter;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.worker!.postMessage({ id, type, payload });
    });
  }

  async storeFile(data: FileIndexData): Promise<void> {
    return this.sendRequest('storeFile', data);
  }

  async getFile(uri: string): Promise<FileIndexData | null> {
    return this.sendRequest('getFile', uri);
  }

  async batchGetFiles(uris: string[]): Promise<FileIndexData[]> {
    return this.sendRequest('batchGetFiles', uris);
  }

  async getFileNoLock(uri: string): Promise<FileIndexData | null> {
    // Note: Mutex locking is now handled INSIDE the worker
    return this.sendRequest('getFile', uri);
  }

  async storeFileNoLock(data: FileIndexData): Promise<void> {
    return this.sendRequest('storeFile', data);
  }

  async setAutoSaveDelay(delay: number): Promise<void> {
    this.autoSaveDelay = delay;
    // For now, we only apply this during init, but we could add a worker message
    // if needed to update it dynamically.
  }

  async deleteFile(uri: string): Promise<void> {
    return this.sendRequest('deleteFile', uri);
  }

  async hasFile(uri: string): Promise<boolean> {
    return this.sendRequest('hasFile', uri);
  }

  async getMetadata(uri: string): Promise<FileMetadata | null> {
    return this.sendRequest('getMetadata', uri);
  }

  async getAllMetadata(): Promise<FileMetadata[]> {
    return this.sendRequest('getAllMetadata');
  }

  async updateMetadata(metadata: FileMetadata): Promise<void> {
    return this.sendRequest('updateMetadata', metadata);
  }

  async removeMetadata(uri: string): Promise<void> {
    return this.sendRequest('removeMetadata', uri);
  }

  async getStats(): Promise<StorageStats> {
    return this.sendRequest('getStats');
  }

  async clear(): Promise<void> {
    return this.sendRequest('clear');
  }

  async flush(): Promise<void> {
    return this.sendRequest('flush');
  }

  async dispose(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }

  async withLock<T>(_uri: string, task: () => Promise<T>): Promise<T> {
    // CRITICAL: We cannot easily pass a callback task to a worker.
    // However, the worker-side SqlJsStorage already uses p-limit for internal consistency.
    // For now, we'll just execute the task locally.
    return task();
  }

  getStoragePath(): string {
    return path.join(this.cacheDirectory, 'index.db');
  }

  async collectAllFiles(): Promise<string[]> {
    return this.sendRequest('collectAllFiles');
  }

  async saveMetadataSummary(): Promise<void> {
    return this.sendRequest('saveMetadataSummary');
  }

  async searchSymbols(query: string, mode?: 'exact' | 'fuzzy' | 'fulltext', limit?: number): Promise<Array<{
    uri: string;
    symbol: IndexedSymbol;
    rank?: number;
  }>> {
    return this.sendRequest('searchSymbols', { query, mode, limit });
  }

  async findDefinitionsInSql(name: string): Promise<IndexedSymbol[]> {
    return this.sendRequest('findDefinitionsInSql', name);
  }

  async findReferencesInSql(name: string): Promise<IndexedReference[]> {
    return this.sendRequest('findReferencesInSql', name);
  }

  async findNgRxActionGroups(): Promise<Array<{ uri: string; symbol: IndexedSymbol }>> {
    return this.sendRequest('findNgRxActionGroups');
  }

  async findFilesWithPendingRefs(): Promise<string[]> {
    return this.sendRequest('findFilesWithPendingRefs');
  }

  async getImpactedFiles(uri: string, maxDepth: number = 3): Promise<string[]> {
    return this.sendRequest('getImpactedFiles', { uri, maxDepth });
  }

  async findImplementations(symbolName: string): Promise<any[]> {
    return this.sendRequest('findImplementations', symbolName);
  }
}
