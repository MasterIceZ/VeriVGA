export interface CompileJob {
  generation: number;
  topModule: string;
  sources: Record<string, string>;
  dataFiles: Record<string, string>;
}

export interface CompileQueueDeps {
  start(job: CompileJob): void;
  onTimeout(job: CompileJob): void;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Latest-wins scheduler for a single non-cancellable compile worker: at most one job
 * running, at most one pending (newest), stale results dropped.
 */
export class CompileQueue {
  private running: CompileJob | null = null;
  private pending: CompileJob | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly timeoutMs: number;

  constructor(private readonly deps: CompileQueueDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  submit(job: CompileJob): void {
    if (this.disposed) return;
    if (this.running) {
      this.pending = job;
      return;
    }
    this.startJob(job);
  }

  /** Returns the job whose result the caller should apply, or null if superseded/unknown. */
  complete(generation: number): CompileJob | null {
    if (this.disposed || !this.running || this.running.generation !== generation) return null;
    const finished = this.running;
    this.clearTimer();
    this.running = null;
    if (this.pending) {
      this.startNext();
      return null;
    }
    return finished;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.running = null;
    this.pending = null;
  }

  private startNext(): void {
    const next = this.pending;
    this.pending = null;
    if (next) this.startJob(next);
  }

  private startJob(job: CompileJob): void {
    this.running = job;
    this.timer = setTimeout(() => {
      this.timer = null;
      const timedOut = this.running;
      this.running = null;
      if (timedOut) this.deps.onTimeout(timedOut);
      if (!this.disposed) this.startNext();
    }, this.timeoutMs);
    this.deps.start(job);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
