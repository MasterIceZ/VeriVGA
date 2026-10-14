import { describe, expect, test } from 'vitest';
import type { FsLike } from '../../src/extension/project';
import { ProjectFs } from '../../src/extension/projectFs';
import { FileType, Uri } from './fakes/vscode';

const u = (path: string) => Uri.file(path) as never;
const notFound = () => Object.assign(new Error('not found'), { code: 'FileNotFound' });
const text = async (p: PromiseLike<Uint8Array>) => new TextDecoder().decode(await p);

/** A counting FsLike over `files` (absolute path → text). Paths in `broken` fail to read. */
function baseFs(files: Record<string, string>, broken: string[] = []) {
  const calls: string[] = [];
  const fs = {
    async readFile(uri: Uri) {
      calls.push(`read ${uri.path}`);
      if (broken.includes(uri.path)) throw new Error('rate limited');
      if (files[uri.path] === undefined) throw notFound();
      return new TextEncoder().encode(files[uri.path]);
    },
    async stat(uri: Uri) {
      calls.push(`stat ${uri.path}`);
      if (files[uri.path] === undefined) throw notFound();
      return { type: FileType.File, ctime: 0, mtime: 0, size: 0 };
    },
    async readDirectory(uri: Uri) {
      calls.push(`dir ${uri.path}`);
      const prefix = uri.path + '/';
      return Object.keys(files)
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map((k) => [k.slice(prefix.length), FileType.File]);
    },
  };
  return { fs: fs as unknown as FsLike, calls };
}

describe('ProjectFs', () => {
  test('an open document wins over the file system', async () => {
    const { fs: base, calls } = baseFs({ '/ws/a.v': 'disk' });
    const fs = new ProjectFs(base, (uri) => (uri.path === '/ws/a.v' ? 'buffer' : undefined));
    expect(await text(fs.readFile(u('/ws/a.v')))).toBe('buffer');
    expect(fs.openText(u('/ws/a.v'))).toBe('buffer');
    expect(calls).toEqual([]);
  });

  test('reads, stats and listings are cached until invalidate', async () => {
    const { fs: base, calls } = baseFs({ '/ws/a.v': 'disk' });
    const fs = new ProjectFs(base, () => undefined);
    for (let i = 0; i < 2; i++) {
      expect(await text(fs.readFile(u('/ws/a.v')))).toBe('disk');
      await fs.stat(u('/ws/a.v'));
      await fs.readDirectory(u('/ws'));
    }
    expect(calls).toEqual(['read /ws/a.v', 'stat /ws/a.v', 'dir /ws']);

    // Invalidating a file also drops its directory's listing.
    fs.invalidate(u('/ws/a.v'));
    await fs.readFile(u('/ws/a.v'));
    await fs.stat(u('/ws/a.v'));
    await fs.readDirectory(u('/ws'));
    expect(calls).toHaveLength(6);
  });

  test('clear drops every cached entry', async () => {
    const { fs: base, calls } = baseFs({ '/ws/a.v': 'disk' });
    const fs = new ProjectFs(base, () => undefined);
    await fs.readFile(u('/ws/a.v'));
    fs.clear();
    await fs.readFile(u('/ws/a.v'));
    expect(calls).toEqual(['read /ws/a.v', 'read /ws/a.v']);
  });

  test('not-found is cached; other errors are retried', async () => {
    const { fs: base, calls } = baseFs({}, ['/ws/b.v']);
    const fs = new ProjectFs(base, () => undefined);
    for (let i = 0; i < 2; i++) {
      await expect(fs.stat(u('/ws/missing.v'))).rejects.toMatchObject({ code: 'FileNotFound' });
      await expect(fs.readFile(u('/ws/b.v'))).rejects.toThrow('rate limited');
    }
    expect(calls).toEqual(['stat /ws/missing.v', 'read /ws/b.v', 'read /ws/b.v']);
  });

  test('records the URIs a read looked at; the previous set counts until the next one ends', async () => {
    const { fs: base } = baseFs({ '/ws/a.v': 'disk' });
    const fs = new ProjectFs(base, () => undefined);
    fs.beginRead();
    await fs.readFile(u('/ws/a.v'));
    await fs.stat(u('/ws/inc.vh')).catch(() => undefined);
    fs.openText(u('/ws/b.v'));
    fs.endRead();
    for (const p of ['/ws/a.v', '/ws/inc.vh', '/ws/b.v']) expect(fs.uses(u(p))).toBe(true);
    expect(fs.uses(u('/ws/c.v'))).toBe(false);

    fs.beginRead();
    await fs.readFile(u('/ws/c.v')).catch(() => undefined);
    expect(fs.uses(u('/ws/a.v'))).toBe(true);
    expect(fs.uses(u('/ws/c.v'))).toBe(true);
    fs.endRead();
    expect(fs.uses(u('/ws/a.v'))).toBe(false);
    expect(fs.uses(u('/ws/c.v'))).toBe(true);
  });

  test('affectedBy: used URIs, Verilog and info.yaml names, folders holding used files', async () => {
    const { fs: base } = baseFs({ '/ws/src/a.v': 'disk', '/ws/data/rom.hex': '00' });
    const fs = new ProjectFs(base, () => undefined);
    fs.beginRead();
    await fs.readFile(u('/ws/src/a.v'));
    await fs.readFile(u('/ws/data/rom.hex'));
    fs.endRead();
    expect(fs.affectedBy(u('/ws/data/rom.hex'))).toBe(true);
    expect(fs.affectedBy(u('/ws/new.sv'))).toBe(true);
    expect(fs.affectedBy(u('/ws/inc/defs.VH'))).toBe(true);
    expect(fs.affectedBy(u('/ws/info.yaml'))).toBe(true);
    expect(fs.affectedBy(u('/ws/src'))).toBe(true);
    expect(fs.affectedBy(u('/ws/README.md'))).toBe(false);
    expect(fs.affectedBy(u('/ws/docs'))).toBe(false);
    expect(fs.affectedBy(u('/ws/sr'))).toBe(false);
  });
});
