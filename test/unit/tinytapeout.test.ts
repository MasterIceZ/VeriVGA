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

// Verilator's Emscripten glue calls process.exit after -Wall warnings; the XML is already written.
const originalExit = process.exit;
beforeAll(() => {
  process.setMaxListeners(40);
  process.exit = vi.fn() as never;
});
afterAll(() => {
  process.exit = originalExit;
});

async function xmlFor(topModule: string, sources: Record<string, string>): Promise<string> {
  const res = await runVerilator({ topModule, sources, wasmBinary });
  if (!res.xml) throw new Error(res.errors.map((e) => e.message).join('\n'));
  return res.xml;
}

test('stripes builds, validates and renders a frame with vsync', async () => {
  const dir = resolve(root, 'examples/stripes/src');
  const sources = {
    'project.v': readFileSync(resolve(dir, 'project.v'), 'utf8'),
    'hvsync_generator.v': readFileSync(resolve(dir, 'hvsync_generator.v'), 'utf8'),
  };
  const xml = await xmlFor('tt_um_vga_example', sources);
  const built = await buildSim({
    xml,
    topModule: 'tt_um_vga_example',
    dataFiles: {},
    adapter: tinyTapeoutAdapter,
    uiIn: 0,
  });
  if (!built.ok) throw new Error(built.message);
  const pixels = new Uint8Array(VGA_WIDTH * VGA_HEIGHT * 4);
  const r = tinyTapeoutAdapter.renderFrame(built.sim.mod, pixels, built.sim.polarity);
  built.sim.dispose();
  expect(r.vsyncSeen).toBe(true);
});

test('module without TT ports → validate message, no throw', async () => {
  const xml = await xmlFor('plain', {
    'plain.v': `module plain(input clk, output hsync, output vsync, output [3:0] red);
  reg [3:0] c;
  always @(posedge clk) c <= c + 1;
  assign hsync = c[0];
  assign vsync = c[1];
  assign red = c;
endmodule
`,
  });
  const built = await buildSim({
    xml,
    topModule: 'plain',
    dataFiles: {},
    adapter: tinyTapeoutAdapter,
    uiIn: 0,
  });
  expect(built.ok).toBe(false);
  if (built.ok) return;
  expect(built.message).toContain("doesn't have the TinyTapeout port list");
  expect(built.message).toContain('uo_out');
  expect(built.message).toContain('`plain`');
});
