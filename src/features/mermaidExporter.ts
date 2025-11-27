import * as vscode from 'vscode';
import { DependencyDirection } from '../providers/DependencyTreeProvider.js';

/**
 * MermaidExporter - Handles exporting dependency graphs to Mermaid format
 */
export class MermaidExporter {
  constructor(
    private client: any, // LanguageClient
    private logChannel: vscode.LogOutputChannel
  ) {}

  /**
   * Generate and copy Mermaid diagram to clipboard
   */
  async exportToMermaid(
    filePath: string,
    direction: DependencyDirection,
    maxDepth: number = 3
  ): Promise<void> {
    try {
      this.logChannel.info(
        `[MermaidExporter] Generating Mermaid for ${filePath}, direction: ${direction}, depth: ${maxDepth}`
      );

      const result = await this.client.sendRequest('smartIndexer/generateMermaid', {
        filePath: filePath,
        direction: direction,
        maxDepth: maxDepth
      });

      if (result && result.mermaidString) {
        await vscode.env.clipboard.writeText(result.mermaidString);
        
        const directionLabel = direction === 'incoming' ? 'Used By' : 'Uses';
        vscode.window.showInformationMessage(
          `Mermaid diagram (${directionLabel}) copied to clipboard!`
        );
        
        this.logChannel.info('[MermaidExporter] Mermaid diagram copied to clipboard');
      } else {
        vscode.window.showWarningMessage('No dependency data available to export');
      }
    } catch (error) {
      this.logChannel.error(`[MermaidExporter] Error generating Mermaid: ${error}`);
      vscode.window.showErrorMessage(`Failed to generate Mermaid diagram: ${error}`);
    }
  }

  /**
   * Show Mermaid diagram in a new document
   */
  async showMermaidPreview(
    filePath: string,
    direction: DependencyDirection,
    maxDepth: number = 3
  ): Promise<void> {
    try {
      const result = await this.client.sendRequest('smartIndexer/generateMermaid', {
        filePath: filePath,
        direction: direction,
        maxDepth: maxDepth
      });

      if (result && result.mermaidString) {
        const doc = await vscode.workspace.openTextDocument({
          content: result.mermaidString,
          language: 'markdown'
        });
        
        await vscode.window.showTextDocument(doc, {
          preview: true,
          viewColumn: vscode.ViewColumn.Beside
        });
        
        this.logChannel.info('[MermaidExporter] Mermaid diagram opened in preview');
      }
    } catch (error) {
      this.logChannel.error(`[MermaidExporter] Error showing Mermaid preview: ${error}`);
      vscode.window.showErrorMessage(`Failed to show Mermaid preview: ${error}`);
    }
  }
}
