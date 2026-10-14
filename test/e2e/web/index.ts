// Mocha runner for the web extension host: @vscode/test-web calls `run` from this bundle.
import 'mocha/mocha';

export async function run(): Promise<void> {
  mocha.setup({ ui: 'tdd', reporter: undefined, timeout: 60000 });
  // Loaded after setup so the tdd globals (`suite`, `test`) exist.
  await import('../preview.test');
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} tests failed.`)) : resolve(),
    );
  });
}
