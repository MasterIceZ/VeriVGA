import { CompileQueue, type CompileJob } from './compileQueue';
import type { FromWorker, ToWorker } from './workerProtocol';

export type WorkerResult = Extract<FromWorker, { type: 'result' }>;

/** What the host needs from a compile worker. main.ts wraps a real `Worker` in one. */
export interface WorkerHandle {
  postMessage(msg: ToWorker): void;
  terminate(): void;
}

/** Events from one worker. `onError` is its uncaught error (`Worker.onerror`). */
export interface WorkerEvents {
  onMessage(msg: FromWorker): void;
  onError(message: string): void;
}

export interface CompilerEvents {
  /** The worker's result for a job that is still the newest. Superseded results never get here. */
  onResult(job: CompileJob, result: WorkerResult): void;
  /** The job produced nothing usable: "Compiler crashed: …" or "Compile timed out". */
  onFailure(job: CompileJob, message: string): void;
}

export interface CompilerHostDeps extends CompilerEvents {
  wasmModule: WebAssembly.Module;
  createWorker(events: WorkerEvents): WorkerHandle;
  timeoutMs?: number;
  log?: Pick<Console, 'error'>;
}

/**
 * Owns the compile worker: one job at a time through a latest-wins {@link CompileQueue} with a
 * watchdog. A crash, an uncaught worker error or a timeout settles the in-flight job through
 * `onFailure`, and a fresh worker (re-`init`ed) carries on with the pending job.
 */
export class CompilerHost {
  private readonly queue: CompileQueue;
  private readonly log: Pick<Console, 'error'>;
  private worker: WorkerHandle | undefined;
  /** The job the worker is running, so a worker error can be pinned on its generation. */
  private inFlight: CompileJob | undefined;

  constructor(private readonly deps: CompilerHostDeps) {
    this.log = deps.log ?? console;
    this.queue = new CompileQueue({
      start: (job) => this.start(job),
      onTimeout: (job) => this.onTimeout(job),
      timeoutMs: deps.timeoutMs,
    });
    this.spawn();
  }

  get busy(): boolean {
    return this.queue.busy;
  }

  submit(job: CompileJob): void {
    this.queue.submit(job);
  }

  dispose(): void {
    this.queue.dispose();
    this.worker?.terminate();
    this.worker = undefined;
  }

  private spawn(): void {
    const handle: WorkerHandle = this.deps.createWorker({
      onMessage: (msg) => {
        if (this.worker === handle) this.onMessage(msg);
      },
      onError: (message) => {
        const text = `Compiler crashed: ${message || 'worker error'}`;
        if (this.worker === handle) this.onWorkerFailure(this.inFlight?.generation, text);
      },
    });
    handle.postMessage({ type: 'init', wasmModule: this.deps.wasmModule });
    this.worker = handle;
  }

  /** Terminates the worker and starts a fresh one. Never throws: the queue must keep going. */
  private restart(): void {
    try {
      this.worker?.terminate();
    } catch {
      // A worker that can't be terminated is dropped anyway.
    }
    this.worker = undefined;
    try {
      this.spawn();
    } catch (err) {
      // The next job then hits the watchdog, which tries again.
      this.log.error('[verivga] could not restart the compile worker', err);
    }
  }

  private start(job: CompileJob): void {
    this.inFlight = job;
    const { generation, topModule, sources } = job;
    this.worker?.postMessage({ type: 'compile', generation, topModule, sources });
  }

  private onTimeout(job: CompileJob): void {
    // Runs inside the queue's timer, which starts the pending job right after this returns:
    // never throw and never submit from here.
    try {
      this.log.error(`[verivga] gen ${job.generation}: compile timed out`);
      this.inFlight = undefined;
      this.restart();
      this.deps.onFailure(job, 'Compile timed out');
    } catch (err) {
      this.log.error('[verivga] compile timeout handling failed', err);
    }
  }

  private onMessage(msg: FromWorker): void {
    if (msg.type === 'crash') {
      this.onWorkerFailure(msg.generation, `Compiler crashed: ${msg.message}`);
      return;
    }
    if (this.inFlight?.generation === msg.generation) this.inFlight = undefined;
    // null: superseded by a newer load (which starts now) or stale. Drop it silently.
    const job = this.queue.complete(msg.generation);
    if (job) this.deps.onResult(job, msg);
  }

  /** A crash or worker error settles the in-flight generation, then a fresh worker carries on. */
  private onWorkerFailure(generation: number | undefined, message: string): void {
    this.log.error(`[verivga] ${message}`);
    const job = this.inFlight;
    if (!job || job.generation !== generation) return;
    this.inFlight = undefined;
    this.restart();
    // Frees the queue; a pending job starts on the new worker.
    this.queue.complete(job.generation);
    this.deps.onFailure(job, message);
  }
}
