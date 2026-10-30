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
 * A string is parsed as JSON. A plain object is used as the map. The backend
 * holds the map in memory. `exists` and `lookup` do not read the filesystem
 * and do not use the network.
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
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResolverError(
      'manifest must be a JSON object mapping record ids to measurement classes',
      { code: 'malformed' },
    );
  }
  const records = new Map<string, string>();
  for (const [id, klass] of Object.entries(value)) {
    assertRecordId(id, 'manifest');
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
      return records.has(id);
    },
    lookup(id: string): RecordShape | null {
      const measurementClass = records.get(id);
      if (measurementClass === undefined) return null;
      return { id, measurementClass, attributes: {} };
    },
  };
}
