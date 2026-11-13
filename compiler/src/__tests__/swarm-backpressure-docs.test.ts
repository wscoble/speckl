import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const files = ['docs/swarm-backpressure.md', 'README.md', 'CHANGELOG.md', 'speckdl/SPEC.md'].map(name =>
  readFileSync(join(root, name), 'utf8'),
);
const tests = readFileSync(join(here, 'swarm-backpressure.test.ts'), 'utf8');

describe('swarm backpressure docs', () => {
  it('says backpressure is the budget stop and a delivery that fits is not named', () => {
    for (const text of files) {
      expect(text).toContain('budget stop');
      expect(text).toContain('is not named');
      expect(text).toContain('does not call `deliver`');
      expect(text).toContain('`deliver` does not throttle');
      expect(text).toContain('RouteBuilder');
      expect(text).toContain('A negative cost waits and is named');
    }
  });

  it('names the negative tests', () => {
    expect(tests).toContain('does not name backpressure for a delivery that fits');
    expect(tests).toContain('names a negative-cost delivery and does not run it');
    expect(tests).toContain('does not report backpressure for a domain that declares no budget');
    expect(tests).toContain('keeps a delivery that can never fit, and does not invent a route');
    expect(tests).toContain('compileSpec does not call deliver');
  });
});
