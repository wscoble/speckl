import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertRecordId,
  createResolverRegistry,
  filesystemBackend,
  ResolverError,
  staticManifestBackend,
  staticManifestBackendFromFile,
  type ResolverBackend,
} from '../index.js';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function expectMalformed(fn: () => void, pattern: RegExp): ResolverError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ResolverError);
    const resolverErr = err as ResolverError;
    expect(resolverErr.code).toBe('malformed');
    expect(resolverErr.message).toMatch(pattern);
    return resolverErr;
  }
  throw new Error('expected ResolverError');
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'speckl-resolver-'));
}

function writeRecord(dir: string, name: string, body: string): void {
  writeFileSync(path.join(dir, name), body);
}

const PROBE = `---
id: backup/exampleco/2026-09-19
measurement_class: backup.restore_probe
window: 24h
---
Fictional ExampleCo restore probe.
`;

describe('static-manifest backend', () => {
  const manifest = {
    'backup/exampleco/2026-09-19': 'backup.restore_probe',
    'incident/exampleco-mirror-404': '  sync.upstream  ',
  };

  it('answers existence and shape from a parsed object, with no filesystem read', () => {
    const backend = staticManifestBackend(manifest);
    expect(backend.name).toBe('static-manifest');
    expect(backend.exists('backup/exampleco/2026-09-19')).toBe(true);
    expect(backend.lookup('backup/exampleco/2026-09-19')).toEqual({
      id: 'backup/exampleco/2026-09-19',
      measurementClass: 'backup.restore_probe',
      attributes: {},
    });
    expect(backend.lookup('incident/exampleco-mirror-404')?.measurementClass).toBe('sync.upstream');
  });

  it('answers the same queries from a JSON string', () => {
    const backend = staticManifestBackend(JSON.stringify(manifest), { name: 'offline' });
    expect(backend.name).toBe('offline');
    expect(backend.exists('backup/exampleco/2026-09-19')).toBe(true);
    expect(backend.lookup('backup/exampleco/2026-09-19')?.measurementClass).toBe('backup.restore_probe');
  });

  it('loads a manifest file from disk and still resolves offline', () => {
    const dir = tempDir();
    const file = path.join(dir, 'manifest.json');
    writeFileSync(file, JSON.stringify({ 'incident/exampleco-pebblekv': 'sync.vendor_api' }));
    const backend = staticManifestBackendFromFile(file);
    expect(backend.exists('incident/exampleco-pebblekv')).toBe(true);
    expect(backend.lookup('incident/exampleco-pebblekv')).toEqual({
      id: 'incident/exampleco-pebblekv',
      measurementClass: 'sync.vendor_api',
      attributes: {},
    });
  });

  it('treats an unknown id as a miss, including an id that looks like a path', () => {
    const backend = staticManifestBackend(manifest);
    expect(backend.exists('incident/exampleco-quill')).toBe(false);
    expect(backend.lookup('incident/exampleco-quill')).toBeNull();
    expect(backend.exists('../../etc/passwd')).toBe(false);
    expect(backend.lookup('../../etc/passwd')).toBeNull();
    expect(() => backend.exists('')).toThrow(ResolverError);
    expect(() => backend.lookup('')).toThrow(ResolverError);
  });

  it('accepts an empty manifest', () => {
    const backend = staticManifestBackend('{}');
    expect(backend.exists('backup/exampleco/2026-09-19')).toBe(false);
    expect(backend.lookup('backup/exampleco/2026-09-19')).toBeNull();
  });

  it('rejects a malformed manifest', () => {
    expectMalformed(() => staticManifestBackend('{'), /not valid JSON/);
    expectMalformed(() => staticManifestBackend('[]'), /JSON object/);
    expectMalformed(() => staticManifestBackend('null'), /JSON object/);
    expectMalformed(() => staticManifestBackend('1'), /JSON object/);
    expectMalformed(() => staticManifestBackend('"nope"'), /JSON object/);
    expectMalformed(
      () => staticManifestBackend({ 'backup/exampleco/2026-09-19': 1 } as unknown as Record<string, unknown>),
      /non-empty string/,
    );
    expectMalformed(() => staticManifestBackend({ 'backup/exampleco/2026-09-19': '   ' }), /non-empty string/);
    expectMalformed(() => staticManifestBackend({ '': 'sync.upstream' }), /non-empty string/);
    expectMalformed(() => staticManifestBackend({ '&backup/exampleco/2026-09-19': 'probe' }), /sigil/);
    expectMalformed(() => staticManifestBackend({ 'backup/example co': 'probe' }), /whitespace/);
  });

  it('rejects a missing manifest file and a file that is not JSON', () => {
    expectMalformed(
      () => staticManifestBackendFromFile(path.join(tempDir(), 'missing.json')),
      /cannot read manifest/,
    );
    const dir = tempDir();
    const file = path.join(dir, 'broken.json');
    writeFileSync(file, '{');
    expectMalformed(() => staticManifestBackendFromFile(file), /not valid JSON/);
  });
});

describe('filesystem backend', () => {
  it('reads Markdown frontmatter, including a nested record and a camelCase class', () => {
    const dir = tempDir();
    writeRecord(dir, 'probe.md', PROBE);
    writeRecord(dir, 'notes.txt', 'id: not-a-record\n');
    writeRecord(dir, 'readme.md', '# no frontmatter\n');
    const nested = path.join(dir, 'incidents');
    mkdirSync(nested);
    writeRecord(nested, 'mirror.md', `---
id: incident/exampleco-mirror-404
measurementClass: sync.upstream
awake: upstream
---
Fictional upstream 404.
`);
    const backend = filesystemBackend(dir);
    expect(backend.name).toBe('filesystem');
    expect(backend.exists('backup/exampleco/2026-09-19')).toBe(true);
    const probe = backend.lookup('backup/exampleco/2026-09-19');
    expect(probe).toEqual({
      id: 'backup/exampleco/2026-09-19',
      measurementClass: 'backup.restore_probe',
      attributes: { window: '24h' },
    });
    if (probe) probe.attributes.window = 'mutated';
    expect(backend.lookup('backup/exampleco/2026-09-19')?.attributes.window).toBe('24h');
    expect(backend.lookup('incident/exampleco-mirror-404')).toEqual({
      id: 'incident/exampleco-mirror-404',
      measurementClass: 'sync.upstream',
      attributes: { awake: 'upstream' },
    });
    expect(backend.exists('not-a-record')).toBe(false);
  });

  it('accepts both class keys when they agree, and drops them from attributes', () => {
    const dir = tempDir();
    writeRecord(dir, 'one.md', `---
id: incident/exampleco-pebblekv
measurement_class: sync.vendor_api
measurementClass: sync.vendor_api
---
`);
    const backend = filesystemBackend(dir, { name: 'records' });
    expect(backend.name).toBe('records');
    expect(backend.lookup('incident/exampleco-pebblekv')).toEqual({
      id: 'incident/exampleco-pebblekv',
      measurementClass: 'sync.vendor_api',
      attributes: {},
    });
  });

  it('trims a padded measurement class', () => {
    const dir = tempDir();
    writeRecord(dir, 'one.md', `---
id: incident/exampleco-quill
measurement_class: "  sync.configuration  "
---
`);
    expect(filesystemBackend(dir).lookup('incident/exampleco-quill')?.measurementClass).toBe('sync.configuration');
  });

  it('does not treat an unknown id, or a path-shaped id, as a file read', () => {
    const dir = tempDir();
    writeRecord(dir, 'probe.md', PROBE);
    const backend = filesystemBackend(dir);
    expect(backend.exists('incident/does-not-exist')).toBe(false);
    expect(backend.lookup('incident/does-not-exist')).toBeNull();
    expect(backend.exists('../../etc/passwd')).toBe(false);
    expect(backend.lookup('../../etc/passwd')).toBeNull();
  });

  it('refuses a symlink instead of following it or skipping the record', () => {
    const outside = tempDir();
    writeRecord(outside, 'secret.md', `---
id: incident/outside-the-tree
measurement_class: sync.upstream
---
`);
    const dir = tempDir();
    symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'linked.md'));
    expectMalformed(() => filesystemBackend(dir), /symlink/);
  });

  it('rejects a missing directory and a file used as the root', () => {
    expectMalformed(() => filesystemBackend(path.join(tempDir(), 'missing')), /cannot read record directory/);
    const dir = tempDir();
    const file = path.join(dir, 'not-a-dir.md');
    writeFileSync(file, PROBE);
    expectMalformed(() => filesystemBackend(file), /not a directory/);
  });

  it('rejects malformed records', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['unclosed.md', '---\nid: backup/exampleco/2026-09-19\n', /unclosed frontmatter/],
      ['bad-yaml.md', '---\nfoo: [\n---\n', /not valid YAML/],
      ['empty.md', '---\nnull\n---\n', /frontmatter is empty/],
      ['list.md', '---\n- id\n---\n', /YAML mapping/],
      ['number-id.md', '---\nid: 1\nmeasurement_class: probe\n---\n', /id must be a non-empty string/],
      ['sigil.md', '---\nid: "&backup/x"\nmeasurement_class: probe\n---\n', /sigil/],
      ['space.md', '---\nid: "backup/x y"\nmeasurement_class: probe\n---\n', /whitespace/],
      ['no-class.md', '---\nid: backup/x\n---\n', /measurement_class must be a non-empty string/],
      ['blank-class.md', '---\nid: backup/x\nmeasurement_class: "  "\n---\n', /measurement_class must be a non-empty string/],
      ['disagree.md', '---\nid: backup/x\nmeasurement_class: probe\nmeasurementClass: other\n---\n', /disagree/],
    ];
    for (const [name, body, pattern] of cases) {
      const dir = tempDir();
      writeRecord(dir, name, body);
      expectMalformed(() => filesystemBackend(dir), pattern);
    }
  });

  it('rejects two files that declare the same id', () => {
    const dir = tempDir();
    const body = `---
id: backup/exampleco/2026-09-19
measurement_class: backup.restore_probe
---
`;
    writeRecord(dir, 'a.md', body);
    writeRecord(dir, 'b.md', body);
    const err = expectMalformed(() => filesystemBackend(dir), /already defined/);
    expect(err.recordId).toBe('backup/exampleco/2026-09-19');
  });

  it('loads an empty directory', () => {
    const backend = filesystemBackend(tempDir());
    expect(backend.exists('backup/exampleco/2026-09-19')).toBe(false);
    expect(backend.lookup('backup/exampleco/2026-09-19')).toBeNull();
  });
});

describe('registry', () => {
  it('routes existence and lookup to the named backend', () => {
    const registry = createResolverRegistry();
    registry.register(staticManifestBackend({
      'incident/exampleco-mirror-404': 'sync.upstream',
    }));
    expect(registry.backends()).toEqual(['static-manifest']);
    expect(registry.exists('static-manifest', 'incident/exampleco-mirror-404')).toBe(true);
    expect(registry.lookup('static-manifest', 'incident/exampleco-mirror-404')).toEqual({
      id: 'incident/exampleco-mirror-404',
      measurementClass: 'sync.upstream',
      attributes: {},
    });
    expect(registry.exists('static-manifest', 'missing')).toBe(false);
    expect(registry.lookup('static-manifest', 'missing')).toBeNull();
  });

  it('registers an out-of-tree backend beside a reference backend', () => {
    const external: ResolverBackend = {
      name: 'exampleco-records',
      exists(id: string): boolean {
        return id === 'lifecycle/exampleco-keepsake-tombstone';
      },
      lookup(id: string) {
        if (id !== 'lifecycle/exampleco-keepsake-tombstone') return null;
        return {
          id,
          measurementClass: 'lifecycle.tombstone',
          attributes: { incident: false },
        };
      },
    };
    const registry = createResolverRegistry();
    registry.register(external);
    registry.register(staticManifestBackend({ 'incident/exampleco-mirror-404': 'sync.upstream' }));
    expect(registry.backends()).toEqual(['exampleco-records', 'static-manifest']);
    expect(registry.lookup('exampleco-records', 'lifecycle/exampleco-keepsake-tombstone')?.measurementClass)
      .toBe('lifecycle.tombstone');
    expect(registry.exists('static-manifest', 'lifecycle/exampleco-keepsake-tombstone')).toBe(false);
  });

  it('fails closed when the backend name was not registered', () => {
    const registry = createResolverRegistry();
    expect(() => registry.exists('static-manifest', 'backup/x')).toThrow(ResolverError);
    expect(() => registry.lookup('static-manifest', 'backup/x')).toThrow(ResolverError);
    try {
      registry.lookup('static-manifest', 'backup/x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ResolverError);
      expect((err as ResolverError).code).toBe('unknown_backend');
      expect((err as ResolverError).recordId).toBe('backup/x');
    }
  });

  it('wraps a backend that throws and rethrows ResolverError unchanged', () => {
    const boom = new Error('disk on fire');
    const throwing: ResolverBackend = {
      name: 'boom',
      exists(): boolean {
        throw boom;
      },
      lookup(): null {
        throw 'lookup failed';
      },
    };
    const registry = createResolverRegistry();
    registry.register(throwing);
    try {
      registry.exists('boom', 'backup/x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ResolverError);
      const wrapped = err as ResolverError;
      expect(wrapped.code).toBe('backend_error');
      expect(wrapped.backendName).toBe('boom');
      expect(wrapped.recordId).toBe('backup/x');
      expect(wrapped.message).toContain('disk on fire');
      expect(wrapped.cause).toBe(boom);
    }
    try {
      registry.lookup('boom', 'backup/y');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ResolverError);
      expect((err as ResolverError).code).toBe('backend_error');
      expect((err as ResolverError).message).toContain('lookup failed');
      expect((err as ResolverError).cause).toBe('lookup failed');
    }

    const own = new ResolverError('manifest unreadable', { code: 'malformed', backendName: 'strict' });
    const strict: ResolverBackend = {
      name: 'strict',
      exists(): boolean {
        throw own;
      },
      lookup(): null {
        return null;
      },
    };
    registry.register(strict);
    try {
      registry.exists('strict', 'backup/x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBe(own);
      expect((err as ResolverError).code).toBe('malformed');
    }
  });

  it('rejects a bad registration', () => {
    const registry = createResolverRegistry();
    expectMalformed(() => registry.register(undefined as unknown as ResolverBackend), /must be an object/);
    expectMalformed(() => registry.register(null as unknown as ResolverBackend), /must be an object/);
    expectMalformed(
      () => registry.register({ name: '   ', exists: () => false, lookup: () => null }),
      /non-empty token/,
    );
    expectMalformed(
      () => registry.register({ name: 'half', exists: () => false } as unknown as ResolverBackend),
      /exists and lookup/,
    );
    registry.register(staticManifestBackend({}));
    try {
      registry.register(staticManifestBackend({ 'backup/x': 'probe' }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ResolverError);
      expect((err as ResolverError).code).toBe('duplicate_backend');
      expect((err as ResolverError).backendName).toBe('static-manifest');
      expect((err as ResolverError).message).toMatch(/already registered/);
    }
  });

  it('keeps two registries independent', () => {
    const a = createResolverRegistry();
    const b = createResolverRegistry();
    a.register(staticManifestBackend({ 'backup/x': 'probe' }));
    expect(b.backends()).toEqual([]);
    expect(() => b.exists('static-manifest', 'backup/x')).toThrow(ResolverError);
  });
});

describe('record ids', () => {
  it('accepts a plain id and rejects an empty id, a sigil, and whitespace', () => {
    expect(() => assertRecordId('backup/exampleco/2026-09-19', 'manifest')).not.toThrow();
    expectMalformed(() => assertRecordId('   ', 'manifest'), /non-empty/);
    const sigil = expectMalformed(() => assertRecordId('&backup/x', 'manifest'), /sigil/);
    expect(sigil.recordId).toBe('&backup/x');
    expectMalformed(() => assertRecordId('backup/x y', 'manifest'), /whitespace/);
  });
});

describe('the rest of the compiler stays unwired', () => {
  const files = sourceFiles(srcDir).filter((file) => !file.includes(`${path.sep}resolver${path.sep}`));

  it('scans the compiler sources outside the resolver', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((file) => file.endsWith(`${path.sep}generators${path.sep}z3.ts`))).toBe(true);
    expect(files.some((file) => file.endsWith(`${path.sep}parser.ts`))).toBe(true);
  });

  it('no compiler source outside the resolver imports it', () => {
    const hits = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /from ['"][^'"]*resolver/.test(text) || text.includes('speckl/resolver');
    });
    expect(hits).toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      found.push(...sourceFiles(child));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      found.push(child);
    }
  }
  return found;
}
