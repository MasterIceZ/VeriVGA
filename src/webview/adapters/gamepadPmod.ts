// Gamepad Pmod emulation: a 24-bit serial frame stepped once per scanline on ui_in[6:4].
// Ported from TinyTapeout/vga-playground (`updateGamepadPmod` in src/InputController.ts,
// pinned at 3e3c77e), Apache-2.0, Copyright Uri Shaked / Tiny Tapeout. Keep it bit-for-bit
// identical to upstream: `test/unit/gamepadPmod.test.ts` compares the two.

export interface GamepadButton {
  /** Bit in the 12-bit button mask. */
  bit: number;
  label: string;
  title: string;
  /** `KeyboardEvent.key` that presses it. */
  key: string;
}

/** The Pmod's button order (bit index) and the upstream keyboard map. */
export const GAMEPAD_BUTTONS: readonly GamepadButton[] = [
  { bit: 6, label: 'Left', title: 'Left', key: 'ArrowLeft' },
  { bit: 7, label: 'Right', title: 'Right', key: 'ArrowRight' },
  { bit: 4, label: 'Up', title: 'Up', key: 'ArrowUp' },
  { bit: 5, label: 'Down', title: 'Down', key: 'ArrowDown' },
  { bit: 8, label: 'A', title: 'A button', key: 'a' },
  { bit: 0, label: 'B', title: 'B button', key: 'b' },
  { bit: 9, label: 'X', title: 'X button', key: 'x' },
  { bit: 1, label: 'Y', title: 'Y button', key: 'y' },
  { bit: 2, label: 'Sel', title: 'Select', key: 's' },
  { bit: 3, label: 'Start', title: 'Start', key: 't' },
  { bit: 10, label: 'L', title: 'Left bumper', key: 'l' },
  { bit: 11, label: 'R', title: 'Right bumper', key: 'r' },
];

/** The `ui_in` bits the Pmod drives (latch, clock, data); the UI disables their toggles. */
export const GAMEPAD_UI_IN_BITS: readonly number[] = [4, 5, 6];

const PULSES = 24;
const CYCLE = 400;

export class GamepadPmod {
  private counter = 0;

  /** Advances one scanline. Returns the pins in bits 4 (latch), 5 (clock) and 6 (data). */
  next(buttons: number): number {
    const cycle = this.counter++ % CYCLE;
    const dataReg = buttons << 12; // the lower 12 bits are for a second game controller
    const clock = cycle < PULSES * 2 ? cycle % 2 : 0;
    const dataIndex = cycle < PULSES * 2 + 1 ? cycle >> 1 : 0;
    const data = (dataReg >> dataIndex) & 1;
    const latch = cycle === PULSES * 2 + 1 ? 1 : 0;
    return (data << 6) | (clock << 5) | (latch << 4);
  }

  reset(): void {
    this.counter = 0;
  }
}
