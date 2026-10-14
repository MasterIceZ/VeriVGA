import { describe, expect, test } from 'vitest';
import {
  clampDelay,
  errorText,
  formatCompiled,
  formatUnplaced,
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
  test('one line per compiled: generation, outcome, time', () => {
    const c = { type: 'compiled' as const, generation: 3, ok: true, messages: [], ms: 412 };
    expect(formatCompiled(c)).toBe('[gen 3] ok (412 ms)');
    expect(formatCompiled({ ...c, generation: 4, ok: false, ms: 38 })).toBe(
      '[gen 4] errors (38 ms)',
    );
  });
});

describe('formatUnplaced', () => {
  test('a file-less message is logged as is, indented', () => {
    expect(formatUnplaced(msg({ message: 'Compile timed out' }))).toBe(
      '  error: Compile timed out',
    );
  });

  test('a message on a file outside the project keeps its position', () => {
    const m = msg({ severity: 'warning', file: 'lib/x.v', line: 3, column: 7, message: 'w' });
    expect(formatUnplaced(m)).toBe('  warning: lib/x.v:3:7: w');
  });

  test("a build failure's stack loses only its repeated `Error: <message>` line", () => {
    const stack = 'TypeError: bad width\n    at build (simHost.ts:10:3)\n    at run (x.ts:1:1)';
    expect(formatUnplaced(msg({ message: `bad width\n${stack}` }))).toBe(
      '  error: bad width\n    at build (simHost.ts:10:3)\n    at run (x.ts:1:1)',
    );
  });

  test('a multi-line message followed by its stack', () => {
    const m = msg({
      message: 'line one\nline two\nError: line one\nline two\n    at f (a.ts:1:1)',
    });
    expect(formatUnplaced(m)).toBe('  error: line one\nline two\n    at f (a.ts:1:1)');
  });

  test('a stack that does not repeat the message is kept whole', () => {
    const m = msg({ message: 'bad width\nbuild@simHost.ts:10:3' });
    expect(formatUnplaced(m)).toBe('  error: bad width\nbuild@simHost.ts:10:3');
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
