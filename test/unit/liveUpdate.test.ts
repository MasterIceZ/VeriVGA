import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  hashPayload,
  LiveUpdate,
  type LiveUpdateDeps,
  type LoadPayload,
} from '../../src/extension/liveUpdate';
import type { LoadMessage } from '../../src/shared/protocol';

const payload = (src = 'module top; endmodule'): LoadPayload => ({
  topModule: 'top',
  sources: { 'src/top.v': src },
  dataFiles: {},
});

function setup(over: Partial<LiveUpdateDeps> = {}) {
  const sent: LoadMessage[] = [];
  const state = { current: payload(), visible: true, enabled: true };
  const lu = new LiveUpdate({
    delayMs: () => 300,
    enabled: () => state.enabled,
    isVisible: () => state.visible,
    gather: () => Promise.resolve(state.current),
    send: (m) => sent.push(m),
    ...over,
  });
  return { lu, sent, state };
}

// Only timers are faked: crypto.subtle.digest completes on real I/O, so tests
// wait for it with `until` rather than by advancing fake time.
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
  expect(cond()).toBe(true);
}

describe('hashPayload', () => {
  test('is independent of key order and sensitive to content', async () => {
    const a = await hashPayload({
      topModule: 't',
      sources: { a: '1', b: '2' },
      dataFiles: {},
    });
    const b = await hashPayload({
      topModule: 't',
      sources: { b: '2', a: '1' },
      dataFiles: {},
    });
    const c = await hashPayload({
      topModule: 't2',
      sources: { a: '1', b: '2' },
      dataFiles: {},
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('LiveUpdate', () => {
  test('edits within the delay coalesce into one send after the last edit', async () => {
    const { lu, sent } = setup();
    lu.onEdit();
    await vi.advanceTimersByTimeAsync(100);
    lu.onEdit();
    await vi.advanceTimersByTimeAsync(100);
    lu.onEdit();
    await vi.advanceTimersByTimeAsync(299);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => sent.length === 1);
    expect(sent[0]).toMatchObject({
      type: 'load',
      generation: 1,
      topModule: 'top',
    });
    expect(lu.generation).toBe(1);
  });

  test('unchanged payload is skipped', async () => {
    const { lu, sent, state } = setup();
    await lu.flush();
    await lu.flush();
    expect(sent).toHaveLength(1);
    state.current = payload('module top; wire x; endmodule');
    await lu.flush();
    expect(sent).toHaveLength(2);
    expect(lu.generation).toBe(2);
  });

  test('flush sends immediately and cancels the timer', async () => {
    const { lu, sent, state } = setup();
    lu.onEdit();
    await lu.flush();
    expect(sent).toHaveLength(1);
    state.current = payload('changed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(1);
  });

  test('liveUpdate disabled: edits ignored, flush still works', async () => {
    const { lu, sent, state } = setup();
    state.enabled = false;
    lu.onEdit();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(0);
    await lu.flush();
    expect(sent).toHaveLength(1);
  });

  test('hidden: nothing sent; onVisible sends once', async () => {
    const { lu, sent, state } = setup();
    state.visible = false;
    lu.onEdit();
    await vi.advanceTimersByTimeAsync(500);
    await lu.flush();
    expect(sent).toHaveLength(0);
    state.visible = true;
    await lu.onVisible();
    expect(sent).toHaveLength(1);
    await lu.onVisible();
    expect(sent).toHaveLength(1);
  });

  test('onVisible with nothing held sends nothing', async () => {
    const { lu, sent } = setup();
    await lu.onVisible();
    expect(sent).toHaveLength(0);
  });

  test('resend ignores the hash and bumps generation', async () => {
    const { lu, sent } = setup();
    await lu.flush();
    await lu.resend();
    expect(sent.map((m) => m.generation)).toEqual([1, 2]);
    await lu.flush(); // hash of last sent is unchanged -> skipped
    expect(sent).toHaveLength(2);
  });

  test('gather returning null sends nothing and does not bump generation', async () => {
    const { lu, sent } = setup({ gather: () => Promise.resolve(null) });
    await lu.flush();
    await lu.resend();
    expect(sent).toHaveLength(0);
    expect(lu.generation).toBe(0);
  });

  test('dispose cancels a pending timer; later calls are no-ops', async () => {
    const { lu, sent } = setup();
    lu.onEdit();
    lu.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    await lu.flush();
    await lu.resend();
    lu.onEdit();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(0);
  });

  test('dispose during an in-flight gather suppresses its send', async () => {
    let resolve!: (p: LoadPayload) => void;
    const { lu, sent } = setup({
      gather: () => new Promise<LoadPayload>((r) => (resolve = r)),
    });
    const p = lu.flush();
    lu.dispose();
    resolve(payload());
    await p;
    expect(sent).toHaveLength(0);
  });

  test('delay 0 still goes through the timer', async () => {
    const { lu, sent } = setup({ delayMs: () => 0 });
    lu.onEdit();
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    await until(() => sent.length === 1);
  });

  test('a trigger during a slow gather queues exactly one rerun, in order', async () => {
    const resolvers: ((p: LoadPayload) => void)[] = [];
    const { lu, sent } = setup({
      gather: () => new Promise<LoadPayload>((r) => resolvers.push(r)),
    });
    const p1 = lu.flush();
    await until(() => resolvers.length === 1);
    const p2 = lu.flush();
    const p3 = lu.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolvers).toHaveLength(1); // still only one gather running
    resolvers[0](payload('first'));
    await until(() => resolvers.length === 2);
    resolvers[1](payload('second'));
    await Promise.all([p1, p2, p3]);
    expect(sent.map((m) => m.generation)).toEqual([1, 2]);
    expect(sent[0].sources['src/top.v']).toBe('first');
    expect(sent[1].sources['src/top.v']).toBe('second');
  });

  test('a queued resend keeps its ignore-hash meaning', async () => {
    const resolvers: ((p: LoadPayload) => void)[] = [];
    const { lu, sent } = setup({
      gather: () => new Promise<LoadPayload>((r) => resolvers.push(r)),
    });
    const p1 = lu.flush();
    await until(() => resolvers.length === 1);
    const p2 = lu.resend();
    resolvers[0](payload());
    await until(() => resolvers.length === 2);
    resolvers[1](payload()); // identical payload, but resend must still send
    await Promise.all([p1, p2]);
    expect(sent.map((m) => m.generation)).toEqual([1, 2]);
  });
});
