#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { compileSpec, type CompileOptions } from './compile.js';
import { runVerify, packageVersion } from './cli-support.js';
import { runDoctor } from './doctor.js';

export { runVerify, runDoctor };

export async function main(argv: string[] = process.argv): Promise<number> {
  if (argv[2] === 'verify') {
    return runVerify(argv.slice(3));
  }
  if (argv[2] === 'doctor') {
    return runDoctor(argv.slice(3));
  }
  const parsed = await yargs(hideBin(argv))
    .scriptName('speckl')
    .version(packageVersion())
    .usage('Usage:\n  $0 <file> [options]\n  $0 verify [paths..] [--depth <n>]\n  $0 doctor <file>')
    .command('$0 <file>', 'Compile a SpeckDL specification', (yargsCmd) => {
      return yargsCmd
        .positional('file', {
          describe: 'SpeckDL file to compile',
          type: 'string',
          demandOption: true,
        })
        .option('output-dir', {
          alias: 'o',
          describe: 'Output directory for compiled artifacts',
          type: 'string',
          default: './out',
        })
        .option('target', {
          alias: 't',
          describe: 'Compilation target',
          type: 'string',
          choices: ['typescript', 'z3', 'rust', 'go', 'protobuf', 'k8s', 'openapi', 'camel', 'elm', 'agent', 'all', 'all-ir'],
          default: 'typescript' as const,
        })
        .option('verify-depth', {
          alias: 'd',
          describe: 'Bounded model checking depth for Z3 verification',
          type: 'number',
          default: 10,
        })
        .option('bom-format', {
          alias: 'b',
          describe: 'BOM output format',
          type: 'string',
          choices: ['cdx', 'spdx', 'both'],
          default: 'both' as const,
        });
    })
    .command('verify [paths..]', 'Check every verify block with Z3 (needs the z3 binary; see `speckl verify --help`)')
    .help()
    .argv;

  const file = parsed.file as string;
  const options = {
    outputDir: parsed.outputDir as string,
    bomFormat: parsed.bomFormat as 'cdx' | 'spdx' | 'both',
    target: parsed.target as CompileOptions['target'],
    verifyDepth: parsed.verifyDepth as number,
  };

  compileSpec(file, options);
  return 0;
}

export function exitProcess(code: number): never {
  process.exit(code);
}

export function reportFatal(err: unknown): never {
  console.error('Compilation failed:', err);
  process.exit(1);
}

/**
 * True when this file is the process entry.
 *
 * `node dist/index.js` and a bin symlink both put this file in argv[1]
 * (the symlink only matches after realpath). `vite-node src/index.ts`
 * rewrites argv so argv[1] is vite-node itself and the user arguments
 * start at argv[2]; that runner is an entry too. Importing this module
 * from a test is not.
 */
export function isCliEntry(entry: string | undefined = process.argv[1], self = fileURLToPath(import.meta.url)): boolean {
  if (!entry) return false;
  let entryPath: string;
  try {
    entryPath = fs.realpathSync(entry);
  } catch {
    entryPath = path.resolve(entry);
  }
  if (entryPath === self) return true;
  const base = path.basename(entryPath);
  return base === 'vite-node.mjs' || base === 'vite-node.js' || base === 'vite-node.cjs';
}

if (isCliEntry()) {
  main().then(exitProcess).catch(reportFatal);
}