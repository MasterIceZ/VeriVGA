// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { Banner } from '../../src/webview/ui/banner';
import { Controls } from '../../src/webview/ui/controls';

function key(k: string, init: KeyboardEventInit = {}) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
}

function mkControls() {
  document.body.innerHTML = '<div id="root"></div>';
  const h = { onUiIn: vi.fn(), onReset: vi.fn(), onPauseToggle: vi.fn() };
  const root = document.getElementById('root')!;
  const c = new Controls(root, h);
  return { c, h, root };
}

describe('Controls', () => {
  test('clicking bit 3 and pressing key "5" call onUiIn with 0b0010_1000', () => {
    const { h, root } = mkControls();
    const toggles = root.querySelectorAll<HTMLButtonElement>('button[data-bit]');
    expect(toggles.length).toBe(8);
    toggles[3].click();
    expect(h.onUiIn).toHaveBeenLastCalledWith(0b0000_1000);
    key('5');
    expect(h.onUiIn).toHaveBeenLastCalledWith(0b0010_1000);
    expect(toggles[5].getAttribute('aria-pressed')).toBe('true');
    key('5');
    expect(h.onUiIn).toHaveBeenLastCalledWith(0b0000_1000);
  });

  test('r resets; modifiers are ignored', () => {
    const { h } = mkControls();
    key('r');
    key('R');
    expect(h.onReset).toHaveBeenCalledTimes(2);
    key('r', { ctrlKey: true });
    key('3', { metaKey: true });
    key('3', { altKey: true });
    expect(h.onReset).toHaveBeenCalledTimes(2);
    expect(h.onUiIn).not.toHaveBeenCalled();
  });

  test('setUiIn updates pressed state without calling onUiIn', () => {
    const { c, h, root } = mkControls();
    c.setUiIn(0b101);
    const t = root.querySelectorAll('button[data-bit]');
    expect(t[0].getAttribute('aria-pressed')).toBe('true');
    expect(t[1].getAttribute('aria-pressed')).toBe('false');
    expect(t[2].getAttribute('aria-pressed')).toBe('true');
    expect(h.onUiIn).not.toHaveBeenCalled();
    key('1');
    expect(h.onUiIn).toHaveBeenLastCalledWith(0b111);
  });

  test('pause, fps and compiling', () => {
    const { c, h, root } = mkControls();
    root.querySelector<HTMLButtonElement>('button[data-action="pause"]')!.click();
    expect(h.onPauseToggle).toHaveBeenCalledTimes(1);
    c.setPaused(true);
    expect(root.querySelector('button[data-action="pause"]')!.textContent).toBe('Resume');
    c.setFps(59.6);
    expect(root.querySelector('.fps')!.textContent).toContain('60');
    const comp = root.querySelector<HTMLElement>('.compiling')!;
    expect(comp.hidden).toBe(true);
    c.setCompiling(true);
    expect(comp.hidden).toBe(false);
  });
});

describe('Banner', () => {
  test('banner never takes focus and sits outside the canvas container', () => {
    document.body.innerHTML =
      '<div id="wrap"><div id="bannerRoot"></div><div id="canvasBox"><canvas id="screen"></canvas></div></div>';
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const onShowProblems = vi.fn();
    const onRetry = vi.fn();
    const root = document.getElementById('bannerRoot')!;
    const b = new Banner(root, { onShowProblems, onRetry });
    const buttons = () => [...root.querySelectorAll('button')];
    b.showErrors(3);
    expect(root.textContent).toContain('3 errors');
    buttons()[0].click();
    expect(onShowProblems).toHaveBeenCalledTimes(1);
    b.showErrors(1);
    expect(root.textContent).toContain('1 error');
    expect(root.textContent).not.toContain('1 errors');
    b.showMessage('Boom', { retry: true });
    expect(root.textContent).toContain('Boom');
    buttons()
      .find((x) => x.textContent === 'Retry')!
      .click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    b.showMessage('Plain');
    expect(buttons().some((x) => x.textContent === 'Retry')).toBe(false);
    b.setNoSync(true);
    expect(root.textContent).toContain('No VGA sync detected');
    b.hide();
    expect(root.textContent).not.toContain('Plain');
    expect(root.textContent).toContain('No VGA sync detected');
    b.setNoSync(false);
    expect(root.querySelector<HTMLElement>('.banner-hint')!.hidden).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    expect(document.getElementById('canvasBox')!.contains(root)).toBe(false);
    expect(root.nextElementSibling).toBe(document.getElementById('canvasBox'));
    focus.mockRestore();
  });
});
