import * as vscode from 'vscode';
import type { LoadMessage, WebviewToHost } from '../shared/protocol';
import { PreviewPanel } from './PreviewPanel';

type Compiled = Extract<WebviewToHost, { type: 'compiled' }>;

// M0 skeleton (Task 3): one panel, fixed stripes sources. Task 12 replaces this with
// discovery, live update and diagnostics, and keeps the test commands.
const SKELETON_FILES = ['src/project.v', 'src/hvsync_generator.v'];

async function readSkeletonLoad(): Promise<LoadMessage> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Open a file inside a workspace folder');
  const decoder = new TextDecoder();
  const sources: Record<string, string> = {};
  for (const rel of SKELETON_FILES) {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, rel));
    sources[rel] = decoder.decode(bytes);
  }
  return { type: 'load', generation: 1, topModule: 'tt_um_vga_example', sources, dataFiles: {} };
}

export function activate(context: vscode.ExtensionContext): void {
  let panel: PreviewPanel | undefined;
  let lastCompiled: Compiled | undefined;

  const onMessage = async (msg: WebviewToHost) => {
    switch (msg.type) {
      case 'ready':
        try {
          panel?.post(await readSkeletonLoad());
        } catch (err) {
          void vscode.window.showErrorMessage(`VeriVGA: ${(err as Error).message}`);
        }
        break;
      case 'compiled':
        lastCompiled = msg;
        break;
      case 'runtimeError':
        console.error(`[verivga] webview: ${msg.message}`);
        break;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('verivga.openPreview', () => {
      if (panel) {
        panel.reveal();
        return;
      }
      const p = PreviewPanel.create(context.extensionUri, 'VeriVGA', vscode.ViewColumn.Beside);
      panel = p;
      p.onMessage(onMessage);
      p.onDidDispose(() => {
        if (panel === p) panel = undefined;
      });
    }),
  );

  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand('verivga._lastCompiled', () => lastCompiled),
    );
  }
}

export function deactivate(): void {}
