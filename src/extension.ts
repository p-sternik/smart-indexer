import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';
import { SmartIndexerStatusBar, IndexProgress } from './ui/statusBar';
import { showQuickMenu } from './commands/showMenu';

let client: LanguageClient;
let smartStatusBar: SmartIndexerStatusBar;
let logChannel: vscode.LogOutputChannel;

/**
 * Ensure cache directory is in .gitignore to prevent accidental commits.
 */
async function ensureGitIgnoreEntry(workspaceRoot: string, cacheDir: string): Promise<void> {
  try {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    const gitignoreEntry = `${cacheDir}/`;
    
    let gitignoreContent = '';
    let needsUpdate = false;
    
    if (fs.existsSync(gitignorePath)) {
      gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
      
      // Check if entry already exists (with or without trailing slash)
      const lines = gitignoreContent.split('\n');
      const hasEntry = lines.some(line => {
        const trimmed = line.trim();
        return trimmed === cacheDir || trimmed === gitignoreEntry || trimmed === `/${cacheDir}/` || trimmed === `/${cacheDir}`;
      });
      
      if (!hasEntry) {
        needsUpdate = true;
      }
    } else {
      // .gitignore doesn't exist, create it
      needsUpdate = true;
    }
    
    if (needsUpdate) {
      const appendContent = gitignoreContent.endsWith('\n') || gitignoreContent === '' 
        ? `${gitignoreEntry}\n`
        : `\n${gitignoreEntry}\n`;
      
      fs.appendFileSync(gitignorePath, appendContent, 'utf-8');
      logChannel.info(`[Client] Added '${gitignoreEntry}' to .gitignore`);
    }
  } catch (error) {
    logChannel.warn(`[Client] Failed to update .gitignore: ${error}`);
  }
}

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

  // Initialize smart status bar
  smartStatusBar = new SmartIndexerStatusBar(logChannel);
  context.subscriptions.push(smartStatusBar);

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
  const mode = config.get<string>('mode', 'hybrid');
  const hybridTimeout = config.get<number>('hybridTimeoutMs', 200);
  const cacheDirectory = config.get<string>('cacheDirectory', '.smart-index');
  
  // Ensure cache directory is in .gitignore
  if (workspaceFolders && workspaceFolders.length > 0) {
    await ensureGitIgnoreEntry(workspaceFolders[0].uri.fsPath, cacheDirectory);
  }
  
  const initializationOptions = {
    cacheDirectory,
    enableGitIntegration: config.get('enableGitIntegration', true),
    excludePatterns: config.get('excludePatterns', []),
    maxIndexedFileSize: config.get('maxIndexedFileSize', 1048576),
    maxFileSizeMB: config.get('maxFileSizeMB', 50),
    maxCacheSizeMB: config.get('maxCacheSizeMB', 500),
    maxConcurrentIndexJobs: config.get('maxConcurrentIndexJobs', 4),
    enableBackgroundIndex: config.get('enableBackgroundIndex', true),
    textIndexingEnabled: config.get('textIndexing.enabled', false),
    staticIndexEnabled: config.get('staticIndex.enabled', false),
    staticIndexPath: config.get('staticIndex.path', ''),
    maxConcurrentWorkers: config.get('indexing.maxConcurrentWorkers', 4),
    batchSize: config.get('indexing.batchSize', 50),
    useFolderHashing: config.get('indexing.useFolderHashing', true)
  };

  logChannel.info('[Client] Initialization options:', initializationOptions);
  logChannel.info(`[Client] Mode: ${mode}, Hybrid timeout: ${hybridTimeout}ms`);

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
    
    // Middleware: Implement fallback strategy (Native TS first, Smart Indexer fallback)
    middleware: mode === 'hybrid' ? {
      provideDefinition: async (document, position, token, next) => {
        const start = Date.now();
        logChannel.info(`[Middleware] Definition request for ${document.uri.fsPath}:${position.line}:${position.character}`);
        
        try {
          // Race Native TS with configurable timeout
          const nativePromise = next(document, position, token);
          const timeoutPromise = new Promise<null>((resolve) => 
            setTimeout(() => resolve(null), hybridTimeout)
          );
          
          const nativeResult = await Promise.race([nativePromise, timeoutPromise]);
          
          // Check if cancellation was requested
          if (token.isCancellationRequested) {
            logChannel.info(`[Middleware] Definition request cancelled`);
            return null;
          }
          
          // If Native TS returned valid results, use them (Native wins)
          if (nativeResult && Array.isArray(nativeResult) && nativeResult.length > 0) {
            logChannel.info(`[Middleware] Native TS returned ${nativeResult.length} results in ${Date.now() - start}ms`);
            return nativeResult;
          }
          
          // Fallback to Smart Indexer
          logChannel.info(`[Middleware] Native TS returned nothing, falling back to Smart Indexer...`);
          const smartResult = await client.sendRequest(
            'textDocument/definition',
            {
              textDocument: { uri: document.uri.toString() },
              position: { line: position.line, character: position.character }
            },
            token
          );
          
          const duration = Date.now() - start;
          if (smartResult && Array.isArray(smartResult) && smartResult.length > 0) {
            logChannel.info(`[Middleware] Smart Indexer returned ${smartResult.length} results in ${duration}ms`);
          } else {
            logChannel.info(`[Middleware] Smart Indexer returned nothing in ${duration}ms`);
          }
          
          return smartResult as vscode.Definition | vscode.LocationLink[] | null;
        } catch (error) {
          logChannel.error(`[Middleware] Definition error: ${error}`);
          return null;
        }
      },
      
      provideReferences: async (document, position, context, token, next) => {
        const start = Date.now();
        logChannel.info(`[Middleware] References request for ${document.uri.fsPath}:${position.line}:${position.character}`);
        
        try {
          // Race Native TS with configurable timeout
          const nativePromise = next(document, position, context, token);
          const timeoutPromise = new Promise<null>((resolve) => 
            setTimeout(() => resolve(null), hybridTimeout)
          );
          
          const nativeResult = await Promise.race([nativePromise, timeoutPromise]);
          
          // Check if cancellation was requested
          if (token.isCancellationRequested) {
            logChannel.info(`[Middleware] References request cancelled`);
            return null;
          }
          
          // If Native TS returned valid results, use them (Native wins)
          if (nativeResult && Array.isArray(nativeResult) && nativeResult.length > 0) {
            logChannel.info(`[Middleware] Native TS returned ${nativeResult.length} references in ${Date.now() - start}ms`);
            return nativeResult;
          }
          
          // Fallback to Smart Indexer
          logChannel.info(`[Middleware] Native TS returned nothing, falling back to Smart Indexer...`);
          const smartResult = await client.sendRequest(
            'textDocument/references',
            {
              textDocument: { uri: document.uri.toString() },
              position: { line: position.line, character: position.character },
              context: { includeDeclaration: context.includeDeclaration }
            },
            token
          );
          
          const duration = Date.now() - start;
          if (smartResult && Array.isArray(smartResult) && smartResult.length > 0) {
            logChannel.info(`[Middleware] Smart Indexer returned ${smartResult.length} references in ${duration}ms`);
          } else {
            logChannel.info(`[Middleware] Smart Indexer returned nothing in ${duration}ms`);
          }
          
          return smartResult as vscode.Location[] | null;
        } catch (error) {
          logChannel.error(`[Middleware] References error: ${error}`);
          return null;
        }
      }
    } : undefined
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
    
    // Listen for progress notifications from server
    client.onNotification('smart-indexer/progress', (progress: IndexProgress) => {
      smartStatusBar.updateProgress(progress);
    });
    logChannel.info('[Client] Registered progress notification listener');
    
    if (mode === 'hybrid') {
      logChannel.info('[Client] Hybrid mode active - using middleware fallback strategy (Native TS → Smart Indexer)');
    } else {
      logChannel.info('[Client] Standalone mode active - Smart Indexer only');
    }
  } catch (error) {
    logChannel.error('[Client] Failed to start language client:', error);
    smartStatusBar.setError('Failed to start');
    vscode.window.showErrorMessage(`Smart Indexer failed to start: ${error}`);
    throw error;
  }

  // Command: Show quick menu
  context.subscriptions.push(
    vscode.commands.registerCommand('smart-indexer.showQuickMenu', async () => {
      await showQuickMenu(client, logChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('smart-indexer.rebuildIndex', async () => {
      logChannel.info('[Client] ========== REBUILD INDEX COMMAND ==========');
      smartStatusBar.setBusy(0, 'Rebuilding...');

      try {
        logChannel.info('[Client] Sending rebuildIndex request to server...');
        const stats = await client.sendRequest('smart-indexer/rebuildIndex');
        logChannel.info('[Client] Index rebuild complete, stats received:', stats);
        vscode.window.showInformationMessage(
          `Index rebuilt: ${(stats as any).totalFiles} files, ${(stats as any).totalSymbols} symbols`
        );
        smartStatusBar.setIdle();
      } catch (error) {
        logChannel.error('[Client] Failed to rebuild index:', error);
        vscode.window.showErrorMessage(`Failed to rebuild index: ${error}`);
        smartStatusBar.setError('Rebuild failed');
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
        logChannel.info(`  - Static Index: ${s.staticFiles || 0} files, ${s.staticSymbols || 0} symbols`);
        logChannel.info(`  - Cache Hits: ${s.cacheHits}`);
        logChannel.info(`  - Cache Misses: ${s.cacheMisses}`);
        logChannel.info(`  - Last Update: ${new Date(s.lastUpdateTime).toISOString()}`);

        const profilingInfo = s.avgDefinitionTimeMs ? `
**Performance Metrics**:
- Avg Definition Time: ${s.avgDefinitionTimeMs.toFixed(2)} ms
- Avg References Time: ${s.avgReferencesTimeMs.toFixed(2)} ms
- Avg File Index Time: ${s.avgFileIndexTimeMs.toFixed(2)} ms
` : '';

        const message = `
**Smart Indexer Statistics**

**Total**: ${s.totalFiles} files, ${s.totalSymbols} symbols, ${s.totalShards || 0} shards

**Dynamic Index**: ${s.dynamicFiles || 0} files, ${s.dynamicSymbols || 0} symbols
**Background Index**: ${s.backgroundFiles || 0} files, ${s.backgroundSymbols || 0} symbols
**Static Index**: ${s.staticFiles || 0} files, ${s.staticSymbols || 0} symbols

**Cache Performance**:
- Hits: ${s.cacheHits}
- Misses: ${s.cacheMisses}
${profilingInfo}
**Last Update**: ${new Date(s.lastUpdateTime).toLocaleString()}
        `.trim();

        vscode.window.showInformationMessage(message, { modal: false });
      } catch (error) {
        logChannel.error('[Client] Failed to get stats:', error);
        vscode.window.showErrorMessage(`Failed to get stats: ${error}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('smart-indexer.inspectIndex', async () => {
      logChannel.info('[Client] ========== INSPECT INDEX COMMAND ==========');
      try {
        logChannel.info('[Client] Sending inspectIndex request to server...');
        const data = await client.sendRequest('smart-indexer/inspectIndex') as any;
        
        logChannel.info(`[Client] Index data received: ${data.folderBreakdown?.length || 0} folders`);

        // Build quick pick items
        interface FolderItem extends vscode.QuickPickItem {
          folder: string;
          files: number;
          symbols: number;
          sizeBytes: number;
        }

        const items: FolderItem[] = (data.folderBreakdown || [])
          .sort((a: any, b: any) => b.symbols - a.symbols)
          .map((item: any) => ({
            label: `$(folder) ${path.basename(item.folder)}`,
            description: `${item.files} files, ${item.symbols} symbols`,
            detail: `${(item.sizeBytes / 1024).toFixed(1)} KB - ${item.folder}`,
            folder: item.folder,
            files: item.files,
            symbols: item.symbols,
            sizeBytes: item.sizeBytes
          }));

        const header: vscode.QuickPickItem = {
          label: `$(database) Smart Indexer - Total: ${data.totalFiles} files, ${data.totalSymbols} symbols`,
          kind: vscode.QuickPickItemKind.Separator
        };

        const indexBreakdown: vscode.QuickPickItem = {
          label: `Dynamic: ${data.dynamicFiles} files | Background: ${data.backgroundFiles} files | Static: ${data.staticFiles || 0} files`,
          kind: vscode.QuickPickItemKind.Separator
        };

        await vscode.window.showQuickPick([header, indexBreakdown, ...items], {
          title: 'Smart Indexer: Inspect Index',
          placeHolder: 'Browse indexed folders...'
        });

      } catch (error) {
        logChannel.error('[Client] Failed to inspect index:', error);
        vscode.window.showErrorMessage(`Failed to inspect index: ${error}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('smart-indexer.findDeadCode', async () => {
      logChannel.info('[Client] ========== FIND DEAD CODE COMMAND ==========');
      try {
        logChannel.info('[Client] Sending findDeadCode request to server...');
        
        const result = await client.sendRequest('smart-indexer/findDeadCode', {
          excludePatterns: ['node_modules', '.test.', '.spec.', 'test/', 'tests/'],
          includeTests: false
        }) as any;
        
        logChannel.info(
          `[Client] Dead code analysis complete: ${result.candidates?.length || 0} candidates, ` +
          `${result.analyzedFiles} files analyzed, ${result.totalExports} exports in ${result.duration}ms`
        );

        if (!result.candidates || result.candidates.length === 0) {
          vscode.window.showInformationMessage('No dead code found! All exports are being used.');
          return;
        }

        // Group by confidence
        const highConfidence = result.candidates.filter((c: any) => c.confidence === 'high');
        const mediumConfidence = result.candidates.filter((c: any) => c.confidence === 'medium');
        const lowConfidence = result.candidates.filter((c: any) => c.confidence === 'low');

        // Build quick pick items
        interface DeadCodeItem extends vscode.QuickPickItem {
          filePath: string;
          location: any;
        }

        const items: (DeadCodeItem | vscode.QuickPickItem)[] = [];

        if (highConfidence.length > 0) {
          items.push({
            label: `$(warning) High Confidence (${highConfidence.length})`,
            kind: vscode.QuickPickItemKind.Separator
          });
          
          for (const candidate of highConfidence) {
            items.push({
              label: `$(symbol-${candidate.kind}) ${candidate.name}`,
              description: candidate.kind,
              detail: `${candidate.filePath}:${candidate.location.line + 1} - ${candidate.reason}`,
              filePath: candidate.filePath,
              location: candidate.location
            });
          }
        }

        if (mediumConfidence.length > 0) {
          items.push({
            label: `$(info) Medium Confidence (${mediumConfidence.length})`,
            kind: vscode.QuickPickItemKind.Separator
          });
          
          for (const candidate of mediumConfidence) {
            items.push({
              label: `$(symbol-${candidate.kind}) ${candidate.name}`,
              description: candidate.kind,
              detail: `${candidate.filePath}:${candidate.location.line + 1} - ${candidate.reason}`,
              filePath: candidate.filePath,
              location: candidate.location
            });
          }
        }

        if (lowConfidence.length > 0) {
          items.push({
            label: `$(question) Low Confidence (${lowConfidence.length})`,
            kind: vscode.QuickPickItemKind.Separator
          });
          
          for (const candidate of lowConfidence.slice(0, 20)) { // Limit low confidence to 20
            items.push({
              label: `$(symbol-${candidate.kind}) ${candidate.name}`,
              description: candidate.kind,
              detail: `${candidate.filePath}:${candidate.location.line + 1} - ${candidate.reason}`,
              filePath: candidate.filePath,
              location: candidate.location
            });
          }
        }

        const selected = await vscode.window.showQuickPick(items, {
          title: `Dead Code Analysis - ${result.candidates.length} unused exports found`,
          placeHolder: 'Select a symbol to navigate to its definition...'
        });

        if (selected && 'filePath' in selected) {
          const uri = vscode.Uri.file(selected.filePath);
          const document = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(document);
          const position = new vscode.Position(selected.location.line, selected.location.character);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }

      } catch (error) {
        logChannel.error('[Client] Failed to find dead code:', error);
        vscode.window.showErrorMessage(`Failed to find dead code: ${error}`);
      }
    })
  );

  // Command: Find Dead Code in Folder (context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand('smart-indexer.findDeadCodeInFolder', async (folderUri: vscode.Uri) => {
      if (!folderUri) {
        vscode.window.showErrorMessage('No folder selected');
        return;
      }

      const folderName = path.basename(folderUri.fsPath);
      logChannel.info(`[Client] ========== FIND DEAD CODE IN FOLDER: ${folderUri.fsPath} ==========`);
      
      try {
        logChannel.info('[Client] Sending findDeadCode request to server with scope...');
        
        const result = await client.sendRequest('smart-indexer/findDeadCode', {
          excludePatterns: ['node_modules', '.test.', '.spec.', 'test/', 'tests/'],
          includeTests: false,
          scopeUri: folderUri.toString()
        }) as any;
        
        logChannel.info(
          `[Client] Dead code analysis complete in ${folderName}: ${result.candidates?.length || 0} candidates, ` +
          `${result.analyzedFiles} files analyzed, ${result.totalExports} exports in ${result.duration}ms`
        );

        if (!result.candidates || result.candidates.length === 0) {
          vscode.window.showInformationMessage(`No dead code found in '${folderName}'! All exports are being used.`);
          return;
        }

        // Group by confidence
        const highConfidence = result.candidates.filter((c: any) => c.confidence === 'high');
        const mediumConfidence = result.candidates.filter((c: any) => c.confidence === 'medium');
        const lowConfidence = result.candidates.filter((c: any) => c.confidence === 'low');

        // Build quick pick items
        interface DeadCodeItem extends vscode.QuickPickItem {
          filePath: string;
          location: any;
        }

        const items: (DeadCodeItem | vscode.QuickPickItem)[] = [];

        if (highConfidence.length > 0) {
          items.push({
            label: `$(warning) High Confidence (${highConfidence.length})`,
            kind: vscode.QuickPickItemKind.Separator
          });
          
          for (const candidate of highConfidence) {
            items.push({
              label: `$(symbol-${candidate.kind}) ${candidate.name}`,
              description: candidate.kind,
              detail: `${candidate.filePath}:${candidate.location.line + 1} - ${candidate.reason}`,
              filePath: candidate.filePath,
              location: candidate.location
            });
          }
        }

        if (mediumConfidence.length > 0) {
          items.push({
            label: `$(info) Medium Confidence (${mediumConfidence.length})`,
            kind: vscode.QuickPickItemKind.Separator
          });
          
          for (const candidate of mediumConfidence) {
            items.push({
              label: `$(symbol-${candidate.kind}) ${candidate.name}`,
              description: candidate.kind,
              detail: `${candidate.filePath}:${candidate.location.line + 1} - ${candidate.reason}`,
              filePath: candidate.filePath,
              location: candidate.location
            });
          }
        }

        if (lowConfidence.length > 0) {
          items.push({
            label: `$(question) Low Confidence (${lowConfidence.length})`,
            kind: vscode.QuickPickItemKind.Separator
          });
          
          for (const candidate of lowConfidence.slice(0, 20)) { // Limit low confidence to 20
            items.push({
              label: `$(symbol-${candidate.kind}) ${candidate.name}`,
              description: candidate.kind,
              detail: `${candidate.filePath}:${candidate.location.line + 1} - ${candidate.reason}`,
              filePath: candidate.filePath,
              location: candidate.location
            });
          }
        }

        const selected = await vscode.window.showQuickPick(items, {
          title: `Dead Code in '${folderName}' - ${result.candidates.length} unused exports found`,
          placeHolder: 'Select a symbol to navigate to its definition...'
        });

        if (selected && 'filePath' in selected) {
          const uri = vscode.Uri.file(selected.filePath);
          const document = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(document);
          const position = new vscode.Position(selected.location.line, selected.location.character);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }

      } catch (error) {
        logChannel.error('[Client] Failed to find dead code in folder:', error);
        vscode.window.showErrorMessage(`Failed to find dead code in folder: ${error}`);
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
