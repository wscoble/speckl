// Round-2 regression cases. A throw from a backend-supplied object is
// ResolverError. YAML aliases are rejected before the deep copy runs.
import { describe, it, expect, afterEach } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createResolverRegistry,
  filesystemBackend,
  ResolverError,
  staticManifestBackend,
  type ResolverBackend,
} from '../index.js';

const td = () => mkdtempSync(path.join(tmpdir(), 'brk2-'));
const rec = (id: string, cls = 'probe', extra = '') =>
  `---\nid: ${JSON.stringify(id)}\nmeasurement_class: ${cls}\n${extra}---\n`;

function reg(backend: unknown) {
  const registry = createResolverRegistry();
  registry.register(backend as ResolverBackend);
  return registry;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof ResolverError ? err.code : `RAW:${(err as Error).constructor.name}`;
  }
  return 'no-throw';
}

describe('backend throws stay inside ResolverError', () => {
  it('rejects a Promise from exists and from lookup', () => {
    expect(codeOf(() => reg({
      name: 'a', exists: async () => true, lookup: () => null,
    }).exists('a', 'x'))).toBe('backend_error');
    expect(codeOf(() => reg({
      name: 'a', exists: () => true,
      lookup: async () => ({ id: 'x', measurementClass: 'c', attributes: {} }),
    }).lookup('a', 'x'))).toBe('backend_error');
  });

  it('wraps a throwing then getter on exists and lookup', () => {
    const evil = {};
    Object.defineProperty(evil, 'then', { get() { throw new Error('boom'); } });
    expect(codeOf(() => reg({ name: 'a', exists: () => evil, lookup: () => null }).exists('a', 'x')))
      .toBe('backend_error');
    expect(codeOf(() => reg({ name: 'a', exists: () => true, lookup: () => evil }).lookup('a', 'x')))
      .toBe('backend_error');
  });

  it('wraps a throwing id getter, attributes getter, and ownKeys trap', () => {
    const shape = {
      get id() { throw new Error('getter'); },
      measurementClass: 'c',
      attributes: {},
    };
    expect(codeOf(() => reg({ name: 'a', exists: () => true, lookup: () => shape }).lookup('a', 'x')))
      .toBe('backend_error');
    const attrs = { get k() { throw new Error('attr getter'); } };
    expect(codeOf(() => reg({
      name: 'a', exists: () => true,
      lookup: () => ({ id: 'x', measurementClass: 'c', attributes: attrs }),
    }).lookup('a', 'x'))).toBe('backend_error');
    const proxy = new Proxy({}, { ownKeys() { throw new Error('trap'); } });
    expect(codeOf(() => reg({
      name: 'a', exists: () => true,
      lookup: () => ({ id: 'x', measurementClass: 'c', attributes: proxy }),
    }).lookup('a', 'x'))).toBe('backend_error');
  });

  it('wraps a cyclic attribute instead of overflowing the stack', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(codeOf(() => reg({
      name: 'a', exists: () => true,
      lookup: () => ({ id: 'x', measurementClass: 'c', attributes: cycle }),
    }).lookup('a', 'x'))).toBe('backend_error');
  });

  it('copies a Map as a plain object with its entries', () => {
    const out = reg({
      name: 'a', exists: () => true,
      lookup: () => ({ id: 'x', measurementClass: 'c', attributes: { m: new Map([['k', 1]]) } }),
    }).lookup('a', 'x');
    expect(Object.keys(out!.attributes.m as object).length).toBeGreaterThan(0);
    expect((out!.attributes.m as { k: number }).k).toBe(1);
  });

  it('reports a throwing exists getter at register as malformed', () => {
    const backend = { name: 'g', get exists() { throw new Error('g'); }, lookup: () => null };
    expect(codeOf(() => createResolverRegistry().register(backend as unknown as ResolverBackend)))
      .toBe('malformed');
  });

  it('captures the backend name once at register', () => {
    let n = 0;
    const backend = {
      get name() { return n++ === 0 ? 'one' : 'two'; },
      exists: () => true,
      lookup: () => null,
    };
    const registry = reg(backend);
    expect(registry.backends()).toEqual(['one']);
    expect(registry.exists('one', 'x')).toBe(true);
  });
});

describe('lookup reads own properties only', () => {
  afterEach(() => {
    delete (Object.prototype as { measurementClass?: unknown }).measurementClass;
    delete (Object.prototype as { id?: unknown }).id;
  });

  it('does not accept a measurement class inherited from Object.prototype', () => {
    (Object.prototype as { measurementClass?: string }).measurementClass = 'backup.restore_probe';
    const registry = reg({
      name: 'a', exists: () => true, lookup: (id: string) => ({ id }),
    });
    expect(codeOf(() => registry.lookup('a', 'x'))).toBe('backend_error');
  });

  it('does not accept a shape whose fields live on the prototype', () => {
    const registry = reg({
      name: 'a',
      exists: () => true,
      lookup: (id: string) => Object.create({ id, measurementClass: 'c', attributes: {} }),
    });
    expect(codeOf(() => registry.lookup('a', 'x'))).toBe('backend_error');
  });
});

describe('record id canonical form', () => {
  it('rejects a Latin and Cyrillic homoglyph pair', () => {
    expect(() => staticManifestBackend({ 'backup/a': 'c', 'backup/\u0430': 'c' })).toThrow(ResolverError);
  });

  it('rejects an NFKC ligature that folds onto an ASCII id', () => {
    expect(() => staticManifestBackend({ 'backup/fi': 'c', 'backup/\ufb01': 'c' })).toThrow(ResolverError);
  });

  it('rejects empty segments and dot segments', () => {
    for (const id of ['/', '.', '..', 'a//b', 'a/', '/a', 'a/../b']) {
      expect(() => staticManifestBackend({ [id]: 'c' }), id).toThrow(ResolverError);
    }
  });

  it('rejects a lone surrogate', () => {
    expect(codeOf(() => staticManifestBackend({ 'a\ud800': 'c' }))).toBe('malformed');
  });

  it('accepts Devanagari, whose vowel signs are combining marks', () => {
    expect(() => staticManifestBackend({ 'incident/\u0939\u093f\u0902\u0926\u0940': 'c' })).not.toThrow();
  });

  it('keeps case variants distinct', () => {
    const backend = staticManifestBackend({ 'Incident/X': 'c', 'incident/x': 'd' });
    expect(backend.lookup('Incident/X')!.measurementClass).toBe('c');
    expect(backend.lookup('incident/x')!.measurementClass).toBe('d');
  });

  it('rejects a measurement class that contains a newline', () => {
    expect(() => staticManifestBackend({ a: 'backup.restore\nprobe' })).toThrow(ResolverError);
  });
});

describe('filesystem links and aliases', () => {
  it('rejects a YAML alias bomb as malformed without expanding it', () => {
    const dir = td();
    let yaml = 'a0: &a0 [x,x,x,x,x,x,x,x,x,x]\n';
    for (let i = 1; i < 9; i++) {
      const refs = Array.from({ length: 10 }, () => `*a${i - 1}`).join(',');
      yaml += `a${i}: &a${i} [${refs}]\n`;
    }
    writeFileSync(path.join(dir, 'r.md'), `---\nid: incident/bomb\nmeasurement_class: c\n${yaml}---\n`);
    const started = Date.now();
    expect(codeOf(() => filesystemBackend(dir))).toBe('malformed');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects a root whose parent directory is a symlink', () => {
    const real = td();
    mkdirSync(path.join(real, 'recs'));
    writeFileSync(path.join(real, 'recs', 'r.md'), rec('incident/via-parent-link'));
    const linkParent = path.join(td(), 'lp');
    symlinkSync(real, linkParent);
    expect(codeOf(() => filesystemBackend(path.join(linkParent, 'recs')))).toBe('malformed');
  });

  it('loads a hard link, which has no symlink bit to reject', () => {
    const outside = td();
    writeFileSync(path.join(outside, 'r.md'), rec('incident/hard'));
    const dir = td();
    linkSync(path.join(outside, 'r.md'), path.join(dir, 'r.md'));
    expect(filesystemBackend(dir).exists('incident/hard')).toBe(true);
  });
});
