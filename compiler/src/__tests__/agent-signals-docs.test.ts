import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const doc = readFileSync(join(here, '..', '..', '..', 'docs', 'agent-signals.md'), 'utf8');
const tests = readFileSync(join(here, 'hook-completion-signal.test.ts'), 'utf8');

describe('agent signal docs', () => {
  it('describes the prime line and says the hook does not enforce a queue', () => {
    expect(doc).toContain('signal` is `prime`');
    expect(doc).toContain('does not keep the');
    expect(doc).toContain('An observe tool does not get these');
    expect(doc).toContain('The hook does not enforce a queue');
    expect(doc).toContain('does not run the agent');
    expect(doc).toContain('proves nothing to an outside auditor');
  });

  it('names the tests that drive the generated hook', () => {
    expect(doc).toContain('hook-completion-signal.test.ts');
    expect(tests).toContain('stores the ingress trace on an allow pre and a prime signal on the matching post');
    expect(tests).toContain('replaces a bad trace id and still allows the call');
    expect(tests).toContain('denies a post with no matching pre and does not keep the caller trace');
    expect(tests).toContain('replaces an empty trace id and still allows the call');
    expect(tests).toContain('an observe tool does not get the signal fields');
    expect(tests).toContain('a matching post does not keep the caller kpis');
  });
});
