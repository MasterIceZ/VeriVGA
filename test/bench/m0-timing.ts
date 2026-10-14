// M0 spike: per-phase timing of the compile → first frame path on the stripes example, in
// Node. Not part of `pnpm test`. Run with: pnpm exec vite-node test/bench/m0-timing.ts [runs]

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { HDLModuleWASM } from '../../src/sim/hdlwasm';
import { parseVerilatorXml, runVerilator } from '../../src/sim/verilator/compile';
import {
  detectSyncPolarity,
  renderVGAFrame,
  resetModule,
  VGA_HEIGHT,
  VGA_WIDTH,
} from '../../src/sim/vga';

const runs = Number(process.argv[2] ?? 10);
const root = new URL('../../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');
const sources = {
  'src/project.v': read('examples/stripes/src/project.v'),
  'src/hvsync_generator.v': read('examples/stripes/src/hvsync_generator.v'),
};

// Each Emscripten instance adds process listeners in Node; this script makes one per run.
process.setMaxListeners(0);

type Phases = Record<'verilator' | 'parseInit' | 'resetPolarity' | 'firstFrame', number>;

async function once(wasmModule: WebAssembly.Module): Promise<Phases> {
  const t0 = performance.now();
  const log = console.log;
  console.log = () => {}; // Verilator echoes its output through console.log
  const { xml, errors } = await runVerilator({
    wasmModule,
    topModule: 'tt_um_vga_example',
    sources,
  }).finally(() => (console.log = log));
  if (xml === undefined) throw new Error(errors.map((e) => e.message).join('\n'));
  const t1 = performance.now();
  const { modules } = parseVerilatorXml(xml);
  const mod = new HDLModuleWASM(modules['TOP'], modules['@CONST-POOL@'] ?? modules['__Vconst']);
  await mod.init();
  const t2 = performance.now();
  resetModule(mod);
  const polarity = detectSyncPolarity(mod);
  resetModule(mod);
  const t3 = performance.now();
  renderVGAFrame(mod, new Uint8Array(VGA_WIDTH * VGA_HEIGHT * 4), { polarity });
  const t4 = performance.now();
  mod.dispose();
  return { verilator: t1 - t0, parseInit: t2 - t1, resetPolarity: t3 - t2, firstFrame: t4 - t3 };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = (n: number) => n.toFixed(1).padStart(7);

const tc = performance.now();
const wasmModule = await WebAssembly.compile(
  readFileSync(new URL('src/sim/verilator/verilator_bin.wasm', root)),
);
console.log(`WebAssembly.compile(verilator_bin.wasm): ${(performance.now() - tc).toFixed(1)} ms`);

const all: Phases[] = [];
for (let i = 0; i < runs + 1; i++) all.push(await once(wasmModule));
const [cold, ...warm] = all;

console.log(`\nphase (ms)          cold   warm median   warm min   (${runs} warm runs)`);
for (const k of Object.keys(cold) as (keyof Phases)[]) {
  const w = warm.map((p) => p[k]);
  console.log(`${k.padEnd(14)} ${fmt(cold[k])} ${fmt(median(w))}      ${fmt(Math.min(...w))}`);
}
// The spike's budget check: Verilator + parse + binaryen must stay under 700 ms.
const budget = (p: Phases) => p.verilator + p.parseInit;
console.log(
  `\nverilator + parse + binaryen: cold ${budget(cold).toFixed(1)} ms, ` +
    `warm median ${median(warm.map(budget)).toFixed(1)} ms`,
);
