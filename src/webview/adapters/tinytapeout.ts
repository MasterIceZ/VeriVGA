import type { HDLModuleWASM } from '../../sim/hdlwasm';
import { detectSyncPolarity, renderVGAFrame, resetModule, type SyncPolarity } from '../../sim/vga';
import type { FrameResult, VgaAdapter } from './types';

const REQUIRED_PORTS = [
  'ui_in',
  'uo_out',
  'uio_in',
  'uio_out',
  'uio_oe',
  'ena',
  'clk',
  'rst_n',
] as const;

const VSYNC_MASK = 0b00001000;
const VSYNC_WAIT_CAP = 420_000;

export const tinyTapeoutAdapter: VgaAdapter = {
  validate(mod: HDLModuleWASM, topModule: string): string | null {
    const missing = REQUIRED_PORTS.filter((name) => mod.globals.lookup(name) === undefined);
    if (missing.length === 0) return null;
    return `Top module \`${topModule}\` doesn't have the TinyTapeout port list (missing: ${missing.join(', ')})`;
  },

  reset(mod: HDLModuleWASM): void {
    resetModule(mod);
  },

  detectPolarity(mod: HDLModuleWASM): SyncPolarity {
    return detectSyncPolarity(mod);
  },

  setInputs(mod: HDLModuleWASM, uiIn: number): void {
    mod.state.ui_in = uiIn;
  },

  renderFrame(mod: HDLModuleWASM, pixels: Uint8Array, polarity: SyncPolarity): FrameResult {
    renderVGAFrame(mod, pixels, { polarity });

    const data8 = mod.data8;
    const offset = mod.globals.lookup('uo_out').offset;
    const activeLow = polarity.vsyncActiveLow;
    // vsync is asserted when (raw bit set) XOR activeLow.
    const asserted = () => !!(data8[offset] & VSYNC_MASK) !== activeLow;

    let n = 0;
    while (!asserted() && n < VSYNC_WAIT_CAP) {
      mod.tick2(1);
      n++;
    }
    if (n >= VSYNC_WAIT_CAP) return { vsyncSeen: false };
    n = 0;
    while (asserted() && n < VSYNC_WAIT_CAP) {
      mod.tick2(1);
      n++;
    }
    return { vsyncSeen: n < VSYNC_WAIT_CAP };
  },
};
