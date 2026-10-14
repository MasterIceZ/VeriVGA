import { describe, expect, test } from 'vitest';
import {
  clampDelay,
  errorText,
  formatCompiled,
  formatMessage,
} from '../../src/extension/sessionUtil';
import type { VerilatorMessage } from '../../src/shared/protocol';

const msg = (over: Partial<VerilatorMessage>): VerilatorMessage => ({
  severity: 'error',
  file: '',
  line: 1,
  column: 1,
  message: 'boom',
  ...over,
});

describe('formatCompiled', () => {
  test('the header line: generation, outcome, time', () => {
    const c = { type: 'compiled' as const, generation: 3, ok: true, messages: [], ms: 412 };
    expect(formatCompiled(c)).toBe('[gen 3] ok (412 ms)');
    expect(formatCompiled({ ...c, generation: 4, ok: false, ms: 38 })).toBe(
      '[gen 4] errors (38 ms)',
    );
  });

  // Spec §3: the Output channel gets the raw Verilator output, placed messages included.
  test('then every message, placed or not, one per line in order', () => {
    const c = {
      type: 'compiled' as const,
      generation: 5,
      ok: false,
      ms: 21,
      messages: [
        msg({ file: 'src/project.v', line: 12, column: 5, message: 'syntax error' }),
        msg({ severity: 'warning', file: 'src/a.v', line: 3, column: 1, message: 'unused' }),
        msg({ message: 'Compile timed out' }),
      ],
    };
    expect(formatCompiled(c)).toBe(
      '[gen 5] errors (21 ms)\n' +
        '  src/project.v:12:5: error: syntax error\n' +
        '  src/a.v:3:1: warning: unused\n' +
        '  error: Compile timed out',
    );
  });
});

describe('formatMessage', () => {
  test('a file-less message is logged as is, indented', () => {
    expect(formatMessage(msg({ message: 'Compile timed out' }))).toBe('  error: Compile timed out');
  });

  test('a message on a file starts with its position', () => {
    const m = msg({ severity: 'warning', file: 'lib/x.v', line: 3, column: 7, message: 'w' });
    expect(formatMessage(m)).toBe('  lib/x.v:3:7: warning: w');
  });

  test("a build failure's stack loses only its repeated `Error: <message>` line", () => {
    const stack = 'TypeError: bad width\n    at build (simHost.ts:10:3)\n    at run (x.ts:1:1)';
    expect(formatMessage(msg({ message: `bad width\n${stack}` }))).toBe(
      '  error: bad width\n    at build (simHost.ts:10:3)\n    at run (x.ts:1:1)',
    );
  });

  test('a multi-line message followed by its stack', () => {
    const m = msg({
      message: 'line one\nline two\nError: line one\nline two\n    at f (a.ts:1:1)',
    });
    expect(formatMessage(m)).toBe('  error: line one\nline two\n    at f (a.ts:1:1)');
  });

  test('a stack that does not repeat the message is kept whole', () => {
    const m = msg({ message: 'bad width\nbuild@simHost.ts:10:3' });
    expect(formatMessage(m)).toBe('  error: bad width\nbuild@simHost.ts:10:3');
  });
});

describe('clampDelay', () => {
  test('keeps 0–2000, clamps outside, falls back to 300 for non-numbers', () => {
    expect(clampDelay(0)).toBe(0);
    expect(clampDelay(450)).toBe(450);
    expect(clampDelay(-5)).toBe(0);
    expect(clampDelay(99999)).toBe(2000);
    expect(clampDelay('fast')).toBe(300);
    expect(clampDelay(Number.NaN)).toBe(300);
    expect(clampDelay(undefined)).toBe(300);
  });
});

describe('errorText', () => {
  test('an Error gives its stack, anything else its string', () => {
    const e = new Error('nope');
    expect(errorText(e)).toBe(e.stack);
    const bare = new Error('bare');
    bare.stack = undefined;
    expect(errorText(bare)).toBe('Error: bare');
    expect(errorText('plain')).toBe('plain');
  });
});
