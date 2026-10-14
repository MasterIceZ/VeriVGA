// Minimal fake of the `vscode` module for unit tests. Extend as tasks need more.

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

export class Uri {
  private constructor(readonly scheme: string, readonly authority: string, readonly path: string) {}

  static file(path: string): Uri {
    return new Uri('file', '', path);
  }

  static from(c: { scheme: string; authority?: string; path?: string }): Uri {
    return new Uri(c.scheme, c.authority ?? '', c.path ?? '');
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return base.with({ path: normalize([base.path, ...segments].join('/')) });
  }

  with(change: { scheme?: string; authority?: string; path?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
    );
  }

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}
