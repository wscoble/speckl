// Validation test: every CustomResourceDefinition the k8s target generates
// validates against the official Kubernetes v1.31 schema for
// apiextensions.k8s.io/v1 (pinned in scripts/fetch-compile-deps.mjs), in
// strict mode: unknown fields are errors, as with `kubeconform -strict`.
// See helpers/toolchains.ts.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import * as yaml from 'js-yaml';
import { filesUnder, generate, targetSuite, Probe } from './helpers/toolchains.js';
// @ts-ignore plain ESM script shared with `npm run test:compile`
import { DEPS, depPath, missingDeps } from '../../scripts/fetch-compile-deps.mjs';

const CRD = 'io.k8s.apiextensions-apiserver.pkg.apis.apiextensions.v1.CustomResourceDefinition';

/** Disallow unknown properties wherever the schema lists properties. */
function strict(node: unknown): void {
  if (Array.isArray(node)) { node.forEach(strict); return; }
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (o.properties && typeof o.properties === 'object' && o.additionalProperties === undefined) o.additionalProperties = false;
  Object.values(o).forEach(strict);
}

let validate: ((doc: unknown) => boolean) & { errors?: unknown } | undefined;
const schemaProbe = (): Probe => {
  if (missingDeps('k8s').length) return { ok: false, reason: 'pinned Kubernetes apiextensions schema not cached (run `node scripts/fetch-compile-deps.mjs`)' };
  const dep = (DEPS as { group: string }[]).find((d) => d.group === 'k8s')!;
  const spec = JSON.parse(readFileSync(depPath(dep), 'utf-8'));
  strict(spec.components.schemas);
  const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
  ajv.addSchema({ components: spec.components }, 'k8s');
  validate = ajv.getSchema(`k8s#/components/schemas/${CRD}`) as typeof validate;
  return validate ? { ok: true, version: 'Kubernetes v1.31 apiextensions schema' } : { ok: false, reason: `schema ${CRD} not found` };
};

targetSuite({
  target: 'k8s',
  name: 'CRD schema (strict): generated Kubernetes CRDs',
  toolchain: schemaProbe(),
  check: (example) => {
    const files = filesUnder(join(generate(example, 'k8s'), 'k8s'), '.yaml');
    if (files.length === 0) return { ok: false, output: 'no k8s output' };
    for (const f of files) {
      let docs: unknown[];
      try {
        docs = yaml.loadAll(readFileSync(f, 'utf-8')).filter((d) => d != null);
      } catch (e) {
        return { ok: false, output: `${f}: invalid YAML: ${(e as Error).message}` };
      }
      for (const d of docs as Record<string, unknown>[]) {
        if (d.apiVersion !== 'apiextensions.k8s.io/v1' || d.kind !== 'CustomResourceDefinition') {
          return { ok: false, output: `${f}: expected an apiextensions.k8s.io/v1 CustomResourceDefinition, got ${d.apiVersion} ${d.kind}` };
        }
        if (!validate!(d)) return { ok: false, output: `${f} (${(d.metadata as { name?: string })?.name}): ${JSON.stringify(validate!.errors, null, 1).slice(0, 3000)}` };
      }
    }
    return { ok: true, output: '' };
  },
});

describe.skipIf(!validate)('CRD schema check itself', () => {
  const crd = (spec: Record<string, unknown>) => ({
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: { name: 'widgets.example.com' },
    spec: {
      group: 'example.com',
      names: { kind: 'Widget', plural: 'widgets' },
      scope: 'Namespaced',
      versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: { type: 'object' } } }],
      ...spec,
    },
  });
  it('accepts a minimal valid CRD', () => {
    expect(validate!(crd({}))).toBe(true);
  });
  it('rejects an unknown field (strict) and a wrong type', () => {
    expect(validate!(crd({ scpoe: 'Namespaced' }))).toBe(false);
    expect(validate!(crd({ versions: [{ name: 'v1', served: 'yes', storage: true }] }))).toBe(false);
  });
});
