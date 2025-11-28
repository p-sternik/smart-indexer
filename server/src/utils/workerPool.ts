import { Worker } from 'worker_threads';
import * as os from 'os';
import * as path from 'path';

interface WorkerTaskData {
  uri: string;
  content?: string;
  priority?: 'high' | 'normal'; // High priority for self-healing repairs
}

interface WorkerResult {
  success: boolean;
  result?: any;
  error?: string;
}

interface QueuedTask {
  taskData: WorkerTaskData;
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  priority: 'high' | 'normal';
}

interface WorkerState {
  worker: Worker;
  idle: boolean;
}

export class WorkerPool {
  private workers: WorkerState[] = [];
  private taskQueue: QueuedTask[] = [];
  private highPriorityQueue: QueuedTask[] = []; // Separate queue for high-priority tasks
  private workerScriptPath: string;
  private poolSize: number;
  private totalTasksProcessed: number = 0;
  private totalErrors: number = 0;

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
      try {
        workerState.worker.terminate();
      } catch (error) {
        console.error(`[WorkerPool] Error terminating worker:`, error);
      }
      
      this.workers.splice(index, 1);
      this.createWorker();
    }
  }

  private getIdleWorker(): WorkerState | null {
    return this.workers.find(w => w.idle) || null;
  }

  async runTask(taskData: WorkerTaskData): Promise<any> {
    return new Promise((resolve, reject) => {
      const idleWorker = this.getIdleWorker();
      const priority = taskData.priority || 'normal';

      if (idleWorker) {
        this.executeTask(idleWorker, taskData, resolve, reject);
      } else {
        // Add to appropriate queue based on priority
        const queuedTask = { taskData, resolve, reject, priority };
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
    resolve: (result: any) => void,
    reject: (error: Error) => void
  ): void {
    workerState.idle = false;

    const messageHandler = (result: WorkerResult) => {
      workerState.worker.off('message', messageHandler);
      workerState.idle = true;

      if (result.success) {
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
    const terminationPromises = this.workers.map(workerState =>
      workerState.worker.terminate()
    );
    await Promise.all(terminationPromises);
    this.workers = [];
    this.taskQueue = [];
    this.highPriorityQueue = [];
  }

  getStats(): { 
    poolSize: number; 
    idleWorkers: number; 
    queuedTasks: number;
    highPriorityQueuedTasks: number;
    totalProcessed: number;
    totalErrors: number;
  } {
    return {
      poolSize: this.workers.length,
      idleWorkers: this.workers.filter(w => w.idle).length,
      queuedTasks: this.taskQueue.length,
      highPriorityQueuedTasks: this.highPriorityQueue.length,
      totalProcessed: this.totalTasksProcessed,
      totalErrors: this.totalErrors
    };
  }
}
