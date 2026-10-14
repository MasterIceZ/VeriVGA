import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { PNG } from 'pngjs';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import { HDLModuleWASM } from '../../src/sim/hdlwasm';
import { compileVerilator } from '../../src/sim/verilator/compile';
import {
  detectSyncPolarity,
  renderVGAFrame,
  resetModule,
  skipToFrameBoundary,
  VGA_HEIGHT,
  VGA_WIDTH,
} from '../../src/sim/vga';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const wasmBinary = readFileSync(resolve(root, 'src/sim/verilator/verilator_bin.wasm'));

// Verilator calls process.exit when -Wall warnings are fatal (e.g. music, drop). A browser's
// Emscripten swallows that and the XML is still produced; emulate it with a no-op.
const originalExit = process.exit;
beforeAll(() => {
  process.setMaxListeners(40);
  process.exit = vi.fn() as never;
});
afterAll(() => {
  process.exit = originalExit;
});

const ids = ['stripes', 'music', 'rings', 'logo', 'conway', 'checkers', 'drop', 'gamepad'];

test.each(ids)('frame 0 of %s matches upstream golden', async (id) => {
  const dir = resolve(root, 'examples', id);
  const info = parse(readFileSync(resolve(dir, 'info.yaml'), 'utf8')).project;
  const sources: Record<string, string> = {};
  for (const f of info.source_files as string[]) {
    sources[f] = readFileSync(resolve(dir, 'src', f), 'utf8');
  }

  const res = await compileVerilator({ topModule: info.top_module, sources, wasmBinary });
  if (!res.output) {
    throw new Error(`Compilation failed: ${res.errors.map((e) => e.message).join('\n')}`);
  }
  const constpool = res.output.modules['@CONST-POOL@'] || res.output.modules['__Vconst'];
  const mod = new HDLModuleWASM(res.output.modules['TOP'], constpool);
  await mod.init();
  resetModule(mod);
  const polarity = detectSyncPolarity(mod);
  resetModule(mod);
  skipToFrameBoundary(mod, polarity);
  const pixels = new Uint8Array(VGA_WIDTH * VGA_HEIGHT * 4);
  renderVGAFrame(mod, pixels, { polarity });
  mod.dispose();

  const png = PNG.sync.read(readFileSync(resolve(root, 'test/golden', `${id}.png`)));
  expect(Buffer.from(pixels).equals(Buffer.from(png.data))).toBe(true);
});
