import type { VerilatorMessage, WebviewToHost } from '../shared/protocol';

type Compiled = Extract<WebviewToHost, { type: 'compiled' }>;

const DEFAULT_DELAY_MS = 300;
const MAX_DELAY_MS = 2000;

/**
 * The Output channel's block for each `compiled` (spec §3: timings and the raw Verilator
 * output): `[gen N] ok|errors (ms)`, then every message, placed or not, one per line.
 */
export function formatCompiled(c: Compiled): string {
  const header = `[gen ${c.generation}] ${c.ok ? 'ok' : 'errors'} (${c.ms} ms)`;
  return [header, ...c.messages.map(formatMessage)].join('\n');
}

/** `<message>\n<Name>: <message>`: a stack whose first line repeats the message before it. */
const REPEATED_STACK_HEAD = /^([\s\S]+?)\n[\w$.]*: \1(?=\n|$)/;

/**
 * One message as logged: `  file:line:col: severity: message`, without the position when it
 * has no file. A build failure carries `message\nstack`; the stack's `Error: <message>` line
 * is dropped.
 */
export function formatMessage(m: VerilatorMessage): string {
  const where = m.file ? `${m.file}:${m.line}:${m.column}: ` : '';
  return `  ${where}${m.severity}: ${m.message.replace(REPEATED_STACK_HEAD, '$1')}`;
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
