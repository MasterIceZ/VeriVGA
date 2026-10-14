// VeriVGA (not upstream): runVerilator keeps the %Error lines that ErrorParser can't place.
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { runVerilator } from './compile';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBinary = readFileSync(resolve(__dirname, './verilator_bin.wasm'));

const originalExit = process.exit;
beforeAll(() => {
  process.setMaxListeners(20);
  process.exit = vi.fn() as never;
  // Verilator echoes every line to the console; keep the test output clean.
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  process.exit = originalExit;
  vi.restoreAllMocks();
});

const errorsOf = async (topModule: string, source: string) => {
  const res = await runVerilator({ topModule, sources: { 'project.v': source }, wasmBinary });
  return { ...res, errors: res.errors.filter((e) => e.type === 'error') };
};

describe('runVerilator: %Error lines ErrorParser cannot place', () => {
  test('a nonexistent top module reports an error naming it', async () => {
    const { xml, errors } = await errorsOf(
      'nope_top',
      'module tt_um_t(input wire clk); endmodule\n',
    );
    expect(xml).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: '', line: 1, column: 1 });
    expect(errors[0].message).toContain("'nope_top'");
    expect(errors[0].message).not.toMatch(/^%Error/);
  });

  test('a coded error (%Error-PINNOTFOUND) keeps its location', async () => {
    const src =
      'module a(input wire x); endmodule\nmodule tt_um_t(input wire clk); a ua(.y(clk)); endmodule\n';
    const { errors } = await errorsOf('tt_um_t', src);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      file: 'src/project.v',
      line: 2,
      column: 39,
      endColumn: 40,
      warningClass: 'PINNOTFOUND',
      message: "Pin not found: 'y'",
    });
  });

  test('the "Exiting due to" summary is never an error of its own', async () => {
    const { errors } = await errorsOf(
      'tt_um_t',
      'module tt_um_t(input wire clk);\nwire y = ;\nendmodule\n',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe('src/project.v');
  });

  test('warnings only ("Exiting due to N warning(s)") still yields XML and no error', async () => {
    const src = 'module tt_um_t(input wire clk, input wire [7:0] ui_in); endmodule\n';
    const res = await runVerilator({
      topModule: 'tt_um_t',
      sources: { 'project.v': src },
      wasmBinary,
    });
    expect(res.errors.some((e) => e.type === 'warning')).toBe(true);
    expect(res.errors.filter((e) => e.type === 'error')).toEqual([]);
    expect(res.xml).toContain('<verilator_xml');
  });
});
