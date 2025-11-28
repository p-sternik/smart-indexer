import * as vscode from 'vscode';

/**
 * Progress payload sent from the server via LSP notification.
 */
export interface IndexProgress {
  state: 'busy' | 'idle' | 'error' | 'finalizing';
  processed: number;
  total: number;
  currentFile?: string;
}

/**
 * Status bar indicator for Smart Indexer.
 * Shows indexing progress, errors, and provides quick access to commands.
 */
export class SmartIndexerStatusBar {
  private statusBarItem: vscode.StatusBarItem;
  private state: 'idle' | 'busy' | 'error' = 'idle';
  private logChannel: vscode.LogOutputChannel;

  constructor(logChannel: vscode.LogOutputChannel) {
    this.logChannel = logChannel;
    
    // Create status bar item on the right side with priority 100
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    
    // Click opens quick menu
    this.statusBarItem.command = 'smart-indexer.showQuickMenu';
    
    // Set initial state
    this.setIdle();
    this.statusBarItem.show();
  }

  /**
   * Update the status bar based on progress notification from server.
   */
  updateProgress(progress: IndexProgress): void {
    switch (progress.state) {
      case 'busy':
        this.setBusy(progress.total - progress.processed, progress.currentFile);
        break;
      case 'finalizing':
        this.setFinalizing();
        break;
      case 'idle':
        this.setIdle();
        break;
      case 'error':
        this.setError();
        break;
    }
  }

  /**
   * Set status bar to idle (ready) state.
   */
  setIdle(): void {
    this.state = 'idle';
    this.statusBarItem.text = '$(check) Smart Indexer';
    this.statusBarItem.tooltip = 'Smart Indexer: Ready\nClick for options';
    this.statusBarItem.backgroundColor = undefined;
  }

  /**
   * Set status bar to busy (indexing) state.
   */
  setBusy(remaining: number, currentFile?: string): void {
    this.state = 'busy';
    this.statusBarItem.text = `$(sync~spin) Indexing... (${remaining} remaining)`;
    
    let tooltip = 'Smart Indexer: Processing background queue';
    if (currentFile) {
      // Show just the filename, not the full path
      const fileName = currentFile.split(/[\\/]/).pop() || currentFile;
      tooltip += `\nCurrently: ${fileName}`;
    }
    tooltip += '\nClick for options';
    
    this.statusBarItem.tooltip = tooltip;
    this.statusBarItem.backgroundColor = undefined;
  }

  /**
   * Set status bar to finalizing (linking references) state.
   */
  setFinalizing(): void {
    this.state = 'busy';
    this.statusBarItem.text = '$(sync~spin) Finalizing index...';
    this.statusBarItem.tooltip = 'Smart Indexer: Linking references...\nClick for options';
    this.statusBarItem.backgroundColor = undefined;
  }

  /**
   * Set status bar to error state.
   */
  setError(message?: string): void {
    this.state = 'error';
    this.statusBarItem.text = '$(alert) Indexer Error';
    this.statusBarItem.tooltip = message 
      ? `Smart Indexer Error: ${message}\nClick to see logs`
      : 'Smart Indexer: Error occurred\nClick to see logs';
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  /**
   * Get the current state.
   */
  getState(): 'idle' | 'busy' | 'error' {
    return this.state;
  }

  /**
   * Dispose of the status bar item.
   */
  dispose(): void {
    this.statusBarItem.dispose();
  }
}
