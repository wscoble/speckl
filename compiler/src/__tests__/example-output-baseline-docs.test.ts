// The baseline docs name the allow list and what the check does not decide.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const page = readFileSync(join(root, 'docs', 'example-output-baseline.md'), 'utf8');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const tests = readFileSync(join(here, 'compile-pipeline.test.ts'), 'utf8');

describe('example output baseline docs', () => {
  it('states the allow list, the rewrite switch, and that the baseline does not judge the hook', () => {
    for (const text of [page, changelog]) {
      expect(text).toContain('agent/hook.mjs');
      expect(text).toContain('A missing allow-listed file does not fail');
      expect(text).toContain('SPECKL_WRITE_BASELINE=1');
      expect(text).toContain('CI does not set that variable');
      expect(text).toContain('does not decide whether the hook is correct');
      expect(text).toContain('does not rewrite the hook');
    }
  });

  it('names the negative tests', () => {
    expect(tests).toContain('does not fail when an allow-listed file is missing from the fresh compile');
    expect(tests).toContain('rejects a file the baseline does not list');
    expect(tests).toContain('rejects a target the baseline does not list');
    expect(tests).toContain('ignores an allow-listed hook file and rejects a changed artifact');
    expect(tests).toContain('rejects a missing baseline key');
    expect(tests).toContain('CI does not set SPECKL_WRITE_BASELINE');
    expect(tests).toContain('does not rewrite the hook');
  });
});
