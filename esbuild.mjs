import * as esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.env.NODE_ENV === 'production';

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const configs = [
  {
    ...common,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/web/extension.js',
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: { webview: 'src/webview/main.ts' },
    outdir: 'dist',
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    external: ['vscode', 'fs', 'path'],
  },
  {
    // Emscripten only detects a worker when importScripts exists, so no module worker.
    ...common,
    entryPoints: ['src/webview/compileWorker.ts'],
    outfile: 'dist/compileWorker.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    external: ['vscode', 'fs', 'path'],
  },
];

function copyAssets() {
  mkdirSync('dist', { recursive: true });
  const wasm = 'src/sim/verilator/verilator_bin.wasm';
  if (existsSync(wasm)) copyFileSync(wasm, 'dist/verilator_bin.wasm');
  const css = 'src/webview/styles.css';
  if (existsSync(css)) copyFileSync(css, 'dist/webview.css');
}

if (watch) {
  copyAssets();
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching...');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  copyAssets();
}
