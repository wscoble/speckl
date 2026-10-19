#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { parseSpeckFile } from './parser.js';
import { generateCycloneDX } from './generators/cyclonedx.js';
import { generateSPDX } from './generators/spdx.js';
import { generateTypeScriptStateMachine } from './generators/typescript-state-machine.js';
import { generateProtobuf } from './generators/protobuf.js';
import { generateZ3, Z3Options } from './generators/z3.js';
import type { InvariantMemberNode } from './parser.js';
import { generateZ3FromIR } from './generators/z3-from-ir.js';
import { generateRust } from './generators/rust.js';
import { generateGo } from './generators/go.js';
import { generateElm } from './generators/elm.js';
import { generateK8sCRD } from './generators/k8s-crd.js';
import { generateProvenanceFromIR } from './generators/provenance-from-ir.js';
import { lower } from './ir/lower.js';
import { generateCamel } from './generators/camel.js';
import { OpenAPITarget } from './generators/openapi.js';
import { generateAgent } from './generators/agent/index.js';
import { injectSignalActions } from './generators/agent/inject-signals.js';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

interface CompileOptions {
  outputDir: string;
  bomFormat: 'cdx' | 'spdx' | 'both';
  target: 'typescript' | 'z3' | 'rust' | 'go' | 'protobuf' | 'k8s' | 'openapi' | 'camel' | 'elm' | 'agent' | 'all' | 'all-ir';
  verifyDepth: number;
}

/**
 * `speckl verify [paths...]`: run the bundled Z3 verifier (scripts/verify-z3.mjs,
 * shipped in the package) with this compiler. Returns the verifier's exit code
 * (0 all obligations hold, 1 a failure, 2 no z3 binary).
 */
export function runVerify(args: string[], here = path.dirname(fileURLToPath(import.meta.url))): number {
  const script = path.join(here, '..', 'scripts', 'verify-z3.mjs');
  if (!fs.existsSync(script)) {
    console.error(`speckl verify: verifier not found at ${script}`);
    return 1;
  }
  const env = { ...process.env };
  const self = path.join(here, 'index.js');
  if (!env.SPECKL_BIN && fs.existsSync(self)) env.SPECKL_BIN = self;
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env });
  if (r.error) {
    console.error(`speckl verify: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

/** Version from the package.json next to dist/ (or src/), so --version works when installed. */
function packageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf-8')).version;
  } catch {
    return 'unknown';
  }
}

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

  console.log(`Compiling ${file}...`);
  
  const ast = parseSpeckFile(file);
  // Synthetic __signal_* actions are injected only for Z3 BMC (and again
  // inside the agent target). Other backends keep the source AST clean.
  const astForProof = injectSignalActions(ast);

  const speckCount = ast.specks.length;
  const memberCount = ast.specks.reduce((sum, s) => sum + s.members.length, 0);
  console.log(`AST parsed successfully: ${speckCount} speck(s), ${memberCount} member(s)`);
  
  if (!fs.existsSync(options.outputDir)) {
    fs.mkdirSync(options.outputDir, { recursive: true });
  }
  
  const irAst = lower(ast, { filePath: file, resolveImports: false });
  const isIRTarget = (t: string) => ['k8s', 'openapi', 'camel', 'all-ir'].includes(t);
  const useIR = options.target === 'all' || options.target === 'all-ir' || isIRTarget(options.target);

  // K8s CRDs
  if (options.target === 'k8s' || options.target === 'all' || options.target === 'all-ir') {
    console.log('\nGenerating Kubernetes CustomResourceDefinitions...');
    generateK8sCRD(irAst, { outputDir: options.outputDir });
  }

  // OpenAPI 3.1
  if (options.target === 'openapi' || options.target === 'all' || options.target === 'all-ir') {
    console.log('\nGenerating OpenAPI 3.1 specification...');
    new OpenAPITarget().generate(irAst, { outputDir: options.outputDir });
  }

  // Camel (camel-quarkus Java routes + processors)
  if (options.target === 'camel' || options.target === 'all' || options.target === 'all-ir') {
    console.log('\nGenerating Apache Camel (camel-quarkus) routes...');
    generateCamel(irAst, { outputDir: options.outputDir });
  }

  // Rust
  if (options.target === 'go' || options.target === 'all') {
    // go backend
    generateGo(ast, options.outputDir);
  }
  if (options.target === 'rust' || options.target === 'all') {
    console.log('\nGenerating Rust state machine...');
    generateRust(ast, options.outputDir);
  }

  // Elm
  if (options.target === 'elm' || options.target === 'all') {
    generateElm(ast, options.outputDir);
  }

  // Protobuf
  if (options.target === 'protobuf' || options.target === 'all') {
    console.log('\nGenerating protobuf schema (.proto)...');
    generateProtobuf(ast, options.outputDir);
  }

  // Provenance (core output)
  if (options.target !== 'z3' && options.target !== 'rust') {
    console.log('\nGenerating provenance graph (PROV-O JSON-LD) from IR...');
    generateProvenanceFromIR(irAst, options.outputDir);
  }

  // Z3 SMT-LIB2
  if (options.target === 'z3' || options.target === 'all') {
    console.log('\nGenerating Z3 SMT-LIB2 (IR-driven, focused on formal_spec)...');
    generateZ3FromIR(irAst, { outputDir: options.outputDir, verifyDepth: options.verifyDepth });
    console.log('\nGenerating Z3 SMT-LIB2 (AST-driven, state machine + transitions)...');
    for (const speck of astForProof.specks) {
      // Invariants are first-class AST members now; wrap their expression in
      // the statement shape the Z3 generator consumes. (Legacy raw-source
      // scraping in parseInvariantsFromSource is retired.)
      const invariants = speck.members
        .filter((m): m is InvariantMemberNode => m.type === 'invariant')
        .map((m) => ({
          type: 'invariant' as const,
          name: m.name,
          statements: [{ type: 'require' as const, expr: m.expr }],
        }));
      (speck as any)._invariants = invariants;
    }
    const z3Options: Z3Options = { verifyDepth: options.verifyDepth };
    generateZ3(astForProof, options.outputDir, z3Options);
  }

  // IR-driven Z3 for the all-ir target (formal_spec facet only)
  if (options.target === 'all-ir') {
    console.log('\nGenerating Z3 SMT-LIB2 (IR-driven, focused on formal_spec)...');
    generateZ3FromIR(irAst, { outputDir: options.outputDir, verifyDepth: options.verifyDepth });
  }

  // TypeScript state machine + BOMs
  if (options.target !== 'z3' && options.target !== 'rust') {
    console.log('\nGenerating TypeScript state machine...');
    generateTypeScriptStateMachine(ast, options.outputDir);

    if (options.bomFormat === 'cdx' || options.bomFormat === 'both') {
      console.log('\nGenerating CycloneDX BOM...');
      generateCycloneDX(ast, options.outputDir);
    }

    if (options.bomFormat === 'spdx' || options.bomFormat === 'both') {
      console.log('\nGenerating SPDX BOM...');
      generateSPDX(ast, options.outputDir);
    }
  }
  

  // Agent target (AGENTS.md + tools + hook + signal verifiers)
  if (options.target === 'agent' || options.target === 'all') {
    console.log('\nGenerating agent target (AGENTS.md, tools.json, hook, signals)...');
    // Never emit rails from an agent block that failed validation.
    const agentErrors = irAst.diagnostics.filter(d => d.level === 'error' && d.message.startsWith('agent'));
    if (agentErrors.length > 0) {
      throw new Error('agent block is invalid:\n' + agentErrors.map(d => `  ${d.speck}: ${d.message}`).join('\n'));
    }
    generateAgent(ast, { outputDir: options.outputDir, sourcePath: file });
  }

  console.log(`\nCompilation complete. Output: ${options.outputDir}/`);
}

main().catch((err) => {
  console.error('Compilation failed:', err);
  process.exit(1);
});