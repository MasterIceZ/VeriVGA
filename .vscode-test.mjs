import { defineConfig } from '@vscode/test-cli';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// macOS caps Unix socket paths at 103 chars, and VS Code puts its IPC socket in the user data
// dir. The default (.vscode-test/user-data) is too long in deep checkouts, so use a short dir
// in the OS temp dir, one per checkout so parallel worktrees don't share a VS Code instance.
const checkout = createHash('sha1').update(process.cwd()).digest('hex').slice(0, 8);

export default defineConfig({
  files: 'dist/test/e2e/**/*.test.js',
  workspaceFolder: 'test/fixtures/stripes',
  mocha: { ui: 'tdd', timeout: 60000 },
  launchArgs: [`--user-data-dir=${join(tmpdir(), `verivga-e2e-${checkout}`)}`],
});
