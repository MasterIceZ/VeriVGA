// Webview entry. M0 skeleton (Task 3): boot the compiler, then compile and render one frame
// per `load`. Task 11 replaces the load handling with the queue, render loop and UI.

import {
  isHostToWebview,
  type LoadMessage,
  type VerilatorMessage,
  type WebviewToHost,
} from '../shared/protocol';
import { HDLModuleWASM } from '../sim/hdlwasm';
import { parseVerilatorXml } from '../sim/verilator/compile';
import { detectSyncPolarity, renderVGAFrame, resetModule, VGA_HEIGHT, VGA_WIDTH } from '../sim/vga';
import type { FromWorker, ToWorker } from './workerProtocol';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const host = acquireVsCodeApi();
const postToHost = (msg: WebviewToHost) => host.postMessage(msg);

const canvas = document.getElementById('screen') as HTMLCanvasElement;
canvas.width = VGA_WIDTH;
canvas.height = VGA_HEIGHT;
const ctx2d = canvas.getContext('2d')!;
const image = new ImageData(VGA_WIDTH, VGA_HEIGHT);
const pixels = new Uint8Array(image.data.buffer);

/** `performance.now()` when each in-flight generation's `load` arrived. */
const loadTimes = new Map<number, number>();
let sim: HDLModuleWASM | undefined;

async function fetchOk(uri: string): Promise<Response> {
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`GET ${uri}: ${res.status}`);
  return res;
}

/** Compiles the Verilator WASM once and hands it to a fresh compile worker. */
async function boot(): Promise<Worker> {
  const { wasmUri, workerUri } = document.body.dataset;
  const t0 = performance.now();
  // Not compileStreaming: the webview resource server's MIME type isn't guaranteed.
  const wasmModule = await WebAssembly.compile(await (await fetchOk(wasmUri!)).arrayBuffer());
  const t1 = performance.now();
  // A webview can't start a worker from its resource URI, so go through a Blob URL. The
  // worker is classic: Emscripten only detects a worker when `importScripts` exists.
  const source = await (await fetchOk(workerUri!)).text();
  const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  worker.postMessage({ type: 'init', wasmModule } satisfies ToWorker);
  console.log(
    `[verivga] boot: wasm fetch+compile ${ms(t1 - t0)} ms, worker start ${ms(performance.now() - t1)} ms`,
  );
  return worker;
}

function ms(n: number): number {
  return Math.round(n);
}

function onLoad(worker: Worker, msg: LoadMessage): void {
  loadTimes.set(msg.generation, performance.now());
  const { generation, topModule, sources } = msg;
  worker.postMessage({ type: 'compile', generation, topModule, sources } satisfies ToWorker);
}

async function onWorkerMessage(msg: FromWorker): Promise<void> {
  const { generation } = msg;
  const t0 = loadTimes.get(generation) ?? performance.now();
  loadTimes.delete(generation);
  const compiled = (ok: boolean, messages: VerilatorMessage[]) =>
    postToHost({ type: 'compiled', generation, ok, messages, ms: ms(performance.now() - t0) });
  const failure = (message: string): VerilatorMessage[] => [
    { severity: 'error', file: '', line: 1, column: 1, message },
  ];

  if (msg.type === 'crash') {
    compiled(false, failure(`Compiler crashed: ${msg.message}`));
    return;
  }
  if (msg.xml === undefined || msg.messages.some((m) => m.severity === 'error')) {
    compiled(false, msg.messages);
    return;
  }
  try {
    const t1 = performance.now();
    const { modules } = parseVerilatorXml(msg.xml);
    const mod = new HDLModuleWASM(modules['TOP'], modules['@CONST-POOL@'] ?? modules['__Vconst']);
    await mod.init();
    const t2 = performance.now();
    resetModule(mod);
    const polarity = detectSyncPolarity(mod);
    // Polarity detection advances the simulation, so reset again before the first frame.
    resetModule(mod);
    const t3 = performance.now();
    renderVGAFrame(mod, pixels, { polarity });
    ctx2d.putImageData(image, 0, 0);
    const t4 = performance.now();
    sim?.dispose();
    sim = mod;
    console.log(
      `[verivga] gen ${generation}: verilator ${ms(msg.ms)} ms (worker), ` +
        `parse+binaryen ${ms(t2 - t1)} ms, reset+polarity ${ms(t3 - t2)} ms, ` +
        `first frame ${ms(t4 - t3)} ms, load->compiled ${ms(t4 - t0)} ms`,
    );
    compiled(true, msg.messages);
  } catch (err) {
    compiled(false, failure(String(err)));
  }
}

boot().then(
  (worker) => {
    worker.onmessage = (e: MessageEvent<FromWorker>) => void onWorkerMessage(e.data);
    worker.onerror = (e) =>
      postToHost({ type: 'runtimeError', generation: 0, message: `Worker error: ${e.message}` });
    window.addEventListener('message', (e: MessageEvent<unknown>) => {
      if (isHostToWebview(e.data) && e.data.type === 'load') onLoad(worker, e.data);
    });
    postToHost({ type: 'ready' });
  },
  (err: unknown) => {
    // Task 11 shows a "Couldn't load the compiler" banner with a retry.
    console.error('[verivga] boot failed', err);
    postToHost({ type: 'runtimeError', generation: 0, message: `Boot failed: ${String(err)}` });
  },
);
