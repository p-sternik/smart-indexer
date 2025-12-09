import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

/**
 * Show the Smart Indexer quick menu with common actions.
 */
export async function showQuickMenu(
  client: LanguageClient,
  logChannel: vscode.LogOutputChannel
): Promise<void> {
  interface QuickMenuItem extends vscode.QuickPickItem {
    action: string;
  }

  const items: QuickMenuItem[] = [
    {
      label: '$(graph) Show Statistics',
      description: 'View index metrics and performance data',
      action: 'stats'
    },
    {
      label: '$(bug) Show Search Debug Info',
      description: 'View forensic traces of recent searches',
      action: 'debug'
    },
    {
      label: '$(refresh) Rebuild Index',
      description: 'Clear cache and re-index entire workspace',
      action: 'rebuild'
    },
    {
      label: '$(trash) Clear Cache',
      description: 'Delete all cached index data',
      action: 'clear'
    },
    {
      label: '$(search) Find Dead Code',
      description: 'Scan for unused exports (Beta)',
      action: 'deadCode'
    },
    {
      label: '$(list-tree) Inspect Index',
      description: 'Browse indexed folders and symbols',
      action: 'inspect'
    }
  ];

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Smart Indexer',
    placeHolder: 'Select an action...'
  });

  if (!selected) {
    return;
  }

  switch (selected.action) {
    case 'stats':
      await showStatistics(client, logChannel);
      break;
    case 'debug':
      await vscode.commands.executeCommand('smart-indexer.showDebugInfo');
      break;
    case 'rebuild':
      await vscode.commands.executeCommand('smart-indexer.rebuildIndex');
      break;
    case 'clear':
      await vscode.commands.executeCommand('smart-indexer.clearCache');
      break;
    case 'deadCode':
      await vscode.commands.executeCommand('smart-indexer.findDeadCode');
      break;
    case 'inspect':
      await vscode.commands.executeCommand('smart-indexer.inspectIndex');
      break;
  }
}

/**
 * Show detailed statistics in a modal dialog.
 */
async function showStatistics(
  client: LanguageClient,
  logChannel: vscode.LogOutputChannel
): Promise<void> {
  try {
    logChannel.info('[Client] Fetching statistics for quick menu...');
    const stats = await client.sendRequest('smart-indexer/getStats') as any;
    
    // Format cache size
    const cacheSizeMB = stats.cacheSizeBytes 
      ? (stats.cacheSizeBytes / (1024 * 1024)).toFixed(2) 
      : 'N/A';
    
    // Format last scan duration
    const lastScanDuration = stats.lastScanDurationMs 
      ? `${stats.lastScanDurationMs}ms` 
      : 'N/A';
    
    // Format worker pool status
    const workerStatus = stats.workerPoolActive 
      ? `Active (${stats.workerCount || 4} workers)` 
      : 'Idle';
    
    // Build the message
    const lines = [
      '📊 **Smart Indexer Statistics**',
      '',
      `**Cache Size:** ${cacheSizeMB} MB`,
      `**Total Indexed Files:** ${stats.totalFiles || 0}`,
      `**Total Symbols:** ${stats.totalSymbols || 0}`,
      `**Total Shards:** ${stats.totalShards || 0}`,
      '',
      '**Index Breakdown:**',
      `  • Dynamic: ${stats.dynamicFiles || 0} files, ${stats.dynamicSymbols || 0} symbols`,
      `  • Background: ${stats.backgroundFiles || 0} files, ${stats.backgroundSymbols || 0} symbols`,
      `  • Static: ${stats.staticFiles || 0} files, ${stats.staticSymbols || 0} symbols`,
      '',
      `**Last Scan Duration:** ${lastScanDuration}`,
      `**Worker Pool:** ${workerStatus}`,
      '',
      '**Cache Performance:**',
      `  • Hits: ${stats.cacheHits || 0}`,
      `  • Misses: ${stats.cacheMisses || 0}`
    ];
    
    // Add performance metrics if available
    if (stats.avgDefinitionTimeMs !== undefined) {
      lines.push('');
      lines.push('**Performance Metrics:**');
      lines.push(`  • Avg Definition: ${stats.avgDefinitionTimeMs.toFixed(2)}ms`);
      lines.push(`  • Avg References: ${stats.avgReferencesTimeMs?.toFixed(2) || 'N/A'}ms`);
      lines.push(`  • Avg File Index: ${stats.avgFileIndexTimeMs?.toFixed(2) || 'N/A'}ms`);
    }
    
    lines.push('');
    lines.push(`**Last Update:** ${new Date(stats.lastUpdateTime).toLocaleString()}`);
    
    const message = lines.join('\n');
    
    // Show in a modal dialog
    await vscode.window.showInformationMessage(
      message,
      { modal: true }
    );
    
  } catch (error) {
    logChannel.error(`[Client] Failed to get statistics: ${error}`);
    vscode.window.showErrorMessage(`Failed to get statistics: ${error}`);
  }
}
