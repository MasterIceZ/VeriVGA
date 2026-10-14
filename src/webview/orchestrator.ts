import type {
  HostToWebview,
  LoadMessage,
  VerilatorMessage,
  WebviewToHost,
} from '../shared/protocol';
import type { VgaAdapter } from './adapters/types';
import type { CompileJob } from './compileQueue';
import type { CompilerEvents, WorkerResult } from './compilerHost';
import type { RenderLoop } from './renderLoop';
import type { BuildOptions, BuildResult, RunningSim } from './simHost';
import type { Banner } from './ui/banner';
import type { Controls } from './ui/controls';

export type State = Extract<WebviewToHost, { type: 'stats' }>['state'];

/** The part of the compiler the orchestrator drives (a `CompilerHost`). */
export interface Compiler {
  readonly busy: boolean;
  submit(job: CompileJob): void;
}

export type LoopLike = Pick<
  RenderLoop,
  'sim' | 'uiIn' | 'paused' | 'setSim' | 'pause' | 'resume' | 'reset'
>;
export type BannerLike = Pick<Banner, 'showErrors' | 'showMessage' | 'hide'>;
export type ControlsLike = Pick<Controls, 'setPaused' | 'setFps' | 'setCompiling'>;

export interface OrchestratorDeps {
  post(msg: WebviewToHost): void;
  loop: LoopLike;
  banner: BannerLike;
  controls: ControlsLike;
  adapter: VgaAdapter;
  buildSim(o: BuildOptions): Promise<BuildResult>;
  /** Loads the compiler (Verilator WASM and worker). Rejecting shows "Couldn't load the compiler". */
  startCompiler(events: CompilerEvents): Promise<Compiler>;
  /** Milliseconds; defaults to `performance.now()`. */
  now?: () => number;
  log?: Pick<Console, 'log' | 'error'>;
}

const STATS_INTERVAL_MS = 500;

const failure = (message: string): VerilatorMessage => ({
  severity: 'error',
  file: '',
  line: 1,
  column: 1,
  message,
});

/**
 * The webview's state machine: load → compiler → build → swap, with every failure ending in a
 * `compiled` for the host (spec §3) and a banner, while the previous design keeps rendering.
 * Pure orchestration: the DOM, the worker and the render loop are injected.
 */
export class Orchestrator {
  private readonly now: () => number;
  private readonly log: Pick<Console, 'log' | 'error'>;

  private compiler: Compiler | undefined;
  private booting = false;
  /** A `load` that arrived before the compiler was ready; submitted once it is. */
  private deferred: CompileJob | undefined;

  /** What the banner's main strip shows. Anything but `none` makes the state `error`. */
  private bannerShows: 'none' | 'problem' | 'runtime' = 'none';
  /** The loop paused itself on a runtime error (not the user): a new sim or Reset resumes. */
  private pausedByError = false;
  private hasSim = false;
  private readonly simGeneration = new WeakMap<RunningSim, number>();

  /** Accepted results that are waiting for, or going through, `applyResult`. */
  private applying = 0;
  private chain: Promise<void> = Promise.resolve();
  /** `now()` when each generation's `load` arrived; `compiled.ms` counts from it. */
  private readonly loadedAt = new Map<number, number>();

  private lastFps = 0;
  private postedState: State | undefined;
  private statsAt = -Infinity;
  private statsTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly d: OrchestratorDeps) {
    this.now = d.now ?? (() => performance.now());
    this.log = d.log ?? console;
  }

  get state(): State {
    if (this.booting) return 'loading';
    if (this.busy) return 'compiling';
    if (this.bannerShows !== 'none') return 'error';
    if (!this.hasSim) return 'loading';
    return this.d.loop.paused ? 'paused' : 'running';
  }

  /** Loads the compiler, then posts `ready`. Also the banner's Retry after a failed boot. */
  async boot(): Promise<void> {
    if (this.booting || this.compiler) return;
    this.booting = true;
    if (this.bannerShows !== 'none') this.hideBanner();
    this.refresh();
    try {
      this.compiler = await this.d.startCompiler({
        onResult: (job, result) => this.inOrder(() => this.applyResult(job, result)),
        onFailure: (job, message) => this.inOrder(() => this.settle(job.generation, message)),
      });
    } catch (err) {
      this.log.error("[verivga] couldn't load the compiler", err);
      this.booting = false;
      this.showMessage("Couldn't load the compiler", { retry: true });
      return;
    }
    this.booting = false;
    this.refresh();
    this.d.post({ type: 'ready' });
    const job = this.deferred;
    this.deferred = undefined;
    if (job) this.submit(job);
  }

  onHostMessage(msg: HostToWebview): void {
    switch (msg.type) {
      case 'load':
        this.onLoad(msg);
        break;
      case 'control':
        if (msg.action === 'reset') this.reset();
        else if (msg.action === 'pause') this.setPaused(true);
        else if (msg.action === 'resume') this.setPaused(false);
        // 'screenshot' is v1 (FR-14).
        break;
      case 'status':
        this.showMessage(msg.message);
        break;
    }
  }

  /** The simulation threw (`HDLError`, `EmuHalt`): pause, show it, and tell the host. */
  onRuntimeError(err: unknown): void {
    const { loop, controls } = this.d;
    loop.pause(); // the loop has already paused itself when it reports; reset() has not
    this.pausedByError = true;
    this.lastFps = 0;
    controls.setPaused(true);
    const message = (err instanceof Error && err.message) || String(err);
    const sim = loop.sim;
    const generation = (sim && this.simGeneration.get(sim)) ?? 0;
    this.d.banner.showMessage(message);
    this.bannerShows = 'runtime';
    this.refresh();
    this.d.post({ type: 'runtimeError', generation, message });
  }

  onStats(fps: number): void {
    this.lastFps = fps;
    this.d.controls.setFps(fps);
    this.publishStats(true);
  }

  reset(): void {
    try {
      this.d.loop.reset();
    } catch (err) {
      this.onRuntimeError(err);
      return;
    }
    this.clearErrorPause();
    if (this.bannerShows === 'runtime') this.hideBanner();
    this.refresh();
  }

  /** User or host pause/resume. It overrides an error pause; a user pause survives recompiles. */
  setPaused(paused: boolean): void {
    const { loop } = this.d;
    this.pausedByError = false;
    if (paused) {
      loop.pause();
      this.lastFps = 0;
    } else {
      loop.resume();
      if (this.bannerShows === 'runtime') this.hideBanner();
    }
    this.d.controls.setPaused(paused);
    this.refresh();
  }

  togglePause(): void {
    this.setPaused(!this.d.loop.paused);
  }

  // ── Loads.

  private get busy(): boolean {
    return (this.compiler?.busy ?? false) || this.applying > 0;
  }

  private onLoad(msg: LoadMessage): void {
    const { generation, topModule, sources, dataFiles } = msg;
    this.loadedAt.set(generation, this.now());
    const job: CompileJob = { generation, topModule, sources, dataFiles };
    if (!this.compiler) {
      this.deferred = job;
      return;
    }
    this.submit(job);
  }

  private submit(job: CompileJob): void {
    this.d.controls.setCompiling(true);
    this.compiler!.submit(job);
    this.refresh();
  }

  // ── Results, applied strictly in arrival order (= generation order). Building a sim is
  // async, so without this an older generation could land after a newer one.

  private inOrder(step: () => Promise<void> | void): void {
    this.applying++;
    this.refresh();
    this.chain = this.chain
      .then(step)
      .catch((err: unknown) => this.log.error('[verivga] applying a compile result failed', err))
      .finally(() => {
        this.applying--;
        this.refresh();
      });
  }

  private postCompiled(generation: number, ok: boolean, messages: VerilatorMessage[]): void {
    const t0 = this.loadedAt.get(generation);
    for (const g of this.loadedAt.keys()) if (g <= generation) this.loadedAt.delete(g);
    const ms = t0 === undefined ? 0 : Math.round(this.now() - t0);
    this.d.post({ type: 'compiled', generation, ok, messages, ms });
  }

  /** Settles a generation that produced nothing usable: banner plus a single synthetic error. */
  private settle(generation: number, text: string): void {
    this.showMessage(text);
    this.postCompiled(generation, false, [failure(text)]);
  }

  private async applyResult(job: CompileJob, result: WorkerResult): Promise<void> {
    const { generation } = job;
    const messages = [...result.messages];
    const errors = messages.filter((m) => m.severity === 'error');
    if (result.xml === undefined && errors.length === 0) {
      // Never fail silently.
      const none = failure('Compilation failed (no output)');
      messages.push(none);
      errors.push(none);
    }
    if (result.xml === undefined || errors.length > 0) {
      // Errors without a file can't show up in Problems, so the banner shows the first one.
      if (errors.some((m) => m.file !== '')) this.showErrors(errors.length);
      else this.showMessage(errors[0].message);
      this.postCompiled(generation, false, messages);
      return;
    }

    const t0 = this.now();
    const built = await this.d.buildSim({
      xml: result.xml,
      topModule: job.topModule,
      dataFiles: job.dataFiles,
      adapter: this.d.adapter,
      uiIn: this.d.loop.uiIn,
    });
    if (!built.ok) {
      this.log.error(`[verivga] gen ${generation}: ${built.stack ?? built.message}`);
      this.showMessage(built.message);
      this.postCompiled(generation, false, [failure(built.message)]);
      return;
    }
    this.simGeneration.set(built.sim, generation);
    this.d.loop.setSim(built.sim);
    this.hasSim = true;
    this.clearErrorPause();
    this.hideBanner();
    this.log.log(
      `[verivga] gen ${generation}: verilator ${Math.round(result.ms)} ms, ` +
        `build ${Math.round(this.now() - t0)} ms`,
    );
    this.postCompiled(generation, true, messages);
  }

  // ── Banner and pause.

  private showMessage(text: string, opts?: { retry?: boolean }): void {
    this.d.banner.showMessage(text, opts);
    this.bannerShows = 'problem';
    this.refresh();
  }

  private showErrors(count: number): void {
    this.d.banner.showErrors(count);
    this.bannerShows = 'problem';
    this.refresh();
  }

  private hideBanner(): void {
    this.d.banner.hide();
    this.bannerShows = 'none';
    this.refresh();
  }

  private clearErrorPause(): void {
    if (!this.pausedByError) return;
    this.pausedByError = false;
    this.d.loop.resume();
    this.d.controls.setPaused(false);
  }

  // ── State and stats.

  /** Re-derives the "compiling…" marker and the reported state after any change. */
  private refresh(): void {
    this.d.controls.setCompiling(this.busy);
    this.publishStats();
  }

  /** Posts `stats` on each fps sample and on a state change, at most once per 500 ms. */
  private publishStats(sample = false): void {
    if ((!sample && this.state === this.postedState) || this.statsTimer !== undefined) return;
    const wait = this.statsAt + STATS_INTERVAL_MS - this.now();
    if (wait > 0) {
      this.statsTimer = setTimeout(() => {
        this.statsTimer = undefined;
        this.publishStats(true);
      }, wait);
      return;
    }
    this.statsAt = this.now();
    this.postedState = this.state;
    this.d.post({ type: 'stats', fps: Math.round(this.lastFps), state: this.postedState });
  }
}
