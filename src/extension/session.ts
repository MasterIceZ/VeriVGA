import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import { VerilatorDiagnostics } from './diagnostics';
import { LiveUpdate, type LoadPayload } from './liveUpdate';
import { PreviewPanel } from './PreviewPanel';
import { discover, isInside, type DiscoverResult } from './project';
import { ProjectFs } from './projectFs';
import { clampDelay, errorText, formatCompiled } from './sessionUtil';
import { SourceReader } from './sources';

type Compiled = Extract<WebviewToHost, { type: 'compiled' }>;
type DiscoverFailure = Extract<DiscoverResult, { ok: false }>;

/** The text of the open document for `uri`, if any: unsaved buffers win. */
function openDocumentText(uri: vscode.Uri): string | undefined {
  const key = uri.toString();
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  return doc && !doc.isClosed ? doc.getText() : undefined;
}

/**
 * The live preview of one workspace folder. It owns the panel, the live update, the source
 * reader and the diagnostics, and wires them to VS Code's events. Closing the panel
 * disposes all of it.
 */
export class PreviewSession {
  /** Every `compiled`, in order. Kept in Test mode only, for `verivga._compiledLog`. */
  readonly compiledLog: Compiled[] = [];

  private readonly live: LiveUpdate;
  private readonly fs: ProjectFs;
  private sources: SourceReader;
  private readonly diagnostics: VerilatorDiagnostics;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly disposeEmitter = new vscode.EventEmitter<void>();

  /** Rel path → URI of the last gathered load, for placing its diagnostics. */
  private relToUri = new Map<string, vscode.Uri>();
  /** The info.yaml that has problems in the Problems view, if any. */
  private infoYamlWithProblems: vscode.Uri | undefined;
  private lastStatus: string | undefined;
  private readonly warnedReads = new Set<string>();
  private compiled: Compiled | undefined;
  private disposed = false;

  readonly onDidDispose = this.disposeEmitter.event;

  static open(
    ctx: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    activeUri: vscode.Uri | undefined,
    log: vscode.OutputChannel,
  ): PreviewSession {
    const panel = PreviewPanel.create(
      ctx.extensionUri,
      `VeriVGA: ${folder.name}`,
      vscode.ViewColumn.Beside,
    );
    const keepLog = ctx.extensionMode === vscode.ExtensionMode.Test;
    return new PreviewSession(panel, folder, activeUri, log, keepLog);
  }

  private constructor(
    private readonly panel: PreviewPanel,
    private readonly folder: vscode.WorkspaceFolder,
    private activeUri: vscode.Uri | undefined,
    private readonly log: vscode.OutputChannel,
    private readonly keepLog: boolean,
  ) {
    this.fs = new ProjectFs(vscode.workspace.fs, openDocumentText);
    this.sources = this.newSourceReader();
    this.diagnostics = new VerilatorDiagnostics(
      vscode.languages.createDiagnosticCollection('verivga'),
    );
    this.live = new LiveUpdate({
      // Settings are read on every use, so changes apply without reopening the panel.
      delayMs: () => clampDelay(this.config().get('liveDelay')),
      enabled: () => this.config().get('liveUpdate') !== false,
      isVisible: () => this.panel.visible,
      gather: () => this.gather(),
      send: (msg) => this.panel.post(msg),
      onError: (err) => this.logError('live update', err),
    });

    const ws = vscode.workspace;
    const watcher = ws.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
    this.subscriptions.push(
      panel.onMessage((msg) => this.onMessage(msg)),
      panel.onDidChangeVisible((visible) => {
        if (visible) this.settle(this.live.onVisible(), 'show');
      }),
      panel.onDidDispose(() => this.dispose()),

      ws.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) this.onEdited(e.document.uri);
      }),
      // Closing a document with unsaved changes puts the text on disk back in charge.
      ws.onDidCloseTextDocument((doc) => this.onEdited(doc.uri)),
      ws.onDidSaveTextDocument((doc) => this.onWritten(doc.uri, 'save')),
      ws.onDidCreateFiles((e) => this.onFilesChanged(e.files)),
      ws.onDidDeleteFiles((e) => this.onFilesChanged(e.files)),
      ws.onDidRenameFiles((e) => this.onFilesChanged(e.files.flatMap((f) => [f.oldUri, f.newUri]))),
      // Changes made outside VS Code (git checkout, another editor) arrive only here.
      watcher,
      watcher.onDidCreate((uri) => this.onFilesChanged([uri])),
      watcher.onDidDelete((uri) => this.onFilesChanged([uri])),
      watcher.onDidChange((uri) => this.onWritten(uri, 'file change')),
      // The top module and other settings may have changed: discover again.
      ws.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('verivga', folder.uri)) {
          this.settle(this.live.flush(), 'settings');
        }
      }),
    );
  }

  get lastCompiled(): Compiled | undefined {
    return this.compiled;
  }

  /**
   * Shows the panel. A file inside the folder that differs from the one the session was
   * opened from becomes the active file for discovery (its directory is the fallback root).
   */
  reveal(activeUri?: vscode.Uri): void {
    this.panel.reveal();
    if (
      activeUri &&
      isInside(activeUri, this.folder.uri) &&
      activeUri.toString() !== this.activeUri?.toString()
    ) {
      this.activeUri = activeUri;
      this.settle(this.live.flush(), 'reveal');
    }
  }

  /** Posts straight to the webview (`verivga._postToWebview`, Test mode). */
  post(msg: HostToWebview): void {
    this.panel.post(msg);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.live.dispose();
    this.diagnostics.dispose();
    vscode.Disposable.from(...this.subscriptions).dispose();
    this.panel.dispose();
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
  }

  // ── Events.

  private onMessage(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'ready':
        this.settle(this.live.resend(), 'ready');
        break;
      case 'compiled':
        this.onCompiled(msg);
        break;
      case 'runtimeError':
        this.log.appendLine(`[gen ${msg.generation}] runtime error: ${msg.message}`);
        break;
      case 'showProblems':
        void vscode.commands.executeCommand('workbench.actions.view.problems');
        break;
    }
  }

  private onCompiled(msg: Compiled): void {
    if (this.disposed) return;
    this.compiled = msg;
    if (this.keepLog) this.compiledLog.push(msg);
    // Every message is logged, placed or not (spec §3), so what `apply` couldn't place (no
    // file, or a file outside the project) is in the log too.
    this.log.appendLine(formatCompiled(msg));
    this.diagnostics.apply(msg.generation, this.live.generation, msg.messages, this.relToUri);
  }

  /** A document's text changed (or it closed): restart the idle timer if the load uses it. */
  private onEdited(uri: vscode.Uri): void {
    if (!this.fs.uses(uri)) return;
    this.invalidate(uri);
    this.live.onEdit();
  }

  /** A file the load uses was written (saved here, or changed on disk): load now. */
  private onWritten(uri: vscode.Uri, what: string): void {
    if (!this.fs.uses(uri)) return;
    this.invalidate(uri);
    this.settle(this.live.flush(), what);
  }

  /** Files were created, deleted or renamed: drop every cache, discover again and load. */
  private onFilesChanged(uris: readonly vscode.Uri[]): void {
    const relevant = uris.some((u) => isInside(u, this.folder.uri) && this.fs.affectedBy(u));
    if (!relevant) return;
    this.fs.clear();
    this.sources = this.newSourceReader();
    this.settle(this.live.flush(), 'file event');
  }

  // ── Gathering a load.

  private async gather(): Promise<LoadPayload | null> {
    if (this.disposed) return null;
    const top = this.config().get('topModule');
    this.fs.beginRead();
    try {
      // Only this session's folder, so an active file elsewhere can't move the project.
      const result = await discover({
        activeUri: this.activeUri,
        folders: [this.folder],
        topModuleSetting: typeof top === 'string' ? top.trim() : '',
        fs: this.fs,
      });
      if (this.disposed) return null;
      if (!result.ok) {
        this.showDiscoveryFailure(result);
        return null;
      }
      this.clearInfoYamlProblems();
      const { project } = result;
      const gathered = await this.sources.gather(project);
      if (this.disposed) return null;
      this.lastStatus = undefined;
      this.relToUri = gathered.relToUri;
      return {
        topModule: project.topModule,
        sources: gathered.sources,
        dataFiles: gathered.dataFiles,
      };
    } finally {
      this.fs.endRead();
    }
  }

  /** No design to load: the panel shows why, and a bad info.yaml gets its diagnostics. */
  private showDiscoveryFailure(r: DiscoverFailure): void {
    if (r.reason === 'bad-info-yaml' && r.infoYaml) {
      if (this.infoYamlWithProblems?.toString() !== r.infoYaml.toString()) {
        this.clearInfoYamlProblems();
      }
      this.diagnostics.setInfoYamlProblems(r.infoYaml, r.problems ?? []);
      this.infoYamlWithProblems = r.infoYaml;
    } else {
      this.clearInfoYamlProblems();
    }
    const message = r.reason === 'bad-info-yaml' ? `info.yaml: ${r.message}` : r.message;
    // The banner now covers the design, so the next good load must be sent even if unchanged.
    this.live.forget();
    this.panel.post({ type: 'status', message });
    if (message !== this.lastStatus) this.log.appendLine(message);
    this.lastStatus = message;
  }

  private clearInfoYamlProblems(): void {
    if (!this.infoYamlWithProblems) return;
    this.diagnostics.setInfoYamlProblems(this.infoYamlWithProblems, []);
    this.infoYamlWithProblems = undefined;
  }

  // ── Helpers.

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('verivga', this.folder.uri);
  }

  private newSourceReader(): SourceReader {
    return new SourceReader({
      fs: this.fs,
      openText: (uri) => this.fs.openText(uri),
      onReadError: (uri, err) => this.onReadError(uri, err),
    });
  }

  private invalidate(uri: vscode.Uri): void {
    this.fs.invalidate(uri);
    this.sources.invalidate(uri);
  }

  private onReadError(uri: vscode.Uri, err: unknown): void {
    const name = vscode.workspace.asRelativePath(uri);
    const reason = err instanceof Error ? err.message : String(err);
    this.log.appendLine(`Couldn't read ${name}: ${reason}`);
    const key = uri.toString();
    if (this.warnedReads.has(key)) return;
    this.warnedReads.add(key);
    void vscode.window.showWarningMessage(`VeriVGA: couldn't read ${name}: ${reason}`);
  }

  /** `flush`, `resend` and `onVisible` reject when gathering or sending fails: log it. */
  private settle(p: Promise<void>, what: string): void {
    p.catch((err: unknown) => this.logError(what, err));
  }

  private logError(what: string, err: unknown): void {
    this.log.appendLine(`Live update failed (${what}): ${errorText(err)}`);
  }
}
