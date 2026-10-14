import { describe, expect, test } from 'vitest';
import * as vscode from 'vscode';
import { VerilatorDiagnostics, toDiagnostic } from '../../src/extension/diagnostics';
import type { VerilatorMessage } from '../../src/shared/protocol';

// The vitest alias resolves `vscode` to the fake, which also exports a constructible collection.
const FakeCollection = (
  vscode as unknown as { DiagnosticCollection: new () => vscode.DiagnosticCollection }
).DiagnosticCollection;

const msg = (o: Partial<VerilatorMessage> = {}): VerilatorMessage => ({
  severity: 'error',
  file: 'src/project.v',
  line: 1,
  column: 1,
  message: 'boom',
  ...o,
});

function setup() {
  const coll = new FakeCollection();
  const d = new VerilatorDiagnostics(coll);
  const uri = vscode.Uri.file('/w/src/project.v');
  return { coll, d, uri, map: new Map([['src/project.v', uri]]) };
}

describe('toDiagnostic', () => {
  test('1-based Verilator position → 0-based range with endColumn', () => {
    const x = toDiagnostic(msg({ line: 3, column: 5, endColumn: 9, code: 'WIDTH' }));
    expect([x.range.start.line, x.range.start.character]).toEqual([2, 4]);
    expect([x.range.end.line, x.range.end.character]).toEqual([2, 8]);
    expect(x.source).toBe('verilator');
    expect(x.code).toBe('WIDTH');
    expect(x.severity).toBe(vscode.DiagnosticSeverity.Error);
  });
  test('missing endColumn → 1-char range, warning stays warning, no code', () => {
    const x = toDiagnostic(msg({ severity: 'warning', line: 3, column: 5 }));
    expect([x.range.start.character, x.range.end.character]).toEqual([4, 5]);
    expect(x.severity).toBe(vscode.DiagnosticSeverity.Warning);
    expect(x.code).toBeUndefined();
  });
  test('negative positions clamp to 0', () => {
    const x = toDiagnostic(msg({ line: 0, column: 0 }));
    expect([x.range.start.line, x.range.start.character]).toEqual([0, 0]);
  });
});

describe('VerilatorDiagnostics', () => {
  test('messages land on the right URI for duplicate basenames', () => {
    const coll = new FakeCollection();
    const d = new VerilatorDiagnostics(coll);
    const a = vscode.Uri.file('/w/src/a/top.v');
    const b = vscode.Uri.file('/w/src/b/top.v');
    const map = new Map([
      ['src/a/top.v', a],
      ['src/b/top.v', b],
    ]);
    d.apply(
      1,
      1,
      [msg({ file: 'src/a/top.v', message: 'A' }), msg({ file: 'src/b/top.v', message: 'B' })],
      map,
    );
    expect(coll.get(a)!.map((x) => x.message)).toEqual(['A']);
    expect(coll.get(b)!.map((x) => x.message)).toEqual(['B']);
  });
  test('stale generation is ignored', () => {
    const { coll, d, uri, map } = setup();
    d.apply(2, 2, [msg({ message: 'new' })], map);
    expect(d.apply(1, 2, [msg({ message: 'old' })], map)).toEqual([]);
    expect(coll.get(uri)!.map((x) => x.message)).toEqual(['new']);
  });
  test('success with no messages clears previous diagnostics', () => {
    const { coll, d, uri, map } = setup();
    d.apply(1, 1, [msg()], map);
    d.apply(2, 2, [], map);
    expect(coll.get(uri) ?? []).toEqual([]);
  });
  test('unknown file returned as unplaced, in order', () => {
    const { coll, d, uri, map } = setup();
    const u1 = msg({ file: '', message: 'x' });
    const u2 = msg({ file: 'src/zzz.v', message: 'y' });
    const un = d.apply(1, 1, [u1, msg(), u2], map);
    expect(un).toEqual([u1, u2]);
    expect(coll.get(uri)).toHaveLength(1);
  });
  test('info.yaml problems are independent of apply; [] clears', () => {
    const { coll, d, map } = setup();
    const y = vscode.Uri.file('/w/info.yaml');
    d.setInfoYamlProblems(y, [{ line: 4, message: 'bad' }]);
    d.apply(1, 1, [msg()], map);
    const got = coll.get(y)!;
    expect(got).toHaveLength(1);
    expect(got[0].source).toBe('verivga');
    expect(got[0].severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(got[0].range.start.line).toBe(3);
    d.setInfoYamlProblems(y, []);
    expect(coll.get(y) ?? []).toEqual([]);
  });
  test('clear removes both sets', () => {
    const { coll, d, uri, map } = setup();
    const y = vscode.Uri.file('/w/info.yaml');
    d.setInfoYamlProblems(y, [{ line: 1, message: 'bad' }]);
    d.apply(1, 1, [msg()], map);
    d.clear();
    expect(coll.get(uri) ?? []).toEqual([]);
    expect(coll.get(y) ?? []).toEqual([]);
  });
  test('apply after dispose is a no-op', () => {
    const { coll, d, uri, map } = setup();
    d.dispose();
    expect(d.apply(5, 5, [msg(), msg({ file: '' })], map)).toEqual([]);
    d.setInfoYamlProblems(uri, [{ line: 1, message: 'x' }]);
    expect(coll.get(uri)).toBeUndefined();
    expect((coll as unknown as { disposed: boolean }).disposed).toBe(true);
  });
});
