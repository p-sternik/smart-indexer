import { Connection } from 'vscode-languageserver/node';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Log levels for filtering output.
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  PERF = 4  // Performance measurements
}

/**
 * Structured log entry for JSONL format
 */
interface LogEntry {
  timestamp: string;
  level: string;
  component?: string;
  message: string;
  metadata?: Record<string, any>;
  stack?: string;
  duration?: number;
}

/**
 * Logger interface for dependency injection.
 */
export interface ILogger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, error?: any): void;
  perf(component: string, operation: string, durationMs: number, metadata?: Record<string, any>): void;
  measure<T>(component: string, operation: string, fn: () => Promise<T>, metadata?: Record<string, any>): Promise<T>;
  setLevel(level: LogLevel): void;
}

/**
 * Unified logging service for the Smart Indexer server.
 * 
 * Features:
 * - Dual transport: VS Code output channel + rolling log files
 * - JSONL structured logs for post-mortem analysis
 * - Performance measurement helpers
 * - Automatic log rotation (keeps last 7 days)
 * - Buffered file writes for performance
 * 
 * Usage:
 * ```typescript
 * this.logger.info('Indexing started');
 * this.logger.error('Failed to parse file', parseError);
 * await this.logger.measure('SqlJsStorage', 'FTS5 Query', async () => db.exec(...));
 * ```
 */
export class LoggerService implements ILogger {
  private connection: Connection;
  private currentLevel: LogLevel = LogLevel.INFO;
  private logFilePath: string = '';
  private logBuffer: LogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly maxBufferSize = 50;
  private readonly flushIntervalMs = 5000;
  private workspaceRoot: string = '';

  constructor(connection: Connection, level: LogLevel = LogLevel.INFO) {
    this.connection = connection;
    this.currentLevel = level;
  }

  /**
   * Initialize file logging (call after workspace root is known)
   */
  async initFileLogging(workspaceRoot: string): Promise<void> {
    this.workspaceRoot = workspaceRoot;

    try {
      const logsDir = path.join(workspaceRoot, '.smart-index', 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      const date = new Date().toISOString().split('T')[0];
      this.logFilePath = path.join(logsDir, `server-${date}.log`);

      await this.cleanOldLogs(logsDir, 7);

      this.info('[Logger] File logging initialized: ' + this.logFilePath);
    } catch (error: any) {
      this.warn('[Logger] Failed to initialize file logging: ' + error.message);
    }
  }

  /**
   * Clean old log files (keep last N days)
   */
  private async cleanOldLogs(logsDir: string, keepDays: number): Promise<void> {
    try {
      const files = fs.readdirSync(logsDir);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - keepDays);

      for (const file of files) {
        if (!file.startsWith('server-') || !file.endsWith('.log')) {
          continue;
        }

        const filePath = path.join(logsDir, file);
        const stats = fs.statSync(filePath);

        if (stats.mtime < cutoffDate) {
          fs.unlinkSync(filePath);
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Set the minimum log level to display.
   */
  setLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  /**
   * Log a debug message (verbose, typically disabled in production).
   */
  debug(message: string, ...args: any[]): void {
    if (this.currentLevel <= LogLevel.DEBUG) {
      this.log('DEBUG', message, args);
    }
  }

  /**
   * Log an informational message.
   */
  info(message: string, ...args: any[]): void {
    if (this.currentLevel <= LogLevel.INFO) {
      this.log('INFO', message, args);
    }
  }

  /**
   * Log a warning message.
   */
  warn(message: string, ...args: any[]): void {
    if (this.currentLevel <= LogLevel.WARN) {
      this.log('WARN', message, args);
    }
  }

  /**
   * Log an error message with optional error object.
   */
  error(message: string, error?: any): void {
    if (this.currentLevel <= LogLevel.ERROR) {
      let fullMessage = message;
      let stack: string | undefined;
      
      if (error) {
        if (error instanceof Error) {
          fullMessage += `: ${error.message}`;
          stack = error.stack;
        } else if (typeof error === 'object') {
          fullMessage += `: ${JSON.stringify(error)}`;
        } else {
          fullMessage += `: ${error}`;
        }
      }
      
      this.logStructured('ERROR', fullMessage, undefined, { stack });
    }
  }

  /**
   * Log performance measurement
   */
  perf(component: string, operation: string, durationMs: number, metadata?: Record<string, any>): void {
    const message = `[${component}] ${operation}`;
    this.logStructured('PERF', message, metadata, { duration: durationMs });
  }

  /**
   * Measure execution time of an async operation
   */
  async measure<T>(
    component: string,
    operation: string,
    fn: () => Promise<T>,
    metadata?: Record<string, any>
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      const duration = performance.now() - start;
      this.perf(component, operation, duration, metadata);
      return result;
    } catch (error: any) {
      const duration = performance.now() - start;
      this.error(`[${component}] ${operation} failed after ${duration.toFixed(2)}ms`, error);
      throw error;
    }
  }

  /**
   * Read last N lines from current log file
   */
  async readLastLines(n: number): Promise<string[]> {
    if (!this.logFilePath || !fs.existsSync(this.logFilePath)) {
      return [];
    }

    try {
      this.flush();
      const content = fs.readFileSync(this.logFilePath, 'utf-8');
      const lines = content.trim().split('\n');
      return lines.slice(-n);
    } catch {
      return [];
    }
  }

  /**
   * Get all log files
   */
  getLogFiles(): string[] {
    if (!this.workspaceRoot) {
      return [];
    }

    try {
      const logsDir = path.join(this.workspaceRoot, '.smart-index', 'logs');
      if (!fs.existsSync(logsDir)) {
        return [];
      }

      return fs.readdirSync(logsDir)
        .filter(f => f.startsWith('server-') && f.endsWith('.log'))
        .map(f => path.join(logsDir, f))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /**
   * Flush buffered logs to file
   */
  flush(): void {
    if (this.logBuffer.length === 0 || !this.logFilePath) {
      return;
    }

    try {
      const lines = this.logBuffer.map(entry => JSON.stringify(entry)).join('\n') + '\n';
      fs.appendFileSync(this.logFilePath, lines, 'utf-8');
      this.logBuffer = [];

      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
    } catch {
      // Ignore flush errors
    }
  }

  /**
   * Dispose and flush
   */
  async dispose(): Promise<void> {
    this.flush();
  }

  /**
   * Internal structured logging method
   */
  private logStructured(level: string, message: string, metadata?: Record<string, any>, extra?: { stack?: string; duration?: number }): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      metadata,
      ...(extra?.stack && { stack: extra.stack }),
      ...(extra?.duration !== undefined && { duration: extra.duration })
    };

    // Transport 1: VS Code Output Channel (human-readable, INFO+)
    if (level !== 'DEBUG') {
      const consoleMsg = this.formatForConsole(entry);
      this.connection.console.log(consoleMsg);
    }

    // Transport 2: File (JSONL, all levels)
    if (this.logFilePath) {
      this.bufferLog(entry);
    }
  }

  /**
   * Format entry for console
   */
  private formatForConsole(entry: LogEntry): string {
    const timestamp = entry.timestamp.split('T')[1]?.substring(0, 8) || '';
    const level = entry.level.padEnd(5);
    let message = `[${timestamp}] [${level}] ${entry.message}`;

    if (entry.duration !== undefined) {
      message += ` (${entry.duration.toFixed(2)}ms)`;
    }

    return message;
  }

  /**
   * Buffer log entry
   */
  private bufferLog(entry: LogEntry): void {
    this.logBuffer.push(entry);

    if (this.logBuffer.length >= this.maxBufferSize) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  /**
   * Internal logging method that formats and sends messages to the connection.
   */
  private log(level: string, message: string, args: any[]): void {
    const metadata = args.length > 0 ? { args: args.map(a => this.stringify(a)) } : undefined;
    this.logStructured(level, message, metadata);
  }

  /**
   * Safely stringify any value for logging.
   */
  private stringify(value: any): string {
    if (value === null) {
      return 'null';
    }
    if (value === undefined) {
      return 'undefined';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}

/**
 * Null logger for testing or disabled logging scenarios.
 */
export class NullLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  perf(): void {}
  async measure<T>(_component: string, _operation: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  setLevel(): void {}
}
