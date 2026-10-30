import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { assertRecordId } from './record-id.js';
import {
  ResolverError,
  type RecordShape,
  type ResolverBackend,
} from './types.js';

export interface FilesystemBackendOptions {
  /** Registry name. Default `filesystem`. */
  name?: string;
}

interface StoredRecord {
  measurementClass: string;
  attributes: Record<string, unknown>;
}

/**
 * A directory of Markdown records. A record is a `*.md` file whose body
 * starts with YAML frontmatter:
 *
 * ```markdown
 * ---
 * id: backup/exampleco/2026-09-19
 * measurement_class: backup.restore_probe
 * ---
 * Prose the compiler does not interpret.
 * ```
 *
 * `measurementClass` is accepted as an alias of `measurement_class`. The id
 * is the frontmatter `id`, not the file path. Files without frontmatter, and
 * files that are not Markdown, are skipped. A record with frontmatter that
 * is missing an id or a measurement class fails the whole load (`malformed`),
 * so a bad record is not silently dropped.
 *
 * Symlinks are not followed. Record ids are map keys, never paths.
 */
export function filesystemBackend(
  rootDir: string,
  options: FilesystemBackendOptions = {},
): ResolverBackend {
  const records = loadRecords(rootDir);
  const name = options.name ?? 'filesystem';
  return {
    name,
    exists(id: string): boolean {
      return records.has(id);
    },
    lookup(id: string): RecordShape | null {
      const found = records.get(id);
      if (!found) return null;
      return {
        id,
        measurementClass: found.measurementClass,
        attributes: { ...found.attributes },
      };
    },
  };
}

function loadRecords(rootDir: string): Map<string, StoredRecord> {
  let rootStat;
  try {
    rootStat = statSync(rootDir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ResolverError(`cannot read record directory ${rootDir}: ${detail}`, {
      code: 'malformed',
      cause: err,
    });
  }
  if (!rootStat.isDirectory()) {
    throw new ResolverError(`record directory is not a directory: ${rootDir}`, {
      code: 'malformed',
    });
  }

  const records = new Map<string, StoredRecord>();
  const origins = new Map<string, string>();
  for (const file of markdownFiles(rootDir)) {
    const stored = readRecord(file);
    if (!stored) continue;
    const previous = origins.get(stored.id);
    if (previous) {
      throw new ResolverError(
        `${file}: record id "${stored.id}" is already defined in ${previous}`,
        { code: 'malformed', recordId: stored.id },
      );
    }
    origins.set(stored.id, file);
    records.set(stored.id, stored.record);
  }
  return records;
}

function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ResolverError(`cannot read record directory ${dir}: ${detail}`, {
      code: 'malformed',
      cause: err,
    });
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...markdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      found.push(path);
    }
  }
  found.sort();
  return found;
}

function readRecord(file: string): { id: string; record: StoredRecord } | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ResolverError(`cannot read record ${file}: ${detail}`, {
      code: 'malformed',
      cause: err,
    });
  }
  const data = frontmatter(text, file);
  if (!data) return undefined;

  const idValue = data.id;
  if (typeof idValue !== 'string') {
    throw new ResolverError(`${file}: id must be a non-empty string`, { code: 'malformed' });
  }
  assertRecordId(idValue, file);

  const measurementClass = measurementClassOf(data, file);
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'id' || key === 'measurement_class' || key === 'measurementClass') continue;
    attributes[key] = value;
  }
  return { id: idValue, record: { measurementClass, attributes } };
}

function frontmatter(text: string, file: string): Record<string, unknown> | undefined {
  if (!text.startsWith('---')) return undefined;
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new ResolverError(`${file}: markdown record has an unclosed frontmatter block`, {
      code: 'malformed',
    });
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(match[1] ?? '');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ResolverError(`${file}: frontmatter is not valid YAML: ${detail}`, {
      code: 'malformed',
      cause: err,
    });
  }
  if (parsed === null || parsed === undefined) {
    throw new ResolverError(`${file}: frontmatter is empty`, { code: 'malformed' });
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ResolverError(`${file}: frontmatter must be a YAML mapping`, { code: 'malformed' });
  }
  return parsed as Record<string, unknown>;
}

function measurementClassOf(data: Record<string, unknown>, file: string): string {
  const snake = data.measurement_class;
  const camel = data.measurementClass;
  if (snake !== undefined && camel !== undefined && snake !== camel) {
    throw new ResolverError(
      `${file}: measurement_class and measurementClass disagree`,
      { code: 'malformed' },
    );
  }
  const value = snake !== undefined ? snake : camel;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ResolverError(`${file}: measurement_class must be a non-empty string`, {
      code: 'malformed',
    });
  }
  return value.trim();
}
