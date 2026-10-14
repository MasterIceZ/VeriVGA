// Classic Web Worker that runs Verilator, so compiling never blocks the render loop. It
// returns the XML string; the cyclic HDLModuleDef is built on the main thread.

import { runVerilator } from '../sim/verilator/compile';
import { toVerilatorMessages } from '../sim/verilator/messages';
import type { FromWorker, ToWorker } from './workerProtocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let wasmModule: WebAssembly.Module | undefined;

function post(msg: FromWorker): void {
  ctx.postMessage(msg);
}

ctx.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    wasmModule = msg.wasmModule;
    return;
  }
  const { generation, topModule, sources } = msg;
  const t0 = performance.now();
  try {
    const { xml, errors } = await runVerilator({ wasmModule, topModule, sources });
    const ms = performance.now() - t0;
    post({ type: 'result', generation, xml, messages: toVerilatorMessages(errors, sources), ms });
  } catch (err) {
    post({ type: 'crash', generation, message: String(err) });
  }
};
