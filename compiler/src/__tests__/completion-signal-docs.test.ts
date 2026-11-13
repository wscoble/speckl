import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const files = ['README.md', 'CHANGELOG.md', 'docs/agent-signals.md'].map(name =>
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
    expect(tests).toContain('replaces an empty trace id and still allows the call');
    expect(tests).toContain('replaces a trace id longer than 200 characters');
    expect(tests).toContain('replaces a trace id that contains a disallowed character');
    expect(tests).toContain('replaces a missing trace id and still allows the call');
    expect(tests).toContain('flags a parent branch id that is not an id and clears it');
    expect(tests).toContain('an absent parent is a root and is not flagged');
    expect(tests).toContain('does not keep a branch id equal to its parent');
    expect(tests).toContain('an observe tool does not get the signal fields');
    expect(tests).toContain('a matching post does not keep the caller kpis');
    expect(tests).toContain('a null parent is a root and is not flagged');
    expect(tests).toContain('does not scan the action body, enforce a queue, or run the agent');
  });
});
