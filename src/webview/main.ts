// Webview entry: the composition root. It builds the page, the render loop and the compile
// worker, and hands them to the Orchestrator, which runs load → queue → worker → build → swap.

import { isHostToWebview, type WebviewToHost } from '../shared/protocol';
import { VGA_HEIGHT, VGA_WIDTH } from '../sim/vga';
import { tinyTapeoutAdapter } from './adapters/tinytapeout';
import {
  CompilerHost,
  type CompilerEvents,
  type WorkerEvents,
  type WorkerHandle,
} from './compilerHost';
import { Orchestrator } from './orchestrator';
import { RenderLoop } from './renderLoop';
import { buildSim } from './simHost';
import { Banner } from './ui/banner';
import { Controls } from './ui/controls';
import type { FromWorker } from './workerProtocol';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const adapter = tinyTapeoutAdapter;
const host = acquireVsCodeApi();
const post = (msg: WebviewToHost) => host.postMessage(msg);

// Page: controls, then the banner strip, then the frame. The banner is a sibling above the
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
  onReset: () => orchestrator.reset(),
  onPauseToggle: () => orchestrator.togglePause(),
});

const banner = new Banner(bannerRoot, {
  onShowProblems: () => post({ type: 'showProblems' }),
  onRetry: () => void orchestrator.boot(),
});

let image: ImageData | undefined;
const loop = new RenderLoop({
  adapter,
  draw: (pixels) => {
    // RenderLoop hands over the same buffer every frame, so wrap it once.
    image ??= new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, VGA_WIDTH, VGA_HEIGHT);
    ctx2d.putImageData(image, 0, 0);
  },
  onStats: (fps) => orchestrator.onStats(fps),
  onNoSync: (noSync) => banner.setNoSync(noSync),
  onRuntimeError: (err) => orchestrator.onRuntimeError(err),
});

const orchestrator = new Orchestrator({
  post,
  loop,
  banner,
  controls,
  adapter,
  buildSim,
  capturePng: () => {
    const url = canvas.toDataURL('image/png'); // data:image/png;base64,<png>
    return url.slice(url.indexOf(',') + 1);
  },
  startCompiler,
});

const onVisibility = () => loop.setVisible(document.visibilityState !== 'hidden');
document.addEventListener('visibilitychange', onVisibility);
onVisibility();

window.addEventListener('message', (e: MessageEvent<unknown>) => {
  if (isHostToWebview(e.data)) orchestrator.onHostMessage(e.data);
});

void orchestrator.boot();

async function fetchOk(uri: string): Promise<Response> {
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`GET ${uri}: ${res.status}`);
  return res;
}

/** Compiles the Verilator WASM once and starts the compile worker. */
async function startCompiler(events: CompilerEvents): Promise<CompilerHost> {
  const { wasmUri, workerUri } = document.body.dataset;
  if (!wasmUri || !workerUri) throw new Error('the page has no compiler URIs');
  // Not compileStreaming: the webview resource server's MIME type isn't guaranteed.
  const wasmModule = await WebAssembly.compile(await (await fetchOk(wasmUri)).arrayBuffer());
  // A webview can't start a worker from its resource URI, so go through a Blob URL. The
  // worker is classic: Emscripten only detects a worker when `importScripts` exists.
  const source = await (await fetchOk(workerUri)).text();
  const workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  return new CompilerHost({
    ...events,
    wasmModule,
    createWorker: (ev) => spawnWorker(workerUrl, ev),
  });
}

function spawnWorker(url: string, events: WorkerEvents): WorkerHandle {
  const w = new Worker(url);
  w.onmessage = (e: MessageEvent<FromWorker>) => events.onMessage(e.data);
  w.onerror = (e) => {
    e.preventDefault();
    events.onError(e.message);
  };
  return { postMessage: (msg) => w.postMessage(msg), terminate: () => w.terminate() };
}
