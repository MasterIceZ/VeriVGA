import { VerilogXMLParser } from '../vxmlparser';
import { ErrorParser, IErrorMessage } from './ErrorParser';
import verilator_bin from './verilator_bin';

export interface RunVerilatorOptions {
  topModule: string;
  sources: Record<string, string>;
  wasmBinary?: ArrayBuffer | Uint8Array;
  wasmModule?: WebAssembly.Module;
}

export interface ICompileOptions {
  topModule: string;
  sources: Record<string, string>;
  wasmBinary?: ArrayBuffer | Uint8Array;
  wasmModule?: WebAssembly.Module;
}

/** Runs Verilator and returns the raw XML (when there were no errors) plus its messages. */
export async function runVerilator(
  opts: RunVerilatorOptions,
): Promise<{ xml?: string; errors: IErrorMessage[] }> {
  if (!opts.wasmBinary && !opts.wasmModule) {
    throw new Error('runVerilator: wasmBinary or wasmModule required');
  }

  const errorParser = new ErrorParser();

  const verilatorInst = verilator_bin({
    wasmBinary: opts.wasmBinary,
    ...(opts.wasmModule && {
      instantiateWasm: (
        imports: WebAssembly.Imports,
        receive: (inst: WebAssembly.Instance, mod?: WebAssembly.Module) => void,
      ) => {
        WebAssembly.instantiate(opts.wasmModule!, imports).then((inst) =>
          receive(inst, opts.wasmModule),
        );
        return {};
      },
    }),
    noInitialRun: true,
    noExitRuntime: true,
    print: console.log,
    printErr: (message: string) => {
      console.log(message);
      errorParser.feedLine(message);
    },
  });
  await verilatorInst.ready;
  const { FS } = verilatorInst;

  const sourceList: string[] = [];
  const includeDirs = new Set<string>(['src/']);
  FS.mkdir('src');
  for (const [name, source] of Object.entries(opts.sources)) {
    const path = `src/${name}`;
    const slash = path.lastIndexOf('/');
    const dir = path.slice(0, slash);
    if (dir !== 'src') {
      FS.mkdirTree(dir);
      includeDirs.add(dir + '/');
    }
    FS.writeFile(path, source);
    // Header files (.vh/.svh) are pulled in via `include, not as direct sources
    if (!name.endsWith('.vh') && !name.endsWith('.svh')) {
      sourceList.push(path);
    }
  }
  const xmlPath = `obj_dir/V${opts.topModule}.xml`;
  try {
    const args = [
      '--cc',
      '-O3',
      '-Wall',
      '-Wno-EOFNEWLINE',
      '-Wno-DECLFILENAME',
      '--x-assign',
      'fast',
      '--debug-check', // for XML output
      ...[...includeDirs].map((d) => `-I${d}`),
      '--top-module',
      opts.topModule,
      ...sourceList,
    ];
    verilatorInst.callMain(args);
  } catch (e) {
    console.log(e);
    errorParser.errors.push({
      type: 'error',
      file: '',
      line: 1,
      column: 1,
      message: 'Compilation failed: ' + e,
    });
  }

  if (errorParser.errors.filter((e) => e.type === 'error').length) {
    return { errors: errorParser.errors };
  }

  try {
    const xml = FS.readFile(xmlPath, { encoding: 'utf8' }) as string;
    return { xml, errors: errorParser.errors };
  } catch (e) {
    console.log(e, (e as Error).stack);
    return {
      errors: [
        ...errorParser.errors,
        {
          type: 'error' as const,
          file: '',
          line: 1,
          column: 1,
          message: 'XML parsing failed: ' + e,
        },
      ],
    };
  }
}

/** Parses Verilator's XML output. Throws on failure. */
export function parseVerilatorXml(xml: string): VerilogXMLParser {
  const xmlParser = new VerilogXMLParser();
  xmlParser.parse(xml);
  return xmlParser;
}

export async function compileVerilator(opts: ICompileOptions) {
  const { xml, errors } = await runVerilator(opts);
  if (xml === undefined) {
    return { errors };
  }
  try {
    return { errors, output: parseVerilatorXml(xml) };
  } catch (e) {
    console.log(e, (e as Error).stack);
    return {
      errors: [
        ...errors,
        {
          type: 'error' as const,
          file: '',
          line: 1,
          column: 1,
          message: 'XML parsing failed: ' + e,
        },
      ],
    };
  }
}
