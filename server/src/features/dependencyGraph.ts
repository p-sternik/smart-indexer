import { ISymbolIndex } from '../index/ISymbolIndex.js';
import { IndexedSymbol, IndexedReference } from '../types.js';

export interface DependencyNode {
  filePath: string;
  symbols: string[];
  children?: DependencyNode[];
}

export interface DependencyInfo {
  filePath: string;
  incoming: string[]; // Files that depend on this file (used by)
  outgoing: string[]; // Files this file depends on (uses)
}

export type DependencyDirection = 'incoming' | 'outgoing';

/**
 * DependencyGraphService - Centralized logic for dependency analysis
 * Serves both interactive exploration (Tree View) and documentation (Mermaid export)
 */
export class DependencyGraphService {
  constructor(private index: ISymbolIndex) {}

  /**
   * Get dependencies for a file in the specified direction
   * @param filePath - The file to analyze
   * @param direction - 'incoming' (used by) or 'outgoing' (uses)
   * @returns Array of file paths that have the dependency relationship
   */
  async getDependencies(filePath: string, direction: DependencyDirection): Promise<string[]> {
    if (direction === 'incoming') {
      return this.getIncomingDependencies(filePath);
    } else {
      return this.getOutgoingDependencies(filePath);
    }
  }

  /**
   * Get files that depend on the given file (used by)
   */
  private async getIncomingDependencies(filePath: string): Promise<string[]> {
    const symbols = await this.index.getFileSymbols(filePath);
    const dependentFiles = new Set<string>();

    // For each symbol in the file, find where it's referenced
    for (const symbol of symbols) {
      if (this.index.findReferencesByName) {
        const references = await this.index.findReferencesByName(symbol.name);
        
        for (const ref of references) {
          // Don't include references from the same file
          if (ref.location.uri !== filePath) {
            dependentFiles.add(ref.location.uri);
          }
        }
      }
    }

    return Array.from(dependentFiles).sort();
  }

  /**
   * Get files that the given file depends on (uses)
   */
  private async getOutgoingDependencies(filePath: string): Promise<string[]> {
    const dependencyFiles = new Set<string>();

    // Get all imports from this file to find direct dependencies
    if (this.index.getFileImports) {
      const imports = await this.index.getFileImports(filePath);
      
      // For each import, we'd need to resolve the module path to a file path
      // This is a simplified version - in production you'd use the import resolver
      for (const imp of imports) {
        // This would need proper import resolution in production
        // For now, we'll use a simplified approach
      }
    }

    // Alternative: Get symbols referenced in this file and find their definitions
    // This requires getting the file's references, which we need to add to the index
    const allFileSymbols = await this.index.getFileSymbols(filePath);
    
    // For each unique symbol name used in the file, find where it's defined
    const symbolNames = new Set(allFileSymbols.map(s => s.name));
    
    for (const name of symbolNames) {
      const definitions = await this.index.findDefinitions(name);
      
      for (const def of definitions) {
        // Add files that define symbols used in this file
        if (def.location.uri !== filePath) {
          dependencyFiles.add(def.location.uri);
        }
      }
    }

    return Array.from(dependencyFiles).sort();
  }

  /**
   * Build a dependency tree with specified depth
   */
  async buildDependencyTree(
    rootPath: string,
    direction: DependencyDirection,
    maxDepth: number = 3,
    currentDepth: number = 0,
    visited: Set<string> = new Set()
  ): Promise<DependencyNode> {
    // Prevent circular dependencies
    if (visited.has(rootPath) || currentDepth >= maxDepth) {
      return {
        filePath: rootPath,
        symbols: []
      };
    }

    visited.add(rootPath);

    const symbols = await this.index.getFileSymbols(rootPath);
    const symbolNames = symbols.map(s => s.name);
    const dependencies = await this.getDependencies(rootPath, direction);

    const children: DependencyNode[] = [];
    
    if (currentDepth < maxDepth - 1) {
      for (const depPath of dependencies) {
        const childNode = await this.buildDependencyTree(
          depPath,
          direction,
          maxDepth,
          currentDepth + 1,
          new Set(visited) // Create new set to allow sibling branches
        );
        children.push(childNode);
      }
    }

    return {
      filePath: rootPath,
      symbols: symbolNames,
      children: children.length > 0 ? children : undefined
    };
  }

  /**
   * Generate Mermaid diagram string for the dependency graph
   */
  async generateMermaidString(
    rootPath: string,
    direction: DependencyDirection,
    maxDepth: number = 3
  ): Promise<string> {
    const tree = await this.buildDependencyTree(rootPath, direction, maxDepth);
    const lines: string[] = [];
    
    // Add Mermaid header
    const directionLabel = direction === 'incoming' ? 'Used By' : 'Uses';
    lines.push('```mermaid');
    lines.push('graph TD');
    lines.push(`  Root["${this.getFileLabel(rootPath)}"]`);
    lines.push('');

    // Build the graph
    const nodeIds = new Map<string, string>();
    nodeIds.set(rootPath, 'Root');
    
    let nodeCounter = 1;
    const getNodeId = (path: string): string => {
      if (!nodeIds.has(path)) {
        nodeIds.set(path, `N${nodeCounter++}`);
      }
      return nodeIds.get(path)!;
    };

    const addEdges = (node: DependencyNode, parentId: string) => {
      if (!node.children) return;

      for (const child of node.children) {
        const childId = getNodeId(child.filePath);
        const childLabel = this.getFileLabel(child.filePath);
        
        lines.push(`  ${childId}["${childLabel}"]`);
        
        // Arrow direction depends on dependency type
        if (direction === 'incoming') {
          lines.push(`  ${childId} --> ${parentId}`);
        } else {
          lines.push(`  ${parentId} --> ${childId}`);
        }
        
        addEdges(child, childId);
      }
    };

    addEdges(tree, 'Root');
    
    lines.push('```');
    lines.push('');
    lines.push(`**Impact Analysis (${directionLabel})**`);
    lines.push(`Root: ${rootPath}`);
    lines.push(`Max Depth: ${maxDepth}`);
    
    return lines.join('\n');
  }

  /**
   * Get a friendly label for a file path (show just filename)
   */
  private getFileLabel(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1];
  }
}
