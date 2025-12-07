# LoggerService

Unified logging service for Smart Indexer Language Server.

## Overview

`LoggerService` provides centralized, structured logging for all server components. It replaces scattered `console.log` and `connection.console.log` calls with a consistent, testable interface.

## Features

- ✅ **Automatic Timestamps:** `[HH:MM:SS] [LEVEL] message` format
- ✅ **Log Levels:** DEBUG, INFO, WARN, ERROR with runtime filtering
- ✅ **Error Formatting:** Automatic stack trace extraction
- ✅ **LSP Integration:** Sends logs to VS Code Output panel
- ✅ **Testable:** Mock `ILogger` interface for unit tests
- ✅ **Type-Safe:** Full TypeScript support

## Quick Start

### Basic Usage

```typescript
import { ILogger } from './utils/Logger.js';

class MyService {
  constructor(private logger: ILogger) {}
  
  async processFile(path: string): Promise<void> {
    this.logger.info(`Processing file: ${path}`);
    
    try {
      // ... processing logic ...
      this.logger.info(`Successfully processed ${path}`);
    } catch (error) {
      this.logger.error(`Failed to process ${path}`, error);
    }
  }
}
```

### Dependency Injection

```typescript
// In server.ts (initialization)
import { LoggerService, LogLevel } from './utils/Logger.js';

const connection = createConnection(ProposedFeatures.all);
const logger = new LoggerService(connection, LogLevel.INFO);

// Inject into services
const myService = new MyService(logger);
```

### Log Levels

```typescript
// DEBUG: Verbose internal state (disabled by default in production)
logger.debug('Cache hit for symbol: foo');

// INFO: Normal operations (enabled by default)
logger.info('Indexing started for 1234 files');

// WARN: Recoverable issues
logger.warn('File not found, skipping: missing.ts');

// ERROR: Failures requiring attention
logger.error('Failed to parse file', parseError);
```

## API Reference

### `ILogger` Interface

```typescript
interface ILogger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, error?: any): void;
  setLevel(level: LogLevel): void;
}
```

#### Methods

**`debug(message: string, ...args: any[]): void`**
- Log a debug message (verbose, typically disabled in production)
- Only displayed if log level is DEBUG
- Example: `logger.debug('Token at position:', token, position)`

**`info(message: string, ...args: any[]): void`**
- Log an informational message
- Displayed if log level is INFO or lower
- Example: `logger.info('Indexing complete: 1234 symbols')`

**`warn(message: string, ...args: any[]): void`**
- Log a warning message
- Displayed if log level is WARN or lower
- Example: `logger.warn('Large file skipped: exceeds 10MB')`

**`error(message: string, error?: any): void`**
- Log an error message with optional error object
- Always displayed (unless level is explicitly disabled)
- Automatically extracts `error.message` and `error.stack`
- Example: `logger.error('Parse failure', syntaxError)`

**`setLevel(level: LogLevel): void`**
- Change the minimum log level at runtime
- Example: `logger.setLevel(LogLevel.DEBUG)`

### `LogLevel` Enum

```typescript
enum LogLevel {
  DEBUG = 0,  // Most verbose
  INFO = 1,   // Default
  WARN = 2,
  ERROR = 3   // Least verbose
}
```

### `LoggerService` Class

```typescript
class LoggerService implements ILogger {
  constructor(
    connection: Connection,
    level: LogLevel = LogLevel.INFO
  );
}
```

#### Constructor Parameters

- **`connection`**: LSP connection for sending logs to the client
- **`level`**: Initial log level (default: `LogLevel.INFO`)

### `NullLogger` Class

```typescript
class NullLogger implements ILogger {
  // All methods are no-ops
}
```

Use for testing or when logging should be disabled:

```typescript
const logger = new NullLogger();
const service = new MyService(logger); // Logs are silently discarded
```

## Output Format

All logs follow this format:
```
[HH:MM:SS] [LEVEL] message
```

### Examples

```typescript
logger.info('Server started');
// Output: [14:30:00] [INFO] Server started

logger.warn('Config file missing, using defaults');
// Output: [14:30:01] [WARN] Config file missing, using defaults

logger.error('Failed to connect', new Error('ECONNREFUSED'));
// Output: [14:30:02] [ERROR] Failed to connect: ECONNREFUSED
// Stack trace: Error: ECONNREFUSED
//     at connect (net.js:123:45)
//     ...
```

## Best Practices

### 1. Use Appropriate Log Levels

```typescript
// ❌ BAD: Everything as info
logger.info('DEBUG: cache miss');
logger.info('ERROR: failed to parse');

// ✅ GOOD: Correct levels
logger.debug('Cache miss for key: foo');
logger.error('Failed to parse file', error);
```

### 2. Include Context in Messages

```typescript
// ❌ BAD: Vague message
logger.error('Failed');

// ✅ GOOD: Specific context
logger.error('[BackgroundIndex] Failed to load shard for file: src/app.ts', error);
```

### 3. Use Error Parameter for Exceptions

```typescript
// ❌ BAD: Manual stringification
logger.error(`Error: ${error.message}\n${error.stack}`);

// ✅ GOOD: Let logger handle formatting
logger.error('Operation failed', error);
```

### 4. Prefix Messages with Component Name

```typescript
// ✅ Consistent prefixing helps filter logs
logger.info('[WorkerPool] Started 4 workers');
logger.info('[IndexScheduler] Processing batch of 50 files');
logger.error('[SqlJsStorage] Database corruption detected', error);
```

### 5. Don't Log Sensitive Data

```typescript
// ❌ BAD: Logging credentials
logger.info(`Connecting with password: ${password}`);

// ✅ GOOD: Redact sensitive info
logger.info('Connecting to database...');
```

## Testing

### Mocking with Vitest

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ILogger } from '../utils/Logger.js';

describe('MyService', () => {
  it('logs processing start', async () => {
    const mockLogger: ILogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      setLevel: vi.fn()
    };
    
    const service = new MyService(mockLogger);
    await service.processFile('test.ts');
    
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Processing file: test.ts')
    );
  });
});
```

### Using NullLogger

```typescript
import { NullLogger } from '../utils/Logger.js';

describe('MyService', () => {
  it('processes file without logging', async () => {
    const service = new MyService(new NullLogger());
    // Logs are discarded, focus on business logic
    const result = await service.processFile('test.ts');
    expect(result).toBe(42);
  });
});
```

## Configuration

Currently, log level is set during `LoggerService` construction. Future versions will support:

1. **User Setting** (`smartIndexer.logLevel`)
   ```json
   {
     "smartIndexer.logLevel": "DEBUG"
   }
   ```

2. **Environment Variable**
   ```bash
   SMART_INDEXER_LOG_LEVEL=DEBUG code .
   ```

3. **Runtime API**
   ```typescript
   connection.onRequest('smart-indexer/setLogLevel', (level: string) => {
     logger.setLevel(LogLevel[level]);
   });
   ```

## Troubleshooting

### Logs Not Appearing in VS Code

**Problem:** Logger doesn't output to VS Code Output panel

**Solution:**
1. Check that `LoggerService` is constructed with `connection`:
   ```typescript
   const logger = new LoggerService(connection); // ✅ Correct
   const logger = new LoggerService(null);       // ❌ Wrong
   ```

2. Ensure VS Code Output panel is set to "Smart Indexer":
   - View → Output → Select "Smart Indexer" from dropdown

### TypeScript Errors After Migration

**Problem:** `Property 'logger' does not exist on type 'ServerServices'`

**Solution:** Extract `logger` from services:
```typescript
// Before
const { connection, documents, mergedIndex } = services;

// After
const { connection, documents, mergedIndex, logger } = services;
```

### Missing Stack Traces

**Problem:** Error logs don't show stack traces

**Solution:** Pass error as second parameter, not in message:
```typescript
// ❌ Wrong - stack trace not extracted
logger.error(`Failed: ${error.message}`);

// ✅ Correct - stack trace auto-extracted
logger.error('Failed to process', error);
```

## Migration from Old Logging

See [LOGGER_MIGRATION_GUIDE.md](../../../LOGGER_MIGRATION_GUIDE.md) for comprehensive migration instructions.

Quick reference:

| Old Pattern | New Pattern |
|-------------|-------------|
| `console.log(msg)` | `this.logger.info(msg)` |
| `console.warn(msg)` | `this.logger.warn(msg)` |
| `console.error(msg)` | `this.logger.error(msg)` |
| `connection.console.log(msg)` | `logger.info(msg)` |
| `connection.console.error(\`...\${error}\`)` | `logger.error('...', error)` |

## Implementation Details

### Timestamp Generation

```typescript
private getTimestamp(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}
```

### Error Formatting

```typescript
error(message: string, error?: any): void {
  let fullMessage = message;
  
  if (error) {
    if (error instanceof Error) {
      fullMessage += `: ${error.message}`;
      if (error.stack) {
        fullMessage += `\nStack trace: ${error.stack}`;
      }
    } else {
      fullMessage += `: ${String(error)}`;
    }
  }
  
  this.log('ERROR', fullMessage, []);
}
```

## Performance

- **Overhead:** Minimal (~0.1ms per log call)
- **Memory:** No buffering (logs sent immediately to connection)
- **Network:** Uses existing LSP connection (no additional sockets)
- **Filtering:** Log level check happens before string formatting

## Future Enhancements

### File Logging (Planned v1.2)
```typescript
const logger = new FileLogger('/path/to/smart-indexer.log');
logger.info('Logged to file');
```

### Structured Logging (Planned v2.0)
```typescript
logger.info('Indexing complete', { files: 1234, duration: 5000 });
// Output: {"timestamp":"2025-12-07T14:30:00Z","level":"INFO","message":"Indexing complete","files":1234,"duration":5000}
```

### Log Aggregation (Planned v2.1)
```typescript
const logger = new TelemetryLogger(connection, appInsightsKey);
// Logs sent to both VS Code and Application Insights
```

---

**Version:** 1.0.0  
**Last Updated:** 2025-12-07  
**Status:** Stable  
**License:** Same as Smart Indexer project
