import { VGA_HEIGHT, VGA_WIDTH } from '../sim/vga';
import type { VgaAdapter } from './adapters/types';
import type { RunningSim } from './simHost';

const STATS_INTERVAL_MS = 500;

export interface RenderLoopOptions {
  /** main.ts puts the pixels on the canvas. */
  draw(pixels: Uint8ClampedArray): void;
  adapter: VgaAdapter;
  /** At most one call per 500 ms. */
  onStats(fps: number): void;
  /** Only on change. */
  onNoSync(noSync: boolean): void;
  /** The loop pauses itself before calling this. */
  onRuntimeError(err: Error): void;
  requestFrame?: (cb: (t: number) => void) => number;
  cancelFrame?: (id: number) => void;
}

/**
 * Draws frames from the current simulation and swaps in a freshly compiled one at a frame
 * boundary, so the old design keeps rendering until the new one is ready (no flicker).
 * Knows nothing about pin layouts: everything goes through the {@link VgaAdapter}.
 */
export class RenderLoop {
  private readonly o: RenderLoopOptions;
  private readonly requestFrame: (cb: (t: number) => void) => number;
  private readonly cancelFrame: (id: number) => void;
  // One buffer for the adapter (bytes) and for draw (clamped view), allocated once.
  private readonly pixels: Uint8Array;
  private readonly clamped: Uint8ClampedArray;
  private readonly onFrame = (t: number): void => this.frame(t);

  private current: RunningSim | null = null;
  private pending: RunningSim | null = null;
  private input = 0;
  private isPaused = false;
  private visible = true;
  private disposed = false;
  private errorReported = false;
  private noSync: boolean | null = null;
  private frameId = 0;
  private statsStart = -1;
  private statsFrames = 0;

  constructor(o: RenderLoopOptions) {
    this.o = o;
    this.requestFrame = o.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = o.cancelFrame ?? ((id) => cancelAnimationFrame(id));
    const buf = new ArrayBuffer(VGA_WIDTH * VGA_HEIGHT * 4);
    this.pixels = new Uint8Array(buf);
    this.clamped = new Uint8ClampedArray(buf);
    this.frameId = this.requestFrame(this.onFrame);
  }

  get sim(): RunningSim | null {
    return this.current;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  get uiIn(): number {
    return this.input;
  }

  set uiIn(v: number) {
    this.input = v;
    if (this.current) this.o.adapter.setInputs(this.current.mod, v);
  }

  setSim(next: RunningSim): void {
    this.pending?.dispose();
    this.pending = next;
    this.errorReported = false;
  }

  pause(): void {
    this.isPaused = true;
  }

  resume(): void {
    this.isPaused = false;
    this.errorReported = false;
  }

  setVisible(v: boolean): void {
    this.visible = v;
  }

  reset(): void {
    if (!this.current) return;
    this.o.adapter.reset(this.current.mod);
    this.o.adapter.setInputs(this.current.mod, this.input);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelFrame(this.frameId);
    this.pending?.dispose();
    this.pending = null;
    this.current?.dispose();
    this.current = null;
  }

  private frame(t: number): void {
    if (this.disposed) return;
    this.frameId = this.requestFrame(this.onFrame);
    if (!this.visible || this.isPaused) return;

    if (this.pending) {
      const old = this.current;
      this.o.adapter.setInputs(this.pending.mod, this.input);
      this.current = this.pending;
      this.pending = null;
      old?.dispose();
    }
    const sim = this.current;
    if (!sim) return;

    let vsyncSeen: boolean;
    try {
      vsyncSeen = this.o.adapter.renderFrame(sim.mod, this.pixels, sim.polarity).vsyncSeen;
    } catch (e) {
      this.isPaused = true;
      if (!this.errorReported) {
        this.errorReported = true;
        this.o.onRuntimeError(e instanceof Error ? e : new Error(String(e)));
      }
      return;
    }
    this.o.draw(this.clamped);

    if (this.noSync !== !vsyncSeen) {
      this.noSync = !vsyncSeen;
      this.o.onNoSync(this.noSync);
    }

    if (this.statsStart < 0) this.statsStart = t;
    this.statsFrames++;
    const elapsed = t - this.statsStart;
    if (elapsed >= STATS_INTERVAL_MS) {
      this.o.onStats((this.statsFrames * 1000) / elapsed);
      this.statsStart = t;
      this.statsFrames = 0;
    }
  }
}
