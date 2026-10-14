/// <reference types="mocha" />
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { HostToWebview, LoadMessage, WebviewToHost } from '../../src/shared/protocol';

type Compiled = Extract<WebviewToHost, { type: 'compiled' }>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls every 50 ms, up to 30 s, until `read` returns a value `pred` accepts. */
async function poll<T>(
  what: string,
  read: () => PromiseLike<T>,
  pred: (v: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 30_000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (pred(last)) return last;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}

/** Polls `verivga._lastCompiled` until `pred` holds. */
async function waitForCompiled(pred: (c: Compiled) => boolean): Promise<Compiled> {
  const read = () => vscode.commands.executeCommand<Compiled | undefined>('verivga._lastCompiled');
  return (await poll('compiled', read, (c) => c !== undefined && pred(c)))!;
}

/** Every `compiled` the host received, in order. It persists across tests. */
async function compiledLog(): Promise<Compiled[]> {
  return (await vscode.commands.executeCommand<Compiled[]>('verivga._compiledLog')) ?? [];
}

/** Waits for the `compiled` of one specific generation (the log is shared across tests). */
async function waitForGeneration(generation: number): Promise<Compiled> {
  const log = await poll(`generation ${generation}`, compiledLog, (l) =>
    l.some((c) => c.generation === generation),
  );
  return log.find((c) => c.generation === generation)!;
}

/** Opens (or reveals) the preview and waits until its webview has compiled something. */
async function ensurePreview(): Promise<void> {
  await vscode.commands.executeCommand('verivga.openPreview');
  await poll('a first compiled', compiledLog, (l) => l.length > 0);
}

async function postToWebview(msg: HostToWebview): Promise<void> {
  await vscode.commands.executeCommand('verivga._postToWebview', msg);
}

const STRIPES = ['src/project.v', 'src/hvsync_generator.v'];

/** Generations the tests inject through `_postToWebview` start here; the host's stay below. */
const INJECTED = 100;

const folderUri = () => vscode.workspace.workspaceFolders![0].uri;
const projectV = () => vscode.Uri.joinPath(folderUri(), 'src/project.v');

/** The newest generation the host itself sent (0 if none yet). */
async function lastHostGeneration(): Promise<number> {
  const host = (await compiledLog()).filter((c) => c.generation < INJECTED);
  return host.length ? Math.max(...host.map((c) => c.generation)) : 0;
}

/** Waits for a `compiled` of a host generation newer than `after` that `pred` accepts. */
async function waitForHostCompiled(
  after: number,
  pred: (c: Compiled) => boolean,
): Promise<Compiled> {
  const ok = (c: Compiled) => c.generation > after && c.generation < INJECTED && pred(c);
  const log = await poll(`a host compiled after generation ${after}`, compiledLog, (l) =>
    l.some(ok),
  );
  return log.find(ok)!;
}

/** Replaces a document's whole text with an unsaved `WorkspaceEdit`. */
async function editText(
  uri: vscode.Uri,
  transform: (text: string) => string,
): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const all = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, all, transform(doc.getText()));
  assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
  return doc;
}

const isPreviewTab = (t: vscode.Tab) =>
  t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('verivga.preview');

/**
 * Back to the text on disk, without saving (and the document is no longer dirty). The revert
 * command needs the document in an editor; it opens outside the preview's group, so the
 * panel stays visible (a hidden panel holds loads until it is shown again).
 */
async function revert(doc: vscode.TextDocument): Promise<void> {
  const previewGroup = vscode.window.tabGroups.all.find((g) => g.tabs.some(isPreviewTab));
  const viewColumn =
    previewGroup?.viewColumn === vscode.ViewColumn.One
      ? vscode.ViewColumn.Two
      : vscode.ViewColumn.One;
  await vscode.window.showTextDocument(doc, { viewColumn });
  await vscode.commands.executeCommand('workbench.action.files.revert');
}

/** `wire y = ;` on its own line before the last `endmodule`; returns that 0-based line. */
function insertSyntaxError(text: string): { text: string; line: number } {
  const at = text.lastIndexOf('endmodule');
  return {
    text: `${text.slice(0, at)}wire y = ;\n${text.slice(at)}`,
    line: text.slice(0, at).split('\n').length - 1,
  };
}

const verilatorDiagnostics = (uri: vscode.Uri) =>
  vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'verilator');

async function closePreview(): Promise<void> {
  await vscode.window.tabGroups.close(
    vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isPreviewTab),
  );
}

/** A `load` built from the stripes fixture, read through `workspace.fs` (works on the web). */
async function fixtureLoad(
  generation: number,
  topModule = 'tt_um_vga_example',
  files = STRIPES,
): Promise<LoadMessage> {
  const folder = vscode.workspace.workspaceFolders![0];
  const sources: Record<string, string> = {};
  for (const rel of files) {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, rel));
    sources[rel] = new TextDecoder().decode(bytes);
  }
  return { type: 'load', generation, topModule, sources, dataFiles: {} };
}

suite('preview', () => {
  // The tests never save. VS Code for the Web auto-saves after a delay by default, which
  // would write a test's broken edit into the (in-memory) fixture.
  const files = () => vscode.workspace.getConfiguration('files');
  suiteSetup(() => files().update('autoSave', 'off', vscode.ConfigurationTarget.Global));
  suiteTeardown(() => files().update('autoSave', undefined, vscode.ConfigurationTarget.Global));

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

  // Review Focus 5: a top module without the TinyTapeout ports is reported, never a crash.
  // Only its own file is sent: next to project.v, Verilator itself rejects the top because
  // it is instantiated by tt_um_vga_example.
  test('non-TT top → ok:false with TT-port message, then a valid load recovers', async () => {
    await ensurePreview();
    await postToWebview(await fixtureLoad(100, 'hvsync_generator', ['src/hvsync_generator.v']));
    const bad = await waitForGeneration(100);
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(
      bad.messages.some(
        (m) => m.severity === 'error' && m.message.includes('TinyTapeout port list'),
      ),
      true,
      `messages: ${JSON.stringify(bad.messages)}`,
    );

    await postToWebview(await fixtureLoad(101));
    const good = await waitForGeneration(101);
    assert.strictEqual(good.ok, true, `messages: ${JSON.stringify(good.messages)}`);
  });

  // A smoke test through the real bridge: it also passes with a plain single worker. The
  // build-vs-result race is unit-tested in test/unit/orchestrator.test.ts ("ordering").
  test('back-to-back loads settle on the newest generation', async () => {
    await ensurePreview();
    const before = (await compiledLog()).length;
    await postToWebview(await fixtureLoad(200));
    await postToWebview(await fixtureLoad(201));
    await waitForGeneration(201);
    // A late generation-200 result would land within this window.
    await sleep(1500);
    const log = (await compiledLog()).slice(before);
    const last = log[log.length - 1];
    assert.strictEqual(
      last.generation,
      201,
      `log: ${JSON.stringify(log.map((c) => c.generation))}`,
    );
    assert.strictEqual(last.ok, true);
    const newest = log.findIndex((c) => c.generation === 201);
    assert.strictEqual(
      log.slice(newest).some((c) => c.generation === 200),
      false,
    );
  });

  test('syntax error keeps the old sim and reports errors', async () => {
    await ensurePreview();
    const broken = await fixtureLoad(300);
    const src = broken.sources['src/project.v'];
    const at = src.lastIndexOf('endmodule');
    broken.sources['src/project.v'] = `${src.slice(0, at)}wire y = ;\n${src.slice(at)}`;
    await postToWebview(broken);
    const c = await waitForGeneration(300);
    assert.strictEqual(c.ok, false);
    assert.strictEqual(c.messages[0].severity, 'error');
    assert.strictEqual(c.messages[0].file, 'src/project.v');

    // Leave the webview on a good design for whatever runs next.
    await postToWebview(await fixtureLoad(301));
    assert.strictEqual((await waitForGeneration(301)).ok, true);
  });

  // From here on the host drives: edits are unsaved `WorkspaceEdit`s, never saved, and each
  // test waits for the compile of its restored text so nothing leaks into the next test.

  test('unsaved edit triggers a new generation', async () => {
    await ensurePreview();
    const before = await lastHostGeneration();
    const doc = await editText(projectV(), (t) => t.replace('moving_x[5]', 'moving_x[4]'));
    let edited: Compiled;
    try {
      edited = await waitForHostCompiled(before, () => true);
      assert.strictEqual(edited.ok, true, `messages: ${JSON.stringify(edited.messages)}`);
    } finally {
      await revert(doc);
    }
    assert.strictEqual((await waitForHostCompiled(edited.generation, () => true)).ok, true);
  });

  test('syntax error → diagnostic; fix → cleared', async () => {
    await ensurePreview();
    const uri = projectV();
    let line = -1;
    const doc = await editText(uri, (t) => {
      const broken = insertSyntaxError(t);
      line = broken.line;
      return broken.text;
    });
    try {
      const diags = await poll(
        'a verilator diagnostic',
        async () => verilatorDiagnostics(uri),
        (d) => d.length > 0,
      );
      assert.strictEqual(diags.length, 1, `diagnostics: ${JSON.stringify(diags)}`);
      assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
      assert.strictEqual(diags[0].range.start.line, line);
    } finally {
      await revert(doc);
    }
    await poll(
      'diagnostics cleared',
      async () => verilatorDiagnostics(uri),
      (d) => d.length === 0,
    );
  });

  // Review Focus 5 through the host: Verilator rejects a --top-module that another module
  // instantiates, so the non-TT top is a standalone module added in an unsaved edit.
  test('topModule setting to a non-TT module → ok:false; reset → ok', async () => {
    await ensurePreview();
    const settingsDir = vscode.Uri.joinPath(folderUri(), '.vscode');
    const hadSettingsDir = await vscode.workspace.fs.stat(settingsDir).then(
      () => true,
      () => false,
    );
    const config = () => vscode.workspace.getConfiguration('verivga');
    const before = await lastHostGeneration();
    const doc = await editText(
      projectV(),
      (t) =>
        `${t}\nmodule generic_vga(input wire clk, output wire hsync, output wire vsync, ` +
        `output wire [3:0] red); endmodule\n`,
    );
    try {
      let bad: Compiled;
      try {
        await config().update('topModule', 'generic_vga', vscode.ConfigurationTarget.Workspace);
        bad = await waitForHostCompiled(before, (c) =>
          c.messages.some((m) => m.message.includes('TinyTapeout port list')),
        );
        assert.strictEqual(bad.ok, false);
      } finally {
        await revert(doc);
        await config().update('topModule', undefined, vscode.ConfigurationTarget.Workspace);
      }
      const good = await waitForHostCompiled(bad.generation, (c) => c.ok);
      assert.strictEqual(good.ok, true);
    } finally {
      // The setting lives in the fixture's .vscode/settings.json; leave the fixture as it was.
      if (!hadSettingsDir) await vscode.workspace.fs.delete(settingsDir, { recursive: true });
    }
  });

  // Review Focus 4.
  test('closing the panel mid-compile is clean, reopen works', async () => {
    await ensurePreview();
    const uri = projectV();
    const delay = vscode.workspace.getConfiguration('verivga').get<number>('liveDelay', 300);
    const doc = await editText(uri, (t) => insertSyntaxError(t).text);
    try {
      // Just past the idle delay: the load is going out and its compile (about 15 ms for this
      // error) is in flight. Whichever side of it the close lands on, it must be clean.
      await sleep(delay + 10);
      await closePreview();
      await sleep(2000);
      assert.deepStrictEqual(verilatorDiagnostics(uri), []);
    } finally {
      await revert(doc);
    }
    await vscode.commands.executeCommand('verivga.openPreview');
    const c = await waitForCompiled(() => true);
    assert.strictEqual(c.ok, true, `messages: ${JSON.stringify(c.messages)}`);
    assert.deepStrictEqual(verilatorDiagnostics(uri), []);
  });

  // Review Focus 1.
  test('untitled document active in a single-folder workspace still opens the preview', async () => {
    await closePreview();
    const untitled = await vscode.workspace.openTextDocument({ content: '' });
    await vscode.window.showTextDocument(untitled);
    try {
      await vscode.commands.executeCommand('verivga.openPreview');
      const c = await waitForCompiled(() => true);
      assert.strictEqual(c.ok, true, `messages: ${JSON.stringify(c.messages)}`);
    } finally {
      await vscode.window.showTextDocument(untitled);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  });
});
