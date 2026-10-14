// Stand-in for Node's `assert` in the web extension host, which has no Node built-ins.
// esbuild aliases `assert` to this file for the web test bundle only. It covers what the
// E2E tests use. Values are protocol messages (plain JSON built in a fixed key order), so
// comparing their JSON is a sufficient deep equality here.

export function strictEqual<T>(
  actual: unknown,
  expected: T,
  message?: string,
): asserts actual is T {
  if (!Object.is(actual, expected)) {
    throw new Error(message ?? `expected ${String(expected)}, got ${String(actual)}`);
  }
}

export function deepStrictEqual<T>(
  actual: unknown,
  expected: T,
  message?: string,
): asserts actual is T {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(message ?? `expected ${e}, got ${a}`);
}

export function notStrictEqual(actual: unknown, expected: unknown, message?: string): void {
  if (Object.is(actual, expected)) {
    throw new Error(message ?? `expected a value other than ${String(expected)}`);
  }
}

export function ok(value: unknown, message?: string): asserts value {
  if (!value) throw new Error(message ?? `expected a truthy value, got ${String(value)}`);
}
