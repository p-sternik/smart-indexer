# Hybrid Deduplication - Quick Reference

## What Was Implemented

**Deduplication middleware** that prevents duplicate "Go to Definition" and "Find References" results when using both Native TS Server and Smart Indexer.

## Key Files

- `src/providers/HybridDefinitionProvider.ts` - Definition deduplication
- `src/providers/HybridReferencesProvider.ts` - References deduplication  
- `src/extension.ts` - Provider registration (hybrid mode only)

## How It Works

1. **Parallel Fetch**: Calls both Native TS and Smart Indexer simultaneously
2. **Merge Results**: Combines both result sets
3. **Deduplicate**: 
   - Removes exact matches (same file:line:character)
   - Removes near-duplicates (within 2 lines in same file)
4. **Prefer Native**: When duplicates exist, keeps Native TS result

## Configuration

```json
{
  "smartIndexer.mode": "hybrid",        // Required
  "smartIndexer.hybridTimeoutMs": 100   // Optional (default: 100ms)
}
```

## User Experience

### Before
```
Go to Definition:
  ✗ useState (node_modules/react/index.d.ts:10:5)  [Native TS]
  ✗ useState (node_modules/react/index.d.ts:10:5)  [Smart Indexer] ← Duplicate!
```

### After
```
Go to Definition:
  ✓ useState (node_modules/react/index.d.ts:10:5)  [Merged & Deduplicated]
```

## Testing

1. Set mode to `"hybrid"`
2. Go to Definition on any symbol
3. Verify no duplicates
4. Check output channel for deduplication logs:
   ```
   [HybridDefinitionProvider] Native: 1, Smart: 1
   [HybridDefinitionProvider] Merged: 1 locations (45ms)
   ```

## Performance

- **Parallel execution**: No sequential delay
- **Typical response**: <100ms
- **Native timeout**: 100ms (configurable)

## Modes

| Mode | Behavior |
|------|----------|
| `standalone` | Smart Indexer only (no deduplication) |
| `hybrid` | Both providers + deduplication (default) |

## Key Benefits

✅ No duplicate results  
✅ Combines accuracy (Native) + speed (Smart Indexer)  
✅ Transparent to users  
✅ Fast parallel execution  
✅ Smart proximity detection

## Troubleshooting

**Still seeing duplicates?**
- Verify mode is `"hybrid"`
- Reload VS Code window
- Check extension is active

**Slow performance?**
- Reduce `hybridTimeoutMs` to 50ms
- Switch to `standalone` mode

**Missing results?**
- Increase `hybridTimeoutMs` to 200-500ms
- Rebuild Smart Indexer index
