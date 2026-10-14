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
