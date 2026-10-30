import { readFileSync } from 'node:fs';
import { assertRecordId } from './record-id.js';
import {
  ResolverError,
  type RecordShape,
  type ResolverBackend,
} from './types.js';

export interface StaticManifestOptions {
  /** Registry name. Default `static-manifest`. */
  name?: string;
}

/**
 * JSON object whose keys are record ids and whose values are measurement
 * class names:
 *
 * ```json
 * { "backup/exampleco/2026-09-19": "backup.restore_probe" }
 * ```
 *
 * A string is parsed as JSON. A repeated key is `malformed`. `JSON.parse`
 * would keep the last one, which is not fail closed. A plain object cannot
 * express a duplicate key, so that path has nothing to reject.
 *
 * The backend holds the map in memory. `exists` and `lookup` do not read
 * the filesystem and do not use the network.
 */
export function staticManifestBackend(
  manifest: string | Record<string, unknown>,
  options: StaticManifestOptions = {},
): ResolverBackend {
  const records = parseManifest(manifest);
  return backendFromMap(options.name ?? 'static-manifest', records);
}

/** Read a manifest file and build a backend. Failure to read or parse is `malformed`. */
export function staticManifestBackendFromFile(
  filePath: string,
  options: StaticManifestOptions = {},
): ResolverBackend {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ResolverError(`cannot read manifest ${filePath}: ${detail}`, {
      code: 'malformed',
      cause: err,
    });
  }
  return staticManifestBackend(text, options);
}

function parseManifest(manifest: string | Record<string, unknown>): Map<string, string> {
  let value: unknown = manifest;
  if (typeof manifest === 'string') {
    try {
      value = JSON.parse(manifest);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ResolverError(`manifest is not valid JSON: ${detail}`, {
        code: 'malformed',
        cause: err,
      });
    }
    assertUniqueJsonKeys(manifest);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResolverError(
      'manifest must be a JSON object mapping record ids to measurement classes',
      { code: 'malformed' },
    );
  }
  const records = new Map<string, string>();
  for (const [rawId, klass] of Object.entries(value)) {
    const id = assertRecordId(rawId, 'manifest');
    if (records.has(id)) {
      throw new ResolverError(`manifest: duplicate record id "${id}"`, {
        code: 'malformed',
        recordId: id,
      });
    }
    if (typeof klass !== 'string' || klass.trim() === '') {
      throw new ResolverError(
        `manifest: measurement class for "${id}" must be a non-empty string`,
        { code: 'malformed', recordId: id },
      );
    }
    records.set(id, klass.trim());
  }
  return records;
}

function backendFromMap(name: string, records: Map<string, string>): ResolverBackend {
  return {
    name,
    exists(id: string): boolean {
      return records.has(assertRecordId(id, 'query'));
    },
    lookup(id: string): RecordShape | null {
      const key = assertRecordId(id, 'query');
      const measurementClass = records.get(key);
      if (measurementClass === undefined) return null;
      return { id: key, measurementClass, attributes: {} };
    },
  };
}

/**
 * Walk JSON text and reject an object key that appears twice at one level.
 * Keys are compared after JSON string decoding, so `a\/b` and `a/b` collide.
 */
function assertUniqueJsonKeys(text: string): void {
  let i = 0;
  const n = text.length;
  const fail = (message: string): never => {
    throw new ResolverError(`manifest: ${message}`, { code: 'malformed' });
  };
  const skipWs = (): void => {
    while (i < n) {
      const c = text[i];
      if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t') return;
      i++;
    }
  };
  const parseString = (): string => {
    if (text[i] !== '"') fail('expected a string');
    const start = i;
    i++;
    while (i < n) {
      const c = text[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        try {
          return JSON.parse(text.slice(start, i)) as string;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          fail(`bad string: ${detail}`);
        }
      }
      i++;
    }
    return fail('unterminated string');
  };
  const skipValue = (): void => {
    skipWs();
    const c = text[i];
    if (c === '"') {
      parseString();
      return;
    }
    if (c === '{') {
      parseObject();
      return;
    }
    if (c === '[') {
      parseArray();
      return;
    }
    if (text.startsWith('true', i)) { i += 4; return; }
    if (text.startsWith('false', i)) { i += 5; return; }
    if (text.startsWith('null', i)) { i += 4; return; }
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
      const start = i;
      if (text[i] === '-') i++;
      while (i < n && text[i]! >= '0' && text[i]! <= '9') i++;
      if (text[i] === '.') {
        i++;
        while (i < n && text[i]! >= '0' && text[i]! <= '9') i++;
      }
      if (text[i] === 'e' || text[i] === 'E') {
        i++;
        if (text[i] === '+' || text[i] === '-') i++;
        while (i < n && text[i]! >= '0' && text[i]! <= '9') i++;
      }
      if (i === start) fail('bad number');
      return;
    }
    fail('expected a JSON value');
  };
  const parseObject = (): void => {
    if (text[i] !== '{') fail('expected an object');
    i++;
    skipWs();
    const seen = new Set<string>();
    if (text[i] === '}') { i++; return; }
    for (;;) {
      skipWs();
      const key = parseString();
      if (seen.has(key)) fail(`duplicate record id "${key}"`);
      seen.add(key);
      skipWs();
      if (text[i] !== ':') fail('expected a colon');
      i++;
      skipValue();
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return; }
      fail('expected a comma or the end of an object');
    }
  };
  const parseArray = (): void => {
    if (text[i] !== '[') fail('expected an array');
    i++;
    skipWs();
    if (text[i] === ']') { i++; return; }
    for (;;) {
      skipValue();
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; return; }
      fail('expected a comma or the end of an array');
    }
  };

  skipWs();
  if (i >= n) fail('manifest is empty');
  if (text[i] === '{') parseObject();
  else skipValue();
  skipWs();
  if (i !== n) fail('trailing data after JSON value');
}
