// src/generators/provenance-from-ir.ts
//
// IR-driven PROV-O JSON-LD provenance graph generator. Consumes the
// IR's `provenance` facet (which is non-optional and may be synthesized
// from file metadata if not declared) plus `metadata` for author/license
// fallback. Produces a richer, more complete PROV-O graph than the AST
// version because the IR is the source of truth.
//
// The AST version (provenance.ts) walks member nodes and can miss data
// that the lower pass synthesized (e.g. author/license from speck
// metadata when no `author:` member was declared). The IR version reads
// the IR's already-resolved provenance facet, which is always populated.
//
// Output: <outputDir>/<SpeckName>.prov.jsonld
//   - One .jsonld file per speck in the input
//   - JSON-LD format, can be loaded by any PROV-O tooling
//   - The graph includes: entity, agents, activities, sources, derives,
//     satisfies, design decisions, regulations, parent specs, external docs,
//     BOM metadata, and review policy.

import * as fs from 'fs';
import * as path from 'path';
import { IR, IRSpeck, ProvenanceClause, Author, Source, SourceKind } from '../ir/types.js';

export function generateProvenanceFromIR(ir: IR, outputDir: string): void {
  for (const speck of ir.specks) {
    const graph = renderProvGraph(speck);
    const filename = path.join(outputDir, `${speck.name}.prov.jsonld`);
    fs.writeFileSync(filename, JSON.stringify(graph, null, 2));
    console.log(`Generated provenance: ${filename}`);
  }
}

function renderProvGraph(speck: IRSpeck): any {
  const prov = speck.facets.provenance;
  const graph: any[] = [];

  // Root entity
  graph.push({
    '@type': 'prov:Entity',
    '@id': `speck:${speck.name}`,
    'rdfs:label': speck.name,
    'rdfs:comment': prov.clauses
      .filter((c) => c.kind === 'design_decision')
      .map((c) => (c as any).value)
      .join('; ') || speck.name,
    'prov:wasGeneratedBy': {
      '@type': 'prov:Activity',
      '@id': `speck:${speck.name}:compile`,
      'prov:startTime': new Date().toISOString(),
      'prov:used': `speck:${speck.name}:source`,
    },
    // Carry the synthesized flag as a custom property — tooling can use
    // this to know whether the provenance was declared or synthesized.
    'speckl:synthesized': prov.synthesized,
    // Review policy is a facet-level concern
    'speckl:review': prov.review,
  });

  // Authors as agents
  for (const author of prov.authors) {
    graph.push({
      '@type': 'prov:Agent',
      '@id': `agent:${slug(author.name)}`,
      'foaf:name': author.name,
      ...(author.email ? { 'foaf:mbox': author.email } : {}),
    });
    graph.push({
      '@type': 'prov:Attribution',
      '@id': `attribution:${speck.name}:${slug(author.name)}`,
      'prov:agent': `agent:${slug(author.name)}`,
      'prov:entity': `speck:${speck.name}`,
    });
  }

  // Sources as entities with their kinds
  for (const source of prov.sources) {
    graph.push({
      '@type': 'prov:Entity',
      '@id': `source:${speck.name}:${graph.length}`,
      'speckl:sourceKind': source.kind,
      ...(source.ref ? { 'dct:identifier': source.ref } : {}),
    });
  }

  // Clauses: regulations, design decisions, parent specs, external docs
  for (const clause of prov.clauses) {
    switch (clause.kind) {
      case 'regulation':
        graph.push({
          '@type': 'prov:Entity',
          '@id': `regulation:${slug(clause.value)}`,
          'dct:type': 'regulation',
          'rdfs:label': clause.value,
        });
        graph.push({
          '@type': 'prov:Usage',
          'prov:entity': `regulation:${slug(clause.value)}`,
          'prov:activity': `speck:${speck.name}:compile`,
        });
        break;
      case 'design_decision':
        // Already captured as rdfs:comment on the root entity; add as
        // a separate entity for fine-grained queries.
        graph.push({
          '@type': 'prov:Entity',
          '@id': `decision:${speck.name}:${graph.length}`,
          'dct:type': 'design_decision',
          'rdfs:label': clause.value,
        });
        break;
      case 'parent_spec':
        graph.push({
          '@type': 'prov:Entity',
          '@id': `parent-spec:${slug(clause.value)}`,
          'dct:type': 'parent_spec',
          'rdfs:label': clause.value,
        });
        graph.push({
          '@type': 'prov:wasDerivedFrom',
          'prov:generatedEntity': `speck:${speck.name}`,
          'prov:usedEntity': `parent-spec:${slug(clause.value)}`,
        });
        break;
      case 'external_doc':
        graph.push({
          '@type': 'prov:Entity',
          '@id': `external-doc:${slug(clause.value)}`,
          'dct:type': 'external_doc',
          'rdfs:label': clause.value,
          ...(clause.location ? { 'prov:value': clause.location } : {}),
        });
        break;
    }
  }

  // Derives (PROV-O wasDerivedFrom)
  if (prov.derives) {
    graph.push({
      '@type': 'prov:wasDerivedFrom',
      'prov:generatedEntity': `speck:${speck.name}`,
      'prov:usedEntity': `parent-spec:${slug(prov.derives.from)}`,
      ...(prov.derives.via ? { 'prov:hadRole': prov.derives.via } : {}),
    });
  }

  // Satisfies
  if (prov.satisfies) {
    graph.push({
      '@type': 'prov:Entity',
      '@id': `requirement:${slug(prov.satisfies.requirement)}`,
      'dct:type': 'requirement',
      'rdfs:label': prov.satisfies.requirement,
    });
    graph.push({
      '@type': 'prov:Attribution',
      'prov:entity': `speck:${speck.name}`,
      'prov:agent': `requirement:${slug(prov.satisfies.requirement)}`,
      ...(prov.satisfies.clause
        ? { 'prov:hadRole': prov.satisfies.clause }
        : {}),
    });
  }

  // BOM metadata
  if (prov.bom) {
    const bom = prov.bom;
    graph.push({
      '@type': 'prov:Entity',
      '@id': `bom:${speck.name}`,
      'dct:type': 'bom',
      ...(bom.compiler
        ? { 'speckl:compiler': `${bom.compiler.name}@${bom.compiler.version || '?'}` }
        : {}),
      ...(bom.solver
        ? { 'speckl:solver': `${bom.solver.name}@${bom.solver.version || '?'}` }
        : {}),
      ...(bom.runtime
        ? { 'speckl:runtime': `${bom.runtime.name}@${bom.runtime.version || '?'}` }
        : {}),
      ...(bom.license ? { 'spdx:license': bom.license } : {}),
      ...(bom.hash ? { 'spdx:checksum': bom.hash } : {}),
    });
  }

  // ── Per-event, per-interface, per-constraint, per-verify entities ──
  // Issue #59: The PROV-O graph was shallow — only top-level entities.
  // Now emit one prov:Entity per event, interface (typed schema type),
  // constraint, and verify block, each linked to the parent speck via
  // prov:wasDerivedFrom. This gives fine-grained provenance traceability
  // for every element in the spec.

  const parentId = `speck:${speck.name}`;

  // Events
  for (const event of speck.facets.behavior.events) {
    const entityId = `event:${speck.name}:${slug(event.name)}`;
    graph.push({
      '@type': 'prov:Entity',
      '@id': entityId,
      'rdfs:label': event.name,
      'speckl:kind': 'event',
      ...(event.fields.length > 0
        ? { 'speckl:fields': event.fields.map(f => f.name).join(', ') }
        : {}),
    });
    graph.push({
      '@type': 'prov:wasDerivedFrom',
      'prov:generatedEntity': entityId,
      'prov:usedEntity': parentId,
    });
  }

  // Interfaces / types (typed schema)
  for (const [typeName, typeDef] of speck.facets.typed_schema.types) {
    const entityId = `type:${speck.name}:${slug(typeName)}`;
    graph.push({
      '@type': 'prov:Entity',
      '@id': entityId,
      'rdfs:label': typeName,
      'speckl:kind': typeDef.kind,
      ...(typeDef.kind === 'record' && (typeDef as any).fields?.length > 0
        ? { 'speckl:fields': (typeDef as any).fields.map((f: any) => f.name).join(', ') }
        : {}),
      ...(typeDef.kind === 'enum' && (typeDef as any).variants?.length > 0
        ? { 'speckl:variants': (typeDef as any).variants.join(', ') }
        : {}),
    });
    graph.push({
      '@type': 'prov:wasDerivedFrom',
      'prov:generatedEntity': entityId,
      'prov:usedEntity': parentId,
    });
  }

  // Constraints
  for (let i = 0; i < speck.facets.formal_spec.constraints.length; i++) {
    const constraint = speck.facets.formal_spec.constraints[i];
    const constraintName = constraint.name || `constraint_${i + 1}`;
    const entityId = `constraint:${speck.name}:${slug(constraintName)}`;
    graph.push({
      '@type': 'prov:Entity',
      '@id': entityId,
      'rdfs:label': constraintName,
      'speckl:kind': 'constraint',
    });
    graph.push({
      '@type': 'prov:wasDerivedFrom',
      'prov:generatedEntity': entityId,
      'prov:usedEntity': parentId,
    });
  }

  // Verifies
  for (let i = 0; i < speck.facets.formal_spec.verifies.length; i++) {
    const verify = speck.facets.formal_spec.verifies[i];
    const verifyName = verify.name || `verify_${i + 1}`;
    const entityId = `verify:${speck.name}:${slug(verifyName)}`;
    graph.push({
      '@type': 'prov:Entity',
      '@id': entityId,
      'rdfs:label': verifyName,
      'speckl:kind': 'verify',
      ...(verify.depth != null ? { 'speckl:depth': verify.depth } : {}),
    });
    graph.push({
      '@type': 'prov:wasDerivedFrom',
      'prov:generatedEntity': entityId,
      'prov:usedEntity': parentId,
    });
  }

  return {
    '@context': {
      'prov': 'http://www.w3.org/ns/prov#',
      'speckl': 'https://speckl.scoble.me/ns/v0.3#',
      'rdfs': 'http://www.w3.org/2000/01/rdf-schema#',
      'foaf': 'http://xmlns.com/foaf/0.1/',
      'dct': 'http://purl.org/dc/terms/',
      'spdx': 'http://spdx.org/rdf/terms#',
    },
    '@graph': graph,
  };
}

/** Make a URL-safe slug for use in `@id` URIs. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
