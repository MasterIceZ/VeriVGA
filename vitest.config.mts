import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./test/unit/fakes/vscode.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.spec.ts', 'test/unit/**/*.test.ts', 'test/golden/**/*.test.ts'],
    testTimeout: 60000,
  },
});
