import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const files = ['docs/swarm-queue.md', 'README.md', 'CHANGELOG.md', 'speckdl/SPEC.md'].map(name =>
  readFileSync(join(root, name), 'utf8'),
);
const tests = readFileSync(join(here, 'swarm-queue.test.ts'), 'utf8');

describe('swarm queue docs', () => {
  it('says the trailing integer is the rank and the input is not mutated', () => {
    for (const text of files) {
      expect(text).toContain('trailing integer is the rank');
      expect(text).toContain('not mutated');
      expect(text).toContain('does not route');
      expect(text).toContain('stop on a budget');
    }
  });

  it('names the negative tests', () => {
    expect(tests).toContain('does not mutate the input array');
    expect(tests).toContain('does not sort a numbered label as text');
    expect(tests).toContain('orders the same number by prefix and keeps arrival order for one label');
    expect(tests).toContain('keeps arrival order when P0 and P00 are the same number');
    expect(tests).toContain('an empty priority is unnumbered and is not last');
    expect(tests).toContain('compileSpec does not call the priority order');
  });
});
