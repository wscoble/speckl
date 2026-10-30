// Review cases for the resolver SPI. Each one is a fail-closed behavior.
// Adapted from the break-it file: the synchronous SPI rejects a Promise
// instead of pretending to know what it will resolve to, and an unquoted
// YAML date stays a string under js-yaml 4.
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createResolverRegistry,
  filesystemBackend,
  ResolverError,
  staticManifestBackend,
  type ResolverBackend,
} from '../index.js';
import { MAX_DIRECTORY_DEPTH, MAX_RECORD_BYTES } from '../filesystem.js';

const td = () => mkdtempSync(path.join(tmpdir(), 'brk-'));
const rec = (id: string, cls = 'probe', extra = '') =>
  `---\nid: ${JSON.stringify(id)}\nmeasurement_class: ${cls}\n${extra}---\n`;

describe('registry return values fail closed', () => {
  it('a Promise from exists() is an error, not a truthy miss', () => {
    const asyncBackend = {
      name: 'async-remote',
      async exists(_id: string) { return false; },
      async lookup(_id: string) { return null; },
    } as unknown as ResolverBackend;
    const registry = createResolverRegistry();
    registry.register(asyncBackend);
    expect(() => registry.exists('async-remote', 'incident/never-recorded')).toThrow(ResolverError);
    try {
      registry.exists('async-remote', 'incident/never-recorded');
    } catch (err) {
      expect(err).toBeInstanceOf(ResolverError);
      expect((err as ResolverError).code).toBe('backend_error');
    }
  });

  it('a Promise rejection surfaces as ResolverError, not an unhandled rejection', async () => {
    const backend = {
      name: 'rej',
      exists: async () => { throw new Error('network down'); },
      lookup: async () => null,
    } as unknown as ResolverBackend;
    const registry = createResolverRegistry();
    registry.register(backend);
    let threw = false;
    try {
      const pending: unknown = registry.exists('rej', 'x');
      await pending;
    } catch (err) {
      threw = err instanceof ResolverError;
    }
    expect(threw).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('exists() returning a non-boolean is rejected', () => {
    const backend = {
      name: 'str',
      exists: () => 'no',
      lookup: () => null,
    } as unknown as ResolverBackend;
    const registry = createResolverRegistry();
    registry.register(backend);
    expect(() => registry.exists('str', 'x')).toThrow(ResolverError);
  });

  it('lookup() rejects a shape whose id or measurement class does not match', () => {
    const backend: ResolverBackend = {
      name: 'liar',
      exists: () => true,
      lookup: () => ({ id: 'some/other-id', measurementClass: '', attributes: {} }),
    };
    const registry = createResolverRegistry();
    registry.register(backend);
    expect(() => registry.lookup('liar', 'incident/asked-for')).toThrow(ResolverError);
  });
});

describe('static manifest duplicate ids', () => {
  it('rejects a JSON manifest that repeats an id', () => {
    const json = '{"backup/x": "backup.restore_probe", "backup/x": "sync.upstream"}';
    expect(() => staticManifestBackend(json)).toThrow(ResolverError);
    try {
      staticManifestBackend(json);
    } catch (err) {
      expect((err as ResolverError).code).toBe('malformed');
      expect((err as ResolverError).message).toMatch(/duplicate record id/);
    }
  });

  it('treats escaped and unescaped spellings of one key as a duplicate', () => {
    const json = '{"backup\\/x": "probe", "backup/x": "other"}';
    expect(() => staticManifestBackend(json)).toThrow(/duplicate record id/);
  });
});

describe('record id confusables', () => {
  it('rejects zero-width and NUL characters', () => {
    expect(() => staticManifestBackend({ 'backup/x\u200b': 'probe' })).toThrow(ResolverError);
    expect(() => staticManifestBackend({ 'backup/x\u0000': 'probe' })).toThrow(ResolverError);
  });

  it('does not load both NFC and NFD spellings of one id', () => {
    const dir = td();
    writeFileSync(path.join(dir, 'a.md'), rec('incident/caf\u00e9'));
    writeFileSync(path.join(dir, 'b.md'), rec('incident/cafe\u0301'));
    expect(() => filesystemBackend(dir)).toThrow(ResolverError);
  });

  it('finds an NFD id when the query is NFC', () => {
    const dir = td();
    writeFileSync(path.join(dir, 'a.md'), rec('incident/cafe\u0301'));
    const backend = filesystemBackend(dir);
    expect(backend.exists('incident/caf\u00e9')).toBe(true);
    expect(backend.lookup('incident/cafe\u0301')?.id).toBe('incident/caf\u00e9');
  });
});

describe('filesystem does not drop records it was given', () => {
  it('loads a record behind a UTF-8 BOM', () => {
    const dir = td();
    writeFileSync(path.join(dir, 'bom.md'), '\uFEFF' + rec('incident/bom'));
    expect(filesystemBackend(dir).exists('incident/bom')).toBe(true);
  });

  it('fails the load when a record file is a symlink', () => {
    const outside = td();
    writeFileSync(path.join(outside, 'r.md'), rec('incident/linked'));
    const dir = td();
    symlinkSync(path.join(outside, 'r.md'), path.join(dir, 'r.md'));
    expect(() => filesystemBackend(dir)).toThrow(ResolverError);
  });

  it('fails the load when a subdirectory is a symlink', () => {
    const outside = td();
    writeFileSync(path.join(outside, 'r.md'), rec('incident/in-linked-dir'));
    const dir = td();
    symlinkSync(outside, path.join(dir, 'more'));
    expect(() => filesystemBackend(dir)).toThrow(ResolverError);
  });

  it('loads .MD and .markdown files', () => {
    const dir = td();
    writeFileSync(path.join(dir, 'r.MD'), rec('incident/upper'));
    writeFileSync(path.join(dir, 's.markdown'), rec('incident/long'));
    const backend = filesystemBackend(dir);
    expect(backend.exists('incident/upper')).toBe(true);
    expect(backend.exists('incident/long')).toBe(true);
  });

  it('keeps a YAML __proto__ key as an own property', () => {
    const dir = td();
    writeFileSync(path.join(dir, 'p.md'), rec('incident/proto', 'probe', '__proto__:\n  verdict: Verified\n'));
    const shape = filesystemBackend(dir).lookup('incident/proto');
    expect(Object.prototype.hasOwnProperty.call(shape!.attributes, '__proto__')).toBe(true);
    expect((shape!.attributes as { __proto__?: { verdict?: string } }).__proto__?.verdict).toBe('Verified');
    expect(Object.prototype).not.toHaveProperty('verdict');
  });
});

describe('attribute isolation', () => {
  it('does not let a caller mutate the stored record', () => {
    const dir = td();
    writeFileSync(path.join(dir, 'n.md'), rec('incident/n', 'probe', 'tags:\n  - a\n'));
    const backend = filesystemBackend(dir);
    (backend.lookup('incident/n')!.attributes.tags as string[]).push('injected');
    expect(backend.lookup('incident/n')!.attributes.tags).toEqual(['a']);
  });
});

describe('frontmatter errors', () => {
  it('calls empty frontmatter empty, not unclosed', () => {
    const dir = td();
    writeFileSync(path.join(dir, 'e.md'), '---\n---\nbody\n');
    try {
      filesystemBackend(dir);
      throw new Error('loaded');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/unclosed/);
      expect((err as Error).message).toMatch(/empty/);
    }
  });

  it('keeps an unquoted YAML date as a string id', () => {
    // js-yaml 4 does not parse 2026-09-19 as a Date. The string is a legal id.
    // A non-string id is still malformed.
    const dir = td();
    writeFileSync(path.join(dir, 'dt.md'), '---\nid: 2026-09-19\nmeasurement_class: probe\n---\n');
    expect(filesystemBackend(dir).exists('2026-09-19')).toBe(true);
    const bad = td();
    writeFileSync(path.join(bad, 'num.md'), '---\nid: 1\nmeasurement_class: probe\n---\n');
    expect(() => filesystemBackend(bad)).toThrow(/id must be a non-empty string/);
  });
});

describe('size limits', () => {
  it('rejects a record over the byte cap without treating it as loaded', () => {
    const dir = td();
    const body = rec('incident/big') + 'x'.repeat(64);
    const padded = Buffer.alloc(MAX_RECORD_BYTES + 1);
    padded.write(body);
    writeFileSync(path.join(dir, 'big.md'), padded);
    expect(() => filesystemBackend(dir)).toThrow(/byte limit/);
  });

  it('rejects a directory nested past the depth cap', () => {
    let dir = td();
    const root = dir;
    for (let i = 0; i < MAX_DIRECTORY_DEPTH + 1; i++) {
      dir = path.join(dir, 'd');
      mkdirSync(dir);
    }
    writeFileSync(path.join(dir, 'r.md'), rec('incident/deep'));
    expect(() => filesystemBackend(root)).toThrow(/nested more than/);
  });
});

describe('registry id and name checks', () => {
  it('rejects a sigil id instead of treating it as a miss', () => {
    const registry = createResolverRegistry();
    registry.register(staticManifestBackend({ 'backup/x': 'p' }));
    expect(() => registry.exists('static-manifest', '&backup/x')).toThrow(ResolverError);
  });

  it('rejects a non-string id', () => {
    const registry = createResolverRegistry();
    registry.register(staticManifestBackend({ '1': 'p' }));
    expect(() => registry.exists('static-manifest', 1 as unknown as string)).toThrow(ResolverError);
  });

  it('attributes a forged unknown_backend error to the backend that threw', () => {
    const backend: ResolverBackend = {
      name: 'forger',
      exists: () => {
        throw new ResolverError('x', { code: 'unknown_backend', backendName: 'other' });
      },
      lookup: () => null,
    };
    const registry = createResolverRegistry();
    registry.register(backend);
    try {
      registry.exists('forger', 'id');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ResolverError);
      expect((err as ResolverError).code).toBe('backend_error');
      expect((err as ResolverError).backendName).toBe('forger');
      expect((err as ResolverError).cause).toBeInstanceOf(ResolverError);
    }
  });

  it('rejects a backend name that is only whitespace around a registered name', () => {
    const registry = createResolverRegistry();
    registry.register(staticManifestBackend({}, { name: 'filesystem' }));
    expect(() => registry.register(staticManifestBackend({}, { name: ' filesystem ' }))).toThrow(ResolverError);
  });
});
