import * as vscode from 'vscode';
import * as path from 'path';

export type DependencyDirection = 'incoming' | 'outgoing';

export interface DependencyTreeItem {
  filePath: string;
  label: string;
  children?: DependencyTreeItem[];
}

/**
 * TreeItem for the Dependency Tree View
 */
class DependencyNode extends vscode.TreeItem {
  constructor(
    public readonly filePath: string,
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly children?: DependencyNode[]
  ) {
    super(label, collapsibleState);
    
    this.tooltip = filePath;
    this.description = this.getRelativePath(filePath);
    this.iconPath = new vscode.ThemeIcon('file');
    
    // Make it clickable to open the file
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [vscode.Uri.file(filePath)]
    };
  }

  private getRelativePath(filePath: string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return filePath;
    }
    
    const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);
    const parts = relativePath.split(path.sep);
    
    // Show last 2 parts of the path
    if (parts.length > 2) {
      return path.join('...', parts.slice(-2).join(path.sep));
    }
    
    return relativePath;
  }
}

/**
 * DependencyTreeProvider - VSCode TreeDataProvider for dependency visualization
 */
export class DependencyTreeProvider implements vscode.TreeDataProvider<DependencyNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<DependencyNode | undefined | null | void> = 
    new vscode.EventEmitter<DependencyNode | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<DependencyNode | undefined | null | void> = 
    this._onDidChangeTreeData.event;

  private rootFilePath: string | undefined;
  private direction: DependencyDirection = 'outgoing';
  private treeData: Map<string, DependencyTreeItem> = new Map();
  private maxDepth: number = 3;

  constructor(
    private client: any, // LanguageClient
    private logChannel: vscode.LogOutputChannel
  ) {}

  /**
   * Set the root file and direction for the tree view
   */
  async setRoot(filePath: string, direction: DependencyDirection): Promise<void> {
    this.rootFilePath = filePath;
    this.direction = direction;
    
    this.logChannel.info(`[DependencyTreeProvider] Setting root: ${filePath}, direction: ${direction}`);
    
    // Fetch dependency data from the server
    await this.fetchDependencies();
    
    // Refresh the tree
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get the current root file path
   */
  getRootFilePath(): string | undefined {
    return this.rootFilePath;
  }

  /**
   * Get the current direction
   */
  getDirection(): DependencyDirection {
    return this.direction;
  }

  /**
   * Set the maximum depth for the tree
   */
  setMaxDepth(depth: number): void {
    this.maxDepth = depth;
  }

  /**
   * Fetch dependencies from the language server
   */
  private async fetchDependencies(): Promise<void> {
    if (!this.rootFilePath) {
      return;
    }

    try {
      const result = await this.client.sendRequest('smartIndexer/getDependencyTree', {
        filePath: this.rootFilePath,
        direction: this.direction,
        maxDepth: this.maxDepth
      });

      if (result) {
        this.treeData.clear();
        this.buildTreeData(result);
      }
    } catch (error) {
      this.logChannel.error(`[DependencyTreeProvider] Error fetching dependencies: ${error}`);
      vscode.window.showErrorMessage(`Failed to fetch dependencies: ${error}`);
    }
  }

  /**
   * Build the tree data structure from the server response
   */
  private buildTreeData(node: any, parentPath?: string): void {
    const item: DependencyTreeItem = {
      filePath: node.filePath,
      label: path.basename(node.filePath),
      children: node.children?.map((child: any) => {
        this.buildTreeData(child, node.filePath);
        return {
          filePath: child.filePath,
          label: path.basename(child.filePath)
        };
      })
    };

    this.treeData.set(node.filePath, item);
  }

  /**
   * Get tree item for a node
   */
  getTreeItem(element: DependencyNode): vscode.TreeItem {
    return element;
  }

  /**
   * Get children of a node
   */
  async getChildren(element?: DependencyNode): Promise<DependencyNode[]> {
    if (!this.rootFilePath) {
      return [];
    }

    // Root level - return the root file
    if (!element) {
      const rootItem = this.treeData.get(this.rootFilePath);
      if (!rootItem) {
        return [];
      }

      const hasChildren = rootItem.children && rootItem.children.length > 0;
      return [
        new DependencyNode(
          rootItem.filePath,
          rootItem.label,
          hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
        )
      ];
    }

    // Child level - return dependencies
    const item = this.treeData.get(element.filePath);
    if (!item || !item.children) {
      return [];
    }

    return item.children.map(child => {
      const childItem = this.treeData.get(child.filePath);
      const hasChildren = childItem?.children && childItem.children.length > 0;
      
      return new DependencyNode(
        child.filePath,
        child.label,
        hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
      );
    });
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    if (this.rootFilePath) {
      this.fetchDependencies().then(() => {
        this._onDidChangeTreeData.fire();
      });
    }
  }

  /**
   * Clear the tree view
   */
  clear(): void {
    this.rootFilePath = undefined;
    this.treeData.clear();
    this._onDidChangeTreeData.fire();
  }
}
