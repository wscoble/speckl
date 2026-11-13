import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const page = readFileSync(join(root, 'docs', 'signal-syntax.md'), 'utf8');
const tests = readFileSync(join(here, 'signal-syntax.test.ts'), 'utf8');

describe('priority and kpi docs', () => {
  it('says this slice does not copy labels onto tools and does not enforce a queue', () => {
    expect(page).toContain('does not copy the labels onto tools');
    expect(page).toContain('does not enforce a queue');
    expect(page).toContain('stays an assignment');
  });

  it('names a direct test for each rejected priority and kpi', () => {
    for (const name of [
      'rejects a domain priority that is not an identifier',
      'rejects a domain priority declared twice',
      'rejects an action priority that is not an identifier',
      'rejects an action priority declared more than once',
      'keeps priority := as an assignment',
      'rejects a kpi that is not a string',
      'rejects two kpi tags for one event name',
    ]) {
      expect(tests).toContain(name);
    }
  });
});
