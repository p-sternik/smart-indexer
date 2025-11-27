# Dead Code Detection - Quick Reference

## Configuration

```json
{
  "smartIndexer.deadCode": {
    "enabled": true,
    "entryPoints": [
      "**/main.ts",
      "**/public-api.ts",
      "**/index.ts",
      "**/*.stories.ts",
      "**/*.spec.ts"
    ],
    "excludePatterns": [],
    "checkBarrierFiles": false,
    "debounceMs": 1500
  }
}
```

## Algorithm

1. **Trigger:** File opened in editor
2. **Debounce:** Wait 1.5 seconds
3. **Check:** Is file an entry point? → Skip
4. **Analyze:** For each exported symbol:
   - Is framework method? → Skip
   - Has @public marker? → Skip
   - Query `referenceMap` for cross-file refs
   - If 0 refs → Flag as dead
5. **Publish:** Send diagnostics to VS Code
6. **Display:** Gray out unused exports

## Auto-Excluded Patterns

### Framework Methods
- Angular: `ngOnInit`, `ngOnChanges`, etc.
- Decorators: `@Component`, `@Injectable`, etc.

### JSDoc Markers
```typescript
/**
 * @public
 * @api
 * @publicApi
 */
export function myApi() { }
```

### Entry Points (Default)
- `**/main.ts`
- `**/public-api.ts`
- `**/index.ts`
- `**/*.stories.ts`
- `**/*.spec.ts`
- `**/*.test.ts`

## Confidence Levels

| Level | Condition | Description |
|-------|-----------|-------------|
| HIGH | 0 total refs | Truly unused |
| MEDIUM | <3 same-file refs | Only used locally |
| LOW | ≥3 same-file refs | Intentional internal API |

## API Reference

```typescript
// Core class
class DeadCodeDetector {
  constructor(backgroundIndex: BackgroundIndex)
  setConfigurationManager(config: ConfigurationManager)
  
  // Single file analysis (fast)
  async analyzeFile(
    uri: string, 
    options?: DeadCodeOptions
  ): Promise<DeadCodeCandidate[]>
  
  // Workspace analysis (slow)
  async findDeadCode(
    options?: DeadCodeOptions
  ): Promise<DeadCodeAnalysisResult>
}

// Options
interface DeadCodeOptions {
  excludePatterns?: string[];
  includeTests?: boolean;
  entryPoints?: string[];
  checkBarrierFiles?: boolean;  // Expensive
}

// Result
interface DeadCodeCandidate {
  symbol: IndexedSymbol;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}
```

## Diagnostic Format

```typescript
{
  severity: 4,  // Hint (non-intrusive)
  range: { start: {...}, end: {...} },
  message: "Unused export: 'SymbolName' (reason)",
  source: "smart-indexer",
  code: "unused-export",
  tags: [1]  // Unnecessary (grays out code)
}
```

## Test File

**Location:** `test-files/dead-code-test.ts`

**Contains:**
- Unused exports (should be grayed)
- Active exports (should be normal)
- Angular lifecycle hooks (should not be flagged)
- @public markers (should not be flagged)
- NgRx patterns (should not be flagged)

## Performance

- **Analysis Time:** 10-50ms per file
- **Debounce:** 1.5s (configurable)
- **Memory:** ~100 bytes per file
- **Trigger:** Only on file open (not workspace scan)

## Troubleshooting

### Not showing dead code
✓ Check `deadCode.enabled = true`  
✓ Wait 1.5+ seconds after opening file  
✓ Ensure file is not an entry point

### False positives
✓ Add `@public` JSDoc tag  
✓ Add pattern to `entryPoints`  
✓ Check if using dynamic imports

### Performance issues
✓ Set `checkBarrierFiles = false`  
✓ Increase `debounceMs` to 2000+  
✓ Add patterns to `excludePatterns`

## Related Docs

- **Full Guide:** `DEAD_CODE_DETECTION.md`
- **Architecture:** `docs/SMART_INDEXER_CONTEXT.md`
- **Implementation:** `server/src/features/deadCode.ts`
