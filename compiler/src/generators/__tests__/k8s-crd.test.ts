// src/generators/__tests__/k8s-crd.test.ts
//
// Tests for the K8s CRD target generator and the T | null nullable
// type lowering. The CRD generator must:
//   - Detect CRD roots (types with both `<Kind>Spec` and `<Kind>Status`)
//   - Emit valid CustomResourceDefinition YAML
//   - Use only the K8s-allowed metadata properties (name, generateName)
//   - Not add any custom extensions (K8s strict mode rejects them)
//
// The nullable lowering must:
//   - Parse `T | null` syntax in TypeExpr
//   - Propagate the `nullable` flag to the IR's IRTypeRef
//   - Be handled by the openapi generator (as `type: ['T', 'null']`)

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { parseSpeckFile } from '../../parser.js';
import { lower } from '../../ir/lower.js';
import { generateK8sCRD } from '../k8s-crd.js';
import { OpenAPITarget } from '../openapi.js';

const REPO = '/home/sscoble/speckl';

function compileCRDs(name: string): string {
  const filePath = join(REPO, 'examples', name);
  const ast = parseSpeckFile(filePath);
  const ir = lower(ast, { filePath, resolveImports: false });

  const tmp = mkdtempSync(join(tmpdir(), 'speckl-k8s-'));
  try {
    generateK8sCRD(ir, { outputDir: tmp });
    return readFileSync(join(tmp, 'k8s', 'all-crds.yaml'), 'utf-8');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('K8s CRD target', () => {
  it('emits valid CustomResourceDefinition YAML for TEF (all 8 CRDs)', () => {
    const yaml = compileCRDs('tef.speckdl');

    // Should have 8 CRDs separated by `\n---\n` (js-yaml default for multi-doc)
    const docs = yaml.split(/\n---\n/).filter(d => d.includes('CustomResourceDefinition'));
    expect(docs.length).toBeGreaterThanOrEqual(8);

    // Each doc must have the right top-level shape
    expect(yaml).toContain('apiVersion: apiextensions.k8s.io/v1');
    expect(yaml).toContain('kind: CustomResourceDefinition');
    expect(yaml).toContain('group: tef.scoble.me');
    expect(yaml).toContain('- name: v1alpha1');

    // All 8 CRD names must be present
    for (const crd of [
      'customers.tef.scoble.me',
      'products.tef.scoble.me',
      'specs.tef.scoble.me',
      'flows.tef.scoble.me',
      'acceptancecontracts.tef.scoble.me',
      'buildjobs.tef.scoble.me',
      'integrations.tef.scoble.me',
      'evaluators.tef.scoble.me',
    ]) {
      expect(yaml).toContain(`name: ${crd}`);
    }
  });

  it('CRD metadata only includes name and generateName (K8s constraint)', () => {
    const yaml = compileCRDs('tef.speckdl');
    // The metadata block under openAPIV3Schema must only have name and generateName
    // (K8s strict mode rejects namespace, labels, annotations, etc.)
    expect(yaml).toContain('generateName:');
    // We should NOT have a `namespace:` field inside the CRD metadata schema
    // (it's there in the spec metadata but not in the schema definition)
    const matches = yaml.match(/metadata:\s*\n\s*type: object\s*\n\s*properties:\s*\n\s*name:[\s\S]*?spec:/);
    if (matches) {
      const metadataBlock = matches[0];
      expect(metadataBlock).not.toContain('namespace:');
      expect(metadataBlock).not.toContain('labels:');
    }
  });

  it('CRD does not include x-speckl-nullable or any custom extensions', () => {
    // K8s CRD strict mode rejects unknown fields. The K8s generator
    // should not emit any custom x- extensions for nullable.
    const yaml = compileCRDs('tef.speckdl');
    expect(yaml).not.toContain('x-speckl-nullable');
  });

  it('detects CRD roots from the <Kind>Spec + <Kind>Status pattern', () => {
    const yaml = compileCRDs('tef.speckdl');
    // Each CRD should have a `spec:` (not be the kind itself) and a status subresource
    expect(yaml).toContain('subresources:\n        status: {}');
  });
});

describe('Nullable type lowering (T | null)', () => {
  it('parses `String | null` as a nullable primitive', () => {
    const src = `
speck NullableTest {
  k8s_group: "test.example.com"
  k8s_version: "v1alpha1"
  type Foo = {
    name: String,
    description: String | null
  }
  type FooSpec = { value: String }
  type FooStatus = { ok: Bool }
}
`;
    const ir = lowerFromContent(src);
    const foo = ir.specks[0].facets.typed_schema.types.get('Foo') as any;
    const descField = foo.fields.find((f: any) => f.name === 'description');
    expect(descField.type.nullable).toBe(true);
    expect(descField.type.kind).toBe('primitive');
    expect(descField.type.primitive).toBe('String');

    const nameField = foo.fields.find((f: any) => f.name === 'name');
    expect(nameField.type.nullable).toBeFalsy();
  });

  it('parses `List<T> | null` as a nullable list', () => {
    const src = `
speck NullableListTest {
  k8s_group: "test.example.com"
  k8s_version: "v1alpha1"
  type Foo = {
    tags: List<String> | null
  }
  type FooSpec = { value: String }
  type FooStatus = { ok: Bool }
}
`;
    const ir = lowerFromContent(src);
    const foo = ir.specks[0].facets.typed_schema.types.get('Foo') as any;
    const tagsField = foo.fields.find((f: any) => f.name === 'tags');
    expect(tagsField.type.nullable).toBe(true);
    expect(tagsField.type.kind).toBe('list');
    expect(tagsField.type.elementType.kind).toBe('primitive');
    expect(tagsField.type.elementType.primitive).toBe('String');
  });

  it('parses `NamedType | null` as a nullable ident', () => {
    const src = `
speck NullableIdentTest {
  k8s_group: "test.example.com"
  k8s_version: "v1alpha1"
  enum Status { Active, Inactive }
  type Foo = {
    status: Status | null
  }
  type FooSpec = { value: String }
  type FooStatus = { ok: Bool }
}
`;
    const ir = lowerFromContent(src);
    const foo = ir.specks[0].facets.typed_schema.types.get('Foo') as any;
    const statusField = foo.fields.find((f: any) => f.name === 'status');
    expect(statusField.type.nullable).toBe(true);
    expect(statusField.type.kind).toBe('ident');
    expect(statusField.type.name).toBe('Status');
  });
});

describe('OpenAPI 3.1 nullable', () => {
  it('emits type: ["T", "null"] for nullable fields', () => {
    const src = `
speck OpenAPINullable {
  k8s_group: "test.example.com"
  k8s_version: "v1alpha1"
  type Foo = {
    name: String,
    description: String | null
  }
  type FooSpec = { value: String }
  type FooStatus = { ok: Bool }
}
`;
    const ir = lowerFromContent(src);
    const tmp = mkdtempSync(join(tmpdir(), 'speckl-oapi-'));
    try {
      new OpenAPITarget().generate(ir, { outputDir: tmp });
      const oapiFile = join(tmp, 'openapi', 'openapinullable.openapi.json');
      expect(existsSync(oapiFile)).toBe(true);
      const content = JSON.parse(readFileSync(oapiFile, 'utf-8'));
      const fooSchema = content.components.schemas.Foo;
      expect(fooSchema.properties.description.type).toEqual(['string', 'null']);
      expect(fooSchema.properties.name.type).toBe('string');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Helper: parse SpeckDL content directly (not from file)
import { parseSpeckContent } from '../../parser.js';
import { writeFileSync } from 'fs';

function lowerFromContent(src: string) {
  const filePath = '/tmp/speckl-test.speckdl';
  writeFileSync(filePath, src);
  const ast = parseSpeckFile(filePath);
  return lower(ast, { filePath, resolveImports: false });
}
