import type { HDLModuleWASM } from '../../sim/hdlwasm';
import type { SyncPolarity } from '../../sim/vga';

export interface FrameResult {
  vsyncSeen: boolean;
}

/** What the user drives: the `ui_in` toggles and the emulated gamepad. */
export interface InputState {
  uiIn: number;
  gamepad: { enabled: boolean; buttons: number };
}

/** Everything the render loop needs to know about a design's pin layout. */
export interface VgaAdapter {
  /** null = ok, else a user-facing message. */
  validate(mod: HDLModuleWASM, topModule: string): string | null;
  reset(mod: HDLModuleWASM): void;
  detectPolarity(mod: HDLModuleWASM): SyncPolarity;
  setInputs(mod: HDLModuleWASM, input: InputState): void;
  renderFrame(
    mod: HDLModuleWASM,
    pixels: Uint8Array,
    polarity: SyncPolarity,
    input: InputState,
  ): FrameResult;
}
