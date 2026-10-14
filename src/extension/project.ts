import * as vscode from 'vscode';
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { detectTopModule } from '../shared/verilog';

export type FsLike = Pick<vscode.FileSystem, 'readDirectory' | 'readFile' | 'stat'>;

export interface ProjectSpec {
  folder: vscode.WorkspaceFolder;
  root: vscode.Uri;
  /** Keys are root-relative paths, e.g. `src/project.v`. */
  files: Map<string, vscode.Uri>;
  topModule: string;
  infoYaml?: vscode.Uri;
}

export type DiscoverResult =
  | { ok: true; project: ProjectSpec }
  | {
      ok: false;
      reason: 'no-folder' | 'no-sources' | 'bad-info-yaml';
      message: string;
      infoYaml?: vscode.Uri;
      problems?: { line: number; message: string }[];
    };

export const NO_FOLDER = 'Open a file inside a workspace folder';
const SOURCE_EXT = /\.(v|sv|vh|svh)$/i;
const DETECT_EXT = /\.(v|sv)$/i;

export function isInside(uri: vscode.Uri, folder: vscode.Uri): boolean {
  return (
    uri.scheme === folder.scheme &&
    uri.authority === folder.authority &&
    (uri.path === folder.path || uri.path.startsWith(folder.path.replace(/\/$/, '') + '/'))
  );
}

/**
 * The folder holding the active file. With exactly one folder, an untitled, outside or
 * missing active file falls back to it. Otherwise undefined (no usable folder).
 */
export function pickFolder(
  activeUri: vscode.Uri | undefined,
  folders: readonly vscode.WorkspaceFolder[],
): vscode.WorkspaceFolder | undefined {
  const folder = activeUri ? folders.find((f) => isInside(activeUri, f.uri)) : undefined;
  return folder ?? (folders.length === 1 ? folders[0] : undefined);
}

const decoder = new TextDecoder('utf-8');

async function readText(fs: FsLike, uri: vscode.Uri): Promise<string | undefined> {
  try {
    return decoder.decode(await fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function exists(fs: FsLike, uri: vscode.Uri): Promise<boolean> {
  try {
    await fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `root` as the user sees it in the workspace: the folder's name, then the path below it. */
function displayPath(folder: vscode.WorkspaceFolder, root: vscode.Uri): string {
  const base = folder.uri.path.replace(/\/$/, '');
  const below = root.path.startsWith(base + '/') ? root.path.slice(base.length + 1) : '';
  const rel = below.replace(/\/$/, '');
  return rel ? `${folder.name}/${rel}` : folder.name;
}

export async function discover(o: {
  activeUri?: vscode.Uri;
  folders: readonly vscode.WorkspaceFolder[];
  topModuleSetting: string;
  fs: FsLike;
}): Promise<DiscoverResult> {
  const { activeUri, folders, topModuleSetting, fs } = o;
  const folder = pickFolder(activeUri, folders);
  if (!folder) return { ok: false, reason: 'no-folder', message: NO_FOLDER };

  const infoUri = vscode.Uri.joinPath(folder.uri, 'info.yaml');
  const infoText = await readText(fs, infoUri);
  if (infoText !== undefined) {
    return fromInfoYaml(folder, infoUri, infoText, topModuleSetting, fs);
  }

  const inFolder = activeUri !== undefined && isInside(activeUri, folder.uri);
  const root = inFolder ? vscode.Uri.joinPath(activeUri, '..') : folder.uri;
  let entries: [string, vscode.FileType][] = [];
  try {
    entries = await fs.readDirectory(root);
  } catch {
    // an unreadable directory is the same as one without sources
  }
  const names = entries
    .filter(([name, type]) => type === vscode.FileType.File && SOURCE_EXT.test(name))
    .map(([name]) => name)
    .sort();
  if (names.length === 0) {
    const message = `No Verilog sources found in ${displayPath(folder, root)}`;
    return { ok: false, reason: 'no-sources', message };
  }
  const files = new Map(names.map((n) => [n, vscode.Uri.joinPath(root, n)]));
  const texts: Record<string, string> = {};
  for (const [name, uri] of files) {
    if (!DETECT_EXT.test(name)) continue;
    const text = await readText(fs, uri);
    if (text !== undefined) texts[name] = text;
  }
  return {
    ok: true,
    project: { folder, root, files, topModule: topModuleSetting || detectTopModule(texts) },
  };
}

async function fromInfoYaml(
  folder: vscode.WorkspaceFolder,
  infoUri: vscode.Uri,
  text: string,
  topModuleSetting: string,
  fs: FsLike,
): Promise<DiscoverResult> {
  const bad = (problems: { line: number; message: string }[]): DiscoverResult => ({
    ok: false,
    reason: 'bad-info-yaml',
    message: problems[0].message,
    infoYaml: infoUri,
    problems,
  });

  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (doc.errors.length > 0) {
    return bad(
      doc.errors.map((e) => ({
        line: Math.max(0, (e.linePos?.[0].line ?? 1) - 1),
        message: e.message,
      })),
    );
  }

  const project = doc.get('project', true);
  const sourceFiles = isMap(project) ? project.get('source_files', true) : undefined;
  const files = new Map<string, vscode.Uri>();
  const problems: { line: number; message: string }[] = [];
  if (isSeq(sourceFiles)) {
    for (const item of sourceFiles.items) {
      if (!isScalar(item) || typeof item.value !== 'string') continue;
      const rel = `src/${item.value}`;
      const uri = vscode.Uri.joinPath(folder.uri, rel);
      if (await exists(fs, uri)) {
        files.set(rel, uri);
      } else {
        const line = item.range ? lineCounter.linePos(item.range[0]).line - 1 : 0;
        problems.push({ line, message: `Source file not found: ${rel}` });
      }
    }
  }
  if (problems.length > 0) return bad(problems);
  if (files.size === 0) {
    return {
      ok: false,
      reason: 'no-sources',
      message: 'info.yaml lists no source files',
      infoYaml: infoUri,
    };
  }

  let topModule = topModuleSetting;
  if (!topModule) {
    const top = isMap(project) ? project.get('top_module') : undefined;
    if (typeof top === 'string' && top) {
      topModule = top;
    } else {
      const texts: Record<string, string> = {};
      for (const [rel, uri] of files) {
        const t = await readText(fs, uri);
        if (t !== undefined) texts[basename(rel)] = t;
      }
      topModule = detectTopModule(texts);
    }
  }
  return {
    ok: true,
    project: { folder, root: folder.uri, files, topModule, infoYaml: infoUri },
  };
}
