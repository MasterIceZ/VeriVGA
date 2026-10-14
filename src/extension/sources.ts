import type * as vscode from 'vscode';
import { extractIncludePaths, extractReadmemPaths } from '../shared/verilogRefs';
import type { FsLike, ProjectSpec } from './project';

export interface SourceReaderDeps {
  fs: FsLike;
  openText(uri: vscode.Uri): string | undefined;
  onReadError(uri: vscode.Uri, err: unknown): void;
}

export interface Gathered {
  sources: Record<string, string>;
  dataFiles: Record<string, string>;
  relToUri: Map<string, vscode.Uri>;
}

const decoder = new TextDecoder('utf-8');

/** Joins and normalizes a root-relative path; undefined when it escapes the root. */
function resolveRel(dir: string, literal: string): string | undefined {
  const out: string[] = [];
  for (const seg of `${dir}/${literal}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(seg);
  }
  return out.length ? out.join('/') : undefined;
}

export class SourceReader {
  private readonly cache = new Map<string, string>();
  private readonly failed = new Set<string>();

  constructor(private readonly d: SourceReaderDeps) {}

  /** Open-document text first, then the cache, then the file system. */
  async read(uri: vscode.Uri): Promise<string | undefined> {
    const open = this.d.openText(uri);
    if (open !== undefined) return open;
    const key = uri.toString();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    try {
      const text = decoder.decode(await this.d.fs.readFile(uri));
      this.cache.set(key, text);
      this.failed.delete(key);
      return text;
    } catch (err) {
      if (!this.failed.has(key)) {
        this.failed.add(key);
        this.d.onReadError(uri, err);
      }
      return undefined;
    }
  }

  invalidate(uri: vscode.Uri): void {
    const key = uri.toString();
    this.cache.delete(key);
    this.failed.delete(key);
  }

  /** Like `read`, but a file that does not exist is not an error. */
  private async readIfExists(uri: vscode.Uri): Promise<string | undefined> {
    if (this.d.openText(uri) === undefined && !this.cache.has(uri.toString())) {
      try {
        await this.d.fs.stat(uri);
      } catch {
        return undefined;
      }
    }
    return this.read(uri);
  }

  async gather(p: ProjectSpec): Promise<Gathered> {
    const sources: Record<string, string> = {};
    const dataFiles: Record<string, string> = {};
    const relToUri = new Map<string, vscode.Uri>();
    const queue: string[] = [];

    for (const [rel, uri] of p.files) {
      const text = await this.read(uri);
      if (text === undefined) continue;
      sources[rel] = text;
      relToUri.set(rel, uri);
      queue.push(rel);
    }

    // `sources` only grows, and each file is scanned once, so include cycles terminate.
    for (let i = 0; i < queue.length; i++) {
      const rel = queue[i];
      const single = { [rel]: sources[rel] };
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      const candidates = (literal: string) =>
        [resolveRel(dir, literal), resolveRel('src', literal), resolveRel('', literal)].filter(
          (c, idx, all): c is string => c !== undefined && all.indexOf(c) === idx,
        );

      for (const literal of extractIncludePaths(single)) {
        for (const cand of candidates(literal)) {
          if (cand in sources) break;
          const uri = this.rootUri(p, cand);
          const text = await this.readIfExists(uri);
          if (text === undefined) continue;
          sources[cand] = text;
          relToUri.set(cand, uri);
          queue.push(cand);
          break;
        }
      }

      for (const literal of extractReadmemPaths(single)) {
        if (literal in dataFiles) continue;
        for (const cand of candidates(literal)) {
          const text = await this.readIfExists(this.rootUri(p, cand));
          if (text === undefined) continue;
          dataFiles[literal] = text;
          break;
        }
      }
    }
    return { sources, dataFiles, relToUri };
  }

  private rootUri(p: ProjectSpec, rel: string): vscode.Uri {
    return p.root.with({ path: p.root.path.replace(/\/$/, '') + '/' + rel });
  }
}
