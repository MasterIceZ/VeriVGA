import type { VerilatorMessage, WebviewToHost } from '../shared/protocol';

type Compiled = Extract<WebviewToHost, { type: 'compiled' }>;

const DEFAULT_DELAY_MS = 300;
const MAX_DELAY_MS = 2000;

/** The Output channel's line for each `compiled`: `[gen N] ok|errors (ms)`. */
export function formatCompiled(c: Compiled): string {
  return `[gen ${c.generation}] ${c.ok ? 'ok' : 'errors'} (${c.ms} ms)`;
}

/** `<message>\n<Name>: <message>`: a stack whose first line repeats the message before it. */
const REPEATED_STACK_HEAD = /^([\s\S]+?)\n[\w$.]*: \1(?=\n|$)/;

/**
 * A message the Problems view can't show (no file, or a file outside the project), as logged.
 * A build failure carries `message\nstack`; the stack's `Error: <message>` line is dropped.
 */
export function formatUnplaced(m: VerilatorMessage): string {
  const where = m.file ? `${m.file}:${m.line}:${m.column}: ` : '';
  return `  ${m.severity}: ${where}${m.message.replace(REPEATED_STACK_HEAD, '$1')}`;
}

/** `verivga.liveDelay`, kept within its declared 0–2000 ms range. */
export function clampDelay(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return DEFAULT_DELAY_MS;
  return Math.min(MAX_DELAY_MS, Math.max(0, value));
}

/** An error for the log: its stack when it has one. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}
