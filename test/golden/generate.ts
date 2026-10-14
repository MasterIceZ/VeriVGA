/**
 * Generates golden frames from UNMODIFIED upstream vga-playground code.
 *
 *   npx vite-node test/golden/generate.ts -- "$UPSTREAM"
 *
 * Imports compile/sim/vga from "$UPSTREAM/src" (not from our port), renders frame 0 of each
 * preset twice, fails if the renders differ, then writes test/golden/<id>.png and
 * test/golden/UPSTREAM_COMMIT.
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { PNG } from 'pngjs';
import { fileURLToPath } from 'url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2).filter((a) => a !== '--');
if (!args.length) {
  console.error('usage: vite-node test/golden/generate.ts -- <upstream-checkout>');
  process.exit(2);
}
const upstream = resolve(args[0]);
const realExit = process.exit;

const ids = ['stripes', 'music', 'rings', 'logo', 'conway', 'checkers', 'drop', 'gamepad'];

async function main() {
  const { compileVerilator } = await import(resolve(upstream, 'src/verilator/compile.ts'));
  const { HDLModuleWASM } = await import(resolve(upstream, 'src/sim/hdlwasm.ts'));
  const vga = await import(resolve(upstream, 'src/sim/vga.ts'));
  const wasmBinary = readFileSync(resolve(upstream, 'src/verilator/verilator_bin.wasm'));

  // Verilator calls process.exit when -Wall warnings are fatal (e.g. music, drop). In a browser
  // Emscripten swallows that via ExitStatus and the XML is still produced, so emulate that here
  // by making process.exit a no-op. Compilation failures still surface via res.errors.
  process.setMaxListeners(40);
  process.exit = (() => undefined) as never;

  async function render(sources: Record<string, string>, topModule: string) {
    const res = await compileVerilator({ topModule, sources, wasmBinary });
    if (!res.output) {
      throw new Error(
        `Compilation failed: ${res.errors.map((e: { message: string }) => e.message).join('\n')}`,
      );
    }
    const constpool = res.output.modules['@CONST-POOL@'] || res.output.modules['__Vconst'];
    const mod = new HDLModuleWASM(res.output.modules['TOP'], constpool);
    await mod.init();
    vga.resetModule(mod);
    const polarity = vga.detectSyncPolarity(mod);
    vga.resetModule(mod);
    vga.skipToFrameBoundary(mod, polarity);
    const pixels = new Uint8Array(vga.VGA_WIDTH * vga.VGA_HEIGHT * 4);
    vga.renderVGAFrame(mod, pixels, { polarity });
    mod.dispose();
    return pixels;
  }

  for (const id of ids) {
    const dir = resolve(root, 'examples', id);
    const info = parse(readFileSync(resolve(dir, 'info.yaml'), 'utf8')).project;
    const sources: Record<string, string> = {};
    for (const f of info.source_files as string[]) {
      sources[f] = readFileSync(resolve(dir, 'src', f), 'utf8');
    }
    const a = await render(sources, info.top_module);
    const b = await render(sources, info.top_module);
    const deterministic = Buffer.from(a).equals(Buffer.from(b));
    console.log(`${id}: determinism ${deterministic ? 'OK' : 'FAIL'}`);
    if (!deterministic) {
      console.error(`preset "${id}" rendered differently on two runs`);
      realExit(1);
    }
    const png = new PNG({ width: vga.VGA_WIDTH, height: vga.VGA_HEIGHT });
    png.data = Buffer.from(a);
    const out = resolve(root, 'test/golden', `${id}.png`);
    if (id === 'stripes') {
      const ref = PNG.sync.read(readFileSync(out));
      const same = Buffer.from(a).equals(Buffer.from(ref.data));
      console.log(`stripes: pixels ${same ? 'match' : 'DIFFER from'} committed upstream PNG`);
      if (!same) {
        console.error('stripes does not reproduce upstream golden; render sequence is wrong');
        realExit(1);
      }
      continue; // keep upstream's committed file untouched
    }
    writeFileSync(out, PNG.sync.write(png));
  }

  const hash = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  writeFileSync(resolve(root, 'test/golden/UPSTREAM_COMMIT'), hash + '\n');
  console.log(`upstream commit ${hash}`);
}

main().then(
  () => realExit(0),
  (e) => {
    console.error(e);
    realExit(1);
  },
);
