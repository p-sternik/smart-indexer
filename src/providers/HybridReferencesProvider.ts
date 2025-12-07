import * as vscode from 'vscode';

/**
 * HybridReferencesProvider acts as a complementary provider, returning ONLY
 * Smart Indexer results that are NOT already provided by the native TypeScript service.
 * This prevents duplicate entries since VS Code aggregates results from all providers.
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

      // Return ONLY Smart Index results that Native doesn't have
      const complementaryResults = this.filterComplementaryResults(nativeLocations, smartLocations);

      this.logChannel.info(
        `[HybridReferencesProvider] Complementary: ${complementaryResults.length} locations (${Date.now() - start}ms)`
      );

      return complementaryResults.length > 0 ? complementaryResults : null;
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
            `[HybridReferencesProvider] Filtered duplicate: ${this.getLocationKey(smartLoc)} matches native`
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
