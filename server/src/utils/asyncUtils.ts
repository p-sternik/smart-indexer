/**
 * Async utilities for non-blocking operations.
 * 
 * Provides helpers for yielding to the event loop and cooperative multitasking.
 */

/**
 * Yield to the event loop to allow pending I/O and timers to process.
 * 
 * Use this in tight loops to prevent blocking the Node.js event loop
 * and allow cancellation/progress events to be processed.
 * 
 * @example
 * for (let i = 0; i < items.length; i++) {
 *   if (i % 50 === 0) await yieldToEventLoop();
 *   processItem(items[i]);
 * }
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Cancellation token interface compatible with LSP CancellationToken.
 * 
 * Can be used standalone or with the LSP cancellation system.
 */
export interface CancellationToken {
  /** Whether cancellation has been requested */
  readonly isCancellationRequested: boolean;
  /** Event fired when cancellation is requested */
  onCancellationRequested?: (callback: () => void) => void;
}

/**
 * Error thrown when an operation is cancelled.
 */
export class CancellationError extends Error {
  readonly code = -32800; // LSP RequestCancelled error code

  constructor(message: string = 'Operation cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

/**
 * Check if cancellation is requested and throw if so.
 * 
 * @param token - Cancellation token to check
 * @throws CancellationError if cancellation is requested
 */
export function throwIfCancelled(token?: CancellationToken): void {
  if (token?.isCancellationRequested) {
    throw new CancellationError();
  }
}

/**
 * Progress callback type for long-running operations.
 */
export type ProgressCallback = (
  current: number,
  total: number,
  message?: string
) => void;
