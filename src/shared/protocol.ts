// All host <-> webview message types. Payloads must be JSON-serializable.
// Paths are always project-relative, using `/`. The webview never sees URIs.

export type HostToWebview =
  | {
      type: 'load';
      generation: number;
      topModule: string;
      sources: Record<string, string>;
      dataFiles: Record<string, string>;
    }
  | { type: 'control'; action: 'reset' | 'pause' | 'resume' | 'screenshot' };

export type WebviewToHost =
  | { type: 'ready' }
  | {
      type: 'compiled';
      generation: number;
      ok: boolean;
      messages: VerilatorMessage[];
      ms: number;
    }
  | { type: 'runtimeError'; generation: number; message: string }
  | {
      type: 'stats';
      fps: number;
      state: 'loading' | 'compiling' | 'running' | 'paused' | 'error';
    }
  | { type: 'screenshot'; png: string }; // base64, used by FR-14 (v1)

export interface VerilatorMessage {
  severity: 'error' | 'warning';
  code?: string;
  file: string; // project-relative, as sent in `load.sources`
  line: number;
  column: number;
  endColumn?: number; // 1-based (Verilator)
  message: string;
}

export type LoadMessage = Extract<HostToWebview, { type: 'load' }>;

// Runtime guards for messages crossing the bridge. They check `type` and the types of the
// required fields, so a malformed message is dropped instead of reaching a handler.

type Fields = Record<string, unknown>;

const isObject = (x: unknown): x is Fields => typeof x === 'object' && x !== null;
const isNumber = (x: unknown): x is number => typeof x === 'number';
const isString = (x: unknown): x is string => typeof x === 'string';
const isStringRecord = (x: unknown): boolean =>
  isObject(x) && !Array.isArray(x) && Object.values(x).every(isString);
const oneOf =
  <T extends string>(...values: readonly T[]) =>
  (x: unknown): x is T =>
    values.includes(x as T);

const isSeverity = oneOf('error', 'warning');
const isControlAction = oneOf('reset', 'pause', 'resume', 'screenshot');
const isStatsState = oneOf('loading', 'compiling', 'running', 'paused', 'error');

function isVerilatorMessage(x: unknown): x is VerilatorMessage {
  return (
    isObject(x) &&
    isSeverity(x.severity) &&
    isString(x.file) &&
    isNumber(x.line) &&
    isNumber(x.column) &&
    isString(x.message) &&
    (x.code === undefined || isString(x.code)) &&
    (x.endColumn === undefined || isNumber(x.endColumn))
  );
}

export function isHostToWebview(x: unknown): x is HostToWebview {
  if (!isObject(x)) return false;
  switch (x.type) {
    case 'load':
      return (
        isNumber(x.generation) &&
        isString(x.topModule) &&
        isStringRecord(x.sources) &&
        isStringRecord(x.dataFiles)
      );
    case 'control':
      return isControlAction(x.action);
    default:
      return false;
  }
}

export function isWebviewToHost(x: unknown): x is WebviewToHost {
  if (!isObject(x)) return false;
  switch (x.type) {
    case 'ready':
      return true;
    case 'compiled':
      return (
        isNumber(x.generation) &&
        typeof x.ok === 'boolean' &&
        Array.isArray(x.messages) &&
        x.messages.every(isVerilatorMessage) &&
        isNumber(x.ms)
      );
    case 'runtimeError':
      return isNumber(x.generation) && isString(x.message);
    case 'stats':
      return isNumber(x.fps) && isStatsState(x.state);
    case 'screenshot':
      return isString(x.png);
    default:
      return false;
  }
}
