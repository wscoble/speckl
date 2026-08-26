// k8s-crd.ts — Kubernetes CustomResourceDefinition target.
//
// Consumes the IR's typed_schema + resource_lifecycle + wire_format
// facets to emit K8s CustomResourceDefinition YAML for every CRD type
// declared in the spec.
//
// A "CRD type" is identified by a naming convention: a type whose
// name matches a known CRD kind list (configurable) OR a type whose
// name ends in "Spec"/"Status" and is referenced from a CRD-kind
// type. The generator emits one CRD per top-level CRD-kind type.
//
// Output: <outputDir>/k8s/<plural>.<group>.yaml — one file per CRD.
//
// Wire format: YAML with `---` separators between CRDs (multi-doc).
// Matches `kubectl apply -f -` expectations.
//
// See OB1 #3642 for the architecture rationale.

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { IR, IRRecordType, IRFieldDef, IRTypeRef, IRSpeck, IRFacets, IREnumType } from '../ir/types.js';

/**
 * The K8s CRD target options.
 */
export interface K8sCRDOptions {
  /** Output directory. */
  outputDir: string;
  /**
   * Override the API group. If not specified, derived from the speck
   * `k8sGroup` metadata, or from the first segment of `protoPackage`.
   */
  group?: string;
  /**
   * Override the API version. If not specified, derived from the speck
   * `k8sVersion` metadata, or from the second segment of `protoPackage`.
   */
  version?: string;
  /**
   * CRD kinds to emit. If not specified, every type with a "Spec" sibling
   * is treated as a CRD kind (heuristic: types named like "Foo" with
   * "FooSpec" and "FooStatus" are CRD roots).
   */
  crdKinds?: string[];
  /**
   * Whether to emit all spec types as fields, or only those referenced
   * from CRD Spec/Status types. Default: true (emit all).
   */
  emitAllTypes?: boolean;
}

/**
 * Generate K8s CRD YAML for every CRD type in the IR.
 * Returns the multi-doc YAML string and writes to disk.
 */
export function generateK8sCRD(ir: IR, options: K8sCRDOptions): string {
  const outputDir = options.outputDir;
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const k8sDir = path.join(outputDir, 'k8s');
  if (!fs.existsSync(k8sDir)) {
    fs.mkdirSync(k8sDir, { recursive: true });
  }

  // Collect all docs (one per CRD) into a single multi-doc YAML string
  const docs: string[] = [];

  for (const speck of ir.specks) {
    const group = options.group
      || (speck as any).k8sGroup
      || deriveGroup(speck);
    const version = options.version
      || (speck as any).k8sVersion
      || deriveVersion(speck);

    const crdKinds = options.crdKinds || detectCRDKinds(speck);

    for (const kind of crdKinds) {
      const doc = renderCRD(speck, kind, group, version);
      if (doc) {
        docs.push(doc);
        // Also write each CRD as its own file for `kubectl apply -f`
        const plural = pluralize(kind.toLowerCase());
        const filename = path.join(k8sDir, `${plural}.${group}.yaml`);
        fs.writeFileSync(filename, doc);
        console.log(`Generated K8s CRD: ${filename}`);
      }
    }
  }

  // Multi-doc YAML output
  const multiDoc = docs.join('\n---\n') + '\n';
  const multiFile = path.join(k8sDir, 'all-crds.yaml');
  fs.writeFileSync(multiFile, multiDoc);
  console.log(`Generated K8s CRD bundle: ${multiFile}`);

  return multiDoc;
}

/**
 * Detect which types are CRD roots. A type is a CRD root if:
 *   1. It has both a `<Kind>Spec` and `<Kind>Status` companion type, AND
 *   2. The Spec and Status are themselves record types.
 *
 * This matches the K8s pattern: every CRD has a spec (desired state) and
 * status (observed state) subresource.
 */
function detectCRDKinds(speck: IRSpeck): string[] {
  const types = speck.facets.typed_schema.types;
  const kinds: string[] = [];
  for (const [name, type] of types.entries()) {
    if (type.kind !== 'record') continue;
    const specName = `${name}Spec`;
    const statusName = `${name}Status`;
    if (types.has(specName) && types.has(statusName)) {
      kinds.push(name);
    }
  }
  return kinds;
}

function deriveGroup(speck: IRSpeck): string {
  const protoPackage = (speck as any).protoPackage;
  if (protoPackage) {
    // "tef.v1alpha1" → "tef.scoble.me" (default heuristic)
    const seg = protoPackage.split('.')[0];
    if (seg) return `${seg}.scoble.me`;
  }
  return 'example.com';
}

function deriveVersion(speck: IRSpeck): string {
  const protoPackage = (speck as any).protoPackage;
  if (protoPackage) {
    const segs = protoPackage.split('.');
    if (segs.length > 1) return segs[segs.length - 1];
  }
  return 'v1alpha1';
}

/**
 * Render a single CRD as a YAML string.
 */
function renderCRD(
  speck: IRSpeck,
  kind: string,
  group: string,
  version: string
): string | null {
  const types = speck.facets.typed_schema.types;
  const specType = types.get(`${kind}Spec`);
  const statusType = types.get(`${kind}Status`);
  if (!specType || !statusType) return null;

  const specSchema = recordToOpenAPISchema(speck, specType as IRRecordType);
  const statusSchema = recordToOpenAPISchema(speck, statusType as IRRecordType);

  // Collect required fields from the spec type
  const required = (specType as IRRecordType).fields
    .filter((f) => !f.optional)
    .map((f) => f.name);

  // Build provenance annotations from the speck's provenance
  const prov = speck.facets.provenance;
  const description = prov.clauses
    .filter((c: any) => c.kind === 'design_decision' || c.type === 'design_decision')
    .slice(0, 1)
    .map((c: any) => c.value)
    .join('; ');

  const crd = {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: {
      name: `${pluralize(kind.toLowerCase())}.${group}`,
      annotations: {
        'speckl.scoble.me/spec': speck.name,
        'speckl.scoble.me/version': speck.facets.metadata.version || '0.0.0',
        ...(description ? { 'speckl.scoble.me/description': description } : {}),
      },
    },
    spec: {
      group,
      names: {
        kind,
        listKind: `${kind}List`,
        singular: kind.toLowerCase(),
        plural: pluralize(kind.toLowerCase()),
      },
      scope: 'Namespaced',
      versions: [
        {
          name: version,
          served: true,
          storage: true,
          subresources: {
            status: {},
          },
          additionalPrinterColumns: printerColumnsFor(speck, kind),
          schema: {
            openAPIV3Schema: {
              type: 'object',
              properties: {
                apiVersion: { type: 'string' },
                kind: { type: 'string' },
                // K8s CRD openAPIV3Schema forbids specifying metadata
                // properties other than `name` and `generateName`.
                // See: https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/#specifying-a-structural-schema
                metadata: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    generateName: { type: 'string' },
                  },
                },
                spec: {
                  type: 'object',
                  required: required,
                  properties: specSchema.properties,
                },
                status: {
                  type: 'object',
                  properties: statusSchema.properties,
                },
              },
            },
          },
        },
      ],
    },
  };

  return yaml.dump(crd, { indent: 2, noRefs: true, sortKeys: false });
}

/**
 * Convert an IR record type to an OpenAPI v3 schema object.
 */
function recordToOpenAPISchema(
  speck: IRSpeck,
  record: IRRecordType
): { type: string; properties: Record<string, any> } {
  const properties: Record<string, any> = {};
  for (const field of record.fields) {
    properties[field.name] = typeRefToOpenAPISchema(speck, field.type, field);
  }
  return { type: 'object', properties };
}

/**
 * Convert an IR type reference to an OpenAPI v3 schema fragment.
 */
function typeRefToOpenAPISchema(
  speck: IRSpeck,
  typeRef: IRTypeRef,
  field: IRFieldDef
): any {
  let schema: any;
  if (typeRef.kind === 'primitive') {
    schema = primitiveToOpenAPISchema(typeRef.primitive || 'string');
  } else if (typeRef.kind === 'list' || typeRef.kind === 'set') {
    schema = {
      type: 'array',
      items: typeRefToOpenAPISchema(speck, typeRef.elementType!, field),
    };
  } else if (typeRef.kind === 'map') {
    schema = {
      type: 'object',
      additionalProperties: typeRefToOpenAPISchema(
        speck,
        typeRef.valueType!,
        field
      ),
    };
  } else if (typeRef.kind === 'ident') {
    // Reference to a named type
    const namedType = speck.facets.typed_schema.types.get(typeRef.name || '');
    if (!namedType) {
      schema = { type: 'object' };
    } else if (namedType.kind === 'enum') {
      schema = {
        type: 'string',
        enum: (namedType as IREnumType).variants,
      };
    } else if (namedType.kind === 'record') {
      schema = recordToOpenAPISchema(speck, namedType as IRRecordType);
    } else if (namedType.kind === 'alias') {
      schema = typeRefToOpenAPISchema(speck, (namedType as any).target, field);
    } else {
      schema = { type: 'object' };
    }
  } else {
    schema = { type: 'object' };
  }
  // K8s OpenAPI v3 doesn't support nullability for CRD fields. The CRD
  // structural schema (strict mode) rejects unknown fields, so we cannot
  // use a custom `x-speckl-nullable` extension. Nullability is expressed
  // at the application layer: if a field is `T | null`, the K8s field
  // is just `T` and clients must send the empty value (zero for numbers,
  // "" for strings, [] for arrays, {} for objects) to express "absent."
  // The `optional` flag (not in `required`) means the field can be omitted
  // entirely.
  return schema;
}

function primitiveToOpenAPISchema(prim: string): any {
  switch (prim) {
    case 'String':
      return { type: 'string' };
    case 'Nat':
    case 'Int':
      return { type: 'integer', format: 'int64' };
    case 'Real':
      return { type: 'number', format: 'double' };
    case 'Bool':
      return { type: 'boolean' };
    case 'Bytes':
      return { type: 'string', format: 'byte' };
    case 'Date':
      return { type: 'string', format: 'date-time' };
    default:
      return { type: 'string' };
  }
}

/**
 * Build printer columns from a CRD's status type fields.
 * Each scalar status field gets a column; complex types are skipped.
 */
function printerColumnsFor(speck: IRSpeck, kind: string): any[] {
  const types = speck.facets.typed_schema.types;
  const statusType = types.get(`${kind}Status`) as IRRecordType | undefined;
  if (!statusType) return [];
  const columns: any[] = [];
  for (const field of statusType.fields) {
    if (field.type.kind === 'primitive') {
      const prim = field.type.primitive || 'string';
      if (prim === 'String' || prim === 'Date' || prim === 'Bool') {
        columns.push({
          name: field.name,
          type: prim === 'Date' ? 'date' : prim === 'Bool' ? 'boolean' : 'string',
          jsonPath: `.status.${field.name}`,
        });
      }
    }
  }
  return columns;
}

/**
 * Naive English pluralization. K8s pluralization rules are similar.
 * For our purposes, this matches what `controller-gen` produces for
 * regular nouns: add 's', or 'es' for sibilants.
 */
function pluralize(s: string): string {
  if (s.endsWith('s') || s.endsWith('x') || s.endsWith('ch') || s.endsWith('sh')) {
    return s + 'es';
  }
  if (s.endsWith('y') && s.length > 1 && !'aeiou'.includes(s[s.length - 2])) {
    return s.slice(0, -1) + 'ies';
  }
  return s + 's';
}

function toYAML(value: any): string {
  return yaml.dump(value, { indent: 2, noRefs: true, sortKeys: false });
}
