// tef-ir.test.ts — Verify the IR module can lower the TEF spec end-to-end.
//
// This is the architectural test: not just "does it compile" but "does
// the IR capture every facet of the TEF spec". If the IR is lossless,
// generators can be swapped out without behavioral change.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import * as path from 'path';
// __dirname = .../compiler/src/ir/__tests__
// ../parser = .../compiler/src/parser
// ../../ir/lower = .../compiler/src/ir/lower
import { parseSpeckContent } from '../../parser.js';
import { lower } from '../lower.js';

// __dirname = .../compiler/src/ir/__tests__
// TEK_DIR = .../compiler
const TEK_DIR = path.resolve(__dirname, '..', '..', '..');
const SPEC_PATH = path.join(TEK_DIR, 'examples', 'tef.speckdl');

describe('TEF IR lowering', () => {
  let ir: any;

  beforeAll(() => {
    if (!existsSync(SPEC_PATH)) {
      throw new Error(`TEF spec not found at ${SPEC_PATH}`);
    }
    const src = readFileSync(SPEC_PATH, 'utf-8');
    const ast = parseSpeckContent(src, SPEC_PATH);
    ir = lower(ast, { filePath: SPEC_PATH, resolveImports: false });
  });

  it('produces exactly one IR speck (TEF)', () => {
    expect(ir.specks).toHaveLength(1);
    expect(ir.specks[0].name).toBe('TEF');
  });

  it('captures the typed_schema facet with all 8 CRDs + cross-cutting types', () => {
    const types = ir.specks[0].facets.typed_schema.types;
    const crds = ['Customer', 'Product', 'Spec', 'Flow', 'AcceptanceContract', 'BuildJob', 'Integration', 'Evaluator'];
    for (const crd of crds) {
      expect(types.has(crd)).toBe(true);
    }
    // Cross-cutting types
    expect(types.has('Transition')).toBe(true);
    expect(types.has('Rule')).toBe(true);
    expect(types.has('BuildStep')).toBe(true);
    expect(types.has('ObjectMeta')).toBe(true);
    expect(types.has('TypeMeta')).toBe(true);
  });

  it('captures the behavior facet with 13 actions', () => {
    const actions = ir.specks[0].facets.behavior.actions;
    expect(actions.length).toBe(13);
    const actionNames = actions.map((a: any) => a.name);
    expect(actionNames).toContain('CreateCustomer');
    expect(actionNames).toContain('CreateProduct');
    expect(actionNames).toContain('ShipProduct');
    expect(actionNames).toContain('FireFlowEvent');
    expect(actionNames).toContain('CreateEvaluator');
  });

  it('captures the formal_spec facet with 8 constraints', () => {
    const constraints = ir.specks[0].facets.formal_spec.constraints;
    expect(constraints.length).toBe(8);
    const names = constraints.map((c: any) => c.name);
    expect(names).toContain('every product has a customer');
    expect(names).toContain('every buildjob references a product');
    expect(names).toContain('shipped products have a tomlPath');
  });

  it('captures the wire_format facet', () => {
    const wire = ir.specks[0].facets.wire_format;
    expect(wire.protoPackage).toBe('tef.v1alpha1');
    expect(wire.goPackage).toContain('tef-engine');
    expect(wire.eventSuffix).toBe('Request');
  });

  it('captures the resource_lifecycle facet', () => {
    const rl = ir.specks[0].facets.resource_lifecycle;
    expect(rl.conditions).toContain('Ready');
    expect(rl.conditions).toContain('CRDsEstablished');
    expect(rl.finalizers).toContain('cleanup-customer-namespaces');
    expect(rl.ownerReferences).toBe(false);
  });

  it('captures the provenance facet with all clauses', () => {
    const prov = ir.specks[0].facets.provenance;
    expect(prov.clauses.length).toBeGreaterThan(0);
    // TEF spec declares 1 parent_spec, 4 external_docs, 5 design_decisions = 10 total
    const externalDocs = prov.clauses.filter((c: any) => c.kind === 'external_doc' || c.type === 'external_doc');
    const parentSpecs = prov.clauses.filter((c: any) => c.kind === 'parent_spec' || c.type === 'parent_spec');
    const designDecisions = prov.clauses.filter((c: any) => c.kind === 'design_decision' || c.type === 'design_decision');
    expect(externalDocs.length).toBeGreaterThanOrEqual(4);
    expect(parentSpecs.length).toBeGreaterThanOrEqual(1);
    expect(designDecisions.length).toBeGreaterThanOrEqual(3);
    expect(prov.authors.map((a: any) => a.name)).toContain('wscoble');
  });

  it('captures the metadata facet', () => {
    const meta = ir.specks[0].facets.metadata;
    expect(meta.version).toBe('0.1.2');
    expect(meta.author).toBe('wscoble');
  });

  it('captures the service definition with 11 RPCs', () => {
    const services = ir.specks[0].facets.typed_schema.services;
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe('TEFService');
    // IR uses `methods` (semantic name); the protobuf generator maps to `rpcs`
    expect(services[0].methods.length).toBe(11);
  });

  it('captures all 3 enums (ProductPhase, BuildJobPhase, EvaluatorPhase)', () => {
    const types = ir.specks[0].facets.typed_schema.types;
    expect(types.has('ProductPhase')).toBe(true);
    expect(types.has('BuildJobPhase')).toBe(true);
    expect(types.has('EvaluatorPhase')).toBe(true);
  });

  it('has no IR diagnostics', () => {
    expect(ir.diagnostics.filter((d: any) => d.level === 'error')).toHaveLength(0);
  });
});
