import { HDLModuleWASM } from '../sim/hdlwasm';
import type { SyncPolarity } from '../sim/vga';
import { parseVerilatorXml } from '../sim/verilator/compile';
import type { VgaAdapter } from './adapters/types';

export interface RunningSim {
  mod: HDLModuleWASM;
  polarity: SyncPolarity;
  topModule: string;
  dispose(): void;
}

export type BuildResult =
  | { ok: true; sim: RunningSim }
  | { ok: false; message: string; stack?: string };

export interface BuildOptions {
  xml: string;
  topModule: string;
  dataFiles: Record<string, string>;
  adapter: VgaAdapter;
  uiIn: number;
}

export async function buildSim(o: BuildOptions): Promise<BuildResult> {
  let mod: HDLModuleWASM | undefined;
  try {
    const { modules } = parseVerilatorXml(o.xml);
    mod = new HDLModuleWASM(modules['TOP'], modules['@CONST-POOL@'] ?? modules['__Vconst']);
    await mod.init();
    const files = o.dataFiles;
    mod.getFileData = (p) => files[p];

    const problem = o.adapter.validate(mod, o.topModule);
    if (problem !== null) {
      mod.dispose();
      return { ok: false, message: problem };
    }

    o.adapter.reset(mod);
    const polarity = o.adapter.detectPolarity(mod);
    o.adapter.reset(mod);
    o.adapter.setInputs(mod, o.uiIn);

    const built = mod;
    return {
      ok: true,
      sim: { mod: built, polarity, topModule: o.topModule, dispose: () => built.dispose() },
    };
  } catch (e) {
    try {
      mod?.dispose();
    } catch {
      // already failing; ignore secondary dispose errors
    }
    const err = e instanceof Error ? e : new Error(String(e));
    return { ok: false, message: err.message, stack: err.stack };
  }
}
