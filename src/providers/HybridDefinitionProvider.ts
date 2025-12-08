import * as vscode from 'vscode';

/**
 * HybridDefinitionProvider acts as a complementary provider, returning ONLY
 * Smart Indexer results that are NOT already provided by the native TypeScript service.
 * This prevents duplicate entries since VS Code aggregates results from all providers.
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

      // Normalize results
      const nativeLocations = this.normalizeToArray(nativeResult);
      const smartLocations = this.normalizeToArray(smartResult);

      this.logChannel.info(
        `[HybridDefinitionProvider] Native: ${nativeLocations.length}, Smart: ${smartLocations.length}`
      );

      // Return ONLY Smart Index results that Native doesn't have
      const complementaryResults = this.filterComplementaryResults(nativeLocations, smartLocations);

      this.logChannel.info(
        `[HybridDefinitionProvider] Complementary: ${complementaryResults.length} locations (${Date.now() - start}ms)`
      );

      return complementaryResults.length > 0 ? complementaryResults : null;
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
      let timeoutId: NodeJS.Timeout | null = null;
      
      const result = await Promise.race([
        vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider',
          document.uri,
          position
        ),
        new Promise<null>((resolve) => {
          timeoutId = setTimeout(() => resolve(null), this.nativeTimeout);
        })
      ]);
      
      // Clear timeout if command completed before timeout
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }

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

  private filterComplementaryResults(
    nativeLocations: vscode.Location[],
    smartLocations: vscode.Location[]
  ): vscode.Location[] {
    const complementary: vscode.Location[] = [];

    // Filter Smart results: keep only those NOT already in Native results
    for (const smartLoc of smartLocations) {
      let isDuplicate = false;

      for (const nativeLoc of nativeLocations) {
        if (this.areLocationsSimilar(smartLoc, nativeLoc)) {
          isDuplicate = true;
          this.logChannel.debug(
            `[HybridDefinitionProvider] Filtered duplicate: ${this.getLocationKey(smartLoc)} matches native`
          );
          break;
        }
      }

      if (!isDuplicate) {
        complementary.push(smartLoc);
      }
    }

    return complementary;
  }

  private getLocationKey(location: vscode.Location): string {
    return `${location.uri.toString()}:${location.range.start.line}:${location.range.start.character}`;
  }

  private areLocationsSimilar(loc1: vscode.Location, loc2: vscode.Location): boolean {
    // Different files = not similar
    if (loc1.uri.toString() !== loc2.uri.toString()) {
      return false;
    }

    // Check for range overlap or within tolerance (2 lines)
    const range1 = loc1.range;
    const range2 = loc2.range;

    // Check if ranges overlap
    if (
      range1.start.line <= range2.end.line &&
      range1.end.line >= range2.start.line
    ) {
      return true;
    }

    // Check if within 2 line tolerance
    const lineDiff = Math.abs(range1.start.line - range2.start.line);
    return lineDiff <= 2;
  }
}
