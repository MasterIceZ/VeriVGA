# Upstream provenance

Ported from [TinyTapeout/vga-playground](https://github.com/TinyTapeout/vga-playground)
at commit `3e3c77e` (GPL-3.0; the simulator derives from 8bitworkshop). Keep diffs small so
files can be re-synced.

## File map

| Upstream (`3e3c77e`) | VeriVGA |
|---|---|
| `src/sim/*` (incl. specs, `README.txt`) | `src/sim/` |
| `src/verilator/*` | `src/sim/verilator/` |
| `src/verilog.ts`, `src/verilog.spec.ts` | `src/shared/` |
| `extractReadmemPaths`, `extractIncludePaths` from `src/github/loadProject.ts` | `src/shared/verilogRefs.ts` |
| `src/examples/stripes/*`, `src/examples/common/hvsync_generator.v` | `examples/stripes/{info.yaml,src/*.v,LICENSE.txt}` (TT layout; `info.yaml` is new) |
| `src/examples/stripes/reference/frame0.png` | `test/golden/stripes.png` |

## Edits to upstream files

- `src/sim/verilator/compile.ts`: split into `runVerilator` (returns the XML string) and
  `parseVerilatorXml`; `compileVerilator` is kept as a wrapper with upstream's result shape.
  Removed the Vite `?url` fetch (a wasm binary or module is now required), added the
  `wasmModule` path via `instantiateWasm` so the worker can reuse one compiled module,
  nested source directories are created and passed as `-I`. Flags are unchanged.
- `src/sim/verilator/compile.ts` (Task 11): `printErr` also keeps `%Error` lines that
  `ErrorParser` drops, via `unparsedError`. Upstream loses them, so a wrong `--top-module`
  surfaced as "XML parsing failed" and `%Error-PINNOTFOUND` (a coded error) vanished. A
  location-less line becomes `{ type: 'error', file: '', line: 1, column: 1, message }`; a
  coded line keeps its `file:line:col` and code. The "Exiting due to …" summary is skipped,
  because Verilator also prints it for warnings-only runs. `ErrorParser.ts` is unchanged.
- `src/sim/vga-integration.spec.ts`: fixture paths (examples, golden PNG) and wasm path only.
- `src/sim/hdlwasm-integration.spec.ts`, `src/sim/hdlruntime.spec.ts`: wasm path only.

New (not upstream): `src/sim/verilator/messages.ts` and its spec,
`src/sim/verilator/compile.spec.ts`, `src/shared/protocol.ts`.
