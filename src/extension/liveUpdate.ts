import type { LoadMessage } from '../shared/protocol';

export interface LoadPayload {
  topModule: string;
  sources: Record<string, string>;
  dataFiles: Record<string, string>;
}

export interface LiveUpdateDeps {
  delayMs(): number;
  enabled(): boolean;
  isVisible(): boolean;
  /** null = nothing to send (e.g. project discovery failed). */
  gather(): Promise<LoadPayload | null>;
  send(msg: LoadMessage): void;
}

const sortedEntries = (r: Record<string, string>): [string, string][] =>
  Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** SHA-256 hex over canonical JSON (entries sorted by key, plus topModule). */
export async function hashPayload(p: LoadPayload): Promise<string> {
  const canonical = JSON.stringify({
    topModule: p.topModule,
    sources: sortedEntries(p.sources),
    dataFiles: sortedEntries(p.dataFiles),
  });
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class LiveUpdate {
  generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastHash: string | undefined;
  private held = false;
  private disposed = false;
  private inFlight: Promise<void> | undefined;
  private rerun: { ignoreHash: boolean } | undefined;

  constructor(private readonly d: LiveUpdateDeps) {}

  onEdit(): void {
    if (this.disposed || !this.d.enabled()) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.trigger();
    }, this.d.delayMs());
  }

  async flush(): Promise<void> {
    if (this.disposed) return;
    this.clearTimer();
    await this.trigger();
  }

  async resend(): Promise<void> {
    if (this.disposed) return;
    await this.run(true);
  }

  async onVisible(): Promise<void> {
    if (this.disposed || !this.held) return;
    this.held = false;
    await this.run(false);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.rerun = undefined;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async trigger(): Promise<void> {
    if (this.disposed) return;
    if (!this.d.isVisible()) {
      this.held = true;
      return;
    }
    await this.run(false);
  }

  /** Serialized: one gather at a time; triggers during a gather queue one rerun. */
  private run(ignoreHash: boolean): Promise<void> {
    if (this.inFlight) {
      this.rerun = {
        ignoreHash: (this.rerun?.ignoreHash ?? false) || ignoreHash,
      };
      return this.inFlight;
    }
    const p = this.loop(ignoreHash);
    this.inFlight = p;
    return p;
  }

  private async loop(ignoreHash: boolean): Promise<void> {
    try {
      let ignore = ignoreHash;
      for (;;) {
        await this.once(ignore);
        if (this.disposed || !this.rerun) return;
        ignore = this.rerun.ignoreHash;
        this.rerun = undefined;
      }
    } finally {
      this.inFlight = undefined;
    }
  }

  private async once(ignoreHash: boolean): Promise<void> {
    const payload = await this.d.gather();
    if (this.disposed || !payload) return;
    const hash = await hashPayload(payload);
    if (this.disposed) return;
    if (!ignoreHash && hash === this.lastHash) return;
    this.lastHash = hash;
    this.generation += 1;
    this.d.send({
      type: 'load',
      generation: this.generation,
      topModule: payload.topModule,
      sources: payload.sources,
      dataFiles: payload.dataFiles,
    });
  }
}
