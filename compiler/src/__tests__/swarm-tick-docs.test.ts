import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const files = ['docs/swarm-tick.md', 'README.md', 'CHANGELOG.md', 'speckdl/SPEC.md'].map(name =>
  readFileSync(join(root, name), 'utf8'),
);
const tests = readFileSync(join(here, 'swarm-tick.test.ts'), 'utf8');

describe('swarm tick docs', () => {
  it('names every fail-closed path', () => {
    for (const text of files) {
      expect(text).toContain('negative cost');
      expect(text).toContain('infinite cost is not negative');
      expect(text).toContain('does not increase the remaining budget');
      expect(text).toContain('does not skip a head');
      expect(text).toContain('does not apply backpressure');
    }
  });

  it('names a direct test for each fail-closed path', () => {
    for (const name of [
      'a negative cost waits and blocks the cheaper item behind it',
      'a cost that is not a number waits',
      'a cost that is not a number blocks the item behind it',
      'an infinite cost waits and blocks the item behind it',
      'waits every item when the tick names no domain',
      'does not run the item after the one that fills the budget',
      'does not mutate the caller work list',
      'stops at the first item that does not fit and does not run a cheaper item behind it',
      'does not run an item whose own cost is greater than the budget',
      'schedules domains independently and waits on work for a domain that is not in the tick',
    ]) {
      expect(tests).toContain(name);
    }
  });
});
