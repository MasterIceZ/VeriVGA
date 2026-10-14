/// <reference types="mocha" />
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { WebviewToHost } from '../../src/shared/protocol';

type Compiled = Extract<WebviewToHost, { type: 'compiled' }>;

const RUNS = 7;
/** Allowed overhead on top of `verivga.liveDelay`: the compile and the swap-in. */
const BUDGET_MS = 700;
const POLL_MS = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const compiledLog = async () =>
  (await vscode.commands.executeCommand<Compiled[]>('verivga._compiledLog')) ?? [];

/** Polls every `everyMs`, up to 30 s, until `pred` accepts what `read` returns. */
async function poll<T>(
  what: string,
  read: () => PromiseLike<T>,
  pred: (v: T) => boolean,
  everyMs = 50,
): Promise<T> {
  const deadline = Date.now() + 30_000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (pred(last)) return last;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}

const isPreviewTab = (t: vscode.Tab) =>
  t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('verivga.preview');

/** Back to the text on disk without saving (same approach as `revert` in preview.test.ts). */
async function revert(doc: vscode.TextDocument): Promise<void> {
  const previewGroup = vscode.window.tabGroups.all.find((g) => g.tabs.some(isPreviewTab));
  const viewColumn =
    previewGroup?.viewColumn === vscode.ViewColumn.One
      ? vscode.ViewColumn.Two
      : vscode.ViewColumn.One;
  await vscode.window.showTextDocument(doc, { viewColumn });
  await vscode.commands.executeCommand('workbench.action.files.revert');
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Desktop only: the web run is covered by the functional suite, and its timers make this
// number noisy.
const isWeb = vscode.env.uiKind === vscode.UIKind.Web;

(isWeb ? suite.skip : suite)('latency', () => {
  test(`median edit-to-compiled ≤ liveDelay + ${BUDGET_MS} ms`, async () => {
    const liveDelay = vscode.workspace.getConfiguration('verivga').get<number>('liveDelay', 300);
    await vscode.commands.executeCommand('verivga.openPreview');
    await poll('a first compiled', compiledLog, (l) => l.length > 0);

    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'src/project.v');
    const doc = await vscode.workspace.openTextDocument(uri);
    const original = doc.getText();
    const times: number[] = [];
    try {
      for (let i = 0; i < RUNS; i++) {
        const before = (await compiledLog()).length;
        // A distinct comment each run, so the source hash changes and a recompile happens.
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          uri,
          new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
          `${original}\n// latency run ${i}\n`,
        );
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
        const t0 = Date.now();
        const log = await poll(
          `a compiled after run ${i}`,
          compiledLog,
          (l) => l.length > before && l[l.length - 1].ok,
          POLL_MS,
        );
        times.push(Date.now() - t0);
        assert.strictEqual(log[log.length - 1].ok, true);
        // Settle on the original text before the next run, so every run starts idle.
        await revert(doc);
        const settled = (await compiledLog()).length;
        await poll(
          'the revert compile',
          compiledLog,
          (l) => l.length > settled && l[l.length - 1].ok,
        );
        await sleep(200);
      }
    } finally {
      if (doc.isDirty) await revert(doc);
    }

    const med = median(times);
    console.log(
      `[latency] liveDelay ${liveDelay} ms; runs (ms): ${times.join(', ')}; median ${med} ms; ` +
        `limit ${liveDelay + BUDGET_MS} ms`,
    );
    assert.ok(
      med <= liveDelay + BUDGET_MS,
      `median ${med} ms exceeds ${liveDelay + BUDGET_MS} ms (runs: ${times.join(', ')})`,
    );
  });
});
