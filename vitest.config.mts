import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/unit/**/*.test.ts', 'test/golden/**/*.test.ts'],
    testTimeout: 60000,
  },
});
