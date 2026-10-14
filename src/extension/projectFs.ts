import * as vscode from 'vscode';
import type { FsLike } from './project';

const encoder = new TextEncoder();

/** File names whose creation or deletion can change what discovery finds. */
const PROJECT_NAME = /(?:^|\/)(?:info\.yaml|[^/]*\.(?:v|sv|vh|svh))$/i;

const isNotFound = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'FileNotFound';

/**
 * What discovery and the SourceReader read through. An open document's text wins (unsaved
 * buffers, `info.yaml` included); otherwise a URI-keyed cache over the file system answers,
 * until a change event invalidates the entry. Not-found results are cached too; other errors
 * are retried on the next read.
 *
 * It also records every URI a read looked at, so the session can tell which edits and file
 * events can change the next load.
 */
export class ProjectFs implements FsLike {
  private readonly files = new Map<string, Promise<Uint8Array>>();
  private readonly stats = new Map<string, Promise<vscode.FileStat>>();
  private readonly dirs = new Map<string, Promise<[string, vscode.FileType][]>>();
  /** URIs the last completed read looked at. */
  private settled = new Set<string>();
  /** URIs the read in progress has looked at so far. */
  private recording: Set<string> | undefined;

  constructor(
    private readonly base: FsLike,
    private readonly openDocument: (uri: vscode.Uri) => string | undefined,
  ) {}

  /** The open document's text, if there is one. Recorded like any other read. */
  openText(uri: vscode.Uri): string | undefined {
    this.record(uri);
    return this.openDocument(uri);
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const text = this.openText(uri);
    if (text !== undefined) return Promise.resolve(encoder.encode(text));
    return this.cached(this.files, uri, () => this.base.readFile(uri));
  }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    this.record(uri);
    return this.cached(this.stats, uri, () => this.base.stat(uri));
  }

  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    this.record(uri);
    return this.cached(this.dirs, uri, () => this.base.readDirectory(uri));
  }

  /** Drops what is cached for `uri`, and its directory's listing. */
  invalidate(uri: vscode.Uri): void {
    const key = uri.toString();
    this.files.delete(key);
    this.stats.delete(key);
    this.dirs.delete(key);
    this.dirs.delete(vscode.Uri.joinPath(uri, '..').toString());
  }

  clear(): void {
    this.files.clear();
    this.stats.clear();
    this.dirs.clear();
  }

  /** Starts recording a new read (one gather). */
  beginRead(): void {
    this.recording = new Set();
  }

  /** The finished read's URIs replace the previous read's. */
  endRead(): void {
    if (!this.recording) return;
    this.settled = this.recording;
    this.recording = undefined;
  }

  /** Whether the last read, or the one in progress, looked at `uri`. */
  uses(uri: vscode.Uri): boolean {
    const key = uri.toString();
    return this.settled.has(key) || (this.recording?.has(key) ?? false);
  }

  /**
   * Whether creating, deleting or renaming `uri` can change the next load: it was looked at,
   * it is named like a project file, or it is a folder holding something that was looked at.
   */
  affectedBy(uri: vscode.Uri): boolean {
    if (this.uses(uri) || PROJECT_NAME.test(uri.path)) return true;
    const dir = uri.toString().replace(/\/$/, '') + '/';
    const under = (keys: Iterable<string>) => [...keys].some((k) => k.startsWith(dir));
    return under(this.settled) || under(this.recording ?? []);
  }

  private record(uri: vscode.Uri): void {
    (this.recording ?? this.settled).add(uri.toString());
  }

  private cached<T>(cache: Map<string, Promise<T>>, uri: vscode.Uri, load: () => Thenable<T>) {
    const key = uri.toString();
    const hit = cache.get(key);
    if (hit) return hit;
    const p = Promise.resolve(load());
    cache.set(key, p);
    p.catch((err: unknown) => {
      if (!isNotFound(err) && cache.get(key) === p) cache.delete(key);
    });
    return p;
  }
}
