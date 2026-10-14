import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { LoadMessage, VerilatorMessage, WebviewToHost } from '../../src/shared/protocol';
import type { VgaAdapter } from '../../src/webview/adapters/types';
import { CompileQueue } from '../../src/webview/compileQueue';
import { CompilerHost, type WorkerEvents, type WorkerHandle } from '../../src/webview/compilerHost';
import { Orchestrator } from '../../src/webview/orchestrator';
import type { BuildOptions, BuildResult, RunningSim } from '../../src/webview/simHost';
import type { ToWorker } from '../../src/webview/workerProtocol';

type Compiled = Extract<WebviewToHost, { type: 'compiled' }>;

/** Stands in for the compile worker; the test plays its replies. */
class FakeWorker implements WorkerHandle {
  readonly posted: ToWorker[] = [];
  terminated = false;

  constructor(private readonly events: WorkerEvents) {}

  postMessage(msg: ToWorker): void {
    this.posted.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Generations this worker was asked to compile. */
  get compiles(): number[] {
    return this.posted.flatMap((m) => (m.type === 'compile' ? [m.generation] : []));
  }

  /** `xml: null` = Verilator produced no XML. */
  result(
    generation: number,
    messages: VerilatorMessage[] = [],
    xml: string | null = `gen-${generation}`,
  ) {
    this.events.onMessage({ type: 'result', generation, xml: xml ?? undefined, messages, ms: 1 });
  }

  crash(generation: number, message: string): void {
    this.events.onMessage({ type: 'crash', generation, message });
  }

  uncaught(message: string): void {
    this.events.onError(message);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A sim tagged with the XML it was "built" from. */
const fakeSim = (tag: string) => ({ tag, dispose: vi.fn() }) as unknown as RunningSim;
const tagOf = (sim: unknown) => (sim as { tag: string }).tag;

const warning: VerilatorMessage = {
  severity: 'warning',
  code: 'UNUSED',
  file: 'src/project.v',
  line: 3,
  column: 1,
  message: 'Signal is not used',
};
const syntaxError: VerilatorMessage = {
  severity: 'error',
  file: 'src/project.v',
  line: 2,
  column: 10,
  message: "syntax error, unexpected ';'",
};

const load = (generation: number): LoadMessage => ({
  type: 'load',
  generation,
  topModule: 'tt_um_t',
  sources: { 'src/project.v': `// ${generation}` },
  dataFiles: {},
});

/** Lets the result chain (promise hops around `buildSim`) run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function setup() {
  const calls: string[] = [];
  const posted: WebviewToHost[] = [];
  const workers: FakeWorker[] = [];
  const loop = {
    sim: null as RunningSim | null,
    input: { uiIn: 0x28, gamepad: { enabled: true, buttons: 0x100 } },
    paused: false,
    // The fake swaps at once; the real loop swaps on the next frame.
    setSim: vi.fn((sim: RunningSim) => {
      calls.push(`setSim:${tagOf(sim)}`);
      loop.sim = sim;
    }),
    pause: vi.fn(() => {
      loop.paused = true;
    }),
    resume: vi.fn(() => {
      loop.paused = false;
    }),
    reset: vi.fn(),
  };
  const banner = {
    showErrors: vi.fn(),
    showMessage: vi.fn(),
    hide: vi.fn(() => calls.push('banner.hide')),
  };
  const controls = { setPaused: vi.fn(), setFps: vi.fn(), setCompiling: vi.fn() };
  const buildSim = vi.fn(async (o: BuildOptions): Promise<BuildResult> => ({
    ok: true,
    sim: fakeSim(o.xml),
  }));
  const log = { log: vi.fn(), error: vi.fn() };
  const capturePng = vi.fn(() => 'iVBORw0KGgo=');
  const orchestrator = new Orchestrator({
    post: (msg) => {
      posted.push(msg);
      if (msg.type === 'compiled') calls.push(`compiled:${msg.generation}`);
    },
    loop,
    banner,
    controls,
    adapter: {} as VgaAdapter,
    buildSim,
    capturePng,
    startCompiler: async (events) =>
      new CompilerHost({
        ...events,
        wasmModule: {} as WebAssembly.Module,
        createWorker: (ev) => {
          const w = new FakeWorker(ev);
          workers.push(w);
          return w;
        },
        log,
      }),
    now: () => Date.now(),
    log,
  });
  await orchestrator.boot();
  return {
    orchestrator,
    loop,
    banner,
    controls,
    buildSim,
    capturePng,
    workers,
    worker: () => workers[workers.length - 1],
    posted,
    calls,
    compiled: () => posted.filter((m): m is Compiled => m.type === 'compiled'),
  };
}

type T = Awaited<ReturnType<typeof setup>>;

/** Loads generation `gen` and lets it compile and build successfully. */
async function compileOk(t: T, gen: number): Promise<void> {
  t.orchestrator.onHostMessage(load(gen));
  t.worker().result(gen);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('boot', () => {
  test('posts ready once the compiler is up, and the first worker gets init', async () => {
    const t = await setup();
    expect(t.posted.filter((m) => m.type === 'ready')).toHaveLength(1);
    expect(t.workers).toHaveLength(1);
    expect(t.worker().posted).toEqual([{ type: 'init', wasmModule: expect.anything() }]);
  });

  test('a failed boot shows Retry and no ready; a retry boots and submits an early load', async () => {
    const posted: WebviewToHost[] = [];
    const banner = { showErrors: vi.fn(), showMessage: vi.fn(), hide: vi.fn() };
    const workers: FakeWorker[] = [];
    let fail = true;
    const orchestrator = new Orchestrator({
      post: (m) => posted.push(m),
      loop: {
        sim: null,
        input: { uiIn: 0, gamepad: { enabled: false, buttons: 0 } },
        paused: false,
        setSim: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        reset: vi.fn(),
      },
      banner,
      controls: { setPaused: vi.fn(), setFps: vi.fn(), setCompiling: vi.fn() },
      adapter: {} as VgaAdapter,
      buildSim: vi.fn(),
      capturePng: vi.fn(() => ''),
      startCompiler: async (events) => {
        if (fail) throw new Error('GET verilator_bin.wasm: 503');
        return new CompilerHost({
          ...events,
          wasmModule: {} as WebAssembly.Module,
          createWorker: (ev) => {
            const w = new FakeWorker(ev);
            workers.push(w);
            return w;
          },
        });
      },
      log: { log: vi.fn(), error: vi.fn() },
    });
    await orchestrator.boot();
    expect(banner.showMessage).toHaveBeenLastCalledWith("Couldn't load the compiler", {
      retry: true,
    });
    expect(orchestrator.state).toBe('error');
    expect(posted.some((m) => m.type === 'ready')).toBe(false);

    orchestrator.onHostMessage(load(1)); // arrives before the compiler is ready
    fail = false;
    await orchestrator.boot();
    expect(banner.hide).toHaveBeenCalled();
    expect(posted.filter((m) => m.type === 'ready')).toHaveLength(1);
    expect(workers[0].compiles).toEqual([1]);
  });
});

describe('worker failures settle the in-flight generation (ruling 3)', () => {
  test('a crash posts compiled(ok:false), restarts the worker, and the queue carries on', async () => {
    const t = await setup();
    t.orchestrator.onHostMessage(load(1));
    const first = t.worker();
    expect(first.compiles).toEqual([1]);

    first.crash(1, 'abort(OOM)');
    await flush();

    expect(t.compiled()).toEqual([
      expect.objectContaining({
        generation: 1,
        ok: false,
        messages: [
          {
            severity: 'error',
            file: '',
            line: 1,
            column: 1,
            message: 'Compiler crashed: abort(OOM)',
          },
        ],
      }),
    ]);
    expect(t.posted.some((m) => m.type === 'runtimeError')).toBe(false);
    expect(t.banner.showMessage.mock.lastCall?.[0]).toBe('Compiler crashed: abort(OOM)');
    expect(first.terminated).toBe(true);
    expect(t.workers).toHaveLength(2);
    expect(t.worker().posted).toEqual([{ type: 'init', wasmModule: expect.anything() }]);

    t.orchestrator.onHostMessage(load(2));
    expect(t.worker().compiles).toEqual([2]);
  });

  test('an uncaught worker error settles the in-flight job; the pending one runs on a new worker', async () => {
    const t = await setup();
    t.orchestrator.onHostMessage(load(1));
    t.orchestrator.onHostMessage(load(2)); // pending
    const first = t.worker();

    first.uncaught('Uncaught RangeError: Maximum call stack size exceeded');
    await flush();

    expect(t.compiled()).toEqual([
      expect.objectContaining({
        generation: 1,
        ok: false,
        messages: [
          expect.objectContaining({
            message: 'Compiler crashed: Uncaught RangeError: Maximum call stack size exceeded',
          }),
        ],
      }),
    ]);
    expect(t.posted.some((m) => m.type === 'runtimeError')).toBe(false);
    expect(first.terminated).toBe(true);
    expect(t.workers).toHaveLength(2);
    expect(t.worker().posted[0]).toEqual({ type: 'init', wasmModule: expect.anything() });
    expect(t.worker().compiles).toEqual([2]);

    t.worker().result(2);
    await flush();
    expect(t.compiled().map((c) => [c.generation, c.ok])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  test('a worker error with no job in flight is only logged (no restart loop)', async () => {
    const t = await setup();
    t.worker().uncaught('script error');
    await flush();
    expect(t.workers).toHaveLength(1);
    expect(t.compiled()).toEqual([]);
  });
});

describe('watchdog (ruling 4)', () => {
  test('at 20 000 ms: "Compile timed out", worker restarted, no synchronous submit, pending runs', async () => {
    const t = await setup();
    t.orchestrator.onHostMessage(load(1));
    t.orchestrator.onHostMessage(load(2)); // pending
    const first = t.worker();
    const submit = vi.spyOn(CompileQueue.prototype, 'submit');

    vi.advanceTimersByTime(19_999);
    await flush();
    expect(t.compiled()).toEqual([]);
    expect(first.terminated).toBe(false);

    vi.advanceTimersByTime(1);
    await flush();
    expect(t.compiled()).toEqual([
      expect.objectContaining({
        generation: 1,
        ok: false,
        ms: 20_000,
        messages: [expect.objectContaining({ message: 'Compile timed out' })],
      }),
    ]);
    expect(t.banner.showMessage.mock.lastCall?.[0]).toBe('Compile timed out');
    expect(submit).not.toHaveBeenCalled();
    expect(first.terminated).toBe(true);
    expect(t.workers).toHaveLength(2);
    expect(t.worker().posted).toEqual([
      { type: 'init', wasmModule: expect.anything() },
      expect.objectContaining({ type: 'compile', generation: 2 }),
    ]);

    t.worker().result(2);
    await flush();
    expect(t.compiled().map((c) => [c.generation, c.ok])).toEqual([
      [1, false],
      [2, true],
    ]);
  });
});

describe('pause provenance (ruling 5)', () => {
  test('runtime error, then a successful new sim → resume()', async () => {
    const t = await setup();
    await compileOk(t, 1);

    t.orchestrator.onRuntimeError(new Error('no file "missing.hex" for $readmem'));
    expect(t.loop.paused).toBe(true);
    expect(t.posted).toContainEqual({
      type: 'runtimeError',
      generation: 1,
      message: 'no file "missing.hex" for $readmem',
    });
    expect(t.banner.showMessage.mock.lastCall?.[0]).toBe('no file "missing.hex" for $readmem');
    expect(t.loop.resume).not.toHaveBeenCalled();

    await compileOk(t, 2);
    expect(t.loop.resume).toHaveBeenCalledTimes(1);
    expect(t.loop.paused).toBe(false);
    expect(t.controls.setPaused).toHaveBeenLastCalledWith(false);
  });

  test('user pause, then a successful new sim → no resume()', async () => {
    const t = await setup();
    await compileOk(t, 1);

    t.orchestrator.togglePause();
    expect(t.loop.pause).toHaveBeenCalledTimes(1);
    await compileOk(t, 2);

    expect(t.loop.resume).not.toHaveBeenCalled();
    expect(t.loop.paused).toBe(true);
    expect(t.orchestrator.state).toBe('paused');
    expect(tagOf(t.loop.setSim.mock.lastCall?.[0])).toBe('gen-2');
  });

  test('runtime error, then Reset → resume() and the runtime banner clears', async () => {
    const t = await setup();
    await compileOk(t, 1);
    t.orchestrator.onRuntimeError(new Error('model did not converge on eval()'));
    t.banner.hide.mockClear();

    t.orchestrator.reset();
    expect(t.loop.reset).toHaveBeenCalledTimes(1);
    expect(t.loop.resume).toHaveBeenCalledTimes(1);
    expect(t.banner.hide).toHaveBeenCalled();
    expect(t.orchestrator.state).toBe('running');
  });

  test('a Reset that throws is reported as a runtime error', async () => {
    const t = await setup();
    await compileOk(t, 1);
    t.loop.reset.mockImplementation(() => {
      throw new Error('model did not converge on reset()');
    });
    t.orchestrator.reset();
    expect(t.loop.paused).toBe(true);
    expect(t.posted).toContainEqual({
      type: 'runtimeError',
      generation: 1,
      message: 'model did not converge on reset()',
    });
  });
});

describe('success path (ruling 8)', () => {
  test('setSim, then banner.hide(), then compiled(ok:true) with the warnings', async () => {
    const t = await setup();
    t.orchestrator.onHostMessage(load(1));
    t.calls.length = 0;

    t.worker().result(1, [warning]);
    await flush();

    expect(t.calls).toEqual(['setSim:gen-1', 'banner.hide', 'compiled:1']);
    expect(t.compiled()[0]).toMatchObject({ generation: 1, ok: true, messages: [warning] });
    expect(t.buildSim.mock.lastCall?.[0]).toMatchObject({
      xml: 'gen-1',
      topModule: 'tt_um_t',
      input: { uiIn: 0x28, gamepad: { enabled: true, buttons: 0x100 } },
    });
  });

  test('the compiling marker shows on load and hides when the queue goes idle', async () => {
    const t = await setup();
    t.orchestrator.onHostMessage(load(1));
    expect(t.controls.setCompiling).toHaveBeenLastCalledWith(true);
    t.orchestrator.onHostMessage(load(2)); // pending
    t.worker().result(1); // superseded: dropped, gen 2 starts
    await flush();
    expect(t.controls.setCompiling).toHaveBeenLastCalledWith(true);
    expect(t.orchestrator.state).toBe('compiling');

    t.worker().result(2);
    await flush();
    expect(t.controls.setCompiling).toHaveBeenLastCalledWith(false);
    expect(t.orchestrator.state).toBe('running');
  });

  test('compiled.ms is the wall-clock time from load to compiled', async () => {
    const t = await setup();
    t.orchestrator.onHostMessage(load(1));
    vi.advanceTimersByTime(1234);
    t.worker().result(1);
    await flush();
    expect(t.compiled()[0].ms).toBe(1234);
  });
});

describe('failures keep the old sim', () => {
  test('Verilator errors → compiled(ok:false) with them, "N errors" banner, no setSim', async () => {
    const t = await setup();
    await compileOk(t, 1);
    t.orchestrator.onHostMessage(load(2));
    t.worker().result(2, [syntaxError, warning], null);
    await flush();
    expect(t.compiled()[1]).toMatchObject({
      generation: 2,
      ok: false,
      messages: [syntaxError, warning],
    });
    expect(t.banner.showErrors).toHaveBeenLastCalledWith(1);
    expect(t.loop.setSim).toHaveBeenCalledTimes(1);
    expect(t.orchestrator.state).toBe('error');
  });

  test('no XML and no error → "Compilation failed (no output)" (never silent)', async () => {
    const t = await setup();
    t.orchestrator.onHostMessage(load(1));
    t.worker().result(1, [warning], null);
    await flush();
    expect(t.compiled()[0]).toMatchObject({
      ok: false,
      messages: [
        warning,
        { severity: 'error', file: '', message: 'Compilation failed (no output)' },
      ],
    });
    expect(t.banner.showMessage.mock.lastCall?.[0]).toBe('Compilation failed (no output)');
  });

  test('a build failure posts the stack (for the Output channel); the banner shows only the message', async () => {
    const t = await setup();
    await compileOk(t, 1);
    const stack = 'Error: unsupported construct\n    at HDLModuleWASM.init (hdlwasm.ts:1:1)';
    t.buildSim.mockResolvedValueOnce({ ok: false, message: 'unsupported construct', stack });
    t.orchestrator.onHostMessage(load(2));
    t.worker().result(2);
    await flush();

    expect(t.banner.showMessage.mock.lastCall?.[0]).toBe('unsupported construct');
    expect(t.compiled()[1]).toMatchObject({
      generation: 2,
      ok: false,
      messages: [
        {
          severity: 'error',
          file: '',
          line: 1,
          column: 1,
          message: `unsupported construct\n${stack}`,
        },
      ],
    });
    expect(t.loop.setSim).toHaveBeenCalledTimes(1); // the old sim keeps running
  });

  test('a build failure without a stack (adapter.validate) posts just the message', async () => {
    const t = await setup();
    const message = "Top module `g` doesn't have the TinyTapeout port list (missing: ui_in)";
    t.buildSim.mockResolvedValueOnce({ ok: false, message });
    t.orchestrator.onHostMessage(load(1));
    t.worker().result(1);
    await flush();
    expect(t.compiled()[0].messages).toEqual([
      { severity: 'error', file: '', line: 1, column: 1, message },
    ]);
    expect(t.banner.showMessage.mock.lastCall?.[0]).toBe(message);
  });

  test('a status message shows in the banner and the state becomes error', async () => {
    const t = await setup();
    t.orchestrator.onHostMessage({ type: 'status', message: 'No Verilog sources found in `x`' });
    expect(t.banner.showMessage.mock.lastCall?.[0]).toBe('No Verilog sources found in `x`');
    expect(t.orchestrator.state).toBe('error');
  });
});

describe('ordering', () => {
  test('a result arriving while the previous build is pending lands after it, in order', async () => {
    const t = await setup();
    const builds: Deferred<BuildResult>[] = [];
    t.buildSim.mockImplementation(() => {
      const d = deferred<BuildResult>();
      builds.push(d);
      return d.promise;
    });

    t.orchestrator.onHostMessage(load(1));
    t.worker().result(1);
    await flush();
    expect(builds).toHaveLength(1); // gen 1 is building

    // The queue went idle when gen 1's result came back, so gen 2 compiles and is accepted.
    t.orchestrator.onHostMessage(load(2));
    t.worker().result(2);
    await flush();
    expect(builds).toHaveLength(1); // gen 2 waits for gen 1's build

    builds[0].resolve({ ok: true, sim: fakeSim('gen-1') });
    await flush();
    expect(builds).toHaveLength(2);
    builds[1].resolve({ ok: true, sim: fakeSim('gen-2') });
    await flush();

    expect(t.compiled().map((c) => c.generation)).toEqual([1, 2]);
    expect(t.loop.setSim.mock.calls.map(([s]) => tagOf(s))).toEqual(['gen-1', 'gen-2']);
    expect(tagOf(t.loop.sim)).toBe('gen-2');
  });

  test('errors for gen 2 arriving while gen 1 builds land after it, and the banner keeps them', async () => {
    const t = await setup();
    const build1 = deferred<BuildResult>();
    t.buildSim.mockImplementationOnce(() => build1.promise);

    t.orchestrator.onHostMessage(load(1));
    t.worker().result(1);
    await flush();
    t.orchestrator.onHostMessage(load(2));
    t.worker().result(2, [syntaxError], null);
    await flush();
    expect(t.compiled()).toEqual([]);

    build1.resolve({ ok: true, sim: fakeSim('gen-1') });
    await flush();
    expect(t.calls.filter((c) => c.startsWith('compiled'))).toEqual(['compiled:1', 'compiled:2']);
    expect(t.banner.showErrors).toHaveBeenLastCalledWith(1);
    expect(t.banner.hide.mock.invocationCallOrder[0]).toBeLessThan(
      t.banner.showErrors.mock.invocationCallOrder[0],
    );
  });

  test('a load that arrives while one compiles supersedes it: the older result is dropped', async () => {
    const t = await setup();
    t.orchestrator.onHostMessage(load(1));
    t.orchestrator.onHostMessage(load(2));
    t.worker().result(1);
    await flush();
    expect(t.compiled()).toEqual([]);
    expect(t.worker().compiles).toEqual([1, 2]);
    t.worker().result(2);
    await flush();
    expect(t.compiled().map((c) => c.generation)).toEqual([2]);
    expect(t.buildSim).toHaveBeenCalledTimes(1);
  });
});

describe('host controls', () => {
  test('control: screenshot posts the canvas as a base64 PNG, and nothing else', async () => {
    const t = await setup();
    await compileOk(t, 1);
    t.posted.length = 0;
    t.orchestrator.onHostMessage({ type: 'control', action: 'screenshot' });
    expect(t.capturePng).toHaveBeenCalledTimes(1);
    expect(t.posted).toEqual([{ type: 'screenshot', png: 'iVBORw0KGgo=' }]);
    expect(t.loop.pause).not.toHaveBeenCalled();
    expect(t.loop.reset).not.toHaveBeenCalled();
  });

  test('frames are captured only on request', async () => {
    const t = await setup();
    await compileOk(t, 1);
    t.orchestrator.onHostMessage({ type: 'control', action: 'pause' });
    t.orchestrator.onHostMessage({ type: 'control', action: 'resume' });
    t.orchestrator.onHostMessage({ type: 'control', action: 'reset' });
    expect(t.capturePng).not.toHaveBeenCalled();
    expect(t.posted.some((m) => m.type === 'screenshot')).toBe(false);
  });
});

describe('stats', () => {
  test('at most one stats message per 500 ms, carrying the latest state', async () => {
    const t = await setup();
    const stats = () => t.posted.filter((m) => m.type === 'stats');
    await compileOk(t, 1);
    const before = stats().length;
    for (let i = 0; i < 10; i++) t.orchestrator.onStats(60);
    expect(stats().length - before).toBeLessThanOrEqual(1);
    vi.advanceTimersByTime(500);
    expect(stats().length - before).toBeLessThanOrEqual(2);
    expect(stats().at(-1)).toEqual({ type: 'stats', fps: 60, state: 'running' });
  });
});
