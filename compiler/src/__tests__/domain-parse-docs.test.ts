// The parser docs name only what this slice implements.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const spec = readFileSync(join(root, 'speckdl', 'SPEC.md'), 'utf8');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const tests = readFileSync(join(here, 'domain.test.ts'), 'utf8');

describe('domain parser docs', () => {
  it('says this slice does not check that a member names a speck and does not route', () => {
    for (const text of [readme, spec, changelog]) {
      expect(text).toContain('does not check that a member names a speck');
      expect(text).toContain('does not route');
      expect(text).toContain('missing final "}"');
      expect(text).toContain('does not check harnesses');
    }
  });

  it('names the parser tests for a missing member, a semicolon in a string, and a nested domain', () => {
    expect(tests).toContain('does not check that a member names a speck in this file');
    expect(tests).toContain('keeps a semicolon that sits inside the language string');
    expect(tests).toContain('rejects a domain nested inside a speck');
    expect(tests).toContain('reports a missing brace before an unclosed domain body');
  });
});
