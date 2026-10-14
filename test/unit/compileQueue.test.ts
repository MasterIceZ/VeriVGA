import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CompileQueue, type CompileJob } from '../../src/webview/compileQueue';

const job = (generation: number): CompileJob => ({
  generation,
  topModule: 'top',
  sources: {},
  dataFiles: {},
});

describe('CompileQueue', () => {
  let started: number[];
  let timedOut: number[];
  let q: CompileQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    started = [];
    timedOut = [];
    q = new CompileQueue({
      start: (j) => started.push(j.generation),
      onTimeout: (j) => timedOut.push(j.generation),
    });
  });
  afterEach(() => {
    q.dispose();
    vi.useRealTimers();
  });

  test('idle submit starts immediately', () => {
    expect(q.busy).toBe(false);
    q.submit(job(1));
    expect(started).toEqual([1]);
    expect(q.busy).toBe(true);
  });

  test('submits while running keep only the newest pending', () => {
    q.submit(job(1));
    q.submit(job(2));
    q.submit(job(3));
    expect(started).toEqual([1]);
    q.complete(1);
    expect(started).toEqual([1, 3]);
  });

  test('result with a pending newer job is dropped', () => {
    q.submit(job(1));
    q.submit(job(3));
    expect(q.complete(1)).toBeNull();
    expect(q.busy).toBe(true);
  });

  test('result without pending is applied', () => {
    q.submit(job(3));
    expect(q.complete(3)?.generation).toBe(3);
    expect(q.busy).toBe(false);
  });

  test('stale or unknown generation returns null', () => {
    q.submit(job(2));
    q.submit(job(3));
    expect(q.complete(1)).toBeNull();
    expect(q.complete(99)).toBeNull();
    expect(started).toEqual([2]);
    expect(q.busy).toBe(true);
  });

  test('watchdog fires onTimeout at 20 000 ms and starts pending', () => {
    q.submit(job(1));
    q.submit(job(2));
    vi.advanceTimersByTime(19_999);
    expect(timedOut).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(timedOut).toEqual([1]);
    expect(started).toEqual([1, 2]);
    expect(q.complete(1)).toBeNull();
    expect(q.busy).toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(timedOut).toEqual([1, 2]);
    expect(q.busy).toBe(false);
  });

  test('watchdog without pending goes idle', () => {
    q.submit(job(1));
    vi.advanceTimersByTime(20_000);
    expect(timedOut).toEqual([1]);
    expect(q.busy).toBe(false);
  });

  test('complete clears the watchdog', () => {
    q.submit(job(1));
    q.complete(1);
    vi.advanceTimersByTime(60_000);
    expect(timedOut).toEqual([]);
  });

  test('dispose stops the watchdog and drops pending', () => {
    q.submit(job(1));
    q.submit(job(2));
    q.dispose();
    vi.advanceTimersByTime(60_000);
    expect(timedOut).toEqual([]);
    expect(q.complete(1)).toBeNull();
    q.submit(job(5));
    expect(started).toEqual([1]);
  });
});
