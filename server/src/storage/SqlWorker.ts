import { parentPort } from 'worker_threads';
import { SqlJsStorage } from './SqlJsStorage';
import { NativeSqliteStorage } from './NativeSqliteStorage';
import { IIndexStorage } from './IIndexStorage';
import * as path from 'path';
import { encode } from '@msgpack/msgpack';

if (!parentPort) {
  throw new Error('This script must be run as a worker thread');
}

let storage: IIndexStorage | null = null;

parentPort.on('message', async (message) => {
  const { id, type, payload } = message;

  try {
    if (type === 'init') {
      const { workspaceRoot, cacheDirectory, autoSaveDelay } = payload;
      const dbPath = path.join(workspaceRoot, cacheDirectory, 'index.db');
      
      try {
        console.info('[SqlWorker] Attempting to initialize NativeSqliteStorage...');
        const nativeStorage = new NativeSqliteStorage(dbPath);
        await nativeStorage.init(workspaceRoot, cacheDirectory);
        storage = nativeStorage;
        console.info('[SqlWorker] NativeSqliteStorage initialized successfully.');
      } catch (error: any) {
        console.warn(`[SqlWorker] NativeSqliteStorage failed: ${error.message}. Falling back to SqlJsStorage.`);
        storage = new SqlJsStorage(autoSaveDelay);
        await storage.init(workspaceRoot, cacheDirectory);
      }
      
      parentPort!.postMessage({ id, success: true });
      return;
    }

    if (!storage) {
      throw new Error('Storage not initialized in worker');
    }

    let result: any;
    let useTransfer = false;

    switch (type) {
      case 'storeFile':
        result = await storage.storeFile(payload);
        break;
      case 'getFile':
        result = await storage.getFile(payload);
        break;
      case 'batchGetFiles':
        result = await storage.batchGetFiles(payload);
        break;
      case 'deleteFile':
        result = await storage.deleteFile(payload);
        break;
      case 'hasFile':
        result = await storage.hasFile(payload);
        break;
      case 'getMetadata':
        result = await storage.getMetadata(payload);
        break;
      case 'getAllMetadata':
        result = await storage.getAllMetadata();
        useTransfer = true;
        break;
      case 'updateMetadata':
        result = await storage.updateMetadata(payload);
        break;
      case 'removeMetadata':
        result = await storage.removeMetadata(payload);
        break;
      case 'getStats':
        result = await storage.getStats();
        break;
      case 'clear':
        result = await storage.clear();
        break;
      case 'flush':
        result = await storage.flush();
        break;
      case 'searchSymbols':
        result = await storage.searchSymbols(payload.query, payload.mode, payload.limit);
        useTransfer = true;
        break;
      case 'findDefinitionsInSql':
        result = await storage.findDefinitionsInSql(payload);
        break;
      case 'findReferencesInSql':
        result = await storage.findReferencesInSql(payload);
        useTransfer = true;
        break;
      case 'findNgRxActionGroups':
        result = await storage.findNgRxActionGroups();
        break;
      case 'findFilesWithPendingRefs':
        result = await storage.findFilesWithPendingRefs();
        break;
      case 'getStoragePath':
        result = storage.getStoragePath();
        break;
      case 'collectAllFiles':
        result = await storage.collectAllFiles();
        break;
      case 'saveMetadataSummary':
        result = await storage.saveMetadataSummary();
        break;
      case 'getImpactedFiles':
        if (storage instanceof NativeSqliteStorage) {
          result = await storage.getImpactedFiles(payload.uri, payload.maxDepth);
        } else {
          result = [];
        }
        break;
      default:
        throw new Error(`Unknown message type in SqlWorker: ${type}`);
    }

    if (useTransfer && result) {
      const packed = encode(result);
      const IPC_THRESHOLD = 8192; // 8KB
      
      if (packed.byteLength > IPC_THRESHOLD) {
        const buffer = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength);
        parentPort!.postMessage({ id, success: true, result: buffer, isPacked: true }, [buffer as any]);
      } else {
        parentPort!.postMessage({ id, success: true, result });
      }
    } else {
      parentPort!.postMessage({ id, success: true, result });
    }
  } catch (error: any) {
    parentPort!.postMessage({ id, success: false, error: error.message });
  }
});
