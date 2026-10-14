import { describe, expect, test } from 'vitest';
import { isHostToWebview, isWebviewToHost } from '../../src/shared/protocol';

const message = { severity: 'error', file: 'src/project.v', line: 3, column: 5, message: 'x' };

describe('isWebviewToHost', () => {
  test('accepts valid messages', () => {
    expect(
      isWebviewToHost({ type: 'compiled', generation: 1, ok: true, messages: [], ms: 5 }),
    ).toBe(true);
    expect(
      isWebviewToHost({ type: 'compiled', generation: 1, ok: false, messages: [message], ms: 5 }),
    ).toBe(true);
    expect(isWebviewToHost({ type: 'ready' })).toBe(true);
    expect(isWebviewToHost({ type: 'runtimeError', generation: 2, message: 'boom' })).toBe(true);
    expect(isWebviewToHost({ type: 'stats', fps: 60, state: 'running' })).toBe(true);
    expect(isWebviewToHost({ type: 'screenshot', png: 'iVBOR' })).toBe(true);
  });

  test('rejects wrong field types and unknown types', () => {
    expect(isWebviewToHost({ type: 'compiled', generation: '1' })).toBe(false);
    expect(
      isWebviewToHost({ type: 'compiled', generation: 1, ok: true, messages: [{}], ms: 5 }),
    ).toBe(false);
    expect(isWebviewToHost({ type: 'stats', fps: 60, state: 'bogus' })).toBe(false);
    expect(isWebviewToHost({ type: 'load' })).toBe(false);
    expect(isWebviewToHost(null)).toBe(false);
    expect(isWebviewToHost('ready')).toBe(false);
  });
});

describe('isHostToWebview', () => {
  test('accepts valid messages', () => {
    expect(
      isHostToWebview({ type: 'load', generation: 1, topModule: 't', sources: {}, dataFiles: {} }),
    ).toBe(true);
    expect(isHostToWebview({ type: 'control', action: 'reset' })).toBe(true);
  });

  test('rejects wrong field types and unknown types', () => {
    expect(
      isHostToWebview({
        type: 'load',
        generation: 1,
        topModule: 't',
        sources: { a: 1 },
        dataFiles: {},
      }),
    ).toBe(false);
    expect(isHostToWebview({ type: 'load', generation: 1, topModule: 't', sources: {} })).toBe(
      false,
    );
    expect(isHostToWebview({ type: 'control', action: 'explode' })).toBe(false);
    expect(isHostToWebview({ type: 'ready' })).toBe(false);
    expect(isHostToWebview(undefined)).toBe(false);
  });
});
