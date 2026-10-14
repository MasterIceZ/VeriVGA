// Messages between the webview main thread and the compile worker. These stay inside the
// webview, so unlike `shared/protocol.ts` they may carry a `WebAssembly.Module`.

import type { VerilatorMessage } from '../shared/protocol';

export type ToWorker =
  | { type: 'init'; wasmModule: WebAssembly.Module }
  | {
      type: 'compile';
      generation: number;
      topModule: string;
      sources: Record<string, string>;
    };

export type FromWorker =
  | {
      type: 'result';
      generation: number;
      xml?: string;
      messages: VerilatorMessage[];
      ms: number;
    }
  | { type: 'crash'; generation: number; message: string };
