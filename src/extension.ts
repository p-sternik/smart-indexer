import * as path from 'path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
  Middleware
} from 'vscode-languageclient/node';

let client: LanguageClient;
let statusBarItem: vscode.StatusBarItem;
let logChannel: vscode.LogOutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  logChannel = vscode.window.createOutputChannel('Smart Indexer', { log: true });
  context.subscriptions.push(logChannel);
  
  logChannel.info('[Client] Extension activating...');
  
  // Also log workspace folders for diagnostics
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    logChannel.info(`[Client] Workspace folders: ${workspaceFolders.map(f => f.uri.fsPath).join(', ')}`);
  } else {
    logChannel.warn('[Client] No workspace folders found');
  }

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(database) Smart Indexer';
  statusBarItem.tooltip = 'Smart Indexer: Ready';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] }
    }
  };

  const config = vscode.workspace.getConfiguration('smartIndexer');
  const initializationOptions = {
    cacheDirectory: config.get('cacheDirectory', '.smart-index'),
    enableGitIntegration: config.get('enableGitIntegration', true),
    excludePatterns: config.get('excludePatterns', []),
    maxIndexedFileSize: config.get('maxIndexedFileSize', 1048576),
    maxFileSizeMB: config.get('maxFileSizeMB', 50),
    maxCacheSizeMB: config.get('maxCacheSizeMB', 500),
    maxConcurrentIndexJobs: config.get('maxConcurrentIndexJobs', 4),
    enableBackgroundIndex: config.get('enableBackgroundIndex', true)
  };

  logChannel.info('[Client] Initialization options:', initializationOptions);

  const middleware: Middleware = {
    provideDefinition: async (document, position, token, next) => {
      logChannel.info(`[Client] Definition request: ${document.uri.fsPath}:${position.line}:${position.character}`);
      const start = Date.now();
      try {
        const result = await next(document, position, token);
        const count = Array.isArray(result) ? result.length : (result ? 1 : 0);
        logChannel.info(`[Client] Definition response: ${count} locations, ${Date.now() - start} ms`);
        return result;
      } catch (error) {
        logChannel.error(`[Client] Definition error: ${error}, ${Date.now() - start} ms`);
        throw error;
      }
    },
    provideReferences: async (document, position, context, token, next) => {
      logChannel.info(`[Client] References request: ${document.uri.fsPath}:${position.line}:${position.character}`);
      const start = Date.now();
      try {
        const result = await next(document, position, context, token);
        const count = Array.isArray(result) ? result.length : 0;
        logChannel.info(`[Client] References response: ${count} locations, ${Date.now() - start} ms`);
        return result;
      } catch (error) {
        logChannel.error(`[Client] References error: ${error}, ${Date.now() - start} ms`);
        throw error;
      }
    }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'typescript' },
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'typescriptreact' },
      { scheme: 'file', language: 'javascriptreact' }
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}')
    },
    initializationOptions,
    outputChannel: logChannel,
    middleware
  };

  client = new LanguageClient(
    'smartIndexer',
    'Smart Indexer',
    serverOptions,
    clientOptions
  );

  try {
    logChannel.info('[Client] Starting language client...');
    await client.start();
    logChannel.info('[Client] Language client started successfully');
  } catch (error) {
    logChannel.error('[Client] Failed to start language client:', error);
    vscode.window.showErrorMessage(`Smart Indexer failed to start: ${error}`);
    throw error;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('smart-indexer.rebuildIndex', async () => {
      logChannel.info('[Client] ========== REBUILD INDEX COMMAND ==========');
      statusBarItem.text = '$(sync~spin) Rebuilding Index...';
      statusBarItem.tooltip = 'Smart Indexer: Rebuilding index';

      try {
        logChannel.info('[Client] Sending rebuildIndex request to server...');
        const stats = await client.sendRequest('smart-indexer/rebuildIndex');
        logChannel.info('[Client] Index rebuild complete, stats received:', stats);
        vscode.window.showInformationMessage(
          `Index rebuilt: ${(stats as any).totalFiles} files, ${(stats as any).totalSymbols} symbols`
        );
        statusBarItem.text = '$(database) Smart Indexer';
        statusBarItem.tooltip = 'Smart Indexer: Ready';
      } catch (error) {
        logChannel.error('[Client] Failed to rebuild index:', error);
        vscode.window.showErrorMessage(`Failed to rebuild index: ${error}`);
        statusBarItem.text = '$(database) Smart Indexer';
        statusBarItem.tooltip = 'Smart Indexer: Error';
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('smart-indexer.clearCache', async () => {
      logChannel.info('[Client] Clear cache command invoked');
      const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to clear the index cache?',
        'Yes',
        'No'
      );

      if (confirm === 'Yes') {
        try {
          await client.sendRequest('smart-indexer/clearCache');
          logChannel.info('[Client] Cache cleared successfully');
          vscode.window.showInformationMessage('Cache cleared successfully');
        } catch (error) {
          logChannel.error('[Client] Failed to clear cache:', error);
          vscode.window.showErrorMessage(`Failed to clear cache: ${error}`);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('smart-indexer.showStats', async () => {
      logChannel.info('[Client] ========== SHOW STATS COMMAND ==========');
      try {
        logChannel.info('[Client] Sending getStats request to server...');
        const stats = await client.sendRequest('smart-indexer/getStats');
        const s = stats as any;
        
        logChannel.info(`[Client] Stats received from server:`);
        logChannel.info(`  - Total Files: ${s.totalFiles}`);
        logChannel.info(`  - Total Symbols: ${s.totalSymbols}`);
        logChannel.info(`  - Total Shards: ${s.totalShards || 0}`);
        logChannel.info(`  - Dynamic Index: ${s.dynamicFiles || 0} files, ${s.dynamicSymbols || 0} symbols`);
        logChannel.info(`  - Background Index: ${s.backgroundFiles || 0} files, ${s.backgroundSymbols || 0} symbols`);
        logChannel.info(`  - Cache Hits: ${s.cacheHits}`);
        logChannel.info(`  - Cache Misses: ${s.cacheMisses}`);
        logChannel.info(`  - Last Update: ${new Date(s.lastUpdateTime).toISOString()}`);

        const message = `
**Smart Indexer Statistics**

**Total**: ${s.totalFiles} files, ${s.totalSymbols} symbols, ${s.totalShards || 0} shards

**Dynamic Index**: ${s.dynamicFiles || 0} files, ${s.dynamicSymbols || 0} symbols
**Background Index**: ${s.backgroundFiles || 0} files, ${s.backgroundSymbols || 0} symbols

**Cache Performance**:
- Hits: ${s.cacheHits}
- Misses: ${s.cacheMisses}

**Last Update**: ${new Date(s.lastUpdateTime).toLocaleString()}
        `.trim();

        vscode.window.showInformationMessage(message, { modal: false });
      } catch (error) {
        logChannel.error('[Client] Failed to get stats:', error);
        vscode.window.showErrorMessage(`Failed to get stats: ${error}`);
      }
    })
  );

  logChannel.info('[Client] Extension activation complete');
}

export async function deactivate(): Promise<void> {
  if (client) {
    try {
      logChannel.info('[Client] Deactivating extension, stopping language client...');
      await client.stop();
      logChannel.info('[Client] Language client stopped successfully');
    } catch (error) {
      logChannel.error('[Client] Error stopping language client:', error);
    }
  }
}
