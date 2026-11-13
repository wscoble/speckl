import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const files = ['docs/swarm-routing.md', 'README.md', 'CHANGELOG.md', 'speckdl/SPEC.md'].map(name =>
  readFileSync(join(root, name), 'utf8'),
);
const compile = readFileSync(join(here, '..', 'compile.ts'), 'utf8');

describe('swarm routing docs', () => {
  it('states the one-hop assumption and what this module does not do', () => {
    for (const doc of files) {
      expect(doc).toContain('one hop');
      expect(doc).toContain('does not enqueue');
      expect(doc).toContain('priority number as a queue rank');
      expect(doc).toContain('per-domain budget as the tick');
      expect(doc).toContain('backpressure as the budget stop');
    }
  });

  it('compileSpec does not call the route planner', () => {
    expect(compile.includes('planRoutes')).toBe(false);
    expect(compile.includes('swarm-route')).toBe(false);
  });
});
