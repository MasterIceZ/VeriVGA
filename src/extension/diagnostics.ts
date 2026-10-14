import * as vscode from 'vscode';
import type { VerilatorMessage } from '../shared/protocol';

/** Verilator positions are 1-based; VS Code's are 0-based. */
export function toDiagnostic(m: VerilatorMessage): vscode.Diagnostic {
  const line = Math.max(0, m.line - 1);
  const start = Math.max(0, m.column - 1);
  const end = Math.max(start, (m.endColumn ?? m.column + 1) - 1);
  const d = new vscode.Diagnostic(
    new vscode.Range(line, start, line, end),
    m.message,
    m.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
  );
  d.source = 'verilator';
  if (m.code !== undefined) d.code = m.code;
  return d;
}

export class VerilatorDiagnostics {
  private verilatorUris = new Map<string, vscode.Uri>();
  private infoYamlUris = new Map<string, vscode.Uri>();
  private disposed = false;

  constructor(private readonly collection: vscode.DiagnosticCollection) {}

  /**
   * Replaces all Verilator diagnostics unless `generation` is stale. Returns the messages
   * that could not be placed on a known file, in input order.
   */
  apply(
    generation: number,
    latest: number,
    messages: VerilatorMessage[],
    relToUri: Map<string, vscode.Uri>,
  ): VerilatorMessage[] {
    if (this.disposed || generation < latest) return [];
    const grouped = new Map<string, { uri: vscode.Uri; diags: vscode.Diagnostic[] }>();
    const unplaced: VerilatorMessage[] = [];
    for (const m of messages) {
      const uri = m.file === '' ? undefined : relToUri.get(m.file);
      if (!uri) {
        unplaced.push(m);
        continue;
      }
      const key = uri.toString();
      let g = grouped.get(key);
      if (!g) grouped.set(key, (g = { uri, diags: [] }));
      g.diags.push(toDiagnostic(m));
    }
    for (const uri of this.verilatorUris.values()) {
      if (!this.infoYamlUris.has(uri.toString())) this.collection.delete(uri);
    }
    this.verilatorUris = new Map();
    for (const [key, g] of grouped) {
      // A URI shared with info.yaml problems keeps them alongside.
      const extra = this.infoYamlUris.has(key) ? (this.collection.get(g.uri) ?? []) : [];
      const kept = extra.filter((d) => d.source === 'verivga');
      this.collection.set(g.uri, [...kept, ...g.diags]);
      this.verilatorUris.set(key, g.uri);
    }
    return unplaced;
  }

  setInfoYamlProblems(uri: vscode.Uri, problems: { line: number; message: string }[]): void {
    if (this.disposed) return;
    const key = uri.toString();
    if (problems.length === 0) {
      this.infoYamlUris.delete(key);
      this.collection.delete(uri);
      return;
    }
    this.infoYamlUris.set(key, uri);
    this.collection.set(
      uri,
      problems.map((p) => {
        const line = Math.max(0, p.line); // problems[].line is already 0-based
        const d = new vscode.Diagnostic(
          new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
          p.message,
          vscode.DiagnosticSeverity.Error,
        );
        d.source = 'verivga';
        return d;
      }),
    );
  }

  clear(): void {
    if (this.disposed) return;
    this.collection.clear();
    this.verilatorUris = new Map();
    this.infoYamlUris = new Map();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.verilatorUris = new Map();
    this.infoYamlUris = new Map();
    this.collection.dispose();
  }
}
