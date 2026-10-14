import { describe, expect, test } from 'vitest';
import { discover, pickFolder } from '../../src/extension/project';
import { createMemFs } from './fakes/memfs';
import { Uri } from './fakes/vscode';

const folder = (path: string, index = 0) => ({ uri: Uri.file(path), name: path, index });
const TOP = 'module tt_um_foo(input clk); endmodule';
const INFO = `project:
  top_module: "tt_um_vga_example"
  source_files:
    - "project.v"
    - "hvsync_generator.v"
`;

describe('discover', () => {
  test('info.yaml drives sources and top module', async () => {
    const fs = createMemFs({
      '/ws/info.yaml': INFO,
      '/ws/src/project.v': TOP,
      '/ws/src/hvsync_generator.v': 'module hvsync_generator; endmodule',
    });
    const r = await discover({
      activeUri: Uri.file('/ws/src/project.v') as never,
      folders: [folder('/ws')] as never,
      topModuleSetting: '',
      fs,
    });
    if (!r.ok) throw new Error(r.message);
    expect([...r.project.files.keys()]).toEqual(['src/project.v', 'src/hvsync_generator.v']);
    expect(r.project.files.get('src/project.v')?.path).toBe('/ws/src/project.v');
    expect(r.project.topModule).toBe('tt_um_vga_example');
    expect(r.project.root.path).toBe('/ws');
    expect(r.project.infoYaml?.path).toBe('/ws/info.yaml');
  });

  test('folder fallback detects tt_um_ top module', async () => {
    const fs = createMemFs({ '/ws/a.v': TOP, '/ws/notes.txt': 'x', '/ws/b.vh': '// h' });
    const r = await discover({
      activeUri: Uri.file('/ws/a.v') as never,
      folders: [folder('/ws')] as never,
      topModuleSetting: '',
      fs,
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.project.topModule).toBe('tt_um_foo');
    expect([...r.project.files.keys()].sort()).toEqual(['a.v', 'b.vh']);
    expect(r.project.infoYaml).toBeUndefined();
  });

  test('fallback root is the active file directory', async () => {
    const fs = createMemFs({ '/ws/sub/a.v': TOP, '/ws/other.v': 'module x; endmodule' });
    const r = await discover({
      activeUri: Uri.file('/ws/sub/a.v') as never,
      folders: [folder('/ws')] as never,
      topModuleSetting: '',
      fs,
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.project.root.path).toBe('/ws/sub');
    expect([...r.project.files.keys()]).toEqual(['a.v']);
  });

  test('setting overrides top module', async () => {
    const fs = createMemFs({
      '/ws/info.yaml': INFO,
      '/ws/src/project.v': TOP,
      '/ws/src/hvsync_generator.v': '',
    });
    const r = await discover({
      activeUri: Uri.file('/ws/src/project.v') as never,
      folders: [folder('/ws')] as never,
      topModuleSetting: 'my_top',
      fs,
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.project.topModule).toBe('my_top');
  });

  test('missing source in info.yaml → bad-info-yaml with line', async () => {
    const fs = createMemFs({ '/ws/info.yaml': INFO, '/ws/src/project.v': TOP });
    const r = await discover({
      activeUri: Uri.file('/ws/src/project.v') as never,
      folders: [folder('/ws')] as never,
      topModuleSetting: '',
      fs,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('bad-info-yaml');
    expect(r.infoYaml?.path).toBe('/ws/info.yaml');
    expect(r.problems).toEqual([
      { line: 4, message: 'Source file not found: src/hvsync_generator.v' },
    ]);
    expect(r.message).toContain('src/hvsync_generator.v');
  });

  test('malformed info.yaml → bad-info-yaml with the parser line', async () => {
    const fs = createMemFs({ '/ws/info.yaml': 'project:\n  a: [1, 2\n  b: 3\n' });
    const r = await discover({
      activeUri: Uri.file('/ws/x.v') as never,
      folders: [folder('/ws')] as never,
      topModuleSetting: '',
      fs,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('bad-info-yaml');
    expect(r.problems?.length).toBeGreaterThan(0);
    expect(r.problems?.[0].line).toBeGreaterThanOrEqual(0);
  });

  test('two folders, active file outside both → no-folder', async () => {
    const r = await discover({
      activeUri: Uri.file('/elsewhere/a.v') as never,
      folders: [folder('/ws1'), folder('/ws2', 1)] as never,
      topModuleSetting: '',
      fs: createMemFs({}),
    });
    expect(r).toMatchObject({
      ok: false,
      reason: 'no-folder',
      message: 'Open a file inside a workspace folder',
    });
  });

  test('a sibling folder with a shared name prefix is not inside', async () => {
    const r = await discover({
      activeUri: Uri.file('/ws10/a.v') as never,
      folders: [folder('/ws1'), folder('/ws2', 1)] as never,
      topModuleSetting: '',
      fs: createMemFs({}),
    });
    expect(r).toMatchObject({ ok: false, reason: 'no-folder' });
  });

  test('one folder, untitled active document → uses that folder', async () => {
    const fs = createMemFs({ '/ws/a.v': TOP });
    const r = await discover({
      activeUri: Uri.from({ scheme: 'untitled', path: 'Untitled-1' }) as never,
      folders: [folder('/ws')] as never,
      topModuleSetting: '',
      fs,
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.project.root.path).toBe('/ws');
    expect(r.project.folder.uri.path).toBe('/ws');
  });

  test('no workspace folders → no-folder', async () => {
    const r = await discover({ folders: [], topModuleSetting: '', fs: createMemFs({}) });
    expect(r).toMatchObject({
      ok: false,
      reason: 'no-folder',
      message: 'Open a file inside a workspace folder',
    });
  });

  test('no .v files → no-sources', async () => {
    const fs = createMemFs({ '/ws/readme.md': '# hi' });
    const r = await discover({
      activeUri: Uri.file('/ws/readme.md') as never,
      folders: [folder('/ws')] as never,
      topModuleSetting: '',
      fs,
    });
    expect(r).toMatchObject({ ok: false, reason: 'no-sources' });
  });

  // Spec §3: "No Verilog sources found in <folder>", workspace-relative (no absolute paths,
  // which look odd for github.dev and web URIs).
  test('no-sources message names the folder, not an absolute path', async () => {
    const proj = { uri: Uri.file('/home/me/proj'), name: 'proj', index: 0 };
    const fs = createMemFs({ '/home/me/proj/docs/notes.md': '# hi' });
    const atRoot = await discover({ folders: [proj] as never, topModuleSetting: '', fs });
    expect(atRoot).toMatchObject({ message: 'No Verilog sources found in proj' });
    const inDocs = await discover({
      activeUri: Uri.file('/home/me/proj/docs/notes.md') as never,
      folders: [proj] as never,
      topModuleSetting: '',
      fs,
    });
    expect(inDocs).toMatchObject({ message: 'No Verilog sources found in proj/docs' });
  });
});

describe('pickFolder', () => {
  const ws1 = folder('/ws1');
  const ws2 = folder('/ws2', 1);

  test('the folder holding the active file', () => {
    expect(pickFolder(Uri.file('/ws2/src/a.v') as never, [ws1, ws2] as never)).toBe(ws2);
  });

  test('one folder: an untitled, outside or missing active file falls back to it', () => {
    const untitled = Uri.from({ scheme: 'untitled', path: 'Untitled-1' });
    expect(pickFolder(untitled as never, [ws1] as never)).toBe(ws1);
    expect(pickFolder(Uri.file('/elsewhere/a.v') as never, [ws1] as never)).toBe(ws1);
    expect(pickFolder(undefined, [ws1] as never)).toBe(ws1);
  });

  test('no folder, or several and the active file is outside all of them → undefined', () => {
    expect(pickFolder(Uri.file('/ws1/a.v') as never, [])).toBeUndefined();
    expect(pickFolder(Uri.file('/elsewhere/a.v') as never, [ws1, ws2] as never)).toBeUndefined();
    expect(pickFolder(undefined, [ws1, ws2] as never)).toBeUndefined();
  });
});
