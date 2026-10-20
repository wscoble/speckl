// The compile pipeline behind `speckl <file> -t <target>`. Kept apart from
// the CLI entry (index.ts) so tests can run it in-process.
import { expandTypeAliases } from './aliases.js';
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

export interface CompileOptions {
  outputDir: string;
  bomFormat: 'cdx' | 'spdx' | 'both';
  target: 'typescript' | 'z3' | 'rust' | 'go' | 'protobuf' | 'k8s' | 'openapi' | 'camel' | 'elm' | 'agent' | 'all' | 'all-ir';
  verifyDepth: number;
}

/** Compile one SpeckDL file to the requested target(s). Throws on invalid input. */
export function compileSpec(file: string, options: CompileOptions): void {
  console.log(`Compiling ${file}...`);
  
  // Alias references (`leaderId: ServerId`) are expanded to their targets
  // here, so every backend, IR-based or not, sees ordinary types.
  const ast = expandTypeAliases(parseSpeckFile(file));
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
      // the statement shape the Z3 generator consumes. (The legacy raw-source
      // invariant scraper has been removed.)
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
