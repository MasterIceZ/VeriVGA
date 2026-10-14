# VeriVGA

Live VGA preview of [Tiny Tapeout](https://tinytapeout.com) Verilog designs, inside VS Code.
Edit your Verilog and the rendered frame updates about 300 ms after you stop typing. No save
needed. It works in desktop VS Code and in the browser (vscode.dev, github.dev).

VeriVGA is a port of [vga-playground](https://github.com/TinyTapeout/vga-playground) from a
browser app to a VS Code extension.

## Usage

1. Open a Tiny Tapeout project folder (one with an `info.yaml` and a `src/` directory). The
   folders in [`examples/`](examples) are ready-made presets.
2. Run **VeriVGA: Open Preview** from the Command Palette, or click the preview icon in the
   title bar of a `.v` / `.sv` file.
3. Edit the design. The preview re-renders after you pause typing, and the old frame keeps
   animating until the new design is ready. Verilator errors show up in the Problems panel
   and in the editor.

Verilator diagnostics, timing and internal messages go to the **VeriVGA** Output channel
(View > Output, then pick "VeriVGA").

## Settings

| Setting              | Default | Description                                                              |
| -------------------- | ------- | ------------------------------------------------------------------------ |
| `verivga.liveUpdate` | `true`  | Re-render the preview automatically while typing.                        |
| `verivga.liveDelay`  | `300`   | Milliseconds to wait after the last edit before recompiling (0 to 2000). |
| `verivga.topModule`  | `""`    | Name of the top module. Empty means auto-detect.                         |

## Limits

- Verilator **4.205** (compiled to WebAssembly) supports a subset of SystemVerilog. Newer
  language features may be rejected.
- Only the **Tiny Tapeout interface** (`ui_in`, `uo_out`, `uio_*`, `clk`, `rst_n`, ...) is
  supported until v2. Generic VGA modules with a configurable pin mapping are planned.
- Known upstream simulator bug: `$readmemh` / `$readmemb` fail when the literal filename is
  8 bytes or shorter (for example `"mem.hex"`). Use a longer name or a path instead, such as
  `"../data/mem.hex"` or `"palette_data.hex"`.

## Credits

- [Tiny Tapeout](https://tinytapeout.com) and Uri Shaked, for
  [vga-playground](https://github.com/TinyTapeout/vga-playground), the simulator and the
  example designs this extension is ported from (pinned at commit `3e3c77e`; see
  `src/sim/UPSTREAM.md`).
- [8bitworkshop](https://8bitworkshop.com) and Steven Hugg, whose Verilog-to-WebAssembly
  simulator the playground is derived from.
- [Verilator](https://www.veripool.org/verilator/) and [binaryen](https://github.com/WebAssembly/binaryen).

## License

GPL-3.0-only. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The example designs carry their own
Apache-2.0 license (`examples/*/LICENSE.txt`).
