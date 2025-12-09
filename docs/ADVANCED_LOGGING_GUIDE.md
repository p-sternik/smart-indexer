# Advanced Logging System - Implementation Guide

## ✅ Task 1: Logger Service - COMPLETED

### Features Implemented

**File:** `server/src/utils/Logger.ts`

1. ✅ **Log Levels:**
   - `DEBUG` - Verbose logging (file only)
   - `INFO` - General information
   - `WARN` - Warnings
   - `ERROR` - Errors with stack traces
   - `PERF` - Performance measurements

2. ✅ **Dual Transport:**
   - **VS Code Output Channel** - Human-readable, INFO+ only
   - **Rolling Log File** - JSONL format in `.smart-index/logs/server-YYYY-MM-DD.log`

3. ✅ **Performance Helper:**
   ```typescript
   await logger.measure('SqlJsStorage', 'FTS5 Query', async () => {
     return db.exec('SELECT ...');
   });
   ```

4. ✅ **Features:**
   - Structured JSONL logs with timestamps, metadata
   - Automatic log rotation (keeps last 7 days)
   - Buffered writes (flushes every 5s or 50 entries)
   - Stack trace capture for errors
   - Duration tracking for PERF logs

### Usage Examples

```typescript
// Initialize (in server.ts)
await logger.initFileLogging(workspaceRoot);

// Basic logging
logger.info('[SqlJsStorage] Database initialized');
logger.warn('[Worker] Large file detected', { size: '10MB' });
logger.error('[BackgroundIndex] Index failed', error);

// Performance measurement
const result = await logger.measure(
  'SqlJsStorage',
  'FTS5 Query: findSymbols',
  async () => {
    return db.exec(`SELECT * FROM symbols_fts WHERE ...`);
  },
  { query: 'User*', limit: 100 }
);

// Manual perf logging
const start = performance.now();
// ... do work ...
logger.perf('WorkerPool', 'Parse AST', performance.now() - start, {
  file: 'test.ts',
  symbols: 42
});
```

## 📋 Task 2: Instrument Key Components

### SqlJsStorage Instrumentation

**Location:** `server/src/storage/SqlJsStorage.ts`

Add measurement wrappers:

```typescript
// In getFileData()
return this.logger.measure('SqlJsStorage', 'Query: getFileData', async () => {
  const result = this.db!.exec(
    'SELECT json_data FROM files WHERE uri = ?',
    [normalizedUri]
  );
  return result.length > 0 ? JSON.parse(result[0].values[0][0] as string) : null;
}, { uri: normalizedUri });

// In findSymbols()
return this.logger.measure('SqlJsStorage', 'FTS5: findSymbols', async () => {
  const results = this.db!.exec(
    `SELECT DISTINCT file_uri FROM symbols_fts WHERE name MATCH ? LIMIT ?`,
    [query, limit]
  );
  return results.length > 0 ? results[0].values.map(row => row[0] as string) : [];
}, { query, limit });

// In clear() - log ENOENT/EBUSY
try {
  await fs.promises.unlink(filePath);
} catch (error: any) {
  if (error.code === 'ENOENT') {
    this.logger.debug('SqlJsStorage', `File already gone: ${filePath}`);
  } else if (error.code === 'EBUSY') {
    this.logger.error(`[SqlJsStorage] File busy (Windows lock): ${filePath}`, error);
  } else {
    this.logger.warn(`[SqlJsStorage] Could not delete ${filePath}`, error);
  }
}
```

### Worker Instrumentation

**Location:** `server/src/indexer/worker.ts`

Log NgRx virtual symbols:

```typescript
// After processCreateActionGroup
if (isNgRxCreateActionGroupCall(callExpr)) {
  const eventsMap = processCreateActionGroup(...);
  
  if (eventsMap && Object.keys(eventsMap).length > 0) {
    // Log to global logger (if available)
    console.info(
      `[Worker] Generated ${Object.keys(eventsMap).length} virtual symbols for ${varName} createActionGroup`
    );
  }
}
```

### Handler Instrumentation

**Location:** `server/src/handlers/*`

Example for import guard decisions:

```typescript
if (!this.isImportAllowed(targetUri, currentUri)) {
  this.logger.info(
    '[ReferenceHandler] Rejected reference due to strict import guard',
    { target: targetUri, source: currentUri }
  );
  return null;
}
```

## 🔍 Task 3: Generate Diagnostics Report Command

### Client Command Registration

**File:** `src/extension.ts`

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('smartIndexer.generateReport', async () => {
    try {
      const result = await client.sendRequest('smart-indexer/generateReport');
      
      if (result.reportPath) {
        const doc = await vscode.workspace.openTextDocument(result.reportPath);
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage('Diagnostics report generated successfully');
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to generate report: ${error}`);
    }
  })
);
```

### Server Handler Implementation

**File:** `server/src/server.ts`

```typescript
connection.onRequest('smart-indexer/generateReport', async () => {
  try {
    const report = await generateDiagnosticsReport(
      logger,
      backgroundIndex,
      workspaceRoot
    );
    
    const reportPath = path.join(workspaceRoot, 'SMART_INDEXER_DIAGNOSTICS.md');
    fs.writeFileSync(reportPath, report, 'utf-8');
    
    return { success: true, reportPath };
  } catch (error) {
    logger.error('[Server] Failed to generate diagnostics report', error);
    throw error;
  }
});

async function generateDiagnosticsReport(
  logger: LoggerService,
  backgroundIndex: BackgroundIndex,
  workspaceRoot: string
): Promise<string> {
  const lines: string[] = [];
  
  // Header
  lines.push('# Smart Indexer Diagnostics Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  
  // System Info
  lines.push('## System Information');
  lines.push('');
  lines.push(`- OS: ${process.platform} ${process.arch}`);
  lines.push(`- Node.js: ${process.version}`);
  lines.push(`- VS Code: ${process.env.VSCODE_VERSION || 'unknown'}`);
  lines.push(`- Workspace: ${workspaceRoot}`);
  lines.push('');
  
  // Index Stats
  lines.push('## Index Statistics');
  lines.push('');
  
  const stats = await backgroundIndex.getStats();
  lines.push(`- Total Files: ${stats.totalFiles}`);
  lines.push(`- Total Symbols: ${stats.totalSymbols}`);
  lines.push(`- Storage Size: ${(stats.storageSize / 1024 / 1024).toFixed(2)} MB`);
  lines.push(`- Storage Path: ${stats.storagePath}`);
  lines.push('');
  
  // Database Info
  if (fs.existsSync(stats.storagePath)) {
    const dbStats = fs.statSync(stats.storagePath);
    lines.push(`- DB File Size: ${(dbStats.size / 1024 / 1024).toFixed(2)} MB`);
    lines.push(`- DB Modified: ${dbStats.mtime.toISOString()}`);
  }
  lines.push('');
  
  // Recent Logs
  lines.push('## Recent Logs (Last 100 Lines)');
  lines.push('');
  lines.push('```jsonl');
  
  const logLines = await logger.readLastLines(100);
  for (const line of logLines) {
    lines.push(line);
  }
  
  lines.push('```');
  lines.push('');
  
  // Log Files
  lines.push('## Available Log Files');
  lines.push('');
  
  const logFiles = logger.getLogFiles();
  for (const file of logFiles) {
    const stat = fs.statSync(file);
    lines.push(`- ${path.basename(file)} (${(stat.size / 1024).toFixed(2)} KB)`);
  }
  lines.push('');
  
  // Footer
  lines.push('---');
  lines.push('');
  lines.push('Please attach this report when filing issues.');
  
  return lines.join('\n');
}
```

### package.json Command

**File:** `package.json`

```json
{
  "commands": [
    {
      "command": "smartIndexer.generateReport",
      "title": "Smart Indexer: Generate Diagnostics Report"
    }
  ]
}
```

## 📊 Log File Format

### JSONL Example

```jsonl
{"timestamp":"2025-12-09T18:06:00.567Z","level":"INFO","message":"[SqlJsStorage] Database initialized","metadata":{"logFile":".smart-index/logs/server-2025-12-09.log"}}
{"timestamp":"2025-12-09T18:06:01.234Z","level":"PERF","message":"[SqlJsStorage] FTS5: findSymbols","duration":12.45,"metadata":{"query":"User*","limit":100}}
{"timestamp":"2025-12-09T18:06:02.890Z","level":"ERROR","message":"[Worker] Parse error","metadata":{"file":"test.ts"},"stack":"Error: Unexpected token\\n    at parse..."}
{"timestamp":"2025-12-09T18:06:03.123Z","level":"WARN","message":"[SqlJsStorage] Could not delete index.db-wal","metadata":{"code":"EBUSY"}}
```

## 🧪 Testing

### Manual Test

1. **Open workspace** with Smart Indexer
2. **Trigger operations** (indexing, search, rebuild)
3. **Check logs:**
   - VS Code Output: `Output > Smart Indexer`
   - File: `.smart-index/logs/server-2025-12-09.log`
4. **Generate report:**
   - `Ctrl+Shift+P` → "Smart Indexer: Generate Diagnostics Report"
   - Verify `SMART_INDEXER_DIAGNOSTICS.md` is created and opened

### Verify Log Rotation

1. **Wait 7+ days** (or manually change file dates)
2. **Restart extension**
3. **Verify** old logs are deleted

## 📈 Benefits

1. ✅ **Post-Mortem Analysis** - JSONL logs are machine-readable
2. ✅ **Performance Tracking** - `PERF` logs show bottlenecks
3. ✅ **User Support** - "Generate Report" command collects all needed info
4. ✅ **Race Condition Debugging** - Timestamps help identify timing issues
5. ✅ **No Performance Impact** - Buffered writes, async operations

## 🎯 Next Steps

1. Instrument remaining components:
   - `BackgroundIndex` - log indexing progress
   - `WorkerPool` - log worker lifecycle
   - `FileWatcher` - log file change events

2. Add metrics:
   - Cache hit/miss rates
   - Query performance percentiles
   - Memory usage tracking

3. Consider:
   - Log level configuration (user setting)
   - Log file size limits
   - Export logs as ZIP for support

---

**Status: ✅ READY FOR IMPLEMENTATION**
