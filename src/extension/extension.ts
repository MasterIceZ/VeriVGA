import * as vscode from 'vscode';
import { isHostToWebview } from '../shared/protocol';
import { NO_FOLDER, pickFolder } from './project';
import { PreviewSession } from './session';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('VeriVGA');
  /** One session per workspace folder, keyed by the folder's URI. */
  const sessions = new Map<string, PreviewSession>();
  /** Open sessions, the most recently revealed last. */
  const recent: PreviewSession[] = [];
  const forget = (s: PreviewSession) => {
    const i = recent.indexOf(s);
    if (i >= 0) recent.splice(i, 1);
  };
  const current = (): PreviewSession | undefined => recent[recent.length - 1];

  context.subscriptions.push(
    log,
    { dispose: () => [...sessions.values()].forEach((s) => s.dispose()) },
    // The editor title button passes the editor's URI; the command palette passes nothing.
    vscode.commands.registerCommand('verivga.openPreview', (resource?: unknown) => {
      const activeUri =
        resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
      const folder = pickFolder(activeUri, vscode.workspace.workspaceFolders ?? []);
      if (!folder) {
        void vscode.window.showWarningMessage(NO_FOLDER);
        return;
      }
      const key = folder.uri.toString();
      let session = sessions.get(key);
      if (session) {
        session.reveal(activeUri);
      } else {
        const s = PreviewSession.open(context, folder, activeUri, log);
        sessions.set(key, s);
        s.onDidDispose(() => {
          if (sessions.get(key) === s) sessions.delete(key);
          forget(s);
        });
        session = s;
      }
      forget(session);
      recent.push(session);
    }),
  );

  // Test mode only: the E2E tests observe and drive the most recently revealed session.
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand('verivga._lastCompiled', () => current()?.lastCompiled),
      vscode.commands.registerCommand('verivga._compiledLog', () => [
        ...(current()?.compiledLog ?? []),
      ]),
      vscode.commands.registerCommand('verivga._postToWebview', (msg: unknown) => {
        if (!isHostToWebview(msg)) throw new Error('verivga._postToWebview: not a HostToWebview');
        const session = current();
        if (!session) throw new Error('verivga._postToWebview: no preview panel is open');
        session.post(msg);
      }),
    );
  }
}

export function deactivate(): void {}
