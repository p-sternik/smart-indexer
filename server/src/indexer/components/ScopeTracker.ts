/**
 * ScopeTracker - Tracks scope hierarchy during AST traversal.
 * Used to determine if a reference is local to a scope or cross-scope.
 */
export class ScopeTracker {
  private scopeStack: string[] = [];
  private localVariables: Map<string, Set<string>> = new Map();
  
  enterScope(scopeName: string): void {
    this.scopeStack.push(scopeName);
  }
  
  exitScope(): void {
    this.scopeStack.pop();
  }
  
  getCurrentScopeId(): string {
    return this.scopeStack.join('::') || '<global>';
  }
  
  addLocalVariable(varName: string): void {
    const scopeId = this.getCurrentScopeId();
    if (!this.localVariables.has(scopeId)) {
      this.localVariables.set(scopeId, new Set());
    }
    this.localVariables.get(scopeId)!.add(varName);
  }
  
  isLocalVariable(varName: string): boolean {
    const scopeId = this.getCurrentScopeId();
    return this.localVariables.get(scopeId)?.has(varName) || false;
  }
}
