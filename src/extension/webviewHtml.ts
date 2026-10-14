export interface HtmlOptions {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
  wasmUri: string;
  workerUri: string;
}

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 32 random characters from a 64-character alphabet (valid in a CSP nonce, no modulo bias). */
export function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => NONCE_CHARS[b & 63]).join('');
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * The preview page. The Verilator WASM and the compile worker are fetched by URI from
 * `data-*` attributes; the worker runs from a Blob URL (hence `worker-src blob:`), and
 * Verilator and binaryen need `'wasm-unsafe-eval'`.
 */
export function buildHtml(o: HtmlOptions): string {
  const csp =
    `default-src 'none'; img-src ${o.cspSource} blob: data:; style-src ${o.cspSource}; ` +
    `script-src 'nonce-${o.nonce}' ${o.cspSource} 'wasm-unsafe-eval'; worker-src blob:; ` +
    `connect-src ${o.cspSource};`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${attr(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(o.styleUri)}">
<title>VeriVGA</title>
</head>
<body data-wasm-uri="${attr(o.wasmUri)}" data-worker-uri="${attr(o.workerUri)}">
<canvas id="screen"></canvas>
<script type="module" nonce="${attr(o.nonce)}" src="${attr(o.scriptUri)}"></script>
</body>
</html>
`;
}
