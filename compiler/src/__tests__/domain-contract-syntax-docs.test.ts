// The syntax docs name only what this slice implements.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const spec = readFileSync(join(root, 'speckdl', 'SPEC.md'), 'utf8');
const page = readFileSync(join(root, 'docs', 'domain-contract-syntax.md'), 'utf8');
const tests = readFileSync(join(here, 'domain-contract-syntax-each.test.ts'), 'utf8');

describe('domain contract syntax docs', () => {
  it('says lowering skips cost and this slice does not check that a consumed event is produced', () => {
    for (const text of [spec, page]) {
      expect(text).toContain('cost` is skipped');
      expect(text).toContain('does not check that a consumed event is produced');
      expect(text).toContain('does not route');
      expect(text).toContain('Zero is a real cost');
    }
  });

  it('names the negative tests for an empty consume, a bad event name, and an assignment', () => {
    expect(tests).toContain('rejects consumes with no event');
    expect(tests).toContain('rejects an event name that is not an identifier');
    expect(tests).toContain('rejects a produce name that is not an identifier');
    expect(tests).toContain('rejects the same consume in a second clause');
    expect(tests).toContain('rejects a budget with no integer');
    expect(tests).toContain('rejects a cost with no integer');
    expect(tests).toContain('rejects a budget above the safe integer range');
    expect(tests).toContain('rejects a cost above the safe integer range');
    expect(tests).toContain('rejects a budget that is not an integer');
    expect(tests).toContain('keeps cost := as an assignment');
    expect(tests).toContain('skips cost while lowering and does not store it on the action');
  });
});
