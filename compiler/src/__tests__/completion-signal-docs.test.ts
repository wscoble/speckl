import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const files = ['README.md', 'CHANGELOG.md', 'speckdl/SPEC.md', 'docs/agent-signals.md'].map(name =>
  readFileSync(join(root, name), 'utf8'),
);
const tests = readFileSync(join(here, 'hook-completion-signal.test.ts'), 'utf8');

describe('completion signal docs', () => {
  it('says the hook copies tool fields and does not scan the action body', () => {
    for (const text of files) {
      expect(text).toContain('does not scan the action body');
      expect(text).toContain('does not enforce a queue');
      expect(text).toContain('An observe tool does not get these');
      expect(text).toContain('does not run the agent');
    }
  });

  it('names the hook tests', () => {
    expect(tests).toContain('stores the ingress trace on an allow pre and a prime signal on the matching post');
    expect(tests).toContain('replaces a bad trace id and still allows the call');
    expect(tests).toContain('denies a post with no matching pre and does not keep the caller trace');
  });
});
