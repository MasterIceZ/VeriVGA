import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { PNG } from 'pngjs';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import type { HDLModuleWASM } from '../../src/sim/hdlwasm';
import { runVerilator } from '../../src/sim/verilator/compile';
import { skipToFrameBoundary, VGA_HEIGHT, VGA_WIDTH } from '../../src/sim/vga';
import { tinyTapeoutAdapter } from '../../src/webview/adapters/tinytapeout';
import type { InputState } from '../../src/webview/adapters/types';
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

const input = (uiIn: number, enabled: boolean, buttons = 0): InputState => ({
  uiIn,
  gamepad: { enabled, buttons },
});

describe('tinyTapeoutAdapter.setInputs', () => {
  test('disabled: ui_in equals uiIn exactly', () => {
    const mod = { state: { ui_in: 0 } } as unknown as HDLModuleWASM;
    tinyTapeoutAdapter.setInputs(mod, input(0xff, false, 0xfff));
    expect(mod.state.ui_in).toBe(0xff);
  });

  test('enabled: only bits 4-6 change', () => {
    const mod = { state: { ui_in: 0 } } as unknown as HDLModuleWASM;
    tinyTapeoutAdapter.setInputs(mod, input(0b1000_1111, true, 0));
    expect(mod.state.ui_in & 0b1000_1111).toBe(0b1000_1111);
    tinyTapeoutAdapter.setInputs(mod, input(0b1111_1111, true, 0xfff));
    expect(mod.state.ui_in & 0b1000_1111).toBe(0b1000_1111);
  });
});

const dir = resolve(root, 'examples/gamepad');
const info = parse(readFileSync(resolve(dir, 'info.yaml'), 'utf8')).project;

async function gamepadXml(): Promise<string> {
  const sources: Record<string, string> = {};
  for (const f of info.source_files as string[]) {
    sources[f] = readFileSync(resolve(dir, 'src', f), 'utf8');
  }
  const res = await runVerilator({ topModule: info.top_module, sources, wasmBinary });
  if (!res.xml) throw new Error(res.errors.map((e) => e.message).join('\n'));
  return res.xml;
}

async function frames(xml: string, inp: InputState, n: number): Promise<Uint8Array> {
  const built = await buildSim({
    xml,
    topModule: info.top_module,
    dataFiles: {},
    adapter: tinyTapeoutAdapter,
    input: inp,
  });
  if (!built.ok) throw new Error(built.message);
  const mod = built.sim.mod;
  skipToFrameBoundary(mod, built.sim.polarity);
  const pixels = new Uint8Array(VGA_WIDTH * VGA_HEIGHT * 4);
  for (let i = 0; i < n; i++) {
    tinyTapeoutAdapter.renderFrame(mod, pixels, built.sim.polarity, inp);
  }
  built.sim.dispose();
  return pixels;
}

describe('gamepad design on real Verilator', () => {
  test('buttons change the frame; gamepad off matches golden', async () => {
    const xml = await gamepadXml();
    const pressed = await frames(xml, input(0, true, (1 << 4) | (1 << 8)), 3);
    const idle = await frames(xml, input(0, true, 0), 3);
    expect(Buffer.from(pressed).equals(Buffer.from(idle))).toBe(false);

    const off = await frames(xml, input(0, false), 1);
    const golden = PNG.sync.read(readFileSync(resolve(root, 'test/golden/gamepad.png')));
    expect(Buffer.from(off).equals(Buffer.from(golden.data))).toBe(true);
  }, 60_000);
});
