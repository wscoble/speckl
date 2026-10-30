import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { filesystemBackend, ResolverError, staticManifestBackend } from '../index.js';
import { assertRecordId } from '../record-id.js';

const td = () => mkdtempSync(path.join(realpathSync(tmpdir()), 'brk4-'));

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof ResolverError ? 'malformed' : `RAW:${(err as Error).name}`;
  }
  return 'no-throw';
}

function loadFm(fm: string): string {
  const dir = td();
  writeFileSync(path.join(dir, 'r.md'), `---\nid: r\nmeasurement_class: c\n${fm}\n---\n`);
  return code(() => filesystemBackend(dir));
}

describe('script sets and digits', () => {
  it('accepts Japanese, Korean, and Chinese augmented sets', () => {
    for (const sample of ['東京の記録', '東京タワー', '漢字한글', '漢ㄅ', 'サーバー']) {
      expect(code(() => assertRecordId(sample, 'q')), sample).toBe('no-throw');
    }
  });

  it('accepts Adlam and NKo as one script each', () => {
    expect(code(() => assertRecordId('𞤀𞤁𞤂', 'q'))).toBe('no-throw');
    expect(code(() => assertRecordId('ߊߋߌ', 'q'))).toBe('no-throw');
  });

  it('accepts one non-ASCII numbering system and rejects a mix', () => {
    expect(code(() => assertRecordId('report१२', 'q'))).toBe('no-throw');
    expect(code(() => assertRecordId('2০26', 'q'))).toBe('malformed');
  });

  it('allows ZWNJ between joining Arabic letters and rejects it between Latin letters', () => {
    expect(code(() => assertRecordId('می\u200cخواهم', 'q'))).toBe('no-throw');
    expect(code(() => assertRecordId('a\u200cb', 'q'))).toBe('malformed');
  });

  it('still rejects a Latin and Cyrillic mix in one segment', () => {
    expect(code(() => assertRecordId('\u0441op', 'q'))).toBe('malformed');
    expect(assertRecordId('\u043e\u0442\u0447\u0435\u0442', 'q')).toBe('\u043e\u0442\u0447\u0435\u0442');
  });
});

describe('parser failures and kernel paths', () => {
  it('rejects an anchor after an apostrophe and an alias after a hash', () => {
    expect(loadFm("owner: O'Brien\nx: &a [1]\ny: *a")).toBe('malformed');
    expect(loadFm('x: [a#, &a [1], *a]')).toBe('malformed');
  });

  it('loads ordinary ampersands and stars', () => {
    expect(loadFm('team: R&D')).toBe('no-throw');
    expect(loadFm('url: https://ex.example/?a=1&b=2')).toBe('no-throw');
    expect(loadFm('formula: rto*2')).toBe('no-throw');
    expect(loadFm('note: |\n  Tom &Jerry')).toBe('no-throw');
  });

  it('rejects an undefined alias as malformed rather than a second parse', () => {
    expect(loadFm('x: *nope')).toBe('malformed');
  });

  it('follows ls/../sub the way the operating system does', () => {
    const dir = td();
    mkdirSync(path.join(dir, 'real/sub'), { recursive: true });
    writeFileSync(path.join(dir, 'real/sub/r.md'), '---\nid: inreal\nmeasurement_class: c\n---\n');
    symlinkSync(path.join(dir, 'real/sub'), path.join(dir, 'ls'));
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, 'sub/x.md'), '---\nid: lexical\nmeasurement_class: c\n---\n');
    const backend = filesystemBackend(`${dir}/ls/../sub`);
    expect(backend.exists('inreal')).toBe(true);
    expect(backend.exists('lexical')).toBe(false);
  });

  it('keeps a manifest of distinct whole-script confusables', () => {
    expect(() => staticManifestBackend(JSON.stringify({ 'сор': 'c', 'cop': 'c' }))).not.toThrow();
  });
});
