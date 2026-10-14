import type { VerilatorMessage } from '../../shared/protocol';
import type { IErrorMessage } from './ErrorParser';

/**
 * Verilator reports columns as 1-based character offsets. Verified against the bundled 4.205
 * build: it does not expand tabs, so the column passes through unchanged. It is clamped to the
 * line so a bad value can never point past the end of the line.
 */
function toCharColumn(column: number, lineText: string | undefined): number {
  if (lineText === undefined) return column;
  return Math.max(1, Math.min(column, lineText.length + 1));
}

/**
 * Maps a path Verilator reported back to the project-relative key it was loaded under.
 * Verilator joins an `-I<dir>/` and the include name with another `/`, so a file pulled in by
 * `` `include`` comes back as `src/src//defs.vh` (info.yaml keys) or `src//defs.vh` (fallback
 * keys). Normalize first (repeated `/`, `.` and `..` segments), then remove exactly one leading
 * `src/`, the Emscripten FS root every source is written under.
 */
function toProjectPath(reported: string): string {
  const out: string[] = [];
  for (const seg of reported.split('/')) {
    if (seg === '' || seg === '.') continue;
    // A `..` above the root has no source key; keep it so the path never matches one.
    if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  if (out.length > 1 && out[0] === 'src') out.shift();
  return out.join('/');
}

export function toVerilatorMessages(
  errors: IErrorMessage[],
  sources: Record<string, string>,
): VerilatorMessage[] {
  const lines = new Map<string, string[]>();
  const lineOf = (file: string, line: number): string | undefined => {
    let split = lines.get(file);
    if (!split && file in sources) {
      split = sources[file].split('\n');
      lines.set(file, split);
    }
    return split?.[line - 1]?.replace(/\r$/, '');
  };

  return errors.map((e) => {
    // Verilator sees files at `src/<project-relative path>` in the Emscripten FS.
    const file = toProjectPath(e.file);
    const text = lineOf(file, e.line);
    const msg: VerilatorMessage = {
      severity: e.type,
      file,
      line: e.line,
      column: toCharColumn(e.column, text),
      message: e.message,
    };
    if (e.warningClass !== undefined) msg.code = e.warningClass;
    if (e.endColumn !== undefined) msg.endColumn = toCharColumn(e.endColumn, text);
    return msg;
  });
}
