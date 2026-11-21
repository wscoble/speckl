// The contract docs name only what this stack implements.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const spec = readFileSync(join(root, 'speckdl', 'SPEC.md'), 'utf8');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const contracts = readFileSync(join(here, 'domain-contracts.test.ts'), 'utf8');
const each = readFileSync(join(here, 'domain-contract-syntax-each.test.ts'), 'utf8');

describe('contract docs', () => {
  it('says the Z3 bound is inside the BMC depth and the IR file is not a proof', () => {
    for (const text of [readme, spec, changelog]) {
      expect(text).toContain('speckl-unchecked');
      expect(text).toContain('not a proof');
      expect(text).toContain('does not route');
      expect(text).toContain('BMC depth');
    }
  });

  it('points at a direct test for a negative cost, a stored cost, a missing producer, and the Camel comment', () => {
    expect(each).toContain('rejects a negative cost');
    expect(each).toContain('stores the parsed cost on the action');
    expect(contracts).toContain('rejects a consumed event that no domain produces and that is not external');
    expect(contracts).toContain('proves an in-budget tick and records the obligation on the IR backend as unchecked');
    expect(contracts).toContain('emits a comment block and a typed event class, and does not throttle');
  });
});
