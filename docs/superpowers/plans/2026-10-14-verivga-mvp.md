# VeriVGA MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code extension (desktop and web) that live-renders the VGA output of a
TinyTapeout Verilog project in a webview, re-rendering about 300 ms after the user stops
typing.

**Architecture:** The extension host discovers the project, reads sources (unsaved buffers
first), debounces edits, and sends `load` messages. The webview runs Verilator (WASM) in a
classic Web Worker, builds the simulator (ported vga-playground `HDLModuleWASM` + binaryen)
on the main thread, and renders with upstream's `renderVGAFrame`. Diagnostics flow back to
the host. All TinyTapeout pin knowledge sits behind one adapter.

**Tech Stack:** TypeScript (strict), esbuild, VS Code API ≥ 1.90, binaryen 117.0.0, yaml 2,
vitest 3 (+ jsdom, pngjs), @vscode/test-cli + @vscode/test-electron, @vscode/test-web,
@vscode/vsce, ESLint 9 + typescript-eslint, Prettier 3.

**Spec:** `docs/superpowers/specs/2026-10-14-verivga-mvp-design.md` (requirements in
`docs/requirements.md`, project rules in `CLAUDE.md`). Executors read all three.

**Upstream:** the reference checkout of `https://github.com/TinyTapeout/vga-playground` at
commit `3e3c77e46ae7bd51609f680851aabb81a30564a6` (call it `$UPSTREAM`). Clone it once:
`git clone https://github.com/TinyTapeout/vga-playground "$UPSTREAM" && git -C "$UPSTREAM" checkout 3e3c77e`.

## Global Constraints

- `engines.vscode`: `^1.90.0`; `@types/vscode`: `~1.90.0`. Dev Node: 22+.
- `package.json` `license`: `GPL-3.0-only`; `name`: `verivga`; `displayName`: `VeriVGA`.
- Command IDs: `verivga.openPreview` (title "VeriVGA: Open Preview"). The test-only
  commands are registered only when `extensionMode === ExtensionMode.Test`:
  - `verivga._lastCompiled` returns the last `compiled` message;
  - `verivga._compiledLog` returns every `compiled` message, in order;
  - `verivga._postToWebview` takes a `HostToWebview` and posts it to the open panel.
- Settings: `verivga.liveUpdate` boolean, default `true`; `verivga.liveDelay` number,
  default `300`, min `0`, max `2000`; `verivga.topModule` string, default `""` (= auto).
- Canvas is **736×520** (`VGA_WIDTH`/`VGA_HEIGHT` from `src/sim/vga.ts`), scaled to fit with
  `image-rendering: pixelated`.
- Compile watchdog **20 000 ms**. No-sync threshold **420 000 ticks**. Stats at most every
  **500 ms**.
- Latency gate: median last-edit → `compiled ok` ≤ `liveDelay` + **700 ms** (desktop E2E).
- `src/extension/**` and `src/shared/**` import no Node built-ins; enforced by ESLint.
- `src/sim/**` is upstream code. Edit it only where Task 2 says, and log every edit in
  `src/sim/UPSTREAM.md`.
- Paths crossing the host↔webview bridge are project-relative with `/`. The webview never
  sees URIs.
- Prettier: `printWidth: 100`, `singleQuote: true`, `trailingComma: 'all'`, `tabWidth: 2`,
  plugin `prettier-plugin-organize-imports`.
- Commit after every task with a Conventional Commit message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **No usable folder.** No workspace is open, or there are several folders and the
   active file is outside all of them. Expect the message
   `Open a file inside a workspace folder` and no exception. With exactly one folder, an
   untitled or outside file falls back to that folder (Task 5, Task 12).
2. **Nested or duplicate basenames** (`src/a/top.v` and `src/b/top.v`). Diagnostics must
   land on the right file (Task 2, Task 10).
3. **Tab-indented source.** A Verilator error on a line starting with `\t` must squiggle
   the offending token, not a shifted column (Task 2).
4. **Panel closed while a compile is in flight.** No late diagnostics, no errors, the
   worker is terminated, and reopening works (Task 10, Task 12).
5. **Top module without TT ports** (e.g. a generic VGA module). Expect a banner while the
   previous design keeps running, never a crash (Task 6, Task 11).

---

## M0: Walking skeleton (Tasks 1–3)

### Task 1: Scaffold, build, lint rule, licenses

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `eslint.config.mjs`,
  `prettier.config.js`, `vitest.config.ts`, `.gitignore`, `.vscodeignore`, `LICENSE`,
  `NOTICE`, `src/extension/extension.ts` (stub), `src/webview/main.ts` (stub),
  `src/webview/compileWorker.ts` (stub), `src/webview/styles.css` (empty)
- Test: `test/unit/lint-rule.test.ts`

**Interfaces:**
- Produces: `npm run build` → `dist/extension.js` (cjs/node, `main`),
  `dist/web/extension.js` (cjs/browser, `browser`), `dist/webview.js` (esm/browser,
  target `es2022`), `dist/compileWorker.js` (**iife**/browser: Emscripten only detects
  a worker when `importScripts` exists, so it can't be a module worker),
  `dist/verilator_bin.wasm` and `dist/webview.css` (copied). The webview and worker
  bundles mark `fs` and `path` external (dead Node branches in `verilator_bin.js`).
  `vscode` is external everywhere.
- Scripts: `build`, `watch`, `typecheck` (`tsc --noEmit`), `lint` (`eslint .`), `format`,
  `test` (`vitest run`), `test:e2e` (`vscode-test`), `test:web`, `open:web`, `package`
  (`vsce package`). `test:e2e`, `test:web` and `open:web` get their configs in Task 3.
- Manifest `contributes`:
  - `commands`: `verivga.openPreview`, icon `$(open-preview)`.
  - `menus.editor/title`: `verivga.openPreview` with `when` =
    `resourceExtname =~ /^\\.(s?v|s?vh)$/`. VS Code has no built-in Verilog language
    id, and `.v` is often detected as Coq.
  - `configuration`: the three settings from Global Constraints.

- [ ] **Step 1: Write the failing test** `test/unit/lint-rule.test.ts`, which uses the ESLint
  Node API with the repo config.

```ts
test('host code may not import Node built-ins', async () => {
  const [r] = await eslint.lintText("import * as fs from 'fs';\n", { filePath: 'src/extension/probe.ts' });
  expect(r.messages.map((m) => m.ruleId)).toContain('no-restricted-imports');
});
test('node: specifiers are blocked in shared code', async () => {
  const [r] = await eslint.lintText("import p from 'node:path';\n", { filePath: 'src/shared/probe.ts' });
  expect(r.messages.map((m) => m.ruleId)).toContain('no-restricted-imports');
});
test('Buffer global is blocked in host code', async () => {
  const [r] = await eslint.lintText('export const b = Buffer.from("x");\n', { filePath: 'src/extension/probe.ts' });
  expect(r.messages.map((m) => m.ruleId)).toContain('no-restricted-globals');
});
```

- [ ] **Step 2: Run it.** `npx vitest run test/unit/lint-rule.test.ts` should FAIL
  (no config / no packages).
- [ ] **Step 3: Create the scaffold files listed above.**
  - ESLint: for `src/extension/**` and `src/shared/**`, `no-restricted-imports` with
    `paths` `fs, path, os, child_process, crypto, buffer, util, url, process` and
    `patterns` `node:*`; `no-restricted-globals` for `Buffer, process, __dirname,
    __filename, require`. `src/sim/**` is ignored by lint.
  - `vitest.config.ts`: include `src/**/*.spec.ts`, `test/unit/**/*.test.ts`,
    `test/golden/**/*.test.ts`, with `testTimeout: 60000`.
  - `LICENSE`: the GPL-3.0 text copied from `$UPSTREAM/LICENSE`.
  - `NOTICE`: credits Tiny Tapeout / Uri Shaked (vga-playground, Apache-2.0 parts) and
    8bitworkshop / Steven Hugg (GPL-3.0 simulator).
  - `.vscodeignore`: excludes `src/`, `test/`, `docs/`, `node_modules/`, `*.map`.
  - Install dependencies: `binaryen@117.0.0`, `yaml@^2`.
- [ ] **Step 4: Run** `npx vitest run test/unit/lint-rule.test.ts && npm run build && ls dist`.
  Expect PASS, and `dist/` lists `extension.js web/ webview.js compileWorker.js verilator_bin.wasm webview.css`.
  (The wasm copy may be skipped until Task 2 adds the file; the build must not fail if
  it's missing.)
- [ ] **Step 5: Commit** `chore: scaffold extension, build, lint rule and licenses`.

### Task 2: Port the simulator and Verilator

**Files:**
- Copy verbatim:
  - `$UPSTREAM/src/sim/*` → `src/sim/`, including its `*.spec.ts` and `README.txt`.
  - `$UPSTREAM/src/verilator/*` → `src/sim/verilator/`.
  - `$UPSTREAM/src/verilog.ts` and `verilog.spec.ts` → `src/shared/`.
  - The `extractReadmemPaths` and `extractIncludePaths` functions from
    `$UPSTREAM/src/github/loadProject.ts` → `src/shared/verilogRefs.ts`.
- Copy the stripes example into TT layout: `examples/stripes/{info.yaml,src/project.v,src/hvsync_generator.v,LICENSE.txt}`.
  Copy `reference/frame0.png` → `test/golden/stripes.png`.
- Modify: `src/sim/verilator/compile.ts` (the split below);
  `src/sim/vga-integration.spec.ts`, `hdlwasm-integration.spec.ts`,
  `hdlruntime.spec.ts` (fixture paths and the wasm path only).
- Create: `src/sim/UPSTREAM.md`, `src/sim/verilator/messages.ts`, `src/shared/protocol.ts` (types only, see Task 3 for guards)
- Test: `src/sim/verilator/messages.spec.ts`

**Interfaces:**
- Produces, in `src/sim/verilator/compile.ts`:
  - `interface RunVerilatorOptions { topModule: string; sources: Record<string, string>; wasmBinary?: ArrayBuffer | Uint8Array; wasmModule?: WebAssembly.Module }`
  - `runVerilator(opts: RunVerilatorOptions): Promise<{ xml?: string; errors: IErrorMessage[] }>`.
    It writes each source to `src/<relpath>` (creating directories) and passes `-I` for
    every distinct source directory. Like upstream, `.vh`/`.svh` files are not passed
    as sources. The flags are upstream's.
  - `parseVerilatorXml(xml: string): VerilogXMLParser` (throws on failure).
  - `compileVerilator(opts)`: upstream's signature and result shape, implemented as
    `runVerilator` + `parseVerilatorXml`. Ported specs keep using it.
  - Remove the Vite `?url` import. With neither `wasmBinary` nor `wasmModule`, throw
    `Error('runVerilator: wasmBinary or wasmModule required')`.
  - When `wasmModule` is given, pass this Emscripten hook:
    ```ts
    instantiateWasm: (imports, receive) => {
      WebAssembly.instantiate(opts.wasmModule!, imports).then((inst) => receive(inst, opts.wasmModule));
      return {};
    },
    ```
- Produces, in `src/sim/verilator/messages.ts`:
  `toVerilatorMessages(errors: IErrorMessage[], sources: Record<string, string>): VerilatorMessage[]`.
  It strips the leading `src/` so `file` is the project-relative key used in `sources`.
  It converts Verilator's column to a 1-based **character** column using the line text
  from `sources` (needed if Verilator expands tabs). `endColumn` gets the same treatment.
  `severity` comes from `type`, and `code` from `warningClass`.
- Produces, in `src/shared/protocol.ts`: the `HostToWebview`, `WebviewToHost` and
  `VerilatorMessage` types exactly as in spec §2.2, plus
  `type LoadMessage = Extract<HostToWebview, { type: 'load' }>`.

- [ ] **Step 1: Copy the upstream files.** Fix only import paths and fixture paths. Write
  `src/sim/UPSTREAM.md`: upstream commit, the file map, and one line per edited file
  with the reason.
- [ ] **Step 2: Baseline the port before editing.** Run `npx vitest run src/`. Expect
  PASS: the specs pass `wasmBinary`, so the `?url` branch never runs. If anything fails
  here, it's a copy or path mistake, not a behavior change.
- [ ] **Step 3: Split `compile.ts`** as described in Interfaces.
- [ ] **Step 4: Run** `npx vitest run src/`. Expect PASS for every ported spec, including
  `vga-integration.spec.ts` (stripes frame matches `test/golden/stripes.png` byte for
  byte, for both sync polarities).
- [ ] **Step 5: Write the failing tests** in `src/sim/verilator/messages.spec.ts`, using
  real Verilator through `runVerilator` with `wasmBinary` from disk. Mock
  `process.exit` like upstream specs do.

```ts
test('nested duplicate basenames keep their own path', async () => {
  const sources = {
    'src/a/top.v': 'module a(input wire x); endmodule\n',
    'src/b/top.v': 'module b(input wire x); wire y = ; endmodule\n',
    'src/main.v': 'module tt_um_t(input wire clk); a ua(.x(clk)); b ub(.x(clk)); endmodule\n',
  };
  const { errors } = await runVerilator({ topModule: 'tt_um_t', sources, wasmBinary });
  const msgs = toVerilatorMessages(errors, sources);
  expect(msgs.find((m) => m.severity === 'error')?.file).toBe('src/b/top.v');
});
test('tab-indented error points at the token, not a tab-expanded column', async () => {
  const line = '\t\twire y = ;';
  const sources = { 'project.v': `module tt_um_t(input wire clk);\n${line}\nendmodule\n` };
  const { errors } = await runVerilator({ topModule: 'tt_um_t', sources, wasmBinary });
  const err = toVerilatorMessages(errors, sources).find((m) => m.severity === 'error')!;
  expect(err.line).toBe(2);
  expect(err.column).toBe(line.indexOf(';') + 1);
});
```

- [ ] **Step 6: Run** `npx vitest run src/sim/verilator/messages.spec.ts`. Expect FAIL
  (`toVerilatorMessages` is undefined).
- [ ] **Step 7: Implement `toVerilatorMessages`.** If the tab test shows Verilator
  doesn't expand tabs, the conversion is the identity. Keep it, and keep the test as a
  regression guard.
- [ ] **Step 8: Run** `npx vitest run src/`. Expect all PASS.
- [ ] **Step 9: Commit** `feat(sim): port vga-playground simulator and Verilator at 3e3c77e`.

### Task 3: Webview skeleton, worker compile, first frame (spike, kept)

**Files:**
- Create: `src/extension/webviewHtml.ts`, `src/extension/PreviewPanel.ts`,
  `src/webview/workerProtocol.ts`
- Modify: `src/shared/protocol.ts` (guards), `src/extension/extension.ts`,
  `src/webview/main.ts`, `src/webview/compileWorker.ts`, `esbuild.mjs` (test bundles)
- Create: `test/fixtures/stripes/` (copy of `examples/stripes`), `.vscode-test.mjs`,
  `test/e2e/preview.test.ts`, `test/e2e/web/index.ts`
- Test: `test/unit/webviewHtml.test.ts`, `test/unit/protocol.test.ts`, `test/e2e/preview.test.ts`
- Create: `docs/superpowers/notes/2026-10-14-m0-spike.md`

**Interfaces:**
- Produces, in `src/shared/protocol.ts`: `isHostToWebview(x: unknown): x is HostToWebview` and
  `isWebviewToHost(x: unknown): x is WebviewToHost`. These check `type` plus the
  required fields' types.
- Produces, in `src/extension/webviewHtml.ts`:
  `buildHtml(o: { cspSource: string; nonce: string; scriptUri: string; styleUri: string; wasmUri: string; workerUri: string }): string`
  and `makeNonce(): string` (32 chars from `crypto.getRandomValues`). The CSP is
  exactly:
  `default-src 'none'; img-src ${cspSource} blob: data:; style-src ${cspSource}; script-src 'nonce-${nonce}' ${cspSource} 'wasm-unsafe-eval'; worker-src blob:; connect-src ${cspSource};`.
  The wasm and worker URIs go into `<body data-wasm-uri data-worker-uri>`. The script
  tag is `<script type="module" nonce=…>`.
- Produces, in `src/extension/PreviewPanel.ts`, class `PreviewPanel`:
  - `static create(extensionUri: Uri, title: string, column: ViewColumn): PreviewPanel`
    uses `retainContextWhenHidden: true`, `enableScripts: true` and
    `localResourceRoots: [Uri.joinPath(extensionUri, 'dist')]`.
  - Members: `post(msg: HostToWebview): void`, `readonly visible: boolean`,
    `onMessage: Event<WebviewToHost>` (invalid messages are dropped),
    `onDidChangeVisible: Event<boolean>`, `onDidDispose: Event<void>`, `reveal(): void`,
    `dispose(): void`.
- Produces, in `src/webview/workerProtocol.ts`:
  - `ToWorker = { type: 'init'; wasmModule: WebAssembly.Module } | { type: 'compile'; generation: number; topModule: string; sources: Record<string, string> }`
  - `FromWorker = { type: 'result'; generation: number; xml?: string; messages: VerilatorMessage[]; ms: number } | { type: 'crash'; generation: number; message: string }`
- Webview boot, in `main.ts`:
  1. Fetch `data-wasm-uri` → `WebAssembly.compile(await res.arrayBuffer())`. Don't use
     `compileStreaming`: the MIME type isn't guaranteed.
  2. Fetch `data-worker-uri` text → Blob URL → `new Worker(blobUrl)` (classic) → post
     `init`.
  3. Post `ready`.
- Skeleton host behavior (replaced in Task 12): on `ready`, read `src/project.v` and
  `src/hvsync_generator.v` from the first workspace folder via `workspace.fs` and send
  `load` (generation 1, top `tt_um_vga_example`). On `compiled`, store it for
  `verivga._lastCompiled`.
- Skeleton webview behavior (replaced in Task 11): `load` → worker `compile` →
  `parseVerilatorXml` → `HDLModuleWASM` → `resetModule` / `detectSyncPolarity` /
  `resetModule` → `renderVGAFrame` into the canvas once → post `compiled`.
- E2E config:
  - Desktop: `.vscode-test.mjs` sets `files: 'dist/test/e2e/**/*.test.js'`,
    `workspaceFolder: 'test/fixtures/stripes'`, `mocha: { ui: 'tdd', timeout: 60000 }`.
  - Web: `test:web` = `vscode-test-web --browserType=chromium --headless --extensionDevelopmentPath=. --extensionTestsPath=dist/web/test/index.js test/fixtures/stripes`.
  - `open:web` is the same command without `--headless` and the tests path.
  - `test/e2e/web/index.ts` is the mocha browser runner (tdd) that imports
    `../preview.test`.
  - `esbuild.mjs` builds `test/e2e/**/*.test.ts` → `dist/test/e2e/` (cjs/node) and the
    web runner → `dist/web/test/index.js` (cjs/browser).
  - Run `npx playwright install chromium` once.

- [ ] **Step 1: Write the failing unit tests.**

```ts
// test/unit/webviewHtml.test.ts
const html = buildHtml({ cspSource: 'https://x.vscode-cdn.net', nonce: 'N0NCE', scriptUri: 's', styleUri: 'c', wasmUri: 'w', workerUri: 'k' });
expect(html).toContain("'wasm-unsafe-eval'");
expect(html).toContain('worker-src blob:');
expect(html).toMatch(/<script type="module" nonce="N0NCE"/);
expect(html).not.toMatch(/https?:\/\/(?!x\.vscode-cdn\.net)/);
// test/unit/protocol.test.ts
expect(isWebviewToHost({ type: 'compiled', generation: 1, ok: true, messages: [], ms: 5 })).toBe(true);
expect(isWebviewToHost({ type: 'compiled', generation: '1' })).toBe(false);
expect(isHostToWebview({ type: 'load', generation: 1, topModule: 't', sources: {}, dataFiles: {} })).toBe(true);
```

- [ ] **Step 2: Run** `npx vitest run test/unit/webviewHtml.test.ts test/unit/protocol.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `protocol.ts` guards, `webviewHtml.ts` and `PreviewPanel.ts`.
- [ ] **Step 4: Run the same command.** Expect PASS.
- [ ] **Step 5: Write the failing E2E test** `test/e2e/preview.test.ts`. It polls
  `verivga._lastCompiled` every 50 ms, up to 30 s.

```ts
test('opening the preview compiles stripes', async () => {
  await vscode.commands.executeCommand('verivga.openPreview');
  const c = await waitForCompiled((c) => c.ok);
  assert.strictEqual(c.ok, true);
  assert.deepStrictEqual(c.messages.filter((m) => m.severity === 'error'), []);
});
```

- [ ] **Step 6: Implement** the skeleton host, `main.ts` and `compileWorker.ts` behavior
  above, plus the E2E configs. The worker calls `runVerilator({ wasmModule, … })` →
  `toVerilatorMessages`, and posts `crash` if it throws.
- [ ] **Step 7: Run** `npm run build && npm run test:e2e && npm run test:web`. Expect both PASS.
  - If a blocker appears, apply the fallback and record it:
    - worker in webview fails → run Verilator on the main thread like upstream;
    - `WebAssembly.Module` can't be posted → post the bytes and compile in the worker;
    - binaryen top-level await fails in the bundle → wrap the import in an async
      `loadBinaryen()`.
  - Then re-run.
- [ ] **Step 8: Measure.** Use `npm run watch` + F5, then `npm run open:web`, and log
  `performance.now()` deltas to the console. Record in the spike note: wasm fetch+compile ms,
  Verilator ms, parse+binaryen ms and first-frame ms, for desktop and web, plus any
  fallbacks taken. If Verilator + parse + binaryen > 700 ms on desktop, flag it there.
- [ ] **Step 9: Commit** `feat: webview skeleton compiles and renders stripes (M0)`.

## M1: Golden frames (Task 4)

### Task 4: All 8 presets plus golden frames from unmodified upstream

**Files:**
- Create: `examples/{music,rings,logo,conway,checkers,drop,gamepad}/` in TT layout:
  - `info.yaml` with `project.title`, `author`, `top_module: tt_um_vga_example` and
    `source_files` relative to `src/`;
  - `src/*.v`, with shared files `hvsync_generator.v` and `gamepad_pmod.v` copied per
    example where its `index.ts` lists them;
  - `LICENSE.txt` from upstream.
- Create: `test/golden/generate.ts`, `test/golden/<id>.png` (7 new),
  `test/golden/UPSTREAM_COMMIT`, `test/golden/golden.test.ts`

**Interfaces:**
- Consumes: `compileVerilator` (Task 2), `src/sim/vga.ts`, `src/sim/hdlwasm.ts`.
- `generate.ts` runs as `npx vite-node test/golden/generate.ts -- "$UPSTREAM"`. It
  imports compile/sim/vga **from `$UPSTREAM/src`**, not from our port. For each preset
  it renders frame 0 using the same sequence as upstream's `vga-integration.spec.ts`:
  1. `resetModule`, `detectSyncPolarity`, `resetModule`
  2. `skipToFrameBoundary`
  3. `renderVGAFrame`

  It renders each preset **twice** and exits non-zero, naming the preset, if the two
  renders differ. It writes the PNGs and `UPSTREAM_COMMIT` (the full hash read from
  `git -C "$UPSTREAM" rev-parse HEAD`).

- [ ] **Step 1: Write the failing test** `test/golden/golden.test.ts`. It runs
  `test.each` over the 8 ids, reading sources from `examples/<id>/info.yaml` +
  `src/`, rendering with **our** `src/sim`, and asserting
  `Buffer.from(pixels).equals(Buffer.from(png.data))`.
- [ ] **Step 2: Run** `npx vitest run test/golden`. Expect FAIL (7 PNGs missing).
- [ ] **Step 3: Add the 7 example folders.** Implement `generate.ts`, run it, and commit
  the PNGs.
- [ ] **Step 4: Run** `npx vitest run test/golden`. Expect 8 PASS.
- [ ] **Step 5: Commit** `test: golden frames for all presets from upstream 3e3c77e`.

## M2: Project to pixels (Tasks 5–6)

### Task 5: Project discovery and source gathering (host)

**Files:**
- Create: `src/extension/project.ts`, `src/extension/sources.ts`, `test/unit/fakes/vscode.ts`,
  `test/unit/fakes/memfs.ts`
- Modify: `vitest.config.ts` (alias `vscode` → `test/unit/fakes/vscode.ts`)
- Test: `test/unit/project.test.ts`, `test/unit/sources.test.ts`

**Interfaces:**
- Consumes: `detectTopModule` (`src/shared/verilog.ts`), `extractReadmemPaths` and
  `extractIncludePaths` (`src/shared/verilogRefs.ts`).
- Produces, in `project.ts`:
  - `type FsLike = Pick<vscode.FileSystem, 'readDirectory' | 'readFile' | 'stat'>`
  - `interface ProjectSpec { folder: vscode.WorkspaceFolder; root: vscode.Uri; files: Map<string, vscode.Uri>; topModule: string; infoYaml?: vscode.Uri }`.
    Keys of `files` are root-relative (`src/project.v`).
  - `type DiscoverResult = { ok: true; project: ProjectSpec } | { ok: false; reason: 'no-folder' | 'no-sources' | 'bad-info-yaml'; message: string; infoYaml?: vscode.Uri; problems?: { line: number; message: string }[] }`
  - `discover(o: { activeUri?: vscode.Uri; folders: readonly vscode.WorkspaceFolder[]; topModuleSetting: string; fs: FsLike }): Promise<DiscoverResult>`. Rules:
    1. The folder is the one containing `activeUri`. If `activeUri` is missing, untitled
       or outside every folder, use the only folder when there is exactly one.
       Otherwise return `no-folder` with the message
       `Open a file inside a workspace folder`.
    2. Look for `info.yaml` in the folder root. If present, `root` = folder,
       `files` = `src/<source_files[i]>`, and the top module is `project.top_module`.
    3. With no `info.yaml`: `root` = the active file's directory (or the folder),
       `files` = its `*.v|*.sv|*.vh|*.svh`, and the top module is `detectTopModule` over
       a basename→text map.
    4. A non-empty `topModuleSetting` always wins.
    5. If `info.yaml` lists a missing file, return `bad-info-yaml`, with `problems`
       giving the 0-based line of that entry and the message
       `Source file not found: src/<name>`.
- Produces, in `sources.ts`, class `SourceReader`:
  - `constructor(d: { fs: FsLike; openText(uri: vscode.Uri): string | undefined; onReadError(uri: vscode.Uri, err: unknown): void })`
  - `read(uri: vscode.Uri): Promise<string | undefined>`: open-document text first, then
    the cache, then `fs`. `onReadError` fires at most once per URI until `invalidate`.
  - `invalidate(uri: vscode.Uri): void`
  - `gather(p: ProjectSpec): Promise<{ sources: Record<string, string>; dataFiles: Record<string, string>; relToUri: Map<string, vscode.Uri> }>`.
    It resolves `` `include "x" `` against the including file's directory, then `src/`,
    then root, repeating until no new files appear, and adds them to `sources`.
    `$readmem` paths are resolved the same way into `dataFiles`, **keyed by the literal
    string** in the source, because `HDLModuleWASM.getFileData` receives the literal.
    Missing references are skipped: Verilator or the runtime reports them.

- [ ] **Step 1: Write the failing tests** (`memfs` is an in-memory `FsLike`).

```ts
test('info.yaml drives sources and top module', …)  // files = {src/project.v, src/hvsync_generator.v}, topModule from yaml
test('folder fallback detects tt_um_ top module', …)  // no info.yaml; topModule === 'tt_um_foo'
test('setting overrides top module', …)
test('missing source in info.yaml → bad-info-yaml with line', …)  // problems[0].line === index of that list line
test('malformed info.yaml → bad-info-yaml with the parser line', …)
test('two folders, active file outside both → no-folder', …)     // Review Focus 1
test('one folder, untitled active document → uses that folder', …) // Review Focus 1
test('no workspace folders → no-folder', …)                      // Review Focus 1
test('no .v files → no-sources', …)
// sources.test.ts
test('open document text wins over disk', …)
test('include and readmem are resolved and keyed correctly', …)  // dataFiles['image.hex'] present
test('read error reported once per uri until invalidate', …)
```

- [ ] **Step 2: Run** `npx vitest run test/unit/project.test.ts test/unit/sources.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `project.ts`, `sources.ts` and the fakes.
- [ ] **Step 4: Run the same command.** Expect PASS.
- [ ] **Step 5: Commit** `feat(host): project discovery and source gathering`.

### Task 6: TinyTapeout adapter and simulator builder (webview)

**Files:**
- Create: `src/webview/adapters/types.ts`, `src/webview/adapters/tinytapeout.ts`, `src/webview/simHost.ts`
- Test: `test/unit/tinytapeout.test.ts`, `test/unit/simHost.test.ts`

**Interfaces:**
- Consumes: `parseVerilatorXml`, `runVerilator` (tests only), `HDLModuleWASM`, `src/sim/vga.ts`.
- Produces, in `types.ts`:

```ts
export interface FrameResult { vsyncSeen: boolean }
export interface VgaAdapter {
  validate(mod: HDLModuleWASM, topModule: string): string | null; // null = ok, else user-facing message
  reset(mod: HDLModuleWASM): void;
  detectPolarity(mod: HDLModuleWASM): SyncPolarity;
  setInputs(mod: HDLModuleWASM, uiIn: number): void;
  renderFrame(mod: HDLModuleWASM, pixels: Uint8Array, polarity: SyncPolarity): FrameResult;
}
```

- Behavior of `tinyTapeoutAdapter: VgaAdapter` (in `tinytapeout.ts`):
  - **`validate`:** returns
    ``Top module `${topModule}` doesn't have the TinyTapeout port list (missing: ${names})``
    when any of `ui_in uo_out uio_in uio_out uio_oe ena clk rst_n` is absent.
    `globals.lookup` returns `undefined` for a missing name.
  - **`reset`:** `resetModule`.
  - **`renderFrame`:** `renderVGAFrame`, then waits for vsync to assert and then
    deassert, each wait capped at **420 000** `tick2(1)` steps. `vsyncSeen` is false if
    either cap is hit.
- Produces, in `simHost.ts`:
  - `interface RunningSim { mod: HDLModuleWASM; polarity: SyncPolarity; topModule: string; dispose(): void }`
  - `type BuildResult = { ok: true; sim: RunningSim } | { ok: false; message: string; stack?: string }`
  - `buildSim(o: { xml: string; topModule: string; dataFiles: Record<string, string>; adapter: VgaAdapter; uiIn: number }): Promise<BuildResult>`.
    The sequence is parse → `new HDLModuleWASM(modules.TOP, modules['@CONST-POOL@'] ?? modules.__Vconst)`
    → `init()` → `getFileData = (p) => dataFiles[p]` → `validate` (dispose on failure)
    → `reset`, `detectPolarity`, `reset` → `setInputs(uiIn)`.
    It never throws: every failure becomes `ok: false`.

- [ ] **Step 1: Write the failing tests** (real Verilator, stripes sources from `examples/stripes`).

```ts
test('stripes builds, validates and renders a frame with vsync', …)    // ok, vsyncSeen === true
test('module without TT ports → validate message, no throw', …)       // Review Focus 5: message contains "doesn't have the TinyTapeout port list" and "uo_out"
test('design with no sync → vsyncSeen false within cap', …)           // uo_out = 0
test('$readmemh reads from dataFiles by literal path', …)              // mem[0] observable via uo_out
test('missing $readmemh file → ok:false message names the file', …)
test('uiIn carried into the new sim', …)                               // mod.state.ui_in === 0b1010_0101
```

- [ ] **Step 2: Run** `npx vitest run test/unit/tinytapeout.test.ts test/unit/simHost.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `types.ts`, `tinytapeout.ts` and `simHost.ts`.
- [ ] **Step 4: Run the same command.** Expect PASS.
- [ ] **Step 5: Commit** `feat(webview): TinyTapeout adapter and sim builder`.

## M3: Live update (Tasks 7–9)

### Task 7: Compile queue (webview, pure)

**Files:**
- Create: `src/webview/compileQueue.ts`
- Test: `test/unit/compileQueue.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CompileJob { generation: number; topModule: string; sources: Record<string, string>; dataFiles: Record<string, string> }
export class CompileQueue {
  constructor(d: { start(job: CompileJob): void; onTimeout(job: CompileJob): void; timeoutMs?: number /* default 20_000 */ });
  submit(job: CompileJob): void;               // idle → start now; running → replace pending
  complete(generation: number): CompileJob | null; // returns the job to APPLY, or null if superseded/unknown; then starts pending if any
  readonly busy: boolean;
  dispose(): void;                              // clears watchdog, drops pending
}
```

- [ ] **Step 1: Write the failing tests** (`vi.useFakeTimers()`).

```ts
test('idle submit starts immediately', …)
test('submits while running keep only the newest pending', …)    // submit g1, g2, g3 → start called with g1 then (after complete(1)) g3; g2 never
test('result with a pending newer job is dropped', …)            // complete(1) returns null when g3 pending
test('result without pending is applied', …)                    // complete(3) returns job g3
test('stale or unknown generation returns null', …)
test('watchdog fires onTimeout at 20 000 ms and starts pending', …)
test('dispose stops the watchdog', …)
```

- [ ] **Step 2: Run** `npx vitest run test/unit/compileQueue.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `CompileQueue`.
- [ ] **Step 4: Run the same command.** Expect PASS.
- [ ] **Step 5: Commit** `feat(webview): latest-wins compile queue with watchdog`.

### Task 8: Render loop and controls UI (webview)

**Files:**
- Create: `src/webview/renderLoop.ts`, `src/webview/ui/controls.ts`, `src/webview/ui/banner.ts`
- Modify: `src/webview/styles.css`
- Test: `test/unit/renderLoop.test.ts`, `test/unit/ui.test.ts` (`// @vitest-environment jsdom`)

**Interfaces:**
- Consumes: `RunningSim` and `VgaAdapter` (Task 6).
- Produces, in `renderLoop.ts`:

```ts
export class RenderLoop {
  constructor(o: {
    draw(pixels: Uint8ClampedArray): void;       // main.ts puts it on the canvas
    adapter: VgaAdapter;
    onStats(fps: number): void;                   // ≤ 1 call / 500 ms
    onNoSync(noSync: boolean): void;              // only on change
    onRuntimeError(err: Error): void;             // loop pauses itself first
    requestFrame?: (cb: (t: number) => void) => number; cancelFrame?: (id: number) => void;
  });
  setSim(sim: RunningSim): void;   // swap at the start of the next frame; old sim disposed after swap
  readonly sim: RunningSim | null;
  uiIn: number;                    // setter applies to the current sim immediately
  pause(): void; resume(): void; readonly paused: boolean;
  setVisible(v: boolean): void;    // hidden → no frames rendered
  reset(): void;                   // adapter.reset on current sim, keeps uiIn
  dispose(): void;                 // disposes current sim
}
```

- Produces, in `ui/controls.ts`, class `Controls`:
  - `constructor(root: HTMLElement, h: { onUiIn(v: number): void; onReset(): void; onPauseToggle(): void })`
    renders 8 `ui_in` toggles, Reset, Pause, an fps readout and a "compiling…" marker.
  - Keys `0`–`7` toggle bits; `r`/`R` resets.
  - Members: `setUiIn(v)`, `setPaused(b)`, `setFps(n)`, `setCompiling(b)`.
- Produces, in `ui/banner.ts`, class `Banner`:
  - `constructor(root: HTMLElement, h: { onShowProblems(): void; onRetry(): void })`.
  - `showErrors(count: number)` renders "N errors" plus a "Show in Problems" button.
  - `showMessage(text: string, opts?: { retry?: boolean })`, `setNoSync(b: boolean)`,
    `hide()`.
  - The banner is positioned **outside** the canvas box: a strip above it. It never
    calls `.focus()`.
- CSS: the canvas has `width: 100%; height: auto; aspect-ratio: 736 / 520; image-rendering: pixelated;`
  and chrome colors come only from `--vscode-*` variables.

- [ ] **Step 1: Write the failing tests.**

```ts
// renderLoop.test.ts: fake adapter + fake requestFrame
test('setSim swaps on next frame and disposes the old sim', …)
test('uiIn persists across setSim', …)                    // new sim gets setInputs(…, uiIn)
test('stats throttled to one per 500 ms', …)
test('hidden or paused renders nothing', …)
test('runtime error pauses and reports once', …)
test('onNoSync fires only on change', …)
// ui.test.ts
test('clicking bit 3 and pressing key "5" call onUiIn with 0b0010_1000', …)
test('banner never takes focus and sits outside the canvas container', …)
```

- [ ] **Step 2: Run** `npx vitest run test/unit/renderLoop.test.ts test/unit/ui.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `renderLoop.ts`, `controls.ts`, `banner.ts` and the CSS.
- [ ] **Step 4: Run the same command.** Expect PASS.
- [ ] **Step 5: Commit** `feat(webview): render loop, controls and banner`.

### Task 9: Live update debouncer (host, pure)

**Files:**
- Create: `src/extension/liveUpdate.ts`
- Test: `test/unit/liveUpdate.test.ts`

**Interfaces:**
- Consumes: `LoadMessage` (Task 2).
- Produces:

```ts
export interface LoadPayload { topModule: string; sources: Record<string, string>; dataFiles: Record<string, string> }
export function hashPayload(p: LoadPayload): Promise<string>; // SHA-256 (crypto.subtle) over JSON of sorted entries + topModule
export class LiveUpdate {
  constructor(d: {
    delayMs(): number; enabled(): boolean; isVisible(): boolean;
    gather(): Promise<LoadPayload | null>;       // null = nothing to send (discovery failed)
    send(msg: LoadMessage): void;
  });
  onEdit(): void;              // enabled → restart idle timer; disabled → ignore
  flush(): Promise<void>;      // save: cancel timer, gather+send now (hash-skip applies)
  resend(): Promise<void>;     // webview 'ready': gather+send ignoring hash
  onVisible(): Promise<void>;  // send if something was held while hidden
  readonly generation: number; // last generation sent
  dispose(): void;             // cancels timer; later calls are no-ops
}
```

- [ ] **Step 1: Write the failing tests** (`vi.useFakeTimers()`).

```ts
test('edits within the delay coalesce into one send after the last edit', …) // edits at 0,100,200 ms; delay 300 → send at 500 ms, generation 1
test('unchanged payload is skipped', …)
test('flush sends immediately and cancels the timer', …)
test('liveUpdate disabled → edits ignored, flush still works', …)
test('hidden → nothing sent; onVisible sends once', …)
test('resend ignores the hash and bumps generation', …)
test('dispose cancels a pending timer', …)
```

- [ ] **Step 2: Run** `npx vitest run test/unit/liveUpdate.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `liveUpdate.ts`.
- [ ] **Step 4: Run the same command.** Expect PASS.
- [ ] **Step 5: Commit** `feat(host): debounced live update with hash skip and generations`.

## M4: Diagnostics and wiring (Tasks 10–12)

### Task 10: Diagnostics (host)

**Files:**
- Create: `src/extension/diagnostics.ts`
- Test: `test/unit/diagnostics.test.ts`

**Interfaces:**
- Produces:

```ts
export function toDiagnostic(m: VerilatorMessage): vscode.Diagnostic;
// range: (line-1, column-1) → (line-1, (endColumn ?? column+1) - 1); severity Error/Warning; source 'verilator'; code m.code
export class VerilatorDiagnostics {
  constructor(collection: vscode.DiagnosticCollection);
  apply(generation: number, latest: number, messages: VerilatorMessage[], relToUri: Map<string, vscode.Uri>): VerilatorMessage[];
  // generation < latest → no-op, returns []; otherwise replaces all Verilator diagnostics and
  // returns the messages whose file is not in relToUri (caller logs them / shows in banner)
  setInfoYamlProblems(uri: vscode.Uri, problems: { line: number; message: string }[]): void;
  clear(): void;
  dispose(): void; // later apply/set calls are no-ops
}
```

- [ ] **Step 1: Write the failing tests.**

```ts
test('1-based Verilator position → 0-based range with endColumn', …)  // {line:3,column:5,endColumn:9} → (2,4)-(2,8)
test('missing endColumn → 1-char range', …)
test('messages land on the right URI for duplicate basenames', …)      // Review Focus 2: src/a/top.v vs src/b/top.v
test('stale generation is ignored', …)
test('success with no messages clears previous diagnostics', …)
test('unknown file returned as unplaced', …)
test('apply after dispose is a no-op', …)                              // Review Focus 4
```

- [ ] **Step 2: Run** `npx vitest run test/unit/diagnostics.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `diagnostics.ts`.
- [ ] **Step 4: Run the same command.** Expect PASS.
- [ ] **Step 5: Commit** `feat(host): Verilator diagnostics with stale-generation guard`.

### Task 11: Webview orchestration

**Files:**
- Modify: `src/webview/main.ts` (replaces the skeleton), `src/webview/compileWorker.ts`,
  `src/shared/protocol.ts`, `src/extension/extension.ts` (test commands only),
  spec §2.2 (record the two additive messages)
- Test: `test/unit/protocol.test.ts`, `test/e2e/preview.test.ts`

**Interfaces:**
- Consumes: `CompileQueue` (Task 7), `buildSim` and `tinyTapeoutAdapter` (Task 6),
  `RenderLoop`, `Controls` and `Banner` (Task 8), the worker protocol (Task 3).
- Produces two additive protocol messages, each with a guard and a protocol test case:
  - `HostToWebview | { type: 'status'; message: string }` makes the webview show the
    message (`banner.showMessage`) and set the state to `error`;
  - `WebviewToHost | { type: 'showProblems' }` is posted by the banner's
    "Show in Problems" button.
- Produces the test commands `verivga._compiledLog` and `verivga._postToWebview`, added
  to the skeleton `extension.ts`. Task 12 must keep them.
- Behavior:
  - `load` → `queue.submit`, and `controls.setCompiling(true)`.
  - Worker `result`: if `queue.complete(gen)` returns null, drop the result.
  - Otherwise, `ok` = no message with `severity === 'error'`. Warnings alone don't
    show the banner.
    - **Not ok:** post `compiled` and `banner.showErrors(n)`; the old sim keeps running.
    - **ok:** `buildSim({ …, uiIn: loop.uiIn })`.
      - If the build fails: `banner.showMessage(message)`, and post `compiled` with
        `ok: false` and a single
        `{ severity: 'error', file: '', line: 1, column: 1, message }`.
      - If it succeeds: `loop.setSim`, `banner.hide()`, then post `compiled` with
        `ok: true` and the warnings.
  - Worker `crash` or watchdog `onTimeout`: `worker.terminate()`, create a new worker,
    re-`init`, and show `Compiler crashed: …` / `Compile timed out` with
    `banner.showMessage`. Then post `compiled` (`ok: false`) for that generation.
  - Runtime error: post `runtimeError`, and `banner.showMessage`.
  - `control` messages map to `loop.reset`, `pause`/`resume`. `screenshot` is ignored in the MVP.
  - Stats: post `stats` from `onStats` with the state from:
    `loading | compiling | running | paused | error`.
  - `document.visibilitychange` → `loop.setVisible`.
  - WASM fetch/compile failure: `banner.showMessage("Couldn't load the compiler", { retry: true })`.
    Retry re-runs the boot and then posts `ready`.

- [ ] **Step 1: Write the failing tests.** Add protocol cases for `status` and
  `showProblems`. E2E tests drive the webview directly through
  `verivga._postToWebview`, with sources read from the fixture:

```ts
test('non-TT top → ok:false with TT-port message, then a valid load recovers', …) // Review Focus 5: post load gen 100 top 'hvsync_generator' → last compiled gen 100 ok:false, message includes 'TinyTapeout port list'; post gen 101 stripes → ok
test('an older generation never lands after a newer one', …) // post gen 200 and gen 201 back-to-back → final _compiledLog entry is gen 201 ok, and no gen-200 entry appears after it (deterministic; exact dropping is unit-tested in Task 7)
test('syntax error keeps the old sim and reports errors', …) // post gen 300 with "wire y = ;" → ok:false, messages[0].file === 'src/project.v'
```

- [ ] **Step 2: Run** `npm run build && npx vitest run test/unit/protocol.test.ts && npm run test:e2e`. Expect FAIL.
- [ ] **Step 3: Implement** the orchestration in `main.ts`, the protocol additions and
  the two test commands. Update spec §2.2 with the two messages.
- [ ] **Step 4: Run** `npm test && npm run build && npm run test:e2e && npm run test:web`. Expect PASS.
- [ ] **Step 5: Commit** `feat(webview): orchestrate queue, worker, sim swap and UI`.

### Task 12: Host wiring, sessions and Output channel

**Files:**
- Create: `src/extension/session.ts`
- Modify: `src/extension/extension.ts` (replaces the skeleton)
- Test: `test/e2e/preview.test.ts` (scenarios below)

**Interfaces:**
- Consumes: `discover` and `SourceReader` (Task 5), `LiveUpdate` (Task 9),
  `VerilatorDiagnostics` (Task 10), `PreviewPanel` (Task 3), and the protocol.
- Produces, in `session.ts`, class `PreviewSession`, one per workspace folder:
  - `static open(ctx: vscode.ExtensionContext, folder: vscode.WorkspaceFolder, activeUri: vscode.Uri | undefined, log: vscode.OutputChannel): PreviewSession`
  - `reveal(): void`, `readonly lastCompiled?: Extract<WebviewToHost, { type: 'compiled' }>`, `dispose(): void`
  - It owns: `PreviewPanel`, `LiveUpdate`, `SourceReader`, `VerilatorDiagnostics`
    (collection named `verivga`), and its event subscriptions.
- Wiring:
  - `onDidChangeTextDocument` for a URI in `relToUri`, or the session's `info.yaml` →
    `sources.invalidate` + `live.onEdit()`.
  - `onDidSaveTextDocument` → `live.flush()`.
  - `workspace.onDidCreateFiles`, `onDidDeleteFiles` and `onDidRenameFiles` inside the
    folder → re-`discover` + `live.flush()`.
  - Panel `ready` → `live.resend()`. Visible → `live.onVisible()`.
  - `compiled` → `diagnostics.apply(gen, live.generation, …)`; unplaced messages go to
    the log.
  - `runtimeError` → log. `showProblems` → `workbench.actions.view.problems`.
  - Discovery failure → post `{ type: 'status', message }` (Task 11) instead of `load`,
    and call `setInfoYamlProblems` for `bad-info-yaml`.
  - `SourceReader.onReadError` → `showWarningMessage` once per URI + log.
  - Panel disposed → `session.dispose()`, which disposes `LiveUpdate` and diagnostics
    (diagnostics are cleared), and removes the session from the map.
- `extension.ts`:
  - The Output channel is `VeriVGA`. Log every `compiled` as
    `[gen N] ok|errors (ms)`, plus raw unplaced messages and runtime errors.
  - `verivga.openPreview` → find the folder for the active editor (or prompt
    `Open a file inside a workspace folder` on `no-folder`), then reveal the existing
    session or open a new one in `ViewColumn.Beside`.
  - The three test commands stay in Test mode only. They route to the session whose
    panel is open (the most recently revealed one).

- [ ] **Step 1: Write the failing E2E scenarios** in `test/e2e/preview.test.ts`. Edits
  use `WorkspaceEdit` and are **never saved**; each test restores the original text.

```ts
test('unsaved edit triggers a new generation', …)          // generation increases, ok
test('syntax error → diagnostic; fix → cleared', …)        // languages.getDiagnostics(uri) has 1 error with source 'verilator', then 0
test('topModule setting to a non-TT module → ok:false; reset → ok', …) // Review Focus 5 through the host path
test('closing the panel mid-compile is clean, reopen works', …) // Review Focus 4: edit, close immediately, wait 2 s, getDiagnostics(uri) empty; openPreview → ok
test('untitled document active in a single-folder workspace still opens the preview', …) // Review Focus 1
```

- [ ] **Step 2: Run** `npm run build && npm run test:e2e`. Expect FAIL.
- [ ] **Step 3: Implement** `session.ts` and `extension.ts`.
- [ ] **Step 4: Run** `npm test && npm run build && npm run test:e2e && npm run test:web`. Expect all PASS.
- [ ] **Step 5: Commit** `feat(host): preview sessions wire discovery, live update and diagnostics`.

## M5–M6: Ship-ready (Task 13)

### Task 13: Latency gate, CI, README, package

**Files:**
- Create: `test/e2e/latency.test.ts`, `.github/workflows/ci.yml`, `README.md`, `CHANGELOG.md`
- Modify: `package.json` (`repository`: `https://github.com/MasterIceZ/VeriVGA`,
  `categories`, `keywords`, `icon` optional)

**Interfaces:**
- Consumes: `verivga._lastCompiled`.

- [ ] **Step 1: Write the latency test.** It's desktop only and skipped when
  `vscode.env.uiKind === UIKind.Web`.

```ts
test('median edit-to-compiled ≤ liveDelay + 700 ms', …) // 7 runs: apply a distinct unsaved edit, t0 = after edit applied, poll every 10 ms until generation increases with ok; median(t) - 300 ≤ 700
```

- [ ] **Step 2: Run** `npm run build && npm run test:e2e`. Expect PASS. If it fails,
  record the numbers in the spike note and stop to ask the user before tuning.
- [ ] **Step 3: Write `ci.yml`** for `ubuntu-24.04` and Node 22. Steps: `npm ci`,
  `npx prettier --check .`, `npm run lint`, `npm run typecheck`, `npm test`,
  `npm run build`, `xvfb-run -a npm run test:e2e`, `npx playwright install --with-deps chromium`,
  `npm run test:web`, `npm run package`, and then fail if the `.vsix` is > 25 MB
  (`test $(stat -c%s *.vsix) -lt 26214400`).
- [ ] **Step 4: Write `README.md`.**
  - What it does and how to use it (open a TT project folder, run
    "VeriVGA: Open Preview", type).
  - The settings table.
  - Limits: Verilator 4.205 SystemVerilog subset; TinyTapeout interface only until v2.
  - Credits (Tiny Tapeout / Uri Shaked, 8bitworkshop / Steven Hugg) and GPL-3.0.
- [ ] **Step 5: Run** `npm run package && ls -l *.vsix`. Expect the `.vsix` under 25 MB.
  Install it locally (`code --install-extension verivga-*.vsix`) and open
  `examples/stripes`. The preview animates, and a typed edit shows within about 1 s.
- [ ] **Step 6: Commit** `chore: latency gate, CI, README and packaging`.
