import { describe, expect, test } from 'vitest';
import { GAMEPAD_BUTTONS, GamepadPmod } from '../../src/webview/adapters/gamepadPmod';

/** Verbatim transcription of upstream `updateGamepadPmod()` (vga-playground 3e3c77e). */
class UpstreamRef {
  gamepadPmodCounter = 0;
  gamepadPmodValue = 0;
  uiIn = 0;
  update(): number {
    const cycle = this.gamepadPmodCounter++ % 400;
    const dataReg = this.gamepadPmodValue << 12; // the lower 12 bits are for a second game controller
    const pulses = 24;
    const clock = cycle < pulses * 2 ? cycle % 2 : 0;
    const dataIndex = cycle < pulses * 2 + 1 ? cycle >> 1 : 0;
    const data = (dataReg >> dataIndex) & 1;
    const latch = cycle === pulses * 2 + 1 ? 1 : 0;
    const gamepadPmodPins = (data << 6) | (clock << 5) | (latch << 4);
    this.uiIn = (this.uiIn & ~0b01110000) | gamepadPmodPins;
    return this.uiIn & 0b01110000;
  }
}

const masks = [0, 0xfff, ...Array.from({ length: 12 }, (_, i) => 1 << i), (1 << 4) | (1 << 8)];

describe('GamepadPmod', () => {
  test.each(masks)('matches upstream for 1300 scanlines, buttons 0x%s', (mask) => {
    const ref = new UpstreamRef();
    ref.gamepadPmodValue = mask;
    const pmod = new GamepadPmod();
    for (let i = 0; i < 1300; i++) expect(pmod.next(mask)).toBe(ref.update());
  });

  test('buttons may change between lines', () => {
    const ref = new UpstreamRef();
    const pmod = new GamepadPmod();
    for (let i = 0; i < 900; i++) {
      const mask = (i * 37) & 0xfff;
      ref.gamepadPmodValue = mask;
      expect(pmod.next(mask)).toBe(ref.update());
    }
  });

  test('reset restarts the cycle', () => {
    const pmod = new GamepadPmod();
    const first = Array.from({ length: 60 }, () => pmod.next(0xfff));
    for (let i = 0; i < 17; i++) pmod.next(0xfff);
    pmod.reset();
    expect(Array.from({ length: 60 }, () => pmod.next(0xfff))).toEqual(first);
  });

  test('12 buttons with unique bits and keys', () => {
    expect(GAMEPAD_BUTTONS).toHaveLength(12);
    expect(new Set(GAMEPAD_BUTTONS.map((b) => b.bit)).size).toBe(12);
    expect(new Set(GAMEPAD_BUTTONS.map((b) => b.key)).size).toBe(12);
    const a = GAMEPAD_BUTTONS.find((b) => b.title === 'A button')!;
    expect(a.bit).toBe(8);
    expect(a.key).toBe('a');
  });
});
