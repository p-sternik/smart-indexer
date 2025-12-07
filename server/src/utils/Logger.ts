import { Connection } from 'vscode-languageserver/node';

/**
 * Log levels for filtering output.
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

/**
 * Logger interface for dependency injection.
 */
export interface ILogger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, error?: any): void;
  setLevel(level: LogLevel): void;
}

/**
 * Unified logging service for the Smart Indexer server.
 * 
 * Features:
 * - Centralized logging through LSP connection
 * - Timestamp prefixes for all messages
 * - Log level filtering (DEBUG/INFO/WARN/ERROR)
 * - Consistent formatting across the codebase
 * - Easy to redirect output (e.g., to file) in the future
 * 
 * Usage:
 * ```typescript
 * this.logger.info('Indexing started');
 * this.logger.error('Failed to parse file', parseError);
 * ```
 */
export class LoggerService implements ILogger {
  private connection: Connection;
  private currentLevel: LogLevel = LogLevel.INFO;

  constructor(connection: Connection, level: LogLevel = LogLevel.INFO) {
    this.connection = connection;
    this.currentLevel = level;
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
      
      if (error) {
        if (error instanceof Error) {
          fullMessage += `: ${error.message}`;
          if (error.stack) {
            fullMessage += `\nStack trace: ${error.stack}`;
          }
        } else if (typeof error === 'object') {
          fullMessage += `: ${JSON.stringify(error)}`;
        } else {
          fullMessage += `: ${error}`;
        }
      }
      
      this.log('ERROR', fullMessage, []);
    }
  }

  /**
   * Internal logging method that formats and sends messages to the connection.
   */
  private log(level: string, message: string, args: any[]): void {
    const timestamp = this.getTimestamp();
    const formattedMessage = `[${timestamp}] [${level}] ${message}`;
    
    // Append additional arguments if provided
    const finalMessage = args.length > 0 
      ? `${formattedMessage} ${args.map(arg => this.stringify(arg)).join(' ')}`
      : formattedMessage;
    
    // Send to client via LSP connection
    this.connection.console.log(finalMessage);
  }

  /**
   * Get current timestamp in HH:MM:SS format.
   */
  private getTimestamp(): string {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
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
  setLevel(): void {}
}
