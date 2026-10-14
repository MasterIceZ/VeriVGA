# VeriVGA: Requirements (draft)

Status: **draft; Q1–Q3 and Q5 decided, Q4 (publishing) open (§6)** · 2026-10-14
Reference: [TinyTapeout/vga-playground](https://github.com/TinyTapeout/vga-playground) @ `3e3c77e` (2026-08-26)

## 1. Goal

A VS Code extension that compiles the Verilog in your workspace and shows its VGA
output **live in a panel next to the editor**, the same way vga-playground.com does
in the browser. You edit `.v` files in VS Code's own editor, and the preview updates.
It should need no external toolchain: it works offline with nothing to install
besides the extension.

## 2. What the reference does (feature inventory)

| # | Upstream feature | Where (upstream) | In VeriVGA |
|---|---|---|---|
| 1 | Monaco editor + file tabs | `index.ts`, `ui/FileTabs.ts` | **Replaced** by VS Code's editor |
| 2 | Compile on every keystroke: Verilator 4.205 (WASM, 8bitworkshop build) → XML | `verilator/compile.ts` | Port |
| 3 | XML → HDL IR → WASM via binaryen (JIT simulator) | `sim/vxmlparser.ts`, `sim/hdlwasm.ts` | Port unchanged |
| 4 | Error markers in editor + error overlay | `ErrorParser.ts`, `ui/ErrorOverlay.ts` | → VS Code **Diagnostics** + overlay in panel |
| 5 | 736×520 canvas, TinyVGA Pmod decode, 2-bit RGB | `sim/vga.ts` | Port |
| 6 | Auto-detect hsync/vsync polarity | `sim/vga.ts` | Port |
| 7 | `ui_in[7:0]` toggle buttons, keys `0`–`7`, Reset (`R`) | `InputController.ts` | Port into panel |
| 8 | Audio Pmod: `uio_out[7]` (gated by `uio_oe[7]`) → 192 kHz → 20 kHz low-pass → AudioWorklet | `AudioEngine.ts`, `AudioPlayer.ts`, `public/resampler.js` | Port |
| 9 | Gamepad Pmod emulation: serial on `ui_in[6:4]`, keyboard mapping | `InputController.ts`, `common/gamepad_pmod.v` | Port |
| 10 | FPS counter, audio latency readout | `FPSCounter.ts` | Port |
| 11 | `$readmemh` / `$readmemb` data files | `sim/readmem.ts`, `hdlwasm.ts` | Port; read files from workspace |
| 12 | `` `include `` of `.vh` / `.svh` | `compile.ts` | Port |
| 13 | 8 presets: stripes, music, rings, logo, conway, checkers, drop, gamepad | `examples/` | → "New project from example" command |
| 14 | Load project from GitHub (`?repo=`) via `info.yaml` | `github/loadProject.ts` | **Replaced**: user clones; we read `info.yaml` locally |
| 15 | Export ZIP (info.yaml + src + cocotb test) | `exportProject.ts` | Optional: "Scaffold info.yaml" command |

## 3. Requirements

### 3.1 MVP (must have)

- **FR-1 Open preview.** Command `VeriVGA: Open Preview` plus an editor-title button on
  Verilog files. It opens a webview panel beside the active editor, one panel per
  workspace folder.
- **FR-2 Project discovery.**
  1. If the workspace contains `info.yaml`, use `project.source_files` (relative to `src/`)
     and `project.top_module`.
  2. Otherwise use all `*.v`, `*.sv`, `*.vh`, `*.svh` files in the active file's folder.
- **FR-3 Top module.** Use the setting `verivga.topModule` if set. Otherwise use the
  first `module tt_um_*` (with `project.v` preferred), falling back to `tt_um_vga_example`.
  This mirrors upstream `detectTopModule`.
- **FR-4 Live compile while typing.** The preview re-renders soon after the user stops
  typing, with no save needed.
  - **Trigger:** any edit to a project source file starts an idle timer. This includes
    files that aren't the active editor. The timer restarts on every keystroke, and
    the compile runs when it expires. The delay is set by `verivga.liveDelay` (default
    **300 ms**, range 0–2000). A save compiles immediately. Creating, deleting or
    renaming a source file, or editing `info.yaml`, also triggers a compile.
  - **Source of truth:** compile from **unsaved editor buffers** when a file is open,
    and from disk otherwise.
  - **Latest wins:** every request carries an increasing `generation`. A compile
    can't be cancelled midway (Verilator runs synchronously). So at most one compile
    is running and at most one is queued. The queued one is always the newest
    sources, and results from older generations are dropped.
  - **Skip no-ops:** if the sources and top module hash the same as the last compile,
    do nothing. This covers undo back to the same text and whitespace-only saves.
  - **No flicker:** the old simulation keeps rendering until the new one is ready, and
    then they swap in a single frame. Compiling runs in a Web Worker so the animation
    doesn't freeze during it.
  - **Preserved state:** `ui_in` toggles, gamepad mode, audio on/off and Pause carry
    over across recompiles. The design itself is reset. Upstream clears the toggles;
    we keep them.
  - **Indicator:** a subtle "compiling…" marker shows in the panel and the status bar.
  - **Off switch:** `verivga.liveUpdate` (default `true`). When it's off, only saves
    trigger a compile.
- **FR-5 Diagnostics.** Verilator errors and warnings go to the Problems panel, with
  squiggles that span `column` to `endColumn`. They clear on a successful compile.
  Paths map back to workspace URIs.
- **FR-6 Render.** Draw at 60 fps on the 736×520 canvas, the same geometry as upstream
  so frames match vga-playground.com pixel for pixel. Scale to fit the panel with the
  aspect ratio kept and `image-rendering: pixelated`.
- **FR-7 Controls.** Eight `ui_in` toggles, Reset, Pause/Resume, and an FPS readout.
  Keys `0`–`7` and `R` work while the panel has focus.
- **FR-8 Failure UX.** On a compile error, keep the last good simulation running and
  show a small error banner over it. The banner has a "show in Problems" action. While
  typing, half-written code fails all the time, so the banner must not cover the
  frame or steal focus. It disappears on the next successful compile.
- **FR-9 Data files.** Load `$readmemh`/`$readmemb` paths relative to the source folder,
  and `` `include `` relative to the source folder and `src/`.
- **FR-10 Lifecycle.** Pause the simulation while the panel is hidden. Dispose cleanly
  when the panel closes.

### 3.2 v1 (should have)

- **FR-11 Audio Pmod** with a toggle button. WebAudio needs a user gesture before it plays.
- **FR-12 Gamepad Pmod** emulation, with on-screen buttons and the upstream key mapping.
- **FR-13 Examples.** `VeriVGA: New Project from Example…` copies one of the 8 presets,
  plus `info.yaml` and their LICENSE files, into a chosen folder.
- **FR-14 Screenshot.** `VeriVGA: Save Frame as PNG`.
- **FR-15 Status bar item** showing the compile state, the top module and fps.
  Clicking it opens the preview.
- **FR-20 Web extension.** Works in vscode.dev and github.dev with the same feature set
  as desktop. A student opens `github.dev/<user>/<tt-project>`, installs VeriVGA, and
  sees the preview with nothing else to install.
  - `package.json` has both `main` (Node) and `browser` (webworker) entries, built from
    the **same source**. The scaffold emits both bundles from day one, so compatibility
    never rots.
  - Discovery reads directories with `workspace.fs.readDirectory`/`readFile` instead
    of `workspace.findFiles`, which is limited on virtual file systems like
    `vscode-vfs://`.
  - Data files and includes are read the same way.
  - Supported browsers: current Chrome, Edge, Firefox and Safari. Each needs
    `wasm-unsafe-eval`, module workers and AudioWorklet.

### 3.3 v2: generic VGA modules

For designs that don't use the TinyTapeout port list, such as course or FPGA-lab modules
with ports like `clk`, `reset`, `hsync`, `vsync`, `red[3:0]`, `green[3:0]`, `blue[3:0]`:

- **FR-16 Interface mode.** `verivga.interface` is `"auto" | "tinytapeout" | "generic"`.
  `auto` picks `tinytapeout` when the top module has the TT port list, and `generic`
  otherwise.
- **FR-17 Pin mapping.** In generic mode, the user maps clock, reset (and its polarity),
  hsync, vsync, and the R/G/B ports or bit-slices. Each channel can be 1–8 bits, scaled
  to 8-bit on screen. Inputs such as buttons and switches map to toggles, the same way
  `ui_in` does. The mapping lives in the workspace (e.g. `.vscode/verivga.json`) so it
  travels with the project.
- **FR-18 Auto-guess.** Propose a mapping from common port names (`hsync`/`h_sync`/`hs`,
  `red`/`r`/`vga_r`, `clk`/`clock`/`pixel_clk`, …). The user confirms it once and it's
  saved.
- **FR-19 Clock assumption.** One `tick2(1)` is still one pixel. Designs that divide a
  faster board clock (e.g. 50 MHz ÷ 2) need a `clocksPerPixel` setting.

### 3.4 Later / out of scope (for now)

- Single-step a frame or line, and slow-motion clock.
- Signal probes or waveforms (VCD export). Use a real simulator for that.
- Recording to GIF or video.
- Modes other than 640×480@60.
- Loading from GitHub URLs and exporting a ZIP. On desktop users clone; on the web they
  open the repo in github.dev (FR-20).

### 3.5 Non-functional

- **NFR-1 Self-contained.** Verilator (WASM) and binaryen ship inside the VSIX. No
  network access at runtime.
- **NFR-2 Responsive host.** No long synchronous work in the extension host. Compiling
  and simulating happen in the webview.
- **NFR-3 Performance.** Bundled examples reach ≥ 55 fps on a 2020+ laptop.
  **Edit-to-pixel latency:** from the last keystroke to the first new frame takes at
  most `liveDelay` + 700 ms for the bundled examples (median, warm). The 5.9 MB
  Verilator WASM is fetched and compiled once per panel, and the compiled
  `WebAssembly.Module` is reused for every recompile.
- **NFR-4 Size.** VSIX under 25 MB. `verilator_bin.wasm` alone is 5.9 MB.
- **NFR-5 Security.** Strict webview CSP (nonce scripts plus `'wasm-unsafe-eval'`, nothing
  remote). `localResourceRoots` is limited to the extension's `dist/`.
- **NFR-6 Theming.** Panel chrome uses VS Code theme CSS variables. The canvas itself
  stays true-color.
- **NFR-7 Platforms.** Desktop VS Code ≥ 1.90 on macOS, Windows and Linux, including
  Remote-SSH and WSL. Also vscode.dev and github.dev (FR-20). Extension-host code uses
  **no Node built-ins** (`fs`, `path`, `child_process`, `Buffer`, `process`, …), only
  the `vscode` API and web-standard APIs (`TextDecoder`, `URL`, `crypto.subtle`).
  A lint rule enforces this.
- **NFR-8 Licensing.** Upstream's `LICENSE` is GPL-3.0, and the simulator
  (`src/sim/*`) derives from 8bitworkshop (GPL-3.0). Reusing it makes VeriVGA
  **GPL-3.0**. Keep the attributions to Tiny Tapeout / Uri Shaked and 8bitworkshop /
  Steven Hugg. Each example has its own `LICENSE.txt` (Apache-2.0).
- **NFR-9 Tests.** Unit tests (vitest) for the pure logic, and golden-frame tests per
  example. Extension smoke tests run on desktop (`@vscode/test-electron`) and in the
  browser (`@vscode/test-web`, headless Chromium). Both run in CI.

## 4. Building blocks (the "things" we need)

| Component | Source | Notes |
|---|---|---|
| Verilator → XML (WASM) | upstream `src/verilator/verilator_bin.{js,wasm}` | Verilator **4.205**, Emscripten module, accepts `wasmBinary` |
| Verilator log parser | upstream `ErrorParser.ts` | `%Error:` / `%Warning-X:` lines plus `^~~~` ranges |
| XML → HDL IR | upstream `sim/vxmlparser.ts`, `sim/xml.ts`, `sim/hdltypes.ts` | GPL-3.0 (8bitworkshop) |
| HDL IR → WASM JIT | upstream `sim/hdlwasm.ts` + `binaryen` npm | binaryen ESM uses top-level await |
| VGA decode / render / reset | upstream `sim/vga.ts` | Apache-2.0 |
| Audio | upstream `AudioEngine.ts`, `AudioPlayer.ts`, `public/resampler.js` | AudioWorklet module must load from a webview URI |
| Inputs / gamepad | upstream `InputController.ts` | Rewire to the panel DOM and webview focus |
| Examples | upstream `src/examples/*` | Convert to the on-disk TT layout (`info.yaml` + `src/`) |
| Extension host | **new** | Commands, discovery, diagnostics, settings, status bar |
| Webview UI | **new** (small) | Canvas, controls, overlay; plain TS + CSS, no framework |
| Host ↔ webview protocol | **new** | Typed messages in one shared file |
| Build | **new** | esbuild: one CJS bundle for the extension, one ESM bundle for the webview |

## 5. Architecture options (decision D1)

**Where do compiling and simulating run?**

- **A. Everything in the webview (recommended).** The host sends
  `{sources, dataFiles, topModule}`. The webview compiles, simulates, renders, and posts
  back diagnostics and stats. It's the closest port of upstream (the same browser code).
  Frames never cross `postMessage`, the host stays light, and it stays web-extension
  compatible. Cost: the webview CSP needs `'wasm-unsafe-eval'`, and the 5.9 MB WASM loads
  per panel.
- B. Compile in the host (Node worker), simulate in the webview. Diagnostics stay
  host-native, but the HDL IR is a cyclic object graph that doesn't survive JSON
  `postMessage`. We'd have to ship the XML across and parse it in the webview anyway.
  More moving parts for no gain.
- C. Simulate in the host and stream frames. **Rejected:** 736×520×4 B ≈ 1.5 MB per frame,
  about 90 MB/s at 60 fps through `postMessage`.

## 6. Open questions

1. ~~**Q1 Target designs.**~~ **Decided (2026-10-14): both, TinyTapeout first.** MVP and
   v1 cover only the TT interface. Generic VGA modules come in v2 (§3.3). The MVP must
   keep TT pin knowledge in one place so v2 can add another adapter.
2. ~~**Q2 Compile trigger.**~~ **Decided (2026-10-14):** real-time. Recompile after a
   typing pause (300 ms idle, configurable), with no save needed. See FR-4.
3. ~~**Q3 License.**~~ **Decided (2026-10-14): GPL-3.0.** We reuse the upstream simulator
   as-is. `package.json` `license` is `GPL-3.0-only`, and the repo gets a `LICENSE` file
   (GPL-3.0 text) plus a `NOTICE` crediting Tiny Tapeout and 8bitworkshop. Apache-2.0
   files such as `vga.ts` and the examples keep their own headers and LICENSE files.
4. **Q4 Distribution.** Publish to the VS Code Marketplace / Open VSX? Publisher ID and
   display name?
5. ~~**Q5 vscode.dev.**~~ **Decided (2026-10-14): yes, in v1** (FR-20). Note that web
   users can only install from the VS Code Marketplace, so Q4 must be settled before
   v1 ships.

## 7. Risks

- **Compile latency on large designs.** Real-time preview depends on Verilator plus
  binaryen staying sub-second. If a design is big enough to break NFR-3, the
  "compiling…" indicator keeps the UI honest. Mitigation: measure the bundled examples
  in the first spike, and raise `liveDelay` automatically when the last compile was slow.
- **First load on the web.** vscode.dev downloads the extension, including the 5.9 MB
  Verilator WASM, from the Marketplace CDN on first use. Mitigation: start fetching
  the WASM as soon as the panel opens, in parallel with project discovery, and show
  "loading compiler…" instead of a blank panel.
- **github.dev file access.** Reads go through the GitHub API, so the first discovery
  pass can be slow and is rate-limited. Mitigation: read only the files `info.yaml`
  lists, and cache file contents keyed by URI until a change event invalidates them.
- **Web Worker inside a webview.** The compile worker needs a URL the webview allows
  (`worker-src` in the CSP; use a Blob URL if needed). Verilator must also run inside
  the worker. Prototype this together with the AudioWorklet.

- **Old Verilator (4.205).** SystemVerilog support is limited and some modern constructs
  fail. Mitigation: document it, and surface Verilator's message as-is.
- **AudioWorklet in webviews.** `addModule()` needs a URL the webview allows. If
  `asWebviewUri` is refused, fall back to a Blob URL. Prototype this early.
- **Keyboard focus.** The webview only receives keys while it has focus. Users editing
  code can't press `0`–`7` without clicking the panel. Mitigation: optional VS Code
  keybindings, scoped by a `when` context, that forward to the panel.
- **Upstream drift.** Record the upstream commit for each ported file and keep local edits
  to `src/sim/*` minimal so syncing stays cheap.
