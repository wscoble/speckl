import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { filesystemBackend, ResolverError } from '../index.js';
import { assertRecordId } from '../record-id.js';

const td = () => mkdtempSync(path.join(realpathSync(tmpdir()), 'brk5-'));

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof ResolverError ? 'malformed' : `RAW:${(err as Error).name}`;
  }
  return 'no-throw';
}

describe('unknown scripts fail closed', () => {
  it('rejects Latin mixed with a Unicode 17 letter', () => {
    expect(code(() => assertRecordId('ab\u{10940}', 'q'))).toBe('malformed');
    for (const sample of ['ab\u{1E6C0}', 'ab\u{11DB0}', 'ab\u{16EA0}']) {
      expect(code(() => assertRecordId(sample, 'q')), sample).toBe('malformed');
    }
  });

  it('rejects Han mixed with Latin on purpose', () => {
    expect(code(() => assertRecordId('東京tower', 'q'))).toBe('malformed');
    expect(code(() => assertRecordId('report東京', 'q'))).toBe('malformed');
  });

  it('rejects a join control that ends a segment', () => {
    expect(code(() => assertRecordId('क्\u200d', 'q'))).toBe('malformed');
    expect(code(() => assertRecordId('क्\u200c/x', 'q'))).toBe('malformed');
    expect(code(() => assertRecordId('क्\u200dष', 'q'))).toBe('no-throw');
    expect(code(() => assertRecordId('ก\u0e3a\u200dก', 'q'))).toBe('no-throw');
  });

  it('gives every letter a script, so none is neutral next to Latin', () => {
    const latin = /^\p{Script_Extensions=Latin}$/u;
    const letter = /^\p{L}$/u;
    const common = /^\p{Script=Common}$/u;
    const inherited = /^\p{Script=Inherited}$/u;
    for (let cp = 0; cp <= 0x3ffff; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!letter.test(ch) || common.test(ch) || inherited.test(ch)) continue;
      // NFKC can reject a Latin compatibility letter for a reason other than
      // script. The fail-open bug is the other direction: a non-Latin letter
      // that this runtime has not classified must not be accepted next to "a".
      if (latin.test(ch)) continue;
      expect(code(() => assertRecordId(`a${ch}`, 'q')), `U+${cp.toString(16)}`).toBe('malformed');
    }
  }, 60_000);
});

describe('a fifo does not block the load', () => {
  it('returns without waiting for a writer', () => {
    const dir = td();
    writeFileSync(path.join(dir, 'r.md'), '---\nid: r\nmeasurement_class: c\n---\n');
    execFileSync('mkfifo', [path.join(dir, 'x.md')]);
    const started = Date.now();
    const result = code(() => filesystemBackend(dir));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result === 'no-throw' || result === 'malformed').toBe(true);
    if (result === 'no-throw') expect(filesystemBackend(dir).exists('r')).toBe(true);
  });
});
