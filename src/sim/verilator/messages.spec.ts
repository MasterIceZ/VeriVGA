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
});
