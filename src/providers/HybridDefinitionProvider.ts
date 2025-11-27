import * as vscode from 'vscode';

/**
 * HybridDefinitionProvider combines results from both the native TypeScript
 * service and Smart Indexer, deduplicating them to prevent duplicate entries.
 */
export class HybridDefinitionProvider implements vscode.DefinitionProvider {
  private isDelegating = false;

  constructor(
    private smartIndexerProvider: (
      document: vscode.TextDocument,
      position: vscode.Position,
      token: vscode.CancellationToken
    ) => Promise<vscode.Definition | vscode.LocationLink[] | null | undefined>,
    private nativeTimeout: number,
    private logChannel: vscode.LogOutputChannel
  ) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition | vscode.LocationLink[] | null> {
    // Prevent infinite recursion
    if (this.isDelegating) {
      return null;
    }

    const start = Date.now();
    this.logChannel.info(
      `[HybridDefinitionProvider] Request for ${document.uri.fsPath}:${position.line}:${position.character}`
    );

    try {
      // Fetch both results in parallel
      this.isDelegating = true;
      const [nativeResult, smartResult] = await Promise.all([
        this.fetchNativeDefinitions(document, position, token),
        this.smartIndexerProvider(document, position, token)
      ]);
      this.isDelegating = false;

      // Normalize and merge results
      const nativeLocations = this.normalizeToArray(nativeResult);
      const smartLocations = this.normalizeToArray(smartResult);

      this.logChannel.info(
        `[HybridDefinitionProvider] Native: ${nativeLocations.length}, Smart: ${smartLocations.length}`
      );

      // Merge and deduplicate
      const merged = this.mergeAndDeduplicate(nativeLocations, smartLocations);

      this.logChannel.info(
        `[HybridDefinitionProvider] Merged: ${merged.length} locations (${Date.now() - start}ms)`
      );

      return merged.length > 0 ? merged : null;
    } catch (error) {
      this.isDelegating = false;
      this.logChannel.error(`[HybridDefinitionProvider] Error: ${error}`);
      return null;
    }
  }

  private async fetchNativeDefinitions(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Location[] | null> {
    try {
      const result = await Promise.race([
        vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider',
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
      this.logChannel.warn(`[HybridDefinitionProvider] Native fetch error: ${error}`);
      return null;
    }
  }

  private normalizeToArray(
    result: vscode.Definition | vscode.LocationLink[] | null | undefined
  ): vscode.Location[] {
    if (!result) {
      return [];
    }

    if (Array.isArray(result)) {
      return result.map((item) => {
        if ('targetUri' in item) {
          const link = item as vscode.LocationLink;
          return new vscode.Location(link.targetUri, link.targetRange);
        }
        return item as vscode.Location;
      });
    }

    if ('uri' in result) {
      return [result as vscode.Location];
    }

    const link = result as vscode.LocationLink;
    if ('targetUri' in link) {
      return [new vscode.Location(link.targetUri, link.targetRange)];
    }

    return [];
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
            `[HybridDefinitionProvider] Near-duplicate detected: ${key} ~ ${existingKey}`
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
