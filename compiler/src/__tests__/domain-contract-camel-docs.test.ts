// The Camel docs name only what this slice implements.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const files = ['README.md', 'CHANGELOG.md', 'speckdl/SPEC.md', 'docs/domain-contract-camel.md'].map(name =>
  readFileSync(join(root, name), 'utf8'),
);
const tests = readFileSync(join(here, 'domain-contracts.test.ts'), 'utf8');

describe('Camel contract docs', () => {
  it('says the class is empty and Camel does not throttle or run a tick', () => {
    for (const text of files) {
      expect(text).toContain('private constructor');
      expect(text).toContain('does not throttle');
      expect(text).toContain('does not run a tick');
      expect(text).toContain('no domain emits no contract class');
    }
  });

  it('names the negative tests', () => {
    expect(tests).toContain('does not emit a contract class when the speck has no domain');
    expect(tests).toContain('emits an empty contract class and does not add a runtime method');
    expect(tests).toContain('emits a comment block and a typed event class, and does not throttle');
  });
});
