import { describe, expect, test } from 'vitest';
import type { ProjectSpec } from '../../src/extension/project';
import { SourceReader } from '../../src/extension/sources';
import { createMemFs } from './fakes/memfs';
import { Uri } from './fakes/vscode';

function spec(paths: string[]): ProjectSpec {
  const root = Uri.file('/ws');
  return {
    folder: { uri: root, name: 'ws', index: 0 },
    root,
    files: new Map(paths.map((p) => [p, Uri.joinPath(root, p)])),
    topModule: 'tt_um_x',
  } as unknown as ProjectSpec;
}

describe('SourceReader', () => {
  test('open document text wins over disk', async () => {
    const fs = createMemFs({ '/ws/src/project.v': 'disk' });
    const open = new Map([['file:///ws/src/project.v', 'buffer']]);
    const r = new SourceReader({
      fs,
      openText: (u) => open.get(u.toString()),
      onReadError: () => {},
    });
    const g = await r.gather(spec(['src/project.v']));
    expect(g.sources).toEqual({ 'src/project.v': 'buffer' });
    expect(fs.reads).toEqual([]);
  });

  test('include and readmem are resolved and keyed correctly', async () => {
    const fs = createMemFs({
      '/ws/src/project.v':
        '`include "defs.vh"\n`include "sub/inner.vh"\nmodule m; initial $readmemh("image.hex", mem); endmodule',
      '/ws/src/defs.vh': '`define A 1',
      '/ws/src/sub/inner.vh': '`include "deep.vh"\n',
      '/ws/src/sub/deep.vh': '// deep',
      '/ws/image.hex': 'FF',
    });
    const r = new SourceReader({ fs, openText: () => undefined, onReadError: () => {} });
    const g = await r.gather(spec(['src/project.v']));
    expect(Object.keys(g.sources).sort()).toEqual([
      'src/defs.vh',
      'src/project.v',
      'src/sub/deep.vh',
      'src/sub/inner.vh',
    ]);
    expect(g.dataFiles['image.hex']).toBe('FF');
    expect(g.relToUri.get('src/defs.vh')?.path).toBe('/ws/src/defs.vh');
    expect(g.relToUri.has('image.hex')).toBe(false);
  });

  test('include cycles terminate and missing references are skipped', async () => {
    const fs = createMemFs({
      '/ws/src/a.vh': '`include "b.vh"\n`include "nope.vh"\n$readmemh("gone.hex", m)',
      '/ws/src/b.vh': '`include "a.vh"\n',
      '/ws/src/project.v': '`include "a.vh"\n',
    });
    const errors: unknown[] = [];
    const r = new SourceReader({
      fs,
      openText: () => undefined,
      onReadError: (_u, e) => errors.push(e),
    });
    const g = await r.gather(spec(['src/project.v']));
    expect(Object.keys(g.sources).sort()).toEqual(['src/a.vh', 'src/b.vh', 'src/project.v']);
    expect(g.dataFiles).toEqual({});
    expect(errors).toEqual([]);
  });

  test('read error reported once per uri until invalidate', async () => {
    const fs = createMemFs({});
    const errors: string[] = [];
    const r = new SourceReader({
      fs,
      openText: () => undefined,
      onReadError: (u) => errors.push(u.path),
    });
    const u = Uri.file('/ws/missing.v') as never;
    expect(await r.read(u)).toBeUndefined();
    expect(await r.read(u)).toBeUndefined();
    expect(errors).toEqual(['/ws/missing.v']);
    r.invalidate(u);
    await r.read(u);
    expect(errors).toEqual(['/ws/missing.v', '/ws/missing.v']);
  });

  test('disk reads are cached until invalidate', async () => {
    const fs = createMemFs({ '/ws/a.v': 'x' });
    const r = new SourceReader({ fs, openText: () => undefined, onReadError: () => {} });
    const u = Uri.file('/ws/a.v') as never;
    await r.read(u);
    await r.read(u);
    expect(fs.reads).toHaveLength(1);
    r.invalidate(u);
    await r.read(u);
    expect(fs.reads).toHaveLength(2);
  });
});
