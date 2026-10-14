# CLAUDE.md

## Project

**VeriVGA** is a VS Code extension that compiles the Verilog in the workspace and renders
its VGA output live in a webview panel. It is a port of
[TinyTapeout/vga-playground](https://github.com/TinyTapeout/vga-playground)
(vga-playground.com) from a browser app to an extension. VS Code's own editor replaces
Monaco.

- Requirements, scope and open decisions: `docs/requirements.md`. Read it before
  starting a feature. The MVP design is `docs/superpowers/specs/2026-10-14-verivga-mvp-design.md`.
- Scope: **TinyTapeout interface first** (MVP and v1). Generic VGA modules with a
  configurable pin mapping come in v2 (FR-16 to FR-19).
- The headline feature is **real-time preview**: the frame re-renders `verivga.liveDelay`
  (300 ms by default) after the user stops typing, with no save needed (FR-4).
- One codebase for **desktop VS Code and the browser** (FR-20). The web bundle is built
  and tested in a browser host (`@vscode/test-web`); vscode.dev and github.dev need the
  extension published first (FR-20 is v1, publishing is open question Q4).
- Repo: `git@github.com:MasterIceZ/VeriVGA.git`. License: GPL-3.0-only.
- Status: **MVP implemented** (FR-1 to FR-10, TinyTapeout only). Gamepad Pmod (FR-12)
  is implemented. Not yet: audio, examples command, screenshot command, status bar (FR-11,
  FR-13 to FR-15, v1). Update this file when reality diverges.

## Reference implementation (port, don't rewrite)

Upstream pinned at `3e3c77e` (2026-08-26). Clone it into a scratch dir to read it; never
vendor the whole repo. Mapping:

| Upstream | VeriVGA | Change policy |
|---|---|---|
| `src/sim/*` (vxmlparser, hdlwasm, hdltypes, hdlruntime, readmem, xml, util, emu, vga) | `src/sim/` | **Copy verbatim.** Adapt only through wrappers. |
| `src/verilator/{compile.ts,ErrorParser.ts,verilator_bin.js,.wasm}` | `src/sim/verilator/` | Minimal edits (WASM loading, kept `%Error` lines) |
| `verilog.ts` (`detectTopModule`) | `src/shared/verilog.ts` | Verbatim |
| `github/loadProject.ts` (`extractIncludePaths`, `extractReadmemPaths`) | `src/shared/verilogRefs.ts` | Verbatim |
| `src/examples/*` | `examples/<id>/{info.yaml,src/*.v,LICENSE.txt}` | Converted to TT layout |
| `AudioEngine.ts`, `AudioPlayer.ts`, `public/resampler.js` (v1) | `src/webview/audio/` | Adapt URL loading |
| `InputController.ts` (gamepad) | `src/webview/adapters/gamepadPmod.ts`, `ui/gamepad.ts` | Adapted to the panel DOM |
| `InputController.ts` (keys), `FPSCounter.ts` | `src/webview/ui/controls.ts`, `renderLoop.ts` | Rewritten for the panel |
| `index.ts`, `ui/*`, `github/*` (rest), `exportProject.ts`, Monaco | — | Not ported |

Every edit to an upstream file is listed, with its reason, in `src/sim/UPSTREAM.md`. Keep
diffs against upstream small so they can be re-synced. `src/sim/verilator/messages.ts` is
ours, not upstream.

## Architecture

```
Extension host (web-compatible)           Webview main thread                        Compile Web Worker
───────────────────────────────           ───────────────────                        ──────────────────
PreviewSession (one per workspace folder)
edit to a file the last load read
  → LiveUpdate idle timer (liveDelay);
    a save flushes it
  → discover + SourceReader.gather (open
    TextDocument wins, else ProjectFs)
  → SHA-256 unchanged? skip
  → generation++ (held while hidden)
  ──load {generation, topModule,─────────▶ Orchestrator
          sources, dataFiles}              → CompilerHost: CompileQueue ──compile───▶ runVerilator → XML
                                             (1 running, 1 newest, 20 s watchdog)     string + messages
                                           ◀──result {generation, xml?, messages, ms}──┘
                                           superseded by a newer load? drop
                                           buildSim: XML → HDLModuleWASM → adapter checks
                                           RenderLoop.setSim: swap on the next frame
                                           (the old design renders until then)
VerilatorDiagnostics, Output ◀──compiled── every outcome; `ok` only after setSim
  (a stale generation is dropped)          RenderLoop: rAF → adapter.renderFrame → canvas 736×520
Output channel  ◀──runtimeError──────────  Controls: ui_in toggles, Gamepad Pmod, Reset, Pause, fps
Problems view   ◀──showProblems──────────  Banner: errors, messages, no-sync hint
(status bar, v1)◀──stats (≤ 2/s)─────────  state: loading | compiling | running | paused | error
                ──status {message}───────▶ banner instead of a design (e.g. no sources)
Test mode only: verivga._screenshot
                ──control: screenshot────▶ canvas.toDataURL ──screenshot {png}──▶ host
```

- Compiling and simulating happen **in the webview**. The host never touches
  Verilator or binaryen.
- Verilator runs in a **Web Worker** so the animation doesn't freeze while it compiles.
  The Verilator `WebAssembly.Module` is compiled once per panel and handed to every
  worker. The worker returns the XML **string**. `HDLModuleDef` is a cyclic graph, so it is
  built on the main thread and never sent across any `postMessage`.
- Frames never cross `postMessage`, except a single PNG on an explicit
  `control: screenshot` (the Test-mode frame probe now, FR-14 in v1). Stats go out at
  most twice per second.
- Recompiling is **latest-wins**: every load carries an increasing `generation`, and
  anything older than the newest request gets dropped. Results are applied strictly in
  generation order. The old simulation keeps rendering until the new one is ready, so
  there's never a black flicker.
- `ui_in`, the gamepad mode (with held buttons) and the user's pause carry over across recompiles. Only the design is reset.

## Layout

```
src/extension/   extension.ts      activate: Open Preview, one session per folder, Test-mode commands
                 session.ts        PreviewSession: wires panel, live update, sources, diagnostics, VS Code events
                 PreviewPanel.ts   webview panel, typed and validated message bridge, visibility
                 webviewHtml.ts    page HTML, CSP and nonce
                 project.ts        pickFolder, discover (info.yaml or folder fallback), top module
                 projectFs.ts      open-document-first, cached FS reads; records the URIs a load used
                 sources.ts        SourceReader: read and gather sources, `include`s and $readmem data
                 liveUpdate.ts     idle timer, save flush, hash skip, generations, hidden hold
                 diagnostics.ts    VerilatorMessage[] → DiagnosticCollection, info.yaml problems
                 sessionUtil.ts    Output channel formatting, liveDelay clamp
src/webview/     main.ts           composition root: DOM, compiler boot (WASM + Blob-URL worker)
                 orchestrator.ts   load → compile → build → swap state machine, banner, stats
                 compilerHost.ts   owns the worker: queue, watchdog, crash restart
                 compileQueue.ts   latest-wins scheduler (pure)
                 compileWorker.ts  classic worker: runVerilator → {xml, messages}
                 workerProtocol.ts main ↔ worker messages (may carry a WebAssembly.Module)
                 simHost.ts        buildSim: XML → HDLModuleWASM, validated and reset
                 renderLoop.ts     rAF loop, frame-boundary swap, fps, no-sync, runtime errors
                 adapters/         types.ts (VgaAdapter, InputState), tinytapeout.ts, gamepadPmod.ts: the only place pin layouts live
                 ui/               controls.ts (ui_in, Gamepad, Reset, Pause, fps), gamepad.ts (on-screen pad), banner.ts
                 styles.css        copied to dist/webview.css
src/shared/      protocol.ts (ALL host↔webview message types and guards), verilog.ts, verilogRefs.ts
src/sim/         ported simulator + verilator/ (GPL-3.0, keep headers); ported specs live here too
examples/        eight TT-layout presets
test/unit/       vitest (fakes/: vscode, memfs)   test/golden/  frame-0 PNGs + generate.ts
test/e2e/        preview.test.ts (desktop + web), latency.test.ts (desktop); web/ (runner, assert)
test/fixtures/   stripes (the E2E workspace)      test/bench/   M0 timing (not in pnpm test)
docs/            requirements.md, superpowers/{specs,plans,notes}/
```

## Commands

pnpm only (version pinned by `packageManager` in package.json; `corepack enable` picks it up).

```bash
pnpm install           # pnpm-workspace.yaml allowlists the 3 install scripts we need
pnpm build             # esbuild, from one source (browser bundles target es2022, desktop node18):
                       #   dist/extension.js      (cjs, node)      ← package.json "main"
                       #   dist/web/extension.js  (cjs, browser)   ← package.json "browser"
                       #   dist/webview.js        (esm) + dist/compileWorker.js (iife)
                       #   + dist/verilator_bin.wasm, dist/webview.css, and the E2E bundles
pnpm watch             # rebuild on change (for an Extension Development Host)
pnpm open:web          # local browser VS Code with the extension and the stripes fixture
pnpm test              # vitest: unit, ported specs, golden frames
pnpm test:e2e          # @vscode/test-cli + test-electron, desktop, incl. the latency gate
pnpm test:web          # @vscode/test-web, headless Chromium, --quality=stable
pnpm typecheck         # tsc --noEmit
pnpm lint              # eslint (includes the no-Node-built-ins rule for host code)
pnpm format            # prettier --write .     (format:check = prettier --check .)
pnpm package           # vsce package --no-dependencies → .vsix; vscode:prepublish runs a
                       # production build (minified, no source maps, no E2E bundles)
```

Test-only commands, registered only when `extensionMode === Test`: `verivga._lastCompiled`,
`verivga._compiledLog`, `verivga._postToWebview` and `verivga._screenshot` (the canvas as
a base64 PNG). They act on the most recently revealed preview.

## TinyTapeout VGA facts

- Top module port list (fixed):
  `ui_in[7:0]`, `uo_out[7:0]`, `uio_in[7:0]`, `uio_out[7:0]`, `uio_oe[7:0]`, `ena`, `clk`, `rst_n`.
- TinyVGA Pmod: `uo_out = {hsync, B[0], G[0], R[0], vsync, B[1], G[1], R[1]}`. Two bits
  per channel, displayed as `value * 85`.
- 640×480@60: 25.175 MHz pixel clock. H total 800 (sync 96, front 16, back 48).
  V total 525 (sync 2, front 10, back 33). `tick2(1)` = one clock = one pixel.
- The canvas is **736×520**, not 640×480. Upstream renders past the active area. Keep
  that so golden frames match vga-playground.com.
- Sync polarity is auto-detected (the shorter phase is the pulse). Don't assume
  active-low.
- Reset sequence: `powercycle()`, `ena=1`, `rst_n=0`, keep `ui_in`, `tick2(10)`, `rst_n=1`.
- Audio Pmod (v1): sample `(uio_out & uio_oe) >> 7` every tick, average to 192 kHz, apply
  a 20 kHz box low-pass.
- Gamepad Pmod: drives `ui_in[4]`=latch, `[5]`=clk, `[6]`=data, as a 24-bit serial
  frame stepped once per scanline (see `updateGamepadPmod`).
- Top-module detection: first `module tt_um_*` (with `project.v` first), else the first
  module in `project.v`, else `tt_um_vga_example`. `.vh`/`.svh` files are include-only
  and never passed as sources.

## Rules

- **TinyTapeout first, generic later:** keep every bit of TT pin knowledge (`uo_out`
  layout, `ui_in` gamepad pins, `uio_out[7]` audio, the reset sequence) behind the
  `tinytapeout` adapter. The render loop, controls and audio must not hard-code TT port
  names, so the v2 `generic` adapter can be added without touching them. Don't build the
  generic adapter or its settings before v2.
- **Real-time is a feature, so guard it:** don't add work between a keystroke and the
  new frame without measuring it against NFR-3 (last keystroke → new frame ≤
  `liveDelay` + 700 ms; `latency.test.ts` gates the median). Compile the Verilator
  `WebAssembly.Module` once per panel and reuse it. Diagnostics for a stale `generation`
  must never overwrite newer ones. Errors in half-typed code are normal, so the error
  banner must never cover the frame or take focus.
- **Licensing (decided):** VeriVGA is GPL-3.0-only because the 8bitworkshop-derived simulator is. Keep
  the existing license headers. Credit Tiny Tapeout (Uri Shaked) and 8bitworkshop
  (Steven Hugg) in the README, and list bundled third-party components in `NOTICE`.
- **Bridge:** every message type lives in `src/shared/protocol.ts` as a discriminated
  union with a runtime guard. Payloads must be JSON-serializable. Add a type before using
  a message.
- **Host I/O:** use `vscode.workspace.fs` and open `TextDocument.getText()` (unsaved
  buffers win), never Node `fs`, so Remote, WSL and web keep working.
- **Web-safe host code:** `src/extension/` and `src/shared/` must not import Node
  built-ins (`fs`, `path`, `os`, `child_process`, `Buffer`, `process`, …). Use
  `vscode.Uri.joinPath`, `TextEncoder`/`TextDecoder` and `crypto.subtle`. An ESLint
  `no-restricted-imports` rule enforces this.
- **Discovery:** use `workspace.fs.readDirectory`, not `workspace.findFiles`, which is
  limited on github.dev's virtual FS. Read only what's needed, and cache by URI until a
  change event invalidates the entry.
- **Feature parity:** any feature must work in both `test:e2e` and `test:web` before
  it's done. E2E tests live in `test/e2e/` and run in both hosts; use the `assert`
  functions that `test/e2e/web/assert.ts` provides (the web host has no Node `assert`).
- **Webview security:** nonce on every script, a CSP that includes `'wasm-unsafe-eval'`
  and `worker-src blob:` (for the compile worker and the AudioWorklet), no remote
  origins, and `localResourceRoots` set to `dist/` only.
- **Hot path:** in the per-tick and per-pixel loop, read `jmod.data8[offset]`, not
  `jmod.state.*`. No allocations, closures created per pixel, or logging.
- **Lifecycle:** pause the rAF loop when the panel is hidden (the webview's
  `visibilitychange`; the host holds loads via `onDidChangeViewState`). Dispose
  `HDLModuleWASM` before re-init. Cache the Verilator WASM bytes across
  recompiles.
- **Diagnostics:** Verilator lines and columns are 1-based, VS Code's are 0-based.
  Map Emscripten-FS paths (`src/<name>`) back to the original URIs: normalize the path
  first (`src/src//defs.vh` for an `include`), then strip one `src/`. Keep warnings as
  warnings.
- **Style:** TypeScript strict, ES modules. Prettier as upstream: `printWidth: 100`,
  `singleQuote`, `trailingComma: 'all'`, 2 spaces. Plain DOM in the webview, no UI
  framework.
- **Tests:** pure logic (discovery, top detection, error mapping, decode) gets vitest.
  Each example has a golden-frame test (`test/golden/`, pngjs). Any change under
  `src/sim/` must keep the golden frames identical.

## Gotchas

- The bundled Verilator is **4.205** (8bitworkshop build). SystemVerilog support is
  limited. Flags are `--cc -O3 -Wall -Wno-EOFNEWLINE -Wno-DECLFILENAME --x-assign fast
  --debug-check -Isrc/` (plus `-I` for each source subdirectory), and `--debug-check` is
  what produces the XML. Don't "upgrade" the flags blindly.
- Verilator rejects a `--top-module` that another module instantiates, before our
  TinyTapeout port check runs. A test that needs a non-TT top must make it genuinely
  top-level (a standalone module).
- Upstream simulator bug: `$readmemh`/`$readmemb` with a literal filename of 8 bytes or
  fewer (e.g. `"mem.hex"`) fails with "could not validate wasm module". Documented in the
  README; fixing it means an `hdlwasm` edit (upstream code).
- binaryen's ESM build uses top-level await, so the webview bundle must be ESM loaded
  with `<script type="module">` and target `es2022` or later.
- The compile worker is a classic (iife) worker started from a Blob URL: a webview can't
  start a worker from its resource URI, and Emscripten only detects a worker when
  `importScripts` exists.
- Formatting: run `pnpm format` / `pnpm format:check` (or
  `node node_modules/prettier/bin/prettier.cjs`). Never `npx prettier`: a shell hook (rtk)
  may rewrite it to a global prettier 2, which can't load the v3 organize-imports plugin
  and corrupts generics.
- pnpm is strict: a tool or import must be a declared dependency, not something npm
  happened to hoist. `vite-node` (golden/bench scripts) and `playwright` (browser install)
  are declared for that reason, pinned to the versions vitest and `@vscode/test-web` use.
- Packaging uses `vsce package --no-dependencies`: vsce's dependency walk assumes npm's
  `node_modules` layout, and esbuild already bundles every runtime dependency.
- Regenerating golden frames still runs `npm ci` inside the upstream clone (its lockfile).
- Desktop E2E opens a real VS Code window. Its user-data dir lives in the OS temp dir
  (`.vscode-test.mjs`) because macOS caps the IPC socket path at 103 characters.
- `AudioContext` needs a user gesture. `audioWorklet.addModule()` needs an allowed
  URL; use a Blob URL if the webview URI is refused.
- The webview only gets keyboard events while focused. Don't rely on keys for core
  features.
- Upstream uses Vite (`?raw`, `?url` imports). Replace those with esbuild loaders or
  explicit file reads.
