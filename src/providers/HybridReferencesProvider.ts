import * as vscode from 'vscode';

/**
 * HybridReferencesProvider combines results from both the native TypeScript
 * service and Smart Indexer, deduplicating them to prevent duplicate entries.
 */
export class HybridReferencesProvider implements vscode.ReferenceProvider {
  private isDelegating = false;

  constructor(
    private smartIndexerProvider: (
      document: vscode.TextDocument,
      position: vscode.Position,
      context: vscode.ReferenceContext,
      token: vscode.CancellationToken
    ) => Promise<vscode.Location[] | null | undefined>,
    private nativeTimeout: number,
    private logChannel: vscode.LogOutputChannel
  ) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token: vscode.CancellationToken
  ): Promise<vscode.Location[] | null> {
    // Prevent infinite recursion
    if (this.isDelegating) {
      return null;
    }

    const start = Date.now();
    this.logChannel.info(
      `[HybridReferencesProvider] Request for ${document.uri.fsPath}:${position.line}:${position.character}`
    );

    try {
      // Fetch both results in parallel
      this.isDelegating = true;
      const [nativeResult, smartResult] = await Promise.all([
        this.fetchNativeReferences(document, position, token),
        this.smartIndexerProvider(document, position, context, token)
      ]);
      this.isDelegating = false;

      const nativeLocations = nativeResult || [];
      const smartLocations = smartResult || [];

      this.logChannel.info(
        `[HybridReferencesProvider] Native: ${nativeLocations.length}, Smart: ${smartLocations.length}`
      );

      // Merge and deduplicate
      const merged = this.mergeAndDeduplicate(nativeLocations, smartLocations);

      this.logChannel.info(
        `[HybridReferencesProvider] Merged: ${merged.length} locations (${Date.now() - start}ms)`
      );

      return merged.length > 0 ? merged : null;
    } catch (error) {
      this.isDelegating = false;
      this.logChannel.error(`[HybridReferencesProvider] Error: ${error}`);
      return null;
    }
  }

  private async fetchNativeReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Location[] | null> {
    try {
      const result = await Promise.race([
        vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          document.uri,
          position
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), this.nativeTimeout))
      ]);

      if (token.isCancellationRequested) {
        return null;
      }

      return result || null;
    } catch (error) {
      this.logChannel.warn(`[HybridReferencesProvider] Native fetch error: ${error}`);
      return null;
    }
  }

  private mergeAndDeduplicate(
    nativeLocations: vscode.Location[],
    smartLocations: vscode.Location[]
  ): vscode.Location[] {
    const locationMap = new Map<string, vscode.Location>();

    // Add native results first (prefer native for accuracy)
    for (const loc of nativeLocations) {
      const key = this.getLocationKey(loc);
      locationMap.set(key, loc);
    }

    // Add smart results, checking for duplicates or near-duplicates
    for (const loc of smartLocations) {
      const key = this.getLocationKey(loc);

      // If exact match exists, skip (prefer native)
      if (locationMap.has(key)) {
        continue;
      }

      // Check for near-duplicates (within 2 lines)
      let isDuplicate = false;
      for (const [existingKey, existingLoc] of locationMap.entries()) {
        if (this.areLocationsSimilar(loc, existingLoc)) {
          isDuplicate = true;
          this.logChannel.info(
            `[HybridReferencesProvider] Near-duplicate detected: ${key} ~ ${existingKey}`
          );
          break;
        }
      }

      if (!isDuplicate) {
        locationMap.set(key, loc);
      }
    }

    return Array.from(locationMap.values());
  }

  private getLocationKey(location: vscode.Location): string {
    return `${location.uri.toString()}:${location.range.start.line}:${location.range.start.character}`;
  }

  private areLocationsSimilar(loc1: vscode.Location, loc2: vscode.Location): boolean {
    // Different files = not similar
    if (loc1.uri.toString() !== loc2.uri.toString()) {
      return false;
    }

    // Same file, check if within 2 lines of each other
    const lineDiff = Math.abs(loc1.range.start.line - loc2.range.start.line);
    return lineDiff <= 2;
  }
}
