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
      expect(text).toContain('does not throttle');
      expect(text).toContain('does not run a tick');
      expect(text).toContain('RouteBuilder');
      expect(text).toContain('no contract clauses emits no contract class');
      expect(text).toContain('no domain emits no contract class');
    }
    expect(files[1]).toContain('private constructor');
    expect(files[3]).toContain('private constructor');
  });

  it('names the negative tests', () => {
    expect(tests).toContain('does not emit a contract class when the speck has no domain');
    expect(tests).toContain('emits no contract class when the domain has no contract clauses');
    expect(tests).toContain('emits an empty contract class and does not add a runtime method');
    expect(tests).toContain('emits a comment block and a typed event class, and does not throttle');
    expect(tests).toContain('emits one route per action');
    expect(tests).toContain('does not run Z3 while generating Camel');
  });
});
