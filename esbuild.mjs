import * as esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

// Node-only modules that Emscripten (Verilator, binaryen) requires inside its
// ENVIRONMENT_IS_NODE branch. Never loaded in a browser, so leave them unresolved.
const emscriptenNodeOnly = ['fs', 'path', 'child_process', 'module'];

const allConfigs = [
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
    external: ['vscode', ...emscriptenNodeOnly],
  },
  {
    // Emscripten only detects a worker when importScripts exists, so no module worker.
    ...common,
    entryPoints: ['src/webview/compileWorker.ts'],
    outfile: 'dist/compileWorker.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    external: ['vscode', ...emscriptenNodeOnly],
  },
  // E2E tests. Desktop: one cjs/node file per test for @vscode/test-cli.
  {
    ...common,
    entryPoints: ['test/e2e/**/*.test.ts'],
    outbase: 'test/e2e',
    outdir: 'dist/test/e2e',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  // Web: the mocha runner, with the tests bundled in, for @vscode/test-web.
  {
    ...common,
    entryPoints: ['test/e2e/web/index.ts'],
    outfile: 'dist/web/test/index.js',
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    external: ['vscode'],
    alias: { assert: './test/e2e/web/assert.ts' },
  },
];

// The production build (vsce prepublish) ships runtime files only; the E2E bundles are the
// last two entries.
const configs = production ? allConfigs.slice(0, -2) : allConfigs;

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
