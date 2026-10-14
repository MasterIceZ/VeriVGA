import * as vscode from 'vscode';
import { isWebviewToHost, type HostToWebview, type WebviewToHost } from '../shared/protocol';
import { buildHtml, makeNonce } from './webviewHtml';

/** One preview webview: builds its HTML, and types and validates the message bridge. */
export class PreviewPanel {
  private readonly messageEmitter = new vscode.EventEmitter<WebviewToHost>();
  private readonly visibleEmitter = new vscode.EventEmitter<boolean>();
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  /** Valid messages from the webview. Anything failing `isWebviewToHost` is dropped. */
  readonly onMessage = this.messageEmitter.event;
  readonly onDidChangeVisible = this.visibleEmitter.event;
  readonly onDidDispose = this.disposeEmitter.event;

  static create(extensionUri: vscode.Uri, title: string, column: vscode.ViewColumn): PreviewPanel {
    const panel = vscode.window.createWebviewPanel('verivga.preview', title, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    });
    return new PreviewPanel(panel, extensionUri);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
  ) {
    const { webview } = panel;
    const dist = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', file)).toString();
    webview.html = buildHtml({
      cspSource: webview.cspSource,
      nonce: makeNonce(),
      scriptUri: dist('webview.js'),
      styleUri: dist('webview.css'),
      wasmUri: dist('verilator_bin.wasm'),
      workerUri: dist('compileWorker.js'),
    });

    let visible = panel.visible;
    this.disposables.push(
      this.messageEmitter,
      this.visibleEmitter,
      this.disposeEmitter,
      webview.onDidReceiveMessage((msg: unknown) => {
        if (isWebviewToHost(msg)) this.messageEmitter.fire(msg);
      }),
      panel.onDidChangeViewState(() => {
        if (panel.visible === visible) return;
        visible = panel.visible;
        this.visibleEmitter.fire(visible);
      }),
      panel.onDidDispose(() => {
        this.disposed = true;
        this.disposeEmitter.fire();
        vscode.Disposable.from(...this.disposables).dispose();
      }),
    );
  }

  get visible(): boolean {
    return !this.disposed && this.panel.visible;
  }

  /** Posting to a closed panel is a no-op, so late results never throw. */
  post(msg: HostToWebview): void {
    if (!this.disposed) void this.panel.webview.postMessage(msg);
  }

  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    this.panel.dispose();
  }
}
