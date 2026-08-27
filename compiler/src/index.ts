#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { parseSpeckFile } from './parser.js';
import { generateCycloneDX } from './generators/cyclonedx.js';
import { generateSPDX } from './generators/spdx.js';
import { generateTypeScriptStateMachine } from './generators/typescript-state-machine.js';
import { generateProtobuf } from './generators/protobuf.js';
import { generateZ3, Z3Options, parseInvariantsFromSource, parseNextFromSource } from './generators/z3.js';
import { generateZ3FromIR } from './generators/z3-from-ir.js';
import { generateRust } from './generators/rust.js';
import { generateK8sCRD } from './generators/k8s-crd.js';
import { generateProvenanceFromIR } from './generators/provenance-from-ir.js';
import { lower } from './ir/lower.js';
import { generateCamel } from './generators/camel.js';
import { OpenAPITarget } from './generators/openapi.js';
import fs from 'fs';
import path from 'path';

interface CompileOptions {
  outputDir: string;
  bomFormat: 'cdx' | 'spdx' | 'both';
  target: 'typescript' | 'z3' | 'rust' | 'protobuf' | 'k8s' | 'openapi' | 'camel' | 'all' | 'all-ir';
  verifyDepth: number;
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
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
          choices: ['typescript', 'z3', 'rust', 'protobuf', 'k8s', 'openapi', 'camel', 'all', 'all-ir'],
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

  const speckCount = ast.specks.length;
  const memberCount = ast.specks.reduce((sum, s) => sum + s.members.length, 0);
  console.log(`AST parsed successfully: ${speckCount} speck(s), ${memberCount} member(s)`);
  
  if (!fs.existsSync(options.outputDir)) {
    fs.mkdirSync(options.outputDir, { recursive: true });
  }
  
  const rawSource = fs.readFileSync(file, 'utf-8');

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
  if (options.target === 'rust' || options.target === 'all') {
    console.log('\nGenerating Rust state machine...');
    generateRust(ast, options.outputDir);
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
    for (const speck of ast.specks) {
      const invariants = parseInvariantsFromSource(rawSource, speck.name);
      const nextNode = parseNextFromSource(rawSource, speck.name);
      (speck as any)._invariants = invariants;
      (speck as any)._next = nextNode;
    }
    const z3Options: Z3Options = { verifyDepth: options.verifyDepth };
    generateZ3(ast, options.outputDir, z3Options);
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
  
  console.log(`\nCompilation complete. Output: ${options.outputDir}/`);
}

main().catch((err) => {
  console.error('Compilation failed:', err);
  process.exit(1);
});