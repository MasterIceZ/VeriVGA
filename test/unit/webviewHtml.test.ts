import { describe, expect, test } from 'vitest';
import { buildHtml, makeNonce } from '../../src/extension/webviewHtml';

const opts = {
  cspSource: 'https://x.vscode-cdn.net',
  nonce: 'N0NCE',
  scriptUri: 's',
  styleUri: 'c',
  wasmUri: 'w',
  workerUri: 'k',
};

describe('buildHtml', () => {
  const html = buildHtml(opts);

  test('CSP allows wasm and blob workers', () => {
    expect(html).toContain("'wasm-unsafe-eval'");
    expect(html).toContain('worker-src blob:');
  });

  test('CSP is exactly the documented policy', () => {
    expect(html).toContain(
      "default-src 'none'; img-src https://x.vscode-cdn.net blob: data:; " +
        'style-src https://x.vscode-cdn.net; ' +
        "script-src 'nonce-N0NCE' https://x.vscode-cdn.net 'wasm-unsafe-eval'; " +
        'worker-src blob:; connect-src https://x.vscode-cdn.net;',
    );
  });

  test('the script is a module with the nonce', () => {
    expect(html).toMatch(/<script type="module" nonce="N0NCE"/);
  });

  test('no remote origins besides the webview source', () => {
    expect(html).not.toMatch(/https?:\/\/(?!x\.vscode-cdn\.net)/);
  });

  test('wasm and worker URIs are on the body', () => {
    expect(html).toMatch(/<body[^>]* data-wasm-uri="w"/);
    expect(html).toMatch(/<body[^>]* data-worker-uri="k"/);
  });

  test('attribute values are escaped', () => {
    const h = buildHtml({ ...opts, wasmUri: 'a"b&c' });
    expect(h).toContain('data-wasm-uri="a&quot;b&amp;c"');
  });
});

describe('makeNonce', () => {
  test('32 nonce-safe characters, different each call', () => {
    const a = makeNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(makeNonce()).not.toBe(a);
  });
});
