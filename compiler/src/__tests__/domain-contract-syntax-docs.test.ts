// The check docs name only what this slice implements.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const spec = readFileSync(join(root, 'speckdl', 'SPEC.md'), 'utf8');
const page = readFileSync(join(root, 'docs', 'domain-contract-syntax.md'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const tests = readFileSync(join(here, 'domain-contract-syntax-each.test.ts'), 'utf8');

describe('domain contract check docs', () => {
  it('says this slice copies cost and does not invent one on a speck with no contract', () => {
    for (const text of [spec, page, readme, changelog]) {
      expect(text).toContain('copies `cost` onto the action');
      expect(text).toContain('has no `cost` field');
      expect(text).toContain('does not route');
    }
  });

  it('names the non-regression tests and the stored-cost test', () => {
    expect(tests).toContain('a speck with no contract still lowers and does not invent a cost');
    expect(tests).toContain('a domain with no contract clauses still lowers');
    expect(tests).toContain('stores the parsed cost on the action');
    expect(tests).toContain('rejects consumes with no event');
  });
});
