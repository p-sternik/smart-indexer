import { Worker } from 'worker_threads';
import * as os from 'os';
import { IndexedFileResult } from '../types.js';

/**
 * Data structure for worker task input.
 */
export interface WorkerTaskData {
  uri: string;
  content?: string;
  priority?: 'high' | 'normal'; // High priority for self-healing repairs
}

/**
 * Generic result from a worker thread.
 * @template T - The type of the result payload (defaults to IndexedFileResult)
 */
export interface WorkerResult<T = IndexedFileResult> {
  success: boolean;
  result?: T;
  error?: string;
}

interface QueuedTask<T> {
  taskData: WorkerTaskData;
  resolve: (result: T) => void;
  reject: (error: Error) => void;
  priority: 'high' | 'normal';
}

interface CurrentTask<T> {
  resolve: (result: T) => void;
  reject: (error: Error) => void;
  taskData: WorkerTaskData;
  timeoutId: NodeJS.Timeout;
}

interface WorkerState {
  worker: Worker;
  idle: boolean;
  currentTask?: CurrentTask<IndexedFileResult>;
}

/**
 * Worker pool statistics.
 */
export interface WorkerPoolStats {
  poolSize: number;
  idleWorkers: number;
  queuedTasks: number;
  highPriorityQueuedTasks: number;
  totalProcessed: number;
  totalErrors: number;
  activeTasks: number;
}

/**
 * Interface for worker pool operations.
 * Allows mocking thread pool in unit tests.
 */
export interface IWorkerPool {
  /**
   * Run a task on a worker thread.
   */
  runTask(taskData: WorkerTaskData): Promise<IndexedFileResult>;

  /**
   * Terminate all workers.
   */
  terminate(): Promise<void>;

  /**
   * Get pool statistics.
   */
  getStats(): WorkerPoolStats;

  /**
   * Get the number of currently active tasks.
   */
  getActiveTasks(): number;

  /**
   * Validate and reset counters if desynchronized.
   */
  validateCounters(): boolean;

  /**
   * Force reset the active tasks counter.
   */
  reset(): void;
}

export class WorkerPool implements IWorkerPool {
  private workers: WorkerState[] = [];
  private taskQueue: QueuedTask<IndexedFileResult>[] = [];
  private highPriorityQueue: QueuedTask<IndexedFileResult>[] = []; // Separate queue for high-priority tasks
  private workerScriptPath: string;
  private poolSize: number;
  private totalTasksProcessed: number = 0;
  private totalErrors: number = 0;
  private taskTimeoutMs: number = 60000; // 60 second timeout per task
  private activeTasks: number = 0; // Track in-flight tasks for counter validation

  constructor(workerScriptPath: string, poolSize?: number) {
    this.workerScriptPath = workerScriptPath;
    this.poolSize = poolSize || Math.max(1, os.cpus().length - 1);
    console.info(`[WorkerPool] Creating pool with ${this.poolSize} workers (${os.cpus().length} CPUs available)`);
    this.initializeWorkers();
  }

  private initializeWorkers(): void {
    for (let i = 0; i < this.poolSize; i++) {
      this.createWorker();
    }
  }

  private createWorker(): void {
    const worker = new Worker(this.workerScriptPath);
    const workerState: WorkerState = {
      worker,
      idle: true
    };

    worker.on('error', (error) => {
      console.error(`[WorkerPool] Worker error:`, error);
      this.restartWorker(workerState);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[WorkerPool] Worker exited with code ${code}`);
        this.restartWorker(workerState);
      }
    });

    this.workers.push(workerState);
  }

  private restartWorker(workerState: WorkerState): void {
    const index = this.workers.indexOf(workerState);
    if (index !== -1) {
      // CRITICAL: Reject any pending task before terminating worker
      if (workerState.currentTask) {
        clearTimeout(workerState.currentTask.timeoutId);
        this.totalErrors++;
        const uri = workerState.currentTask.taskData.uri;
        workerState.currentTask.reject(
          new Error(`Worker crashed or timed out while processing: ${uri}`)
        );
        workerState.currentTask = undefined;
      }

      try {
        workerState.worker.terminate();
      } catch (error) {
        console.error(`[WorkerPool] Error terminating worker:`, error);
      }
      
      this.workers.splice(index, 1);
      this.createWorker();
      
      // Immediately process next queued task with the new worker
      this.processNextTask();
    }
  }

  private getIdleWorker(): WorkerState | null {
    return this.workers.find(w => w.idle) || null;
  }

  async runTask(taskData: WorkerTaskData): Promise<IndexedFileResult> {
    // Increment active tasks counter IMMEDIATELY when task is submitted
    this.activeTasks++;
    
    return new Promise<IndexedFileResult>((resolve, reject) => {
      // Wrap resolve/reject to decrement counter on completion
      const wrappedResolve = (result: IndexedFileResult) => {
        this.activeTasks--;
        resolve(result);
      };
      const wrappedReject = (error: Error) => {
        this.activeTasks--;
        reject(error);
      };

      const idleWorker = this.getIdleWorker();
      const priority = taskData.priority || 'normal';

      if (idleWorker) {
        this.executeTask(idleWorker, taskData, wrappedResolve, wrappedReject);
      } else {
        // Add to appropriate queue based on priority
        const queuedTask: QueuedTask<IndexedFileResult> = { taskData, resolve: wrappedResolve, reject: wrappedReject, priority };
        if (priority === 'high') {
          this.highPriorityQueue.push(queuedTask);
        } else {
          this.taskQueue.push(queuedTask);
        }
      }
    });
  }

  private executeTask(
    workerState: WorkerState,
    taskData: WorkerTaskData,
    resolve: (result: IndexedFileResult) => void,
    reject: (error: Error) => void
  ): void {
    workerState.idle = false;

    // Set up timeout to prevent tasks from hanging forever
    const timeoutId = setTimeout(() => {
      console.error(`[WorkerPool] Task timeout after ${this.taskTimeoutMs}ms: ${taskData.uri}`);
      this.restartWorker(workerState);
    }, this.taskTimeoutMs);

    // Track the current task for crash recovery
    workerState.currentTask = { resolve, reject, taskData, timeoutId };

    const messageHandler = (result: WorkerResult<IndexedFileResult>) => {
      // Clear timeout and task tracking on successful completion
      clearTimeout(timeoutId);
      workerState.worker.off('message', messageHandler);
      workerState.idle = true;
      workerState.currentTask = undefined;

      if (result.success && result.result) {
        this.totalTasksProcessed++;
        resolve(result.result);
      } else {
        this.totalErrors++;
        reject(new Error(result.error || 'Worker task failed'));
      }

      this.processNextTask();
    };

    workerState.worker.on('message', messageHandler);
    workerState.worker.postMessage(taskData);
  }

  private processNextTask(): void {
    // Always prioritize high-priority queue (for self-healing repairs)
    if (this.highPriorityQueue.length > 0) {
      const idleWorker = this.getIdleWorker();
      if (idleWorker) {
        const task = this.highPriorityQueue.shift()!;
        this.executeTask(idleWorker, task.taskData, task.resolve, task.reject);
        return;
      }
    }

    if (this.taskQueue.length === 0) {
      return;
    }

    const idleWorker = this.getIdleWorker();
    if (idleWorker) {
      const task = this.taskQueue.shift()!;
      this.executeTask(idleWorker, task.taskData, task.resolve, task.reject);
    }
  }

  async terminate(): Promise<void> {
    // Reject all pending tasks in queues (activeTasks already decremented by wrapped reject)
    for (const task of this.highPriorityQueue) {
      task.reject(new Error('WorkerPool terminated'));
    }
    for (const task of this.taskQueue) {
      task.reject(new Error('WorkerPool terminated'));
    }

    // Reject all in-flight tasks and clear timeouts
    for (const workerState of this.workers) {
      if (workerState.currentTask) {
        clearTimeout(workerState.currentTask.timeoutId);
        workerState.currentTask.reject(new Error('WorkerPool terminated'));
        workerState.currentTask = undefined;
      }
    }

    const terminationPromises = this.workers.map(workerState =>
      workerState.worker.terminate()
    );
    await Promise.all(terminationPromises);
    this.workers = [];
    this.taskQueue = [];
    this.highPriorityQueue = [];
    
    // Safety net: reset counter after termination
    this.activeTasks = 0;
  }

  getStats(): WorkerPoolStats {
    return {
      poolSize: this.workers.length,
      idleWorkers: this.workers.filter(w => w.idle).length,
      queuedTasks: this.taskQueue.length,
      highPriorityQueuedTasks: this.highPriorityQueue.length,
      totalProcessed: this.totalTasksProcessed,
      totalErrors: this.totalErrors,
      activeTasks: this.activeTasks
    };
  }

  /**
   * Get the number of currently active (in-flight + queued) tasks.
   * Use this for accurate status bar updates.
   */
  getActiveTasks(): number {
    return this.activeTasks;
  }

  /**
   * Validate and reset counters if they become desynchronized.
   * Returns true if a reset was performed.
   */
  validateCounters(): boolean {
    const inFlightCount = this.workers.filter(w => !w.idle).length;
    const queuedCount = this.taskQueue.length + this.highPriorityQueue.length;
    const expectedActive = inFlightCount + queuedCount;

    if (this.activeTasks !== expectedActive) {
      console.warn(
        `[WorkerPool] Counter desync detected: activeTasks=${this.activeTasks}, ` +
        `expected=${expectedActive} (inFlight=${inFlightCount}, queued=${queuedCount}). Resetting.`
      );
      this.activeTasks = expectedActive;
      return true;
    }
    return false;
  }

  /**
   * Force reset the active tasks counter to 0.
   * Use this as a safety net when all known tasks have completed.
   */
  reset(): void {
    if (this.activeTasks !== 0) {
      console.warn(`[WorkerPool] Force reset: activeTasks was ${this.activeTasks}, setting to 0`);
    }
    this.activeTasks = 0;
  }
}
