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
});
