# VeriVGA MVP: Design

Date: 2026-10-14 · Status: **awaiting review**
Requirements: `docs/requirements.md` (FR-*/NFR-* IDs below refer to it).
Upstream: TinyTapeout/vga-playground @ `3e3c77e`.

## 1. Scope

**In the MVP:** FR-1 to FR-10 (preview panel, discovery, top module, live compile,
diagnostics, render, controls, failure UX, data files, lifecycle), TinyTapeout interface
only.

The MVP also does three things now because they cost more to retrofit:
- builds the **web bundle** and runs a browser smoke test (FR-20 groundwork);
- keeps all TT pin knowledge in one adapter (v2 groundwork);
- ships GPL-3.0 `LICENSE` and `NOTICE` files.

**Not in the MVP:** audio, gamepad, examples command, screenshot, status bar (FR-11 to
FR-15); full vscode.dev parity (FR-20 is v1); generic modules (v2).

The `screenshot` protocol message is defined now. Until FR-14 only the Test-mode frame probe
uses it (`verivga._screenshot`, §4).

**Done when:**
1. Opening a folder that contains the stripes example and running `VeriVGA: Open Preview`
   renders frames that match upstream's reference PNG byte for byte. This works in both
   desktop VS Code and `vscode-test-web`.
2. Editing `project.v` without saving shows the new design within `liveDelay` + 700 ms
   (median, warm).
3. A syntax error gives a squiggle and a banner while the old design keeps animating.
   Fixing it clears both.
4. `npm test`, `npm run test:e2e` and `npm run test:web` all pass.

## 2. Architecture

The extension side does project I/O and VS Code integration. The webview does everything
HDL. The diagrams and rules are in `CLAUDE.md` §Architecture; that file is the single
source of truth for them.

### 2.1 Units

| Unit | Runs in | Responsibility | Depends on |
|---|---|---|---|
| `extension/extension.ts` | host | `activate`: register the command, the editor-title button, settings and event wiring | the other host units |
| `extension/project.ts` | host | `discover(folder, activeUri, fs) → ProjectSpec {root, files: Map<rel, Uri>, dataFiles, topModule}` | `shared/verilog.ts`, `yaml` |
| `extension/sources.ts` | host | Read file text, preferring open `TextDocument`s. URI-keyed cache, cleared on change, save and file events | `vscode.workspace` |
| `extension/liveUpdate.ts` | host | Idle timer, `flush()` on save, `crypto.subtle` hash, skip when unchanged, `generation++`, hold while hidden | injected clock and `send` |
| `extension/diagnostics.ts` | host | `VerilatorMessage[]` + rel→Uri map → `DiagnosticCollection`. Drops messages older than the newest `generation` | `vscode` |
| `extension/PreviewPanel.ts` | host | Webview creation, `retainContextWhenHidden`, CSP plus nonce, message bridge, visibility events | `shared/protocol.ts` |
| `shared/protocol.ts` | both | The message union (§2.2) plus type guards | none |
| `shared/verilog.ts` | both | `detectTopModule` (copied verbatim) | none |
| `webview/main.ts` | webview | Bootstrap: prefetch the Verilator WASM, wire the bridge, send `ready` | the other webview units |
| `webview/compileQueue.ts` | webview | Pure state machine: `running`, `pending`, latest-wins | none |
| `webview/compileWorker.ts` | worker | Run Verilator, return `{generation, xml?, messages, ms}` | `sim/verilator/*` |
| `webview/simHost.ts` | webview | XML → `VerilogXMLParser` → `HDLModuleWASM.init()` → adapter reset → swap on the next frame → dispose the old module | `sim/*`, adapter |
| `webview/adapters/tinytapeout.ts` | webview | `decode`, `reset`, `detectPolarity`, `applyInputs(ui_in)`, `validate(globals)` | `sim/vga.ts` |
| `webview/renderLoop.ts` | webview | Animation loop calling `renderVGAFrame` into an `ImageData`. Pauses when hidden. Measures fps | `simHost` |
| `webview/ui/*` | webview | `ui_in` toggles, Reset, Pause, fps, error banner, "compiling…" marker | DOM |
| `sim/**` | webview + tests | Ported upstream code (verbatim except §5) | binaryen |

### 2.2 Protocol (`src/shared/protocol.ts`)

```ts
export type HostToWebview =
  | { type: 'load'; generation: number; topModule: string;
      sources: Record<string, string>; dataFiles: Record<string, string> }
  | { type: 'control'; action: 'reset' | 'pause' | 'resume' | 'screenshot' }
  | { type: 'status'; message: string }; // banner message instead of a design; state → 'error'

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'showProblems' } // the banner's "Show in Problems" button
  | { type: 'compiled'; generation: number; ok: boolean;
      messages: VerilatorMessage[]; ms: number }
  | { type: 'runtimeError'; generation: number; message: string }
  | { type: 'stats'; fps: number;
      state: 'loading' | 'compiling' | 'running' | 'paused' | 'error' }
  | { type: 'screenshot'; png: string }; // base64, used by FR-14 (v1)

export interface VerilatorMessage {
  severity: 'error' | 'warning'; code?: string;
  file: string;        // project-relative, as sent in `load.sources`
  line: number; column: number; endColumn?: number; // 1-based (Verilator)
  message: string;
}
```

Paths are always project-relative, using `/`. The webview never sees URIs.

`status` and `showProblems` were added in Task 11. The host sends `status` when it has no
design to load (for example, discovery failed); the webview shows the message in the banner
and reports the `error` state. The webview sends `showProblems` from the banner's "Show in
Problems" button, and the host opens the Problems view.

### 2.3 Live-update flow

This is the flow approved in brainstorming section 2:

1. **Edit:** an edit to a project file restarts the idle timer (`verivga.liveDelay`,
   default 300 ms). A save flushes the timer immediately.
2. **Gather and hash:** the host gathers sources and hashes them. If the hash is
   unchanged, it stops.
3. **Send:** the host increments `generation` and sends `load`. While the panel is
   hidden, it keeps only the latest request and sends it on show.
4. **Queue:** `compileQueue` keeps one `running` and one `pending` compile. A new `load`
   replaces `pending`. When the worker returns and `pending` exists, the result is
   dropped silently and `pending` starts.
5. **Failure:** on failure the webview posts `compiled` (`ok: false`) and shows the
   banner. The old simulation keeps running.
6. **Success:** the webview builds the new simulation, then swaps it in on the next frame.
   `ui_in` and pause state are kept. Then it posts `compiled` (`ok: true`).

Settings: `verivga.liveUpdate` (default `true`), `verivga.liveDelay` (default 300,
range 0–2000), `verivga.topModule` (default empty, meaning auto).

## 3. Error handling

| Failure | Detected by | User sees | Recovery |
|---|---|---|---|
| No Verilog sources in the folder or `info.yaml` | `project.ts` | Panel message: "No Verilog sources found in `<folder>`" | Automatic on the next file event |
| `info.yaml` invalid, or lists a missing file | `project.ts` | Diagnostic on `info.yaml`, plus a panel message | On edit |
| Verilator `%Error` | compile worker | Squiggles, banner "N errors (show Problems)"; old simulation keeps running | Next successful compile |
| Verilator `%Warning` only | compile worker | Squiggles (warnings) and no banner | n/a |
| Top module lacks TT ports (`uo_out`, …) | `adapter.validate` | Banner: "Top module `X` doesn't have the TinyTapeout port list" | Next compile |
| Verilator throws or aborts (Emscripten `abort`, `process.exit`) | worker `try` plus `onerror` | Banner: "Compiler crashed: …"; the worker is recreated | Automatic |
| Compile exceeds 20 s | watchdog in `compileQueue` | Banner: "Compile timed out"; the worker is terminated and recreated | Next edit |
| XML parse or binaryen build fails (unsupported construct) | `simHost` | Banner with the message; full stack in the Output channel | Next compile |
| Runtime `HDLError` / `EmuHalt` (`$stop`, missing `$readmem` file) | `renderLoop` `try` | Simulation paused, banner with the message, `runtimeError` sent to the host | Reset button or next compile |
| No vsync for one full frame period (420 000 ticks) | `renderLoop`'s vsync wait loop reaching its tick limit | Frame shows a "No VGA sync detected" hint; keeps running | Clears when vsync appears |
| Verilator WASM fails to load (CSP, network on the web) | `main.ts` prefetch | Panel: "Couldn't load the compiler" with a **Retry** button | Retry |
| A file read fails (github.dev rate limit, permission) | `sources.ts` | Warning notification once per file; logged | Next change event |

Everything is also logged to a **VeriVGA** Output channel: compile timings, raw Verilator
output, and stacks. The error banner never covers the canvas, never takes focus, and has
a "Show in Problems" action.

## 4. Testing

| Layer | Tool | What |
|---|---|---|
| Unit (host) | vitest + fake `vscode` and fake FS | `project.ts` (info.yaml vs folder fallback, `src/` paths, missing files), `liveUpdate.ts` with fake timers (debounce, save flush, hash skip, hidden hold, generation), `diagnostics.ts` (1-based to 0-based, rel→Uri, `endColumn`, stale drop) |
| Unit (webview) | vitest | `compileQueue` (latest-wins, drop on pending, watchdog), adapter decode/validate |
| Ported upstream | vitest | `ErrorParser.spec`, `verilog.spec`, `hdlwasm*.spec`, `readmem.spec`, `vga-integration.spec`. These must pass unchanged |
| Golden frames | vitest + pngjs | Frame 0 of all 8 presets, byte-identical. Stripes uses upstream's PNG. The other 7 are generated **once** from the unmodified upstream at `3e3c77e` by `test/golden/generate.ts`, which records the commit |
| E2E desktop | `@vscode/test-electron` | Fixture workspace (stripes): open the preview → `compiled ok`; two screenshots 300 ms apart differ (frames are drawn); edit without saving → new `generation` compiled and a different frame; add a syntax error → diagnostic appears; fix → it clears |
| E2E web | `@vscode/test-web` (Chromium) | The same smoke scenario on the virtual FS |
| Latency | E2E desktop | Log keystroke→`compiled ok` ms per run. CI fails if the median exceeds `liveDelay` + 700 ms |

E2E tests observe the webview through test-only commands: `verivga._lastCompiled`,
`verivga._compiledLog`, `verivga._postToWebview` and `verivga._screenshot` (posts
`control: screenshot` and resolves with the next `screenshot` PNG, base64). They are
registered only when `extensionMode === Test`.

## 5. Port details

These are the only planned edits to upstream files:
- **`verilator/compile.ts`:** split it into `runVerilator()` (worker; returns XML text) and
  the existing XML parse (main thread). Load the WASM from the injected
  `wasmBinary` / compiled `WebAssembly.Module` instead of Vite's `?url` import.
- **`hdlwasm.ts`:** no edits. `getFileData` is already injectable, and `simHost` feeds it
  `dataFiles`.
- **`vga.ts`:** no edits. The adapter wraps it.
- **Vite-isms** (`?raw`, `?url`): replaced in our code only; ported files that used them
  get esbuild loaders instead.

Each edit is listed in `src/sim/UPSTREAM.md` with a reason.

## 6. Milestones

Each milestone ends green on `npm test`.

- **M0 Walking skeleton (spike, kept):** scaffold, esbuild with 3 bundles, an empty panel
  with CSP. Verilator compiles hard-coded stripes in a worker, `HDLModuleWASM` renders
  one frame. Verify on desktop **and** in `vscode-test-web`, and measure compile ms.
  **Exit criterion:** the risks in requirements §7 (worker in a webview,
  `wasm-unsafe-eval`, binaryen top-level await) are retired or a fallback is chosen.
- **M1 Simulator port:** `src/sim/**` plus the ported specs and golden frames.
- **M2 Project to pixels:** `project.ts`, `sources.ts`, the `load` path, `simHost`, the
  adapter, `renderLoop`.
- **M3 Live update:** `liveUpdate.ts`, `compileQueue`, swap, state carry-over, hidden
  hold.
- **M4 Errors:** `diagnostics.ts`, banner, Output channel, everything in §3.
- **M5 Controls and lifecycle:** `ui_in`, Reset, Pause, fps, theming.
- **M6 Ship-ready:** E2E desktop and web, latency gate, CI, README, LICENSE, NOTICE,
  `vsce package` under 25 MB.
