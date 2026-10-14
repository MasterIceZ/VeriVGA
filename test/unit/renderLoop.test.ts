import { describe, expect, test, vi } from 'vitest';
import type { HDLModuleWASM } from '../../src/sim/hdlwasm';
import { VGA_HEIGHT, VGA_WIDTH } from '../../src/sim/vga';
import type { VgaAdapter } from '../../src/webview/adapters/types';
import { RenderLoop } from '../../src/webview/renderLoop';
import type { RunningSim } from '../../src/webview/simHost';

function makeSim(name: string): RunningSim & { dispose: ReturnType<typeof vi.fn> } {
  return {
    mod: { name } as unknown as HDLModuleWASM,
    polarity: { hsyncActiveLow: true, vsyncActiveLow: true } as never,
    topModule: name,
    dispose: vi.fn(),
  };
}

function setup(vsyncSeen = true) {
  const adapter = {
    validate: vi.fn(() => null),
    reset: vi.fn(),
    detectPolarity: vi.fn(),
    setInputs: vi.fn(),
    renderFrame: vi.fn<VgaAdapter['renderFrame']>(() => ({ vsyncSeen })),
  };
  let pending: ((t: number) => void) | null = null;
  const requestFrame = vi.fn((cb: (t: number) => void) => {
    pending = cb;
    return 1;
  });
  const cancelFrame = vi.fn();
  const o = {
    draw: vi.fn(),
    adapter: adapter as unknown as VgaAdapter,
    onStats: vi.fn(),
    onNoSync: vi.fn(),
    onRuntimeError: vi.fn(),
    requestFrame,
    cancelFrame,
  };
  const loop = new RenderLoop(o);
  const tick = (t: number) => {
    const cb = pending;
    pending = null;
    cb?.(t);
  };
  return { loop, adapter, o, tick };
}

describe('RenderLoop', () => {
  test('uses one pixel buffer for adapter and draw', () => {
    const { loop, adapter, o, tick } = setup();
    loop.setSim(makeSim('a'));
    tick(0);
    tick(16);
    const px = adapter.renderFrame.mock.calls[0][1] as Uint8Array;
    const px2 = adapter.renderFrame.mock.calls[1][1] as Uint8Array;
    const drawn = o.draw.mock.calls[0][0] as Uint8ClampedArray;
    expect(px).toBe(px2);
    expect(px.byteLength).toBe(VGA_WIDTH * VGA_HEIGHT * 4);
    expect(drawn.buffer).toBe(px.buffer);
    expect(o.draw.mock.calls[1][0]).toBe(drawn);
  });

  test('setSim swaps on next frame and disposes the old sim', () => {
    const { loop, adapter, tick } = setup();
    const a = makeSim('a');
    const b = makeSim('b');
    loop.setSim(a);
    tick(0);
    expect(loop.sim).toBe(a);
    loop.setSim(b);
    expect(loop.sim).toBe(a);
    expect(a.dispose).not.toHaveBeenCalled();
    tick(16);
    expect(loop.sim).toBe(b);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(adapter.renderFrame.mock.calls[1][0]).toBe(b.mod);
  });

  test('a superseded pending sim is disposed immediately', () => {
    const { loop, tick } = setup();
    const a = makeSim('a');
    const b = makeSim('b');
    const c = makeSim('c');
    loop.setSim(a);
    loop.setSim(b);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    loop.setSim(c);
    expect(b.dispose).toHaveBeenCalledTimes(1);
    tick(0);
    expect(loop.sim).toBe(c);
    expect(c.dispose).not.toHaveBeenCalled();
  });

  test('uiIn persists across setSim', () => {
    const { loop, adapter, tick } = setup();
    const a = makeSim('a');
    const b = makeSim('b');
    loop.setSim(a);
    tick(0);
    loop.uiIn = 0x28;
    expect(adapter.setInputs).toHaveBeenLastCalledWith(a.mod, loop.input);
    expect(loop.input.uiIn).toBe(0x28);
    loop.setSim(b);
    tick(16);
    expect(adapter.setInputs).toHaveBeenLastCalledWith(b.mod, loop.input);
    expect(loop.input.uiIn).toBe(0x28);
  });

  test('gamepad state persists across setSim and reaches renderFrame', () => {
    const { loop, adapter, tick } = setup();
    const a = makeSim('a');
    const b = makeSim('b');
    loop.setSim(a);
    tick(0);
    loop.setGamepad(true, 0x100);
    expect(adapter.setInputs).toHaveBeenLastCalledWith(a.mod, {
      uiIn: 0,
      gamepad: { enabled: true, buttons: 0x100 },
    });
    loop.setSim(b);
    tick(16);
    expect(adapter.setInputs).toHaveBeenLastCalledWith(b.mod, loop.input);
    expect(adapter.renderFrame.mock.lastCall?.[3]).toEqual({
      uiIn: 0,
      gamepad: { enabled: true, buttons: 0x100 },
    });
    loop.setGamepad(false, 0);
    tick(32);
    expect(adapter.renderFrame.mock.lastCall?.[3].gamepad).toEqual({ enabled: false, buttons: 0 });
  });

  test('reset resets the current sim and keeps uiIn', () => {
    const { loop, adapter, tick } = setup();
    const a = makeSim('a');
    loop.setSim(a);
    tick(0);
    loop.uiIn = 3;
    loop.reset();
    expect(adapter.reset).toHaveBeenCalledWith(a.mod);
    expect(adapter.setInputs).toHaveBeenLastCalledWith(a.mod, loop.input);
    expect(loop.input.uiIn).toBe(3);
  });

  test('stats throttled to one per 500 ms', () => {
    const { loop, o, tick } = setup();
    loop.setSim(makeSim('a'));
    tick(0);
    for (let t = 100; t < 500; t += 100) tick(t);
    expect(o.onStats).not.toHaveBeenCalled();
    tick(500);
    expect(o.onStats).toHaveBeenCalledTimes(1);
    expect(o.onStats.mock.calls[0][0]).toBeCloseTo(12, 5); // 6 frames / 0.5 s
    tick(600);
    tick(700);
    expect(o.onStats).toHaveBeenCalledTimes(1);
    tick(1000);
    expect(o.onStats).toHaveBeenCalledTimes(2);
  });

  test('hidden or paused renders nothing', () => {
    const { loop, adapter, o, tick } = setup();
    loop.setSim(makeSim('a'));
    loop.setVisible(false);
    tick(0);
    expect(adapter.renderFrame).not.toHaveBeenCalled();
    loop.setVisible(true);
    loop.pause();
    expect(loop.paused).toBe(true);
    tick(16);
    expect(adapter.renderFrame).not.toHaveBeenCalled();
    loop.resume();
    tick(32);
    expect(adapter.renderFrame).toHaveBeenCalledTimes(1);
    expect(o.draw).toHaveBeenCalledTimes(1);
  });

  test('runtime error pauses and reports once, resume re-arms', () => {
    const { loop, adapter, o, tick } = setup();
    loop.setSim(makeSim('a'));
    const boom = new Error('boom');
    adapter.renderFrame.mockImplementation(() => {
      throw boom;
    });
    tick(0);
    expect(loop.paused).toBe(true);
    expect(o.onRuntimeError).toHaveBeenCalledTimes(1);
    expect(o.onRuntimeError).toHaveBeenCalledWith(boom);
    tick(16);
    expect(o.onRuntimeError).toHaveBeenCalledTimes(1);
    loop.resume();
    tick(32);
    expect(o.onRuntimeError).toHaveBeenCalledTimes(2);
  });

  test('onNoSync fires only on change', () => {
    const { loop, adapter, o, tick } = setup(false);
    loop.setSim(makeSim('a'));
    tick(0);
    tick(16);
    expect(o.onNoSync).toHaveBeenCalledTimes(1);
    expect(o.onNoSync).toHaveBeenLastCalledWith(true);
    adapter.renderFrame.mockImplementation(() => ({ vsyncSeen: true }));
    tick(32);
    tick(48);
    expect(o.onNoSync).toHaveBeenCalledTimes(2);
    expect(o.onNoSync).toHaveBeenLastCalledWith(false);
  });

  test('dispose disposes the sim and stops scheduling', () => {
    const { loop, o, tick } = setup();
    const a = makeSim('a');
    const b = makeSim('b');
    loop.setSim(a);
    tick(0);
    loop.setSim(b);
    loop.dispose();
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(o.cancelFrame).toHaveBeenCalled();
    const calls = o.requestFrame.mock.calls.length;
    tick(16);
    expect(o.requestFrame.mock.calls.length).toBe(calls);
  });
});
