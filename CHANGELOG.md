# Changelog

## Unreleased

- Gamepad Pmod emulation (FR-12): a Gamepad toggle, an on-screen pad and the upstream key
  map. `Shift+R` always resets; `r` resets only while Gamepad is off.
- Fix: a design that loads a large memory with `$readmemh`/`$readmemb` but never reads it
  no longer fails with "Invalid typed array length".

## 0.0.1

First MVP.

- **VeriVGA: Open Preview** renders the VGA output of a Tiny Tapeout design in a webview.
- Live update: recompiles `verivga.liveDelay` (300 ms by default) after the last edit,
  unsaved changes included.
- Verilator errors appear as editor diagnostics; the previous frame keeps running meanwhile.
- Controls: eight `ui_in` toggles (keys `0` to `7` while the panel has focus), Reset (`R`)
  and Pause.
- Settings `verivga.liveUpdate`, `verivga.liveDelay` and `verivga.topModule`, per workspace
  folder.
- Runs in desktop VS Code. Built web-compatible and tested in a browser host
  (`@vscode/test-web`); vscode.dev and github.dev availability comes once it's published.
- Eight example designs under `examples/`.
