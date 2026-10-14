import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { runVerilator } from '../../src/sim/verilator/compile';
import { VGA_HEIGHT, VGA_WIDTH } from '../../src/sim/vga';
import { tinyTapeoutAdapter } from '../../src/webview/adapters/tinytapeout';
import { buildSim } from '../../src/webview/simHost';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const wasmBinary = readFileSync(resolve(root, 'src/sim/verilator/verilator_bin.wasm'));

const originalExit = process.exit;
beforeAll(() => {
  process.setMaxListeners(40);
  process.exit = vi.fn() as never;
});
afterAll(() => {
  process.exit = originalExit;
});

const PORTS = `input [7:0] ui_in, output [7:0] uo_out, input [7:0] uio_in,
  output [7:0] uio_out, output [7:0] uio_oe, input ena, input clk, input rst_n`;

async function build(src: string, dataFiles: Record<string, string> = {}, uiIn = 0) {
  const res = await runVerilator({ topModule: 'tt_um_t', sources: { 't.v': src }, wasmBinary });
  if (!res.xml) throw new Error(res.errors.map((e) => e.message).join('\n'));
  return buildSim({
    xml: res.xml,
    topModule: 'tt_um_t',
    dataFiles,
    adapter: tinyTapeoutAdapter,
    uiIn,
  });
}

test('design with no sync → vsyncSeen false within cap', async () => {
  const built = await build(`module tt_um_t(${PORTS});
  assign uo_out = 8'd0;
  assign uio_out = 8'd0;
  assign uio_oe = 8'd0;
endmodule
`);
  if (!built.ok) throw new Error(built.message);
  const pixels = new Uint8Array(VGA_WIDTH * VGA_HEIGHT * 4);
  const r = tinyTapeoutAdapter.renderFrame(built.sim.mod, pixels, built.sim.polarity);
  built.sim.dispose();
  expect(r.vsyncSeen).toBe(false);
});

const MEM_DESIGN = `module tt_um_t(${PORTS});
  reg [7:0] mem [0:15];
  initial $readmemh("../data/mem.hex", mem);
  assign uo_out = mem[ui_in[3:0]];
  assign uio_out = 8'd0;
  assign uio_oe = 8'd0;
endmodule
`;

test('$readmemh reads from dataFiles by literal path', async () => {
  const built = await build(MEM_DESIGN, { '../data/mem.hex': 'A5\n01\n02\n03\n' });
  if (!built.ok) throw new Error(built.message);
  const mod = built.sim.mod;
  mod.tick2(1);
  expect(mod.state.uo_out).toBe(0xa5);
  built.sim.dispose();
});

test('missing $readmemh file → ok:false message names the file', async () => {
  const built = await build(MEM_DESIGN, {});
  expect(built.ok).toBe(false);
  if (built.ok) return;
  expect(built.message).toContain('../data/mem.hex');
});

test('uiIn carried into the new sim', async () => {
  const built = await build(
    `module tt_um_t(${PORTS});
  assign uo_out = ui_in;
  assign uio_out = 8'd0;
  assign uio_oe = 8'd0;
endmodule
`,
    {},
    0b1010_0101,
  );
  if (!built.ok) throw new Error(built.message);
  expect(built.sim.mod.state.ui_in).toBe(0b1010_0101);
  built.sim.dispose();
});

test('malformed xml → ok:false, no throw', async () => {
  const built = await buildSim({
    xml: '<nope',
    topModule: 'x',
    dataFiles: {},
    adapter: tinyTapeoutAdapter,
    uiIn: 0,
  });
  expect(built.ok).toBe(false);
});
