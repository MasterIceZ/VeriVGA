import type { FsLike } from '../../../src/extension/project';
import { FileType, type Uri } from './vscode';

/** In-memory FsLike. Keys are absolute paths (file scheme), values are file text. */
export function createMemFs(files: Record<string, string>): FsLike & { reads: string[] } {
  const reads: string[] = [];
  const enc = new TextEncoder();
  const notFound = (uri: Uri) => new Error(`ENOENT: ${uri.path}`);
  const isDir = (p: string) => Object.keys(files).some((k) => k.startsWith(p + '/'));
  const fs = {
    reads,
    async readFile(uri: Uri) {
      const text = files[uri.path];
      if (text === undefined) throw notFound(uri);
      reads.push(uri.path);
      return enc.encode(text);
    },
    async stat(uri: Uri) {
      if (files[uri.path] !== undefined) {
        return { type: FileType.File, ctime: 0, mtime: 0, size: files[uri.path].length };
      }
      if (isDir(uri.path)) return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 };
      throw notFound(uri);
    },
    async readDirectory(uri: Uri) {
      const prefix = uri.path.replace(/\/$/, '') + '/';
      const entries = new Map<string, FileType>();
      for (const k of Object.keys(files)) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.set(rest, FileType.File);
        else entries.set(rest.slice(0, slash), FileType.Directory);
      }
      if (entries.size === 0) throw notFound(uri);
      return [...entries];
    },
  };
  return fs as unknown as FsLike & { reads: string[] };
}
