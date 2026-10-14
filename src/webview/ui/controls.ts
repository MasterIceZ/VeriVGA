export interface ControlsHandlers {
  onUiIn(v: number): void;
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

    bar.append(bits, reset, this.pauseBtn, this.fps, this.compiling);
    root.append(bar);

    doc.addEventListener('keydown', (e) => this.onKey(e));
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

  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1 && e.key >= '0' && e.key <= '7') this.toggle(Number(e.key));
    else if (e.key === 'r' || e.key === 'R') this.h.onReset();
  }
}
