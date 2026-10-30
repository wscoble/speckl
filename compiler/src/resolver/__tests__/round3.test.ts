// Round-3 cases: YAML events, single-script ids, registry class checks, paths.
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createResolverRegistry,
  filesystemBackend,
  ResolverError,
  staticManifestBackend,
} from '../index.js';
import { MAX_COPY_NODES, plainCopy } from '../plain.js';

const td = () => mkdtempSync(path.join(tmpdir(), 'brk3-'));

function writeRecord(dir: string, name: string, frontmatter: string): void {
  writeFileSync(path.join(dir, name), `---\n${frontmatter}\n---\n`);
}

describe('YAML anchors and aliases come from the parser', () => {
  it('rejects an anchor that follows an apostrophe in an unquoted value', () => {
    const dir = td();
    writeRecord(dir, 'r.md', [
      'id: incident/obrien',
      "owner: O'Brien",
      'measurement_class: c',
      'a: &a [1]',
      'b: *a',
    ].join('\n'));
    expect(() => filesystemBackend(dir)).toThrow(/anchors and aliases/);
  });

  it('rejects an alias hidden after a hash inside a flow list', () => {
    const dir = td();
    writeRecord(dir, 'r.md', [
      'id: incident/flow',
      'measurement_class: c',
      'x: [a#, &a [1], *a]',
    ].join('\n'));
    expect(() => filesystemBackend(dir)).toThrow(ResolverError);
  });

  it('loads R&D, query strings, rto*2, bold stars, and an ampersand in a block scalar', () => {
    const dir = td();
    writeRecord(dir, 'r.md', [
      'id: incident/plain-text',
      'measurement_class: c',
      'team: R&D',
      'url: https://example.test/q?a=1&b=2',
      'factor: rto*2',
      'stars: "**bold**"',
      'note: |',
      '  keep & this',
    ].join('\n'));
    const shape = filesystemBackend(dir).lookup('incident/plain-text');
    expect(shape!.measurementClass).toBe('c');
    expect(shape!.attributes.team).toBe('R&D');
    expect(shape!.attributes.url).toBe('https://example.test/q?a=1&b=2');
    expect(shape!.attributes.factor).toBe('rto*2');
    expect(shape!.attributes.stars).toBe('**bold**');
    expect(shape!.attributes.note).toBe('keep & this\n');
  });
});

describe('single-script record ids', () => {
  it('keeps an all-Cyrillic id unchanged and rejects a mixed segment', () => {
    const cyr = '\u043e\u0442\u0447\u0435\u0442';
    const backend = staticManifestBackend({ [cyr]: 'c' });
    expect(backend.lookup(cyr)!.id).toBe(cyr);
    expect(() => staticManifestBackend({ '\u0441op': 'c' })).toThrow(/mixes scripts/);
  });
});

describe('registry measurement class', () => {
  it('rejects a control character from any backend, not only filesystem', () => {
    const registry = createResolverRegistry();
    registry.register({
      name: 'custom',
      exists: () => true,
      lookup: () => ({ id: 'x', measurementClass: 'backup.restore\nprobe', attributes: {} }),
    });
    expect(() => registry.lookup('custom', 'x')).toThrow(ResolverError);
  });
});

describe('copy budget and resolved paths', () => {
  it('copies a list longer than the old 10_000 node cap', () => {
    const items = Array.from({ length: 10_001 }, () => 'x');
    const copied = plainCopy({ items }) as { items: string[] };
    expect(copied.items).toHaveLength(10_001);
    expect(MAX_COPY_NODES).toBeGreaterThanOrEqual(100_000);
  });

  it('reads root/link/../sub through realpath, not the lexical path', () => {
    const root = td();
    const sub = path.join(root, 'sub');
    mkdirSync(sub);
    writeFileSync(path.join(sub, 'r.md'), '---\nid: incident/real-sub\nmeasurement_class: c\n---\n');
    const outside = td();
    mkdirSync(path.join(outside, 'sub'));
    writeFileSync(path.join(outside, 'sub', 'r.md'), '---\nid: incident/outside\nmeasurement_class: c\n---\n');
    symlinkSync(outside, path.join(root, 'link'));
    const viaLink = filesystemBackend(path.join(root, 'link', '..', 'sub'));
    expect(viaLink.exists('incident/real-sub')).toBe(true);
    expect(viaLink.exists('incident/outside')).toBe(false);
  });

  it('still rejects a symlink file under the resolved root', () => {
    const root = td();
    const outside = td();
    writeFileSync(path.join(outside, 'r.md'), '---\nid: incident/linked\nmeasurement_class: c\n---\n');
    symlinkSync(path.join(outside, 'r.md'), path.join(root, 'r.md'));
    expect(() => filesystemBackend(root)).toThrow(/symlink/);
  });
});
