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
import { OpenAPITarget } from './generators/openapi.js';
import { GraphQLTarget } from './generators/graphql.js';
import { SQLTarget } from './generators/sql.js';
import { JSONSchemaTarget } from './generators/json-schema.js';
import { MarkdownTarget } from './generators/markdown.js';
import { TLAPlusTarget } from './generators/tlaplus.js';
import { HelmTarget } from './generators/helm.js';
import fs from 'fs';
import path from 'path';

interface CompileOptions {
  outputDir: string;
  bomFormat: 'cdx' | 'spdx' | 'both';
  target: 'typescript' | 'z3' | 'rust' | 'protobuf' | 'k8s' | 'openapi' | 'graphql' | 'sql' | 'json-schema' | 'markdown' | 'tlaplus' | 'helm' | 'all' | 'all-ir';
  verifyDepth: number;
}

async function main() {
  // Guard: check that dist is not stale before compiling
  const checkScript = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'check-dist.sh');
  if (fs.existsSync(checkScript)) {
    try {
      const { execSync } = await import('child_process');
      execSync(`bash "${checkScript}"`, { stdio: 'inherit' });
    } catch {
      console.error('\n❌ Cannot compile with stale dist. Rebuild first.');
      process.exit(1);
    }
  }

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
          choices: ['typescript', 'z3', 'rust', 'protobuf', 'k8s', 'openapi', 'graphql', 'sql', 'json-schema', 'markdown', 'tlaplus', 'helm', 'all', 'all-ir'],
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
    target: argv.target as 'typescript' | 'z3' | 'rust' | 'protobuf' | 'k8s' | 'openapi' | 'graphql' | 'sql' | 'json-schema' | 'markdown' | 'tlaplus' | 'helm' | 'all' | 'all-ir',
    verifyDepth: argv.verifyDepth as number,
  };

  console.log(`Compiling ${file}...`);
  
  // Parse the Speck file
  const ast = parseSpeckFile(file);

  const speckCount = ast.specks.length;
  const memberCount = ast.specks.reduce((sum, s) => sum + s.members.length, 0);
  console.log(`AST parsed successfully: ${speckCount} speck(s), ${memberCount} member(s)`);
  
  // Ensure output directory exists
  if (!fs.existsSync(options.outputDir)) {
    fs.mkdirSync(options.outputDir, { recursive: true });
  }
  
  // Read raw source for invariant/next parsing that the AST parser doesn't handle yet
  const rawSource = fs.readFileSync(file, 'utf-8');

  // Build the IR once, used by IR-based targets
  const irAst = lower(ast, { filePath: file, resolveImports: false });
  const isIRTarget = (t: string) => ['k8s', 'openapi', 'graphql', 'sql', 'json-schema', 'markdown', 'tlaplus', 'helm', 'all-ir'].includes(t);
  const useIR = options.target === 'all' || options.target === 'all-ir' || isIRTarget(options.target);

  // Generate K8s CRDs (IR-based) — closes the loop on TEF CRDs
  if (options.target === 'k8s' || options.target === 'all' || options.target === 'all-ir') {
    console.log('\nGenerating Kubernetes CustomResourceDefinitions...');
    generateK8sCRD(irAst, { outputDir: options.outputDir });
  }

  // Generate OpenAPI 3.1 spec (IR-based) — REST API surface
  if (options.target === 'openapi' || options.target === 'all' || options.target === 'all-ir') {
    console.log('\nGenerating OpenAPI 3.1 specification...');
    new OpenAPITarget().generate(irAst, { outputDir: options.outputDir });
  }

  // Generate GraphQL schema (IR-based) — for frontend consumers
  if (options.target === 'graphql' || options.target === 'all' || options.target === 'all-ir') {
    console.log('\nGenerating GraphQL schema...');
    new GraphQLTarget().generate(irAst, { outputDir: options.outputDir });
  }

  // Generate SQL DDL (IR-based) — for relational persistence
  if (options.target === 'sql' || options.target === 'all' || options.target === 'all-ir') {
    console.log('\nGenerating SQL DDL...');
    new SQLTarget().generate(irAst, { outputDir: options.outputDir });
  }

  // Generate JSON Schema (IR-based) — for validation
  if (options.target === 'json-schema' || options.target === 'all' || options.target === 'all-ir') {
    console.log('\nGenerating JSON Schema 2020-12...');
    new JSONSchemaTarget().generate(irAst, { outputDir: options.outputDir });
  }

  // Generate Markdown documentation (IR-based) — for human readers
  if (options.target === 'markdown' || options.target === 'all' || options.target === 'all-ir') {
    console.log('\nGenerating Markdown documentation...');
    new MarkdownTarget().generate(irAst, { outputDir: options.outputDir });
  }

  // Generate TLA+ (IR-based) — for formal model checking
  if (options.target === 'tlaplus' || options.target === 'all' || options.target === 'all-ir') {
    console.log('\nGenerating TLA+ specification...');
    new TLAPlusTarget().generate(irAst, { outputDir: options.outputDir });
  }

  // Generate Helm chart (IR-based) — for deployment
  if (options.target === 'helm' || options.target === 'all' || options.target === 'all-ir') {
    console.log('\nGenerating Helm chart...');
    new HelmTarget().generate(irAst, { outputDir: options.outputDir });
  }
  if (options.target === 'rust' || options.target === 'all') {
    console.log('\nGenerating Rust state machine...');
    generateRust(ast, options.outputDir);
  }

  // Generate protobuf schema if target is protobuf or all
  // This is the load-bearing backend for the "no glue code" claim:
  // the emitted .proto is the canonical wire format. Run `buf generate`
  // on the output to produce Go/TS/Rust/C/Python/Java bindings.
  if (options.target === 'protobuf' || options.target === 'all') {
    console.log('\nGenerating protobuf schema (.proto)...');
    generateProtobuf(ast, options.outputDir);
  }

  // Always generate provenance (it's the core output) if not z3-only or rust-only
  // The IR-based version is preferred: it consumes the IR's resolved provenance
  // facet, which may have been synthesized from file metadata if not declared.
  if (options.target !== 'z3' && options.target !== 'rust') {
    console.log('\nGenerating provenance graph (PROV-O JSON-LD) from IR...');
    generateProvenanceFromIR(irAst, options.outputDir);
  }

  // Generate Z3 SMT-LIB2 if target is z3 or all
  if (options.target === 'z3' || options.target === 'all') {
    console.log('\nGenerating Z3 SMT-LIB2 (IR-driven, focused on formal_spec)...');
    generateZ3FromIR(irAst, { outputDir: options.outputDir, verifyDepth: options.verifyDepth });
    // Also generate the AST-based Z3 for backward compatibility
    console.log('\nGenerating Z3 SMT-LIB2 (AST-driven, state machine + transitions)...');
    // Parse invariants from raw source for Z3 backend
    for (const speck of ast.specks) {
      const invariants = parseInvariantsFromSource(rawSource, speck.name);
      const nextNode = parseNextFromSource(rawSource, speck.name);
      // Attach parsed data to the AST for the generator
      (speck as any)._invariants = invariants;
      (speck as any)._next = nextNode;
    }
    const z3Options: Z3Options = { verifyDepth: options.verifyDepth };
    generateZ3(ast, options.outputDir, z3Options);
  }

  // Generate TypeScript state machine if not z3-only or rust-only
  if (options.target !== 'z3' && options.target !== 'rust') {
    console.log('\nGenerating TypeScript state machine...');
    generateTypeScriptStateMachine(ast, options.outputDir);

    // Generate BOM based on format selection
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
