import type { HDLModuleWASM } from '../../sim/hdlwasm';
import { detectSyncPolarity, renderVGAFrame, resetModule, type SyncPolarity } from '../../sim/vga';
import { GamepadPmod } from './gamepadPmod';
import type { FrameResult, InputState, VgaAdapter } from './types';

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
// Gamepad Pmod pins: ui_in[4] latch, [5] clock, [6] data.
const GAMEPAD_MASK = 0b01110000;

// One serial counter per page: it keeps advancing across frames and recompiles.
const gamepadPmod = new GamepadPmod();
// The pins last driven; setInputs reuses them without stepping the serial counter.
let lastPins = 0;

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

  setInputs(mod: HDLModuleWASM, input: InputState): void {
    const { uiIn, gamepad } = input;
    mod.state.ui_in = gamepad.enabled ? (uiIn & ~GAMEPAD_MASK) | lastPins : uiIn;
  },

  renderFrame(
    mod: HDLModuleWASM,
    pixels: Uint8Array,
    polarity: SyncPolarity,
    input: InputState,
  ): FrameResult {
    const data8 = mod.data8;
    const { gamepad } = input;
    if (gamepad.enabled) {
      // Once per scanline, as upstream. One closure per frame, nothing per line.
      const uiInOffset = mod.globals.lookup('ui_in').offset;
      const onLine = () => {
        lastPins = gamepadPmod.next(gamepad.buttons);
        data8[uiInOffset] = (input.uiIn & ~GAMEPAD_MASK) | lastPins;
      };
      renderVGAFrame(mod, pixels, { polarity, onLine });
    } else {
      renderVGAFrame(mod, pixels, { polarity });
    }

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
