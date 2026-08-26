// src/generators/__tests__/provenance-from-ir.test.ts
//
// Tests for the IR-driven PROV-O JSON-LD generator. The IR-based generator
// must produce a richer, more complete graph than the AST-based one:
//   - Authors as separate prov:Agent entities
//   - Clauses (regulations, design decisions, etc.) as separate entities
//   - Synthesized flag carried as a custom property
//   - Review policy as a custom property
//   - Sources as entities with their kind
//   - Derives/Satisfies as proper PROV-O relations
//   - BOM metadata when present
//
// The IR's provenance facet is always populated (synthesized if missing
// from source), so the IR-based generator is more reliable than the
// AST-based one which depends on the source declaring everything.

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { parseSpeckFile } from '../../parser.js';
import { lower } from '../../ir/lower.js';
import { generateProvenanceFromIR } from '../provenance-from-ir.js';
import { writeFileSync } from 'fs';

const REPO = '__dirname/../..';

function lowerFromContent(src: string) {
  const filePath = '/tmp/speckl-prov-test.speckdl';
  writeFileSync(filePath, src);
  const ast = parseSpeckFile(filePath);
  return lower(ast, { filePath, resolveImports: false });
}

function runIR(ir: any, tmpDir: string): any {
  generateProvenanceFromIR(ir, tmpDir);
  // Find the .prov.jsonld file (one per speck in the IR)
  const speckName = ir.specks[0].name;
  const file = join(tmpDir, `${speckName}.prov.jsonld`);
  return JSON.parse(readFileSync(file, 'utf-8'));
}

describe('IR-driven PROV-O generator', () => {
  it('includes synthesized flag and review policy on the root entity', () => {
    const src = `
speck SynthTest {
  author: "alice"
  review: manual
  source: conversation ref "design-meeting-2026-07-19"
}
`;
    const ir = lowerFromContent(src);
    const tmp = mkdtempSync(join(tmpdir(), 'speckl-prov-'));
    try {
      const graph = runIR(ir, tmp);
      const root = graph['@graph'].find((e: any) => e['@id'] === 'speck:SynthTest');
      expect(root).toBeDefined();
      expect(root).toHaveProperty('speckl:synthesized');
      expect(root).toHaveProperty('speckl:review', 'manual');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('emits authors as separate prov:Agent entities', () => {
    const src = `
speck AuthorTest {
  author: "Scott Scoble" <"scott@scoble.me">
  review: manual
}
`;
    const ir = lowerFromContent(src);
    const tmp = mkdtempSync(join(tmpdir(), 'speckl-prov-'));
    try {
      const graph = runIR(ir, tmp);
      const agents = graph['@graph'].filter((e: any) => e['@type'] === 'prov:Agent');
      expect(agents.length).toBeGreaterThan(0);
      const scott = agents.find((a: any) => a['foaf:name'] === 'Scott Scoble');
      expect(scott).toBeDefined();
      expect(scott).toHaveProperty('foaf:mbox', 'scott@scoble.me');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('emits design decisions as separate entities', () => {
    const src = `
speck DDTest {
  author: "alice"
  review: manual
  provenance {
    design_decision "Use event sourcing for audit trail"
    design_decision "Backed by Postgres for transactional guarantees"
  }
}
`;
    const ir = lowerFromContent(src);
    const tmp = mkdtempSync(join(tmpdir(), 'speckl-prov-'));
    try {
      const graph = runIR(ir, tmp);
      const decisions = graph['@graph'].filter((e: any) => e['dct:type'] === 'design_decision');
      expect(decisions.length).toBe(2);
      const labels = decisions.map((d: any) => d['rdfs:label']);
      expect(labels).toContain('Use event sourcing for audit trail');
      expect(labels).toContain('Backed by Postgres for transactional guarantees');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('emits parent_spec as wasDerivedFrom relation', () => {
    const src = `
speck ChildSpec {
  author: "alice"
  review: manual
  provenance {
    parent_spec "ParentSpec"
  }
}
`;
    const ir = lowerFromContent(src);
    const tmp = mkdtempSync(join(tmpdir(), 'speckl-prov-'));
    try {
      const graph = runIR(ir, tmp);
      const derivations = graph['@graph'].filter((e: any) => e['@type'] === 'prov:wasDerivedFrom');
      expect(derivations.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('emits regulations as usage entities', () => {
    const src = `
speck RegTest {
  author: "alice"
  review: manual
  provenance {
    regulation "GDPR Article 17"
    regulation "HIPAA Security Rule"
  }
}
`;
    const ir = lowerFromContent(src);
    const tmp = mkdtempSync(join(tmpdir(), 'speckl-prov-'));
    try {
      const graph = runIR(ir, tmp);
      const regs = graph['@graph'].filter((e: any) => e['dct:type'] === 'regulation');
      expect(regs.length).toBe(2);
      const labels = regs.map((r: any) => r['rdfs:label']);
      expect(labels).toContain('GDPR Article 17');
      expect(labels).toContain('HIPAA Security Rule');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('emits sources as entities with their kind', () => {
    const src = `
speck SourceTest {
  author: "alice"
  review: manual
  source: meeting ref "team-sync-2026-07-15"
  source: regulation ref "GDPR"
}
`;
    const ir = lowerFromContent(src);
    const tmp = mkdtempSync(join(tmpdir(), 'speckl-prov-'));
    try {
      const graph = runIR(ir, tmp);
      const sources = graph['@graph'].filter((e: any) => e['speckl:sourceKind']);
      expect(sources.length).toBe(2);
      const kinds = sources.map((s: any) => s['speckl:sourceKind']);
      expect(kinds).toContain('meeting');
      expect(kinds).toContain('regulation');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handles synthesized provenance (no source declaration) gracefully', () => {
    // The IR's lower pass synthesizes provenance from file metadata
    // when none is declared. The generator must still emit a valid
    // graph with the synthesized flag set.
    const src = `
speck SynthOnly {
  // no provenance block, no sources, no authors at speck level
}
`;
    const ir = lowerFromContent(src);
    const tmp = mkdtempSync(join(tmpdir(), 'speckl-prov-'));
    try {
      const graph = runIR(ir, tmp);
      const root = graph['@graph'].find((e: any) => e['@id'] === 'speck:SynthOnly');
      expect(root).toBeDefined();
      expect(root['speckl:synthesized']).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('produces valid PROV-O JSON-LD structure for TEF (real spec)', () => {
    // The TEF spec has 8 CRDs, multiple authors, many clauses.
    // The IR-driven generator should produce a graph with all of them.
    const ast = parseSpeckFile(join(REPO, 'examples', 'tef.speckdl'));
    const ir = lower(ast, { filePath: join(REPO, 'examples', 'tef.speckdl'), resolveImports: false });
    const tmp = mkdtempSync(join(tmpdir(), 'speckl-prov-'));
    try {
      const graph = runIR(ir, tmp);

      // JSON-LD structure
      expect(graph['@context']).toBeDefined();
      expect(graph['@context']['prov']).toBe('http://www.w3.org/ns/prov#');
      expect(graph['@graph']).toBeDefined();

      // Root entity
      const root = graph['@graph'].find((e: any) => e['@id'] === 'speck:TEF');
      expect(root).toBeDefined();

      // Authors
      const agents = graph['@graph'].filter((e: any) => e['@type'] === 'prov:Agent');
      expect(agents.length).toBeGreaterThan(0);

      // Design decisions
      const decisions = graph['@graph'].filter((e: any) => e['dct:type'] === 'design_decision');
      expect(decisions.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
