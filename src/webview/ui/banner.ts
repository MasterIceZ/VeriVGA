export interface BannerHandlers {
  onShowProblems(): void;
  onRetry(): void;
}

/**
 * A strip above the canvas (never inside its box) for compile errors, messages and the
 * "no sync" hint. It never calls `.focus()`: errors in half-typed code are normal.
 */
export class Banner {
  private readonly main: HTMLElement;
  private readonly hint: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly h: BannerHandlers,
  ) {
    const doc = root.ownerDocument;
    root.classList.add('banner');
    this.main = doc.createElement('div');
    this.main.className = 'banner-main';
    this.main.hidden = true;
    this.hint = doc.createElement('div');
    this.hint.className = 'banner-hint';
    this.hint.textContent = 'No VGA sync detected';
    this.hint.hidden = true;
    root.append(this.main, this.hint);
  }

  showErrors(count: number): void {
    this.fill(`${count} ${count === 1 ? 'error' : 'errors'}`, 'Show in Problems', () =>
      this.h.onShowProblems(),
    );
  }

  showMessage(text: string, opts?: { retry?: boolean }): void {
    this.fill(text, opts?.retry ? 'Retry' : null, () => this.h.onRetry());
  }

  setNoSync(b: boolean): void {
    this.hint.hidden = !b;
  }

  hide(): void {
    this.main.replaceChildren();
    this.main.hidden = true;
  }

  private fill(text: string, action: string | null, onClick: () => void): void {
    const doc = this.root.ownerDocument;
    const label = doc.createElement('span');
    label.textContent = text;
    this.main.replaceChildren(label);
    if (action !== null) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.textContent = action;
      b.addEventListener('click', onClick);
      this.main.append(b);
    }
    this.main.hidden = false;
  }
}
