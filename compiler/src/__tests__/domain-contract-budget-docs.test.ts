// The budget docs name only what this slice implements.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const files = ['README.md', 'CHANGELOG.md', 'speckdl/SPEC.md', 'docs/domain-contract-budget.md'].map(name =>
  readFileSync(join(root, name), 'utf8'),
);
const tests = readFileSync(join(here, 'domain-contracts.test.ts'), 'utf8');

describe('domain budget docs', () => {
  it('says unsat is inside the BMC depth and the IR file is not a proof', () => {
    for (const text of files) {
      expect(text).toContain('speckl-unchecked');
      expect(text).toContain('not a proof');
      expect(text).toContain('does not route');
      expect(text).toContain('BMC depth');
      expect(text).toContain('writes no budget file');
    }
  });

  it('names the in-budget test', () => {
    expect(tests).toContain('proves an in-budget tick and records the obligation on the IR backend as unchecked');
  });
});
