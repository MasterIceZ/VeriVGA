/// <reference types="mocha" />
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { WebviewToHost } from '../../src/shared/protocol';

type Compiled = Extract<WebviewToHost, { type: 'compiled' }>;

/** Polls `verivga._lastCompiled` every 50 ms, up to 30 s, until `pred` holds. */
async function waitForCompiled(pred: (c: Compiled) => boolean): Promise<Compiled> {
  const deadline = Date.now() + 30_000;
  let last: Compiled | undefined;
  while (Date.now() < deadline) {
    last = await vscode.commands.executeCommand<Compiled | undefined>('verivga._lastCompiled');
    if (last && pred(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for compiled; last: ${JSON.stringify(last)}`);
}

suite('preview', () => {
  test('opening the preview compiles stripes', async () => {
    const t0 = Date.now();
    await vscode.commands.executeCommand('verivga.openPreview');
    const c = await waitForCompiled((c) => c.ok);
    // M0 spike timing, read from the runner output.
    console.log(`[m0] openPreview -> compiled ok: ${Date.now() - t0} ms; compiled.ms: ${c.ms}`);
    assert.strictEqual(c.ok, true);
    assert.deepStrictEqual(
      c.messages.filter((m) => m.severity === 'error'),
      [],
    );
  });
});
