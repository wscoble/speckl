// The check docs name only what this slice implements.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const spec = readFileSync(join(root, 'speckdl', 'SPEC.md'), 'utf8');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const tests = readFileSync(join(here, 'domain-check-each.test.ts'), 'utf8');

describe('domain check docs', () => {
  it('says the directory is created, the file is not written, and an observe tool is not checked', () => {
    for (const text of [readme, spec, changelog]) {
      expect(text).toContain('creates the output directory');
      expect(text).toContain('does not write the generated file');
      expect(text).toContain('An observe tool is not checked');
      expect(text).toContain('does not route');
    }
  });

  it('names the check tests for a missing member, a plain file, and the output directory', () => {
    expect(tests).toContain('rejects a member that is not a speck');
    expect(tests).toContain('a file with no domain has no domain diagnostic');
    expect(tests).toContain('throws the domain error, creates the output directory, and does not write the generated file');
    expect(tests).toContain('does not flag an observe tool that no harness maps');
  });
});
