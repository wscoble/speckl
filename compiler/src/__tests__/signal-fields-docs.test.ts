import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const files = ['README.md', 'CHANGELOG.md', 'speckdl/SPEC.md', 'docs/signal-fields.md'].map(name =>
  readFileSync(join(root, name), 'utf8'),
);
const tests = readFileSync(join(here, 'agent-signal-fields.test.ts'), 'utf8');

describe('tool signal field docs', () => {
  it('says the generator does not write the decision line and does not enforce a queue', () => {
    for (const text of files) {
      expect(text).toContain('does not write the decision line');
      expect(text).toContain('does not route');
      expect(text).toContain('stopping at `return`');
    }
  });

  it('names the four field tests', () => {
    expect(tests).toContain('copies an action priority and a straight-line kpi onto the tool');
    expect(tests).toContain('uses the domain priority when the action declares none');
    expect(tests).toContain('does not tag an emit inside an if or a comment');
    expect(tests).toContain('omits priority and kpis when the speck declares neither');
    expect(tests).toContain('does not use a domain priority when the speck is not a member');
    expect(tests).toContain('does not tag an emit after return');
    expect(tests).toContain('tags a repeated kpi once');
    expect(tests).toContain('copies an action priority onto an observe tool');
  });
});
