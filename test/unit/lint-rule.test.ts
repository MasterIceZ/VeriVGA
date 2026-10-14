import { ESLint } from 'eslint';
import { describe, expect, test } from 'vitest';

const eslint = new ESLint();

describe('web-safe lint rules', () => {
  test('host code may not import Node built-ins', async () => {
    const [r] = await eslint.lintText("import * as fs from 'fs';\n", {
      filePath: 'src/extension/probe.ts',
    });
    expect(r.messages.map((m) => m.ruleId)).toContain('no-restricted-imports');
  });
  test('node: specifiers are blocked in shared code', async () => {
    const [r] = await eslint.lintText("import p from 'node:path';\n", {
      filePath: 'src/shared/probe.ts',
    });
    expect(r.messages.map((m) => m.ruleId)).toContain('no-restricted-imports');
  });
  test('Buffer global is blocked in host code', async () => {
    const [r] = await eslint.lintText('export const b = Buffer.from("x");\n', {
      filePath: 'src/extension/probe.ts',
    });
    expect(r.messages.map((m) => m.ruleId)).toContain('no-restricted-globals');
  });
});
