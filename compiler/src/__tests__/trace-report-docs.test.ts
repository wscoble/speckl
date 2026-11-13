import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const files = ['README.md', 'CHANGELOG.md', 'speckdl/SPEC.md', 'docs/trace-report.md'].map(name =>
  readFileSync(join(root, name), 'utf8'),
);
const tests = readFileSync(join(here, 'trace-report.test.ts'), 'utf8');

describe('trace report docs', () => {
  it('says the report checks the hash chain, checks HMAC only with a key, and does not enforce a queue', () => {
    for (const text of files) {
      expect(text).toContain('checks the hash chain');
      expect(text).toContain('only when a key is passed');
      expect(text).toContain('macs not checked');
      expect(text).toContain('does not enforce a queue');
      expect(text).toContain('does not run the hook');
    }
  });

  it('names the tests for the golden report, the hash chain, and a short state log', () => {
    expect(tests).toContain('matches the golden report, including an empty log');
    expect(tests).toContain('checks the hash chain and leaves the HMAC for a key');
    expect(tests).toContain('fails closed when --state log is shorter than the decision head or gone');
    expect(tests).toContain('does not claim macs on an empty record');
  });
});
