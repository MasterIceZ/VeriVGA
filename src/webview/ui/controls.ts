import { GAMEPAD_BUTTONS, GAMEPAD_UI_IN_BITS } from '../adapters/gamepadPmod';
import { GamepadPad } from './gamepad';

export interface ControlsHandlers {
  onUiIn(v: number): void;
  /** Gamepad Pmod mode and the held-button mask (bit per button). */
  onGamepad(enabled: boolean, buttons: number): void;
  onReset(): void;
  onPauseToggle(): void;
}

function button(doc: Document, text: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.textContent = text;
  return b;
}

/** The `ui_in` toggles, Reset, Pause, fps readout and "compiling…" marker. */
export class Controls {
  private value = 0;
  private gamepadOn = false;
  private held = 0;
  private readonly keyBits = new Map(GAMEPAD_BUTTONS.map((b) => [b.key, b.bit]));
  private readonly pad: GamepadPad;
  private readonly gamepadBtn: HTMLButtonElement;
  private readonly toggles: HTMLButtonElement[] = [];
  private readonly pauseBtn: HTMLButtonElement;
  private readonly fps: HTMLElement;
  private readonly compiling: HTMLElement;

  constructor(
    root: HTMLElement,
    private readonly h: ControlsHandlers,
  ) {
    const doc = root.ownerDocument;
    const bar = doc.createElement('div');
    bar.className = 'controls';

    const bits = doc.createElement('div');
    bits.className = 'bits';
    for (let i = 0; i < 8; i++) {
      const t = button(doc, String(i));
      t.className = 'bit';
      t.dataset.bit = String(i);
      t.title = `ui_in[${i}] (key ${i})`;
      t.setAttribute('aria-pressed', 'false');
      t.addEventListener('click', () => this.toggle(i));
      this.toggles.push(t);
      bits.append(t);
    }

    this.gamepadBtn = button(doc, 'Gamepad');
    this.gamepadBtn.dataset.action = 'gamepad';
    this.gamepadBtn.title = 'Gamepad Pmod: keys A B X Y S T L R and arrows';
    this.gamepadBtn.setAttribute('aria-pressed', 'false');
    this.gamepadBtn.addEventListener('click', () => this.setGamepad(!this.gamepadOn));

    this.pad = new GamepadPad(doc, {
      onPress: (bit) => this.hold(bit, true),
      onRelease: (bit) => this.hold(bit, false),
    });

    const reset = button(doc, 'Reset');
    reset.dataset.action = 'reset';
    reset.title = 'Reset the design (R)';
    reset.addEventListener('click', () => h.onReset());

    this.pauseBtn = button(doc, 'Pause');
    this.pauseBtn.dataset.action = 'pause';
    this.pauseBtn.addEventListener('click', () => h.onPauseToggle());

    this.fps = doc.createElement('span');
    this.fps.className = 'fps';
    this.fps.textContent = '-- fps';

    this.compiling = doc.createElement('span');
    this.compiling.className = 'compiling';
    this.compiling.textContent = 'compiling…';
    this.compiling.hidden = true;

    bar.append(bits, this.gamepadBtn, reset, this.pauseBtn, this.fps, this.compiling);
    root.append(bar, this.pad.element);

    doc.addEventListener('keydown', (e) => this.onKey(e));
    doc.addEventListener('keyup', (e) => this.onKeyUp(e));
    doc.defaultView?.addEventListener('blur', () => this.releaseAll());
  }

  setUiIn(v: number): void {
    this.value = v & 0xff;
    this.toggles.forEach((t, i) => t.setAttribute('aria-pressed', String(((v >> i) & 1) === 1)));
  }

  setPaused(b: boolean): void {
    this.pauseBtn.textContent = b ? 'Resume' : 'Pause';
  }

  setFps(n: number): void {
    this.fps.textContent = `${Math.round(n)} fps`;
  }

  setCompiling(b: boolean): void {
    this.compiling.hidden = !b;
  }

  private toggle(bit: number): void {
    this.setUiIn(this.value ^ (1 << bit));
    this.h.onUiIn(this.value);
  }

  private setGamepad(on: boolean): void {
    this.gamepadOn = on;
    this.gamepadBtn.setAttribute('aria-pressed', String(on));
    this.pad.setVisible(on);
    for (const bit of GAMEPAD_UI_IN_BITS) this.toggles[bit].disabled = on;
    this.held = 0;
    this.pad.setPressed(0);
    this.h.onGamepad(on, 0);
  }

  private hold(bit: number, down: boolean): void {
    const next = down ? this.held | (1 << bit) : this.held & ~(1 << bit);
    if (next === this.held) return;
    this.held = next;
    this.pad.setPressed(next);
    this.h.onGamepad(this.gamepadOn, next);
  }

  private releaseAll(): void {
    if (this.held === 0) return;
    this.held = 0;
    this.pad.setPressed(0);
    this.h.onGamepad(this.gamepadOn, 0);
  }

  private padBit(key: string): number | undefined {
    if (!this.gamepadOn) return undefined;
    return this.keyBits.get(key.length === 1 ? key.toLowerCase() : key);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Shift+R always resets; plain r is the R shoulder while the gamepad is on.
    if (e.key === 'R') {
      this.h.onReset();
      return;
    }
    const bit = this.padBit(e.key);
    if (bit !== undefined) {
      e.preventDefault();
      if (!e.repeat) this.hold(bit, true);
      return;
    }
    if (e.key.length === 1 && e.key >= '0' && e.key <= '7') {
      const n = Number(e.key);
      if (!(this.gamepadOn && GAMEPAD_UI_IN_BITS.includes(n))) this.toggle(n);
    } else if (e.key === 'r') this.h.onReset();
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const bit = this.padBit(e.key);
    if (bit !== undefined) this.hold(bit, false);
  }
}
