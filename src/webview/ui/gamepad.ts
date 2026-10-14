import { GAMEPAD_BUTTONS, type GamepadButton } from '../adapters/gamepadPmod';

export interface GamepadPadHandlers {
  onPress(bit: number): void;
  onRelease(bit: number): void;
}

const LAYOUT: Record<string, string> = {
  Left: 'dpad',
  Right: 'dpad',
  Up: 'dpad',
  Down: 'dpad',
  Sel: 'mid',
  Start: 'mid',
  Y: 'face',
  X: 'face',
  B: 'face',
  A: 'face',
  L: 'shoulder',
  R: 'shoulder',
};

const ARROWS: Record<string, string> = { Left: '◀', Right: '▶', Up: '▲', Down: '▼' };

/** The on-screen gamepad: 12 press-and-hold buttons. It only reports presses; Controls owns the mask. */
export class GamepadPad {
  readonly element: HTMLElement;
  private readonly buttons = new Map<number, HTMLButtonElement>();

  constructor(
    doc: Document,
    private readonly h: GamepadPadHandlers,
  ) {
    this.element = doc.createElement('div');
    this.element.className = 'gamepad';
    this.element.hidden = true;

    const groups = new Map<string, HTMLElement>();
    for (const name of ['shoulder', 'dpad', 'mid', 'face']) {
      const g = doc.createElement('div');
      g.className = `pad-${name}`;
      groups.set(name, g);
    }
    for (const def of GAMEPAD_BUTTONS) {
      const b = this.makeButton(doc, def);
      this.buttons.set(def.bit, b);
      groups.get(LAYOUT[def.label])!.append(b);
    }
    this.element.append(...groups.values());
  }

  setVisible(v: boolean): void {
    this.element.hidden = !v;
  }

  /** Shows which buttons are held. */
  setPressed(mask: number): void {
    for (const [bit, b] of this.buttons) {
      b.setAttribute('aria-pressed', String(((mask >> bit) & 1) === 1));
    }
  }

  private makeButton(doc: Document, def: GamepadButton): HTMLButtonElement {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = ARROWS[def.label] ?? def.label;
    b.title = def.title;
    b.className = `pad-btn pad-${def.label.toLowerCase()}`;
    b.dataset.padBit = String(def.bit);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.h.onPress(def.bit);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
      b.addEventListener(type, () => this.h.onRelease(def.bit));
    }
    return b;
  }
}
