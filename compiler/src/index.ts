#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { compileSpec, type CompileOptions } from './compile.js';
import { runVerify, packageVersion } from './cli-support.js';

export { runVerify };

async function main() {
  if (process.argv[2] === 'verify') {
    process.exit(runVerify(process.argv.slice(3)));
  }
  const argv = await yargs(hideBin(process.argv))
    .scriptName('speckl')
    .version(packageVersion())
    .usage('Usage:\n  $0 <file> [options]\n  $0 verify [paths..] [--depth <n>]')
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

  const file = argv.file as string;
  const options = {
    outputDir: argv.outputDir as string,
    bomFormat: argv.bomFormat as 'cdx' | 'spdx' | 'both',
    target: argv.target as CompileOptions['target'],
    verifyDepth: argv.verifyDepth as number,
  };

  compileSpec(file, options);
}

main().catch((err) => {
  console.error('Compilation failed:', err);
  process.exit(1);
});