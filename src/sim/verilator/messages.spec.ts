import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { runVerilator } from './compile';
import { toVerilatorMessages } from './messages';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBinary = readFileSync(resolve(__dirname, './verilator_bin.wasm'));

// Mock process.exit to prevent Verilator from killing the test process
const originalExit = process.exit;
beforeAll(() => {
  process.setMaxListeners(20);
  process.exit = vi.fn((code?: number) => {
    throw new Error(`process.exit called with code ${code}`);
  }) as never;
});
afterAll(() => {
  process.exit = originalExit;
});

describe('toVerilatorMessages', () => {
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

  // Verilator joins `-I<dir>/` and the include name, so an error in an included file is
  // reported as `src/src//defs.vh` (info.yaml keys) or `src//defs.vh` (fallback keys).
  describe('errors inside `include`d files map to the source key', () => {
    const top = (include: string) =>
      `module tt_um_t(input wire clk);\n\`include "${include}"\nendmodule\n`;
    const broken = "wire a = 1'b0;\nwire y = ;\n";

    const firstError = async (sources: Record<string, string>) => {
      const { errors } = await runVerilator({ topModule: 'tt_um_t', sources, wasmBinary });
      return toVerilatorMessages(errors, sources).find((m) => m.severity === 'error')!;
    };

    test('info.yaml keys: src/project.v includes defs.vh → src/defs.vh', async () => {
      const err = await firstError({ 'src/project.v': top('defs.vh'), 'src/defs.vh': broken });
      expect(err.file).toBe('src/defs.vh');
      expect(err.line).toBe(2);
    });

    test('fallback keys: project.v includes defs.vh → defs.vh', async () => {
      const err = await firstError({ 'project.v': top('defs.vh'), 'defs.vh': broken });
      expect(err.file).toBe('defs.vh');
      expect(err.line).toBe(2);
    });

    test('nested: src/project.v includes sub/inner.vh → src/sub/inner.vh', async () => {
      const err = await firstError({
        'src/project.v': top('sub/inner.vh'),
        'src/sub/inner.vh': broken,
      });
      expect(err.file).toBe('src/sub/inner.vh');
      expect(err.line).toBe(2);
    });
  });

  describe('synthetic messages', () => {
    const sources = { 'project.v': 'module m;\nwire abc;\nendmodule\n' };

    test("a warning's class becomes its code; an error without one has no code", () => {
      const msgs = toVerilatorMessages(
        [
          {
            type: 'warning',
            warningClass: 'UNUSED',
            file: 'src/project.v',
            line: 2,
            column: 6,
            message: "Signal is not used: 'abc'",
          },
          { type: 'error', file: 'src/project.v', line: 2, column: 6, message: 'boom' },
        ],
        sources,
      );
      expect(msgs[0]).toMatchObject({ severity: 'warning', code: 'UNUSED', file: 'project.v' });
      expect(msgs[1]).not.toHaveProperty('code');
    });

    test('`.` and `..` segments resolve before the FS root is stripped', () => {
      const at = (file: string) =>
        toVerilatorMessages([{ type: 'error', file, line: 1, column: 1, message: 'x' }], {})[0]
          .file;
      expect(at('src/src/sub/..//./defs.vh')).toBe('src/defs.vh');
      expect(at('src/src//../inc/defs.vh')).toBe('inc/defs.vh');
      expect(at('')).toBe('');
    });

    test('endColumn is clamped to the end of the line', () => {
      const [msg] = toVerilatorMessages(
        [
          {
            type: 'error',
            file: 'src/project.v',
            line: 2,
            column: 6,
            endColumn: 99,
            message: 'boom',
          },
        ],
        sources,
      );
      // `wire abc;` is 9 characters, so the last 1-based column past it is 10.
      expect(msg.column).toBe(6);
      expect(msg.endColumn).toBe('wire abc;'.length + 1);
    });
  });
});
