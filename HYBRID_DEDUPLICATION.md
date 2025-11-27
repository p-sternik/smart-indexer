# Hybrid Deduplication Implementation

## Overview

This implementation solves the duplicate results problem in the dual-index architecture by introducing **Hybrid Providers** that intelligently merge and deduplicate results from both the Native TypeScript Server and Smart Indexer.

## Problem Statement

When using the extension in `hybrid` mode:
- **Native TS Server** provides accurate but slow results
- **Smart Indexer** provides fast but sometimes less precise results
- **VS Code** merges results from both providers, causing duplicates

Users would see the same definition/reference appear twice in the list, pointing to identical or near-identical locations.

## Solution Architecture

### Components

1. **HybridDefinitionProvider** (`src/providers/HybridDefinitionProvider.ts`)
   - Implements `vscode.DefinitionProvider`
   - Fetches results from both Native TS and Smart Indexer in parallel
   - Deduplicates using exact match and proximity heuristics

2. **HybridReferencesProvider** (`src/providers/HybridReferencesProvider.ts`)
   - Implements `vscode.ReferenceProvider`
   - Same parallel fetching and deduplication logic as definitions

3. **Extension Integration** (`src/extension.ts`)
   - Registers hybrid providers when `mode === 'hybrid'`
   - Removed old middleware-based approach
   - Providers are registered with VS Code's provider system

## How It Works

### Parallel Fetching
```typescript
const [nativeResult, smartResult] = await Promise.all([
  this.fetchNativeDefinitions(document, position, token),
  this.smartIndexerProvider(document, position, token)
]);
```

### Deduplication Strategy

1. **Exact Match Filtering**
   - Creates a unique key: `uri:line:character`
   - Removes exact duplicates

2. **Proximity Heuristic**
   - If two locations are in the same file within 2 lines of each other
   - Treats them as duplicates
   - Useful for handling slight indexing differences

3. **Preference Order**
   - Native TS results added first (preferred for accuracy)
   - Smart Indexer results added only if not duplicates

### Example Deduplication

**Before:**
```
[Native TS] file.ts:10:5
[Smart Indexer] file.ts:10:5  ← Exact duplicate
[Smart Indexer] file.ts:11:5  ← Near duplicate (within 2 lines)
[Smart Indexer] file.ts:50:10 ← Unique
```

**After:**
```
[Native TS] file.ts:10:5      ← Kept (preferred)
[Smart Indexer] file.ts:50:10 ← Kept (unique)
```

## Configuration

The feature works with existing configuration:

```json
{
  "smartIndexer.mode": "hybrid",           // Enable hybrid mode
  "smartIndexer.hybridTimeoutMs": 100      // Timeout for native TS (ms)
}
```

### Modes

- **`standalone`**: Uses only Smart Indexer (no deduplication needed)
- **`hybrid`**: Uses both providers with deduplication (default)

## Performance

### Timing
- Both providers are called **in parallel** (no sequential delay)
- Native TS has a configurable timeout (default: 100ms)
- Smart Indexer typically responds in <50ms

### Logging
All operations are logged to the "Smart Indexer" output channel:
```
[HybridDefinitionProvider] Request for file.ts:10:5
[HybridDefinitionProvider] Native: 2, Smart: 3
[HybridDefinitionProvider] Near-duplicate detected: ...
[HybridDefinitionProvider] Merged: 3 locations (45ms)
```

## Benefits

1. **No More Duplicates**: Users see a clean, deduplicated list
2. **Best of Both Worlds**: Combines Native TS accuracy with Smart Indexer speed
3. **Transparent**: Works automatically in hybrid mode
4. **Fast**: Parallel execution ensures minimal performance impact
5. **Smart Merging**: Proximity heuristic handles edge cases

## Testing

### Manual Test Cases

1. **Go to Definition** on a common symbol (e.g., `useState`)
   - Should see 1 result, not 2
   
2. **Find References** on a function call
   - Should see unique list without duplicates
   
3. **Switch to Standalone Mode**
   - Should only use Smart Indexer (no native calls)

4. **Performance Test**
   - Verify response time is fast (<100ms typical)
   - Check output channel for timing logs

### Verification Steps

1. Open a TypeScript/JavaScript project
2. Set `smartIndexer.mode: "hybrid"` in settings
3. Right-click on a symbol → "Go to Definition"
4. Verify no duplicate entries in the peek window
5. Check "Smart Indexer" output channel for deduplication logs

## Code Structure

```
src/
├── extension.ts                          # Main extension, registers providers
├── providers/
│   ├── HybridDefinitionProvider.ts      # Definition deduplication
│   └── HybridReferencesProvider.ts      # References deduplication
```

## Future Enhancements

1. **Configurable Proximity Threshold**
   - Allow users to adjust the 2-line threshold
   
2. **Quality Scoring**
   - Rank results by confidence/quality
   - Show highest-quality result first

3. **Provider Preferences**
   - Allow users to prefer Smart Indexer over Native TS
   
4. **Analytics**
   - Track deduplication rate
   - Report in statistics command

## Migration Notes

### Breaking Changes
- None (fully backward compatible)

### Removed Code
- Old middleware-based approach in `extension.ts`
- Fallback-only logic (now uses parallel fetch)

### New Dependencies
- None (uses existing VS Code API)

## Troubleshooting

### Issue: Still seeing duplicates
**Solution**: 
- Verify `smartIndexer.mode` is set to `"hybrid"`
- Check output channel for provider registration logs
- Ensure extension is reloaded after changing settings

### Issue: Definitions not found
**Solution**:
- Increase `smartIndexer.hybridTimeoutMs` (try 200-500ms)
- Check if native TS server is working (disable Smart Indexer)
- Rebuild Smart Indexer index

### Issue: Slow performance
**Solution**:
- Reduce `hybridTimeoutMs` to 50-100ms
- Switch to `standalone` mode for maximum speed
- Check for large files that slow native TS

## Summary

The Hybrid Deduplication system provides a seamless experience by:
- ✅ Eliminating duplicate results
- ✅ Combining accuracy and speed
- ✅ Working transparently in the background
- ✅ Requiring no user configuration

Users get the best IntelliSense experience with zero duplicates.
