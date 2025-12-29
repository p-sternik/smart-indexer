import { parentPort } from 'worker_threads';
import { SqlJsStorage } from './SqlJsStorage.js';

if (!parentPort) {
  throw new Error('This script must be run as a worker thread');
}

let storage: SqlJsStorage | null = null;

parentPort.on('message', async (message) => {
  const { id, type, payload } = message;

  try {
    if (type === 'init') {
      const { workspaceRoot, cacheDirectory, autoSaveDelay } = payload;
      storage = new SqlJsStorage(autoSaveDelay);
      await storage.init(workspaceRoot, cacheDirectory);
      parentPort!.postMessage({ id, success: true });
      return;
    }

    if (!storage) {
      throw new Error('Storage not initialized in worker');
    }

    let result: any;

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
        break;
      case 'findDefinitionsInSql':
        result = await storage.findDefinitionsInSql(payload);
        break;
      case 'findReferencesInSql':
        result = await storage.findReferencesInSql(payload);
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
      default:
        throw new Error(`Unknown message type in SqlWorker: ${type}`);
    }

    parentPort!.postMessage({ id, success: true, result });
  } catch (error: any) {
    parentPort!.postMessage({ id, success: false, error: error.message });
  }
});
