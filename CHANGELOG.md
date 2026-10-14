# Changelog

## 0.0.1

First MVP.

- **VeriVGA: Open Preview** renders the VGA output of a Tiny Tapeout design in a webview.
- Live update: recompiles about 300 ms after the last edit, unsaved changes included.
- Verilator errors appear as editor diagnostics; the previous frame keeps running meanwhile.
- Settings `verivga.liveUpdate`, `verivga.liveDelay` and `verivga.topModule`.
- Runs in desktop VS Code and in the browser (vscode.dev, github.dev).
- Eight example designs under `examples/`.
