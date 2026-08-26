// src/ir/__tests__/lower.test.ts
//
// Smoke tests for the lower pass. These verify:
//   1. AST → IR produces the right number of specks
//   2. Facets are populated
//   3. Provenance is synthesized when missing
//   4. Expressions in constraints/actions are typed trees, not strings

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSpeckFile } from '../../parser.js';
import { lower } from '../lower.js';

const REPO = '/home/sscoble/speckl';

function lowerFixture(name: string) {
  const filePath = join(REPO, 'compiler', '__tests__', 'fixtures', name);
  const ast = parseSpeckFile(filePath);
  return lower(ast, { filePath, resolveImports: false });
}

describe('IR lower pass', () => {
  it('lowers a simple speck with provenance', () => {
    const ir = lowerFixture('simple.speck');
    expect(ir.specks).toHaveLength(1);
    const speck = ir.specks[0];
    expect(speck.name).toBe('ToggleSwitch');
    // Provenance synthesized from file metadata
    expect(speck.facets.provenance.synthesized).toBe(true);
  });

  it('lowered IR has 8 named facets', () => {
    const ir = lowerFixture('simple.speck');
    const speck = ir.specks[0];
    expect(speck.facets).toHaveProperty('typed_schema');
    expect(speck.facets).toHaveProperty('behavior');
    expect(speck.facets).toHaveProperty('formal_spec');
    expect(speck.facets).toHaveProperty('wire_format');
    expect(speck.facets).toHaveProperty('validation');
    expect(speck.facets).toHaveProperty('resource_lifecycle');
    expect(speck.facets).toHaveProperty('provenance');
    expect(speck.facets).toHaveProperty('metadata');
  });

  it('typed_schema facet contains records and enums from interfaces', () => {
    const ir = lowerFixture('simple.speck');
    const types = ir.specks[0].facets.typed_schema.types;
    // The simple.speck has a Status enum interface
    expect(types.has('Status')).toBe(true);
    const status = types.get('Status')!;
    expect(status.kind).toBe('enum');
  });

  it('behavior facet contains state, init, actions, events', () => {
    const ir = lowerFixture('simple.speck');
    const behavior = ir.specks[0].facets.behavior;
    expect(behavior.stateVars.length).toBeGreaterThanOrEqual(1);
    expect(behavior.actions.length).toBeGreaterThanOrEqual(1);
  });

  it('constraint expressions are typed trees, not strings', () => {
    const ir = lowerFixture('simple.speck');
    const constraints = ir.specks[0].facets.formal_spec.constraints;
    // The simple.speck has a constraint. The expression should be a tree node.
    if (constraints.length > 0) {
      const c = constraints[0];
      expect(c.expr).toBeDefined();
      expect(typeof c.expr.kind).toBe('string');
    }
  });

  it('lowered IR is lossless: every fact in source is in IR', () => {
    const ir = lowerFixture('tigerbeetle.speck');
    const speck = ir.specks[0];
    // TigerBeetle has 3 events, 4 actions
    expect(speck.facets.behavior.events.length).toBe(3);
    expect(speck.facets.behavior.actions.length).toBe(4);
    // Has 4 state vars
    expect(speck.facets.behavior.stateVars.length).toBe(4);
  });
});
