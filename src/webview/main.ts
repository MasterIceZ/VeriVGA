// Webview entry: boots the compiler, then runs load → queue → worker → build → swap → render.
// Every compile ends in a `compiled` for the host (spec §3); on failure the banner explains
// and the previous design keeps rendering until a new one is ready.

import {
  isHostToWebview,
  type HostToWebview,
  type LoadMessage,
  type VerilatorMessage,
  type WebviewToHost,
} from '../shared/protocol';
import { VGA_HEIGHT, VGA_WIDTH } from '../sim/vga';
import { tinyTapeoutAdapter } from './adapters/tinytapeout';
import { CompileQueue, type CompileJob } from './compileQueue';
import { RenderLoop } from './renderLoop';
import { buildSim, type RunningSim } from './simHost';
import { Banner } from './ui/banner';
import { Controls } from './ui/controls';
import type { FromWorker, ToWorker } from './workerProtocol';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

type State = Extract<WebviewToHost, { type: 'stats' }>['state'];
type WorkerResult = Extract<FromWorker, { type: 'result' }>;

const STATS_INTERVAL_MS = 500;
const adapter = tinyTapeoutAdapter;

const host = acquireVsCodeApi();
const postToHost = (msg: WebviewToHost) => host.postMessage(msg);

// ── Page: controls, then the banner strip, then the frame. The banner is a sibling above the
// canvas, never inside its box, so it can't cover the frame.
const canvas = document.getElementById('screen') as HTMLCanvasElement;
canvas.width = VGA_WIDTH;
canvas.height = VGA_HEIGHT;
const ctx2d = canvas.getContext('2d')!;
const controlsRoot = document.createElement('div');
const bannerRoot = document.createElement('div');
canvas.before(controlsRoot, bannerRoot);

const controls = new Controls(controlsRoot, {
  onUiIn: (v) => {
    loop.uiIn = v;
  },
  onReset: () => reset(),
  onPauseToggle: () => setPaused(!loop.paused),
});

const banner = new Banner(bannerRoot, {
  onShowProblems: () => postToHost({ type: 'showProblems' }),
  onRetry: () => void boot(),
});

/** What the banner's main strip shows. Anything but `none` makes the state `error`. */
let bannerShows: 'none' | 'problem' | 'runtime' = 'none';

function showMessage(text: string, opts?: { retry?: boolean }): void {
  banner.showMessage(text, opts);
  bannerShows = 'problem';
  refresh();
}

function showErrors(count: number): void {
  banner.showErrors(count);
  bannerShows = 'problem';
  refresh();
}

function hideBanner(): void {
  banner.hide();
  bannerShows = 'none';
  refresh();
}

// ── Render loop.
let image: ImageData | undefined;
let lastFps = 0;
/** The loop paused itself on a runtime error (not the user): a new sim or Reset resumes. */
let pausedByError = false;
let hasSim = false;
const simGeneration = new WeakMap<RunningSim, number>();

const loop = new RenderLoop({
  adapter,
  draw: (pixels) => {
    // RenderLoop hands over the same buffer every frame, so wrap it once.
    image ??= new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, VGA_WIDTH, VGA_HEIGHT);
    ctx2d.putImageData(image, 0, 0);
  },
  onStats: (fps) => {
    lastFps = fps;
    controls.setFps(fps);
    publishStats(true);
  },
  onNoSync: (noSync) => banner.setNoSync(noSync),
  onRuntimeError: (err) => onRuntimeError(err),
});

/** The simulation threw (`HDLError`, `EmuHalt`): pause, show it, and tell the host. */
function onRuntimeError(err: unknown): void {
  loop.pause(); // the loop has already paused itself when it reports; reset() has not
  pausedByError = true;
  lastFps = 0;
  controls.setPaused(true);
  const message = (err instanceof Error && err.message) || String(err);
  const sim = loop.sim;
  const generation = (sim && simGeneration.get(sim)) ?? 0;
  banner.showMessage(message);
  bannerShows = 'runtime';
  refresh();
  postToHost({ type: 'runtimeError', generation, message });
}

function clearErrorPause(): void {
  if (!pausedByError) return;
  pausedByError = false;
  loop.resume();
  controls.setPaused(false);
}

function reset(): void {
  try {
    loop.reset();
  } catch (err) {
    onRuntimeError(err);
    return;
  }
  clearErrorPause();
  if (bannerShows === 'runtime') hideBanner();
  refresh();
}

/** User or host pause/resume. It overrides an error pause, and a user pause survives recompiles. */
function setPaused(paused: boolean): void {
  pausedByError = false;
  if (paused) {
    loop.pause();
    lastFps = 0;
  } else {
    loop.resume();
    if (bannerShows === 'runtime') hideBanner();
  }
  controls.setPaused(paused);
  refresh();
}

const onVisibility = () => loop.setVisible(document.visibilityState !== 'hidden');
document.addEventListener('visibilitychange', onVisibility);
onVisibility();

// ── State and stats.
let booting = false;
/** Accepted results that are waiting for, or going through, `applyResult`. */
let applying = 0;
let postedState: State | undefined;
let statsAt = -Infinity;
let statsTimer: ReturnType<typeof setTimeout> | undefined;

const busy = () => queue.busy || applying > 0;

function state(): State {
  if (booting) return 'loading';
  if (busy()) return 'compiling';
  if (bannerShows !== 'none') return 'error';
  if (!hasSim) return 'loading';
  return loop.paused ? 'paused' : 'running';
}

/** Posts `stats` on each fps sample and on a state change, at most once per 500 ms. */
function publishStats(sample = false): void {
  if ((!sample && state() === postedState) || statsTimer !== undefined) return;
  const wait = statsAt + STATS_INTERVAL_MS - performance.now();
  if (wait > 0) {
    statsTimer = setTimeout(() => {
      statsTimer = undefined;
      publishStats(true);
    }, wait);
    return;
  }
  statsAt = performance.now();
  postedState = state();
  postToHost({ type: 'stats', fps: Math.round(lastFps), state: postedState });
}

/** Re-derives the "compiling…" marker and the reported state after any change. */
function refresh(): void {
  controls.setCompiling(busy());
  publishStats();
}

// ── Compile worker.
let compiler: { wasmModule: WebAssembly.Module; workerUrl: string } | undefined;
let worker: Worker | undefined;
/** The job the worker is running, so a worker error can settle its generation. */
let inFlight: CompileJob | undefined;
/** A `load` that arrived before the compiler was ready; submitted once it is. */
let deferred: CompileJob | undefined;

function spawnWorker(): void {
  const c = compiler!;
  const w = new Worker(c.workerUrl);
  w.onmessage = (e: MessageEvent<FromWorker>) => {
    if (w === worker) onWorkerMessage(e.data);
  };
  w.onerror = (e) => {
    e.preventDefault();
    const text = `Compiler crashed: ${e.message || 'worker error'}`;
    if (w === worker) onWorkerFailure(inFlight?.generation, text);
  };
  w.postMessage({ type: 'init', wasmModule: c.wasmModule } satisfies ToWorker);
  worker = w;
}

/** Terminates the worker and starts a fresh one. Never throws: the queue must keep going. */
function restartWorker(): void {
  try {
    worker?.terminate();
  } catch {
    // A worker that can't be terminated is dropped anyway.
  }
  worker = undefined;
  try {
    spawnWorker();
  } catch (err) {
    // The next job then hits the watchdog, which tries again.
    console.error('[verivga] could not restart the compile worker', err);
  }
}

const queue = new CompileQueue({
  start: (job) => {
    inFlight = job;
    const { generation, topModule, sources } = job;
    worker?.postMessage({ type: 'compile', generation, topModule, sources } satisfies ToWorker);
  },
  onTimeout: (job) => {
    // Runs inside the queue's timer, which starts the pending job right after this returns:
    // never throw and never submit from here.
    try {
      console.error(`[verivga] gen ${job.generation}: compile timed out`);
      inFlight = undefined;
      restartWorker();
      inOrder(() => settle(job.generation, 'Compile timed out'));
    } catch (err) {
      console.error('[verivga] compile timeout handling failed', err);
    }
  },
});

function onWorkerMessage(msg: FromWorker): void {
  if (msg.type === 'crash') {
    onWorkerFailure(msg.generation, `Compiler crashed: ${msg.message}`);
    return;
  }
  if (inFlight?.generation === msg.generation) inFlight = undefined;
  // null: superseded by a newer load (which starts now) or stale. Drop it silently.
  const job = queue.complete(msg.generation);
  if (job) inOrder(() => applyResult(job, msg));
  else refresh();
}

/** A crash or worker error settles the in-flight generation, then a fresh worker carries on. */
function onWorkerFailure(generation: number | undefined, text: string): void {
  console.error(`[verivga] ${text}`);
  const job = inFlight;
  if (!job || job.generation !== generation) return;
  inFlight = undefined;
  restartWorker();
  // Frees the queue; a pending job starts on the new worker.
  queue.complete(job.generation);
  inOrder(() => settle(job.generation, text));
}

// ── Results, applied strictly in arrival order (= generation order). Building a sim is async,
// so without this an older generation could land after a newer one.
let chain: Promise<void> = Promise.resolve();

function inOrder(step: () => Promise<void> | void): void {
  applying++;
  refresh();
  chain = chain
    .then(step)
    .catch((err: unknown) => console.error('[verivga] applying a compile result failed', err))
    .finally(() => {
      applying--;
      refresh();
    });
}

/** `performance.now()` when each generation's `load` arrived; `compiled.ms` counts from it. */
const loadedAt = new Map<number, number>();

function postCompiled(generation: number, ok: boolean, messages: VerilatorMessage[]): void {
  const t0 = loadedAt.get(generation);
  for (const g of loadedAt.keys()) if (g <= generation) loadedAt.delete(g);
  const ms = t0 === undefined ? 0 : Math.round(performance.now() - t0);
  postToHost({ type: 'compiled', generation, ok, messages, ms });
}

const failure = (message: string): VerilatorMessage => ({
  severity: 'error',
  file: '',
  line: 1,
  column: 1,
  message,
});

/** Settles a generation that produced nothing usable: banner plus a single synthetic error. */
function settle(generation: number, text: string): void {
  showMessage(text);
  postCompiled(generation, false, [failure(text)]);
}

async function applyResult(job: CompileJob, result: WorkerResult): Promise<void> {
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
    if (errors.some((m) => m.file !== '')) showErrors(errors.length);
    else showMessage(errors[0].message);
    postCompiled(generation, false, messages);
    return;
  }

  const t0 = performance.now();
  const built = await buildSim({
    xml: result.xml,
    topModule: job.topModule,
    dataFiles: job.dataFiles,
    adapter,
    uiIn: loop.uiIn,
  });
  if (!built.ok) {
    console.error(`[verivga] gen ${generation}: ${built.stack ?? built.message}`);
    showMessage(built.message);
    postCompiled(generation, false, [failure(built.message)]);
    return;
  }
  simGeneration.set(built.sim, generation);
  loop.setSim(built.sim);
  hasSim = true;
  clearErrorPause();
  hideBanner();
  console.log(
    `[verivga] gen ${generation}: verilator ${Math.round(result.ms)} ms, ` +
      `build ${Math.round(performance.now() - t0)} ms`,
  );
  postCompiled(generation, true, messages);
}

// ── Host messages.
function onLoad(msg: LoadMessage): void {
  const { generation, topModule, sources, dataFiles } = msg;
  loadedAt.set(generation, performance.now());
  const job: CompileJob = { generation, topModule, sources, dataFiles };
  if (!compiler) {
    deferred = job;
    return;
  }
  controls.setCompiling(true);
  queue.submit(job);
  refresh();
}

function onHostMessage(msg: HostToWebview): void {
  switch (msg.type) {
    case 'load':
      onLoad(msg);
      break;
    case 'control':
      if (msg.action === 'reset') reset();
      else if (msg.action === 'pause') setPaused(true);
      else if (msg.action === 'resume') setPaused(false);
      // 'screenshot' is v1 (FR-14).
      break;
    case 'status':
      showMessage(msg.message);
      break;
  }
}

window.addEventListener('message', (e: MessageEvent<unknown>) => {
  if (isHostToWebview(e.data)) onHostMessage(e.data);
});

// ── Boot: compile the Verilator WASM once, start the worker, then tell the host we're ready.
async function fetchOk(uri: string): Promise<Response> {
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`GET ${uri}: ${res.status}`);
  return res;
}

async function boot(): Promise<void> {
  if (booting || compiler) return;
  booting = true;
  if (bannerShows !== 'none') hideBanner();
  refresh();
  try {
    const { wasmUri, workerUri } = document.body.dataset;
    if (!wasmUri || !workerUri) throw new Error('the page has no compiler URIs');
    // Not compileStreaming: the webview resource server's MIME type isn't guaranteed.
    const wasmModule = await WebAssembly.compile(await (await fetchOk(wasmUri)).arrayBuffer());
    // A webview can't start a worker from its resource URI, so go through a Blob URL. The
    // worker is classic: Emscripten only detects a worker when `importScripts` exists.
    const source = await (await fetchOk(workerUri)).text();
    const workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    compiler = { wasmModule, workerUrl };
    spawnWorker();
  } catch (err) {
    console.error("[verivga] couldn't load the compiler", err);
    compiler = undefined;
    worker = undefined;
    booting = false;
    showMessage("Couldn't load the compiler", { retry: true });
    return;
  }
  booting = false;
  refresh();
  postToHost({ type: 'ready' });
  if (deferred) {
    const job = deferred;
    deferred = undefined;
    queue.submit(job);
    refresh();
  }
}

void boot();
