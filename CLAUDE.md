# CLAUDE.md

## Project

**VeriVGA** is a VS Code extension that compiles the Verilog in the workspace and renders
its VGA output live in a webview panel. It is a port of
[TinyTapeout/vga-playground](https://github.com/TinyTapeout/vga-playground)
(vga-playground.com) from a browser app to an extension. VS Code's own editor replaces
Monaco.

- Requirements, scope and open decisions: `docs/requirements.md`. Read it before
  starting a feature.
- Scope: **TinyTapeout interface first** (MVP and v1). Generic VGA modules with a
  configurable pin mapping come in v2 (FR-16 to FR-19).
- The headline feature is **real-time preview**: the frame re-renders about 300 ms
  after the user stops typing, with no save needed (FR-4).
- Runs on **desktop VS Code and in the browser** (vscode.dev, github.dev) from one
  codebase (FR-20).
- Repo: `git@github.com:MasterIceZ/VeriVGA.git`. License: GPL-3.0-only.
- Status: **pre-scaffold**. The layout and scripts below are the plan. Update this
  file when reality diverges.

## Reference implementation (port, don't rewrite)

Upstream pinned at `3e3c77e` (2026-08-26). Clone it into a scratch dir to read it; never
vendor the whole repo. Mapping:

| Upstream | VeriVGA | Change policy |
|---|---|---|
| `src/sim/*` (vxmlparser, hdlwasm, hdltypes, hdlruntime, readmem, xml, util, emu) | `src/sim/` | **Copy verbatim.** Adapt only through wrappers. |
| `src/sim/vga.ts` | `src/sim/vga.ts` | Verbatim |
| `src/verilator/{compile.ts,ErrorParser.ts,verilator_bin.js,.wasm}` | `src/sim/verilator/` | Minimal edits (WASM loading only) |
| `AudioEngine.ts`, `AudioPlayer.ts`, `public/resampler.js` | `src/webview/audio/` | Adapt URL loading |
| `InputController.ts`, `FPSCounter.ts` | `src/webview/` | Adapt to the panel DOM |
| `verilog.ts` (`detectTopModule`) | `src/shared/verilog.ts` | Verbatim |
| `src/examples/*` | `examples/<id>/{info.yaml,src/*.v,LICENSE.txt}` | Convert to TT layout |
| `index.ts`, `ui/*`, `github/*`, `exportProject.ts`, Monaco | — | Not ported |

Record the upstream commit for every ported file in `src/sim/UPSTREAM.md`. Keep diffs
against upstream small so they can be re-synced.

## Architecture

```
Extension host (Node; keep web-compatible)        Webview main thread              Compile Web Worker
────────────────────────────────────────          ─────────────────────────        ──────────────────
onDidChangeTextDocument (project files)
  → idle timer (verivga.liveDelay, 300 ms)
  → hash(sources, top) unchanged? skip
read sources: open TextDocument, else fs
  ──load {generation, sources, dataFiles, top}──▶ queue (1 running, 1 newest) ──▶ Verilator WASM → XML
                                                  ◀──────────── {generation, xml, errors} ─┘
                                                  drop if stale generation
                                                  VerilogXMLParser → HDLModuleWASM
                                                  swap into render loop (old keeps running until then)
DiagnosticCollection ◀──diag {generation}──────   rAF: renderVGAFrame → canvas (736×520)
status bar           ◀──stats (≤ 2/s)──────────   ui_in / reset / pause / audio / gamepad
```

- Compiling and simulating happen **in the webview**. The host never touches
  Verilator or binaryen.
- Verilator runs in a **Web Worker** so the animation doesn't freeze while it compiles.
  The worker returns the XML **string**. `HDLModuleDef` is a cyclic graph, so build it
  on the main thread and never send it across any `postMessage`.
- Frames never cross `postMessage`. Stats go out at most twice per second.
- Recompiling is **latest-wins**: every load carries an increasing `generation`, and
  anything older than the newest request gets dropped. The old simulation keeps
  rendering until the new one is ready, so there's never a black flicker.
- Carry `ui_in`, gamepad mode, audio and pause state over across recompiles. Only the
  design is reset.

## Layout (planned)

```
src/extension/   extension.ts, PreviewPanel.ts, project.ts, diagnostics.ts, examples.ts
src/webview/     main.ts (bridge + render loop), compileWorker.ts, controls.ts, overlay.ts, audio/, styles.css
src/webview/adapters/  tinytapeout.ts (MVP); generic.ts comes in v2. The only place pin layouts live.
src/shared/      protocol.ts (ALL host↔webview message types), verilog.ts
src/sim/         ported simulator + verilator/ (GPL-3.0, keep headers)
examples/        TT-layout presets
test/unit/       vitest   test/golden/  reference PNGs   test/e2e/  @vscode/test-electron
docs/            requirements.md, specs
```

## Commands (planned)

```bash
npm install
npm run build        # esbuild, 3 bundles from one source:
                     #   dist/extension.js      (cjs, node)       ← package.json "main"
                     #   dist/web/extension.js  (cjs, webworker)  ← package.json "browser"
                     #   dist/webview.js        (esm, browser)    + webview worker + wasm assets
npm run watch        # rebuild on change; press F5 in VS Code to launch Extension Development Host
npm run open:web     # vscode-test-web: run the extension in a local browser VS Code
npm test             # vitest (unit + golden-frame)
npm run test:e2e     # @vscode/test-electron smoke test (desktop)
npm run test:web     # @vscode/test-web smoke test (headless Chromium)
npm run typecheck    # tsc --noEmit
npm run package      # vsce package → .vsix
```

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
- Audio Pmod: sample `(uio_out & uio_oe) >> 7` every tick, average to 192 kHz, apply
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
  `liveDelay` + 700 ms). Compile the Verilator `WebAssembly.Module` once per panel and
  reuse it. Diagnostics for a stale `generation` must never overwrite newer ones.
  Errors in half-typed code are normal, so the error banner must never cover the frame
  or take focus.
- **Licensing (decided):** VeriVGA is GPL-3.0-only because the 8bitworkshop-derived simulator is. Keep
  the existing license headers. Credit Tiny Tapeout (Uri Shaked) and 8bitworkshop
  (Steven Hugg) in the README.
- **Bridge:** every message type lives in `src/shared/protocol.ts` as a discriminated
  union. Payloads must be JSON-serializable. Add a type before using a message.
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
  it's done.
- **Webview security:** nonce on every script, a CSP that includes `'wasm-unsafe-eval'`
  and `worker-src blob:` (for the compile worker and the AudioWorklet), no remote
  origins, and `localResourceRoots` set to `dist/` only.
- **Hot path:** in the per-tick and per-pixel loop, read `jmod.data8[offset]`, not
  `jmod.state.*`. No allocations, closures created per pixel, or logging.
- **Lifecycle:** pause the rAF loop when the panel is hidden (`onDidChangeViewState`).
  Dispose `HDLModuleWASM` before re-init. Cache the Verilator WASM bytes across
  recompiles.
- **Diagnostics:** Verilator lines and columns are 1-based, VS Code's are 0-based.
  Map Emscripten-FS paths (`src/<name>`) back to the original URIs. Keep warnings as
  warnings.
- **Style:** TypeScript strict, ES modules. Prettier as upstream: `printWidth: 100`,
  `singleQuote`, `trailingComma: 'all'`, 2 spaces. Plain DOM in the webview, no UI
  framework.
- **Tests:** pure logic (discovery, top detection, error mapping, decode) gets vitest.
  Each example gets a golden-frame test (port upstream `sim/vga-integration.spec.ts`,
  which uses pngjs). Any change under `src/sim/` must keep the golden frames identical.

## Gotchas

- The bundled Verilator is **4.205** (8bitworkshop build). SystemVerilog support is
  limited. Flags are `--cc -O3 -Wall -Wno-EOFNEWLINE -Wno-DECLFILENAME --x-assign fast
  --debug-check -Isrc/`, and `--debug-check` is what produces the XML. Don't "upgrade"
  the flags blindly.
- binaryen's ESM build uses top-level await, so the webview bundle must be ESM loaded
  with `<script type="module">` and target `esnext`.
- `AudioContext` needs a user gesture. `audioWorklet.addModule()` needs an allowed
  URL; use a Blob URL if the webview URI is refused.
- The webview only gets keyboard events while focused. Don't rely on keys for core
  features.
- Upstream uses Vite (`?raw`, `?url` imports). Replace those with esbuild loaders or
  explicit file reads.
