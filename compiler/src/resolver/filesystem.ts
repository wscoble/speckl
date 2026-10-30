import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { plainCopy, plainRecord } from './plain.js';
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

/** A record file larger than this is `malformed`. The body is not read. */
export const MAX_RECORD_BYTES = 1024 * 1024;

/** Nested directories deeper than this are `malformed`. The root is depth 0. */
export const MAX_DIRECTORY_DEPTH = 32;

interface StoredRecord {
  measurementClass: string;
  attributes: Record<string, unknown>;
}

/**
 * A directory of Markdown records. A record is a `.md` or `.markdown` file,
 * compared case-insensitively, whose body starts with YAML frontmatter:
 *
 * ```markdown
 * ---
 * id: backup/exampleco/2026-09-19
 * measurement_class: backup.restore_probe
 * ---
 * Prose the compiler does not interpret.
 * ```
 *
 * A leading UTF-8 BOM is stripped and the file still loads. `measurementClass`
 * is an alias of `measurement_class`. The id is the frontmatter `id`, not the
 * file path. A file that is not Markdown, and a Markdown file with no
 * frontmatter, is skipped. A Markdown file that has frontmatter but is
 * missing an id or a measurement class fails the whole load (`malformed`).
 * A symlink, a file over {@link MAX_RECORD_BYTES}, or a directory nested
 * deeper than {@link MAX_DIRECTORY_DEPTH} also fails the load. Those cases
 * are not skipped.
 *
 * Symlinks are not followed. Record ids are map keys, never paths.
 * `lookup` returns a deep copy. Nested attributes are not shared with the
 * stored record, and a `__proto__` key stays an own property.
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
      return records.has(assertRecordId(id, 'query'));
    },
    lookup(id: string): RecordShape | null {
      const key = assertRecordId(id, 'query');
      const found = records.get(key);
      if (!found) return null;
      return {
        id: key,
        measurementClass: found.measurementClass,
        attributes: plainCopy(found.attributes) as Record<string, unknown>,
      };
    },
  };
}

function loadRecords(rootDir: string): Map<string, StoredRecord> {
  let rootStat;
  try {
    rootStat = lstatSync(rootDir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ResolverError(`cannot read record directory ${rootDir}: ${detail}`, {
      code: 'malformed',
      cause: err,
    });
  }
  if (rootStat.isSymbolicLink()) {
    throw new ResolverError(`record directory is a symlink: ${rootDir}`, { code: 'malformed' });
  }
  if (!rootStat.isDirectory()) {
    throw new ResolverError(`record directory is not a directory: ${rootDir}`, {
      code: 'malformed',
    });
  }

  const records = new Map<string, StoredRecord>();
  const origins = new Map<string, string>();
  for (const file of markdownFiles(rootDir, 0)) {
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

function markdownFiles(dir: string, depth: number): string[] {
  if (depth > MAX_DIRECTORY_DEPTH) {
    throw new ResolverError(
      `record directory is nested more than ${MAX_DIRECTORY_DEPTH} levels: ${dir}`,
      { code: 'malformed' },
    );
  }
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
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ResolverError(
        `${path}: symlink in a record directory is not followed and is not skipped`,
        { code: 'malformed' },
      );
    }
    if (entry.isDirectory()) {
      found.push(...markdownFiles(path, depth + 1));
    } else if (entry.isFile() && isMarkdownName(entry.name)) {
      found.push(path);
    }
  }
  found.sort();
  return found;
}

function isMarkdownName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

function readRecord(file: string): { id: string; record: StoredRecord } | undefined {
  let size: number;
  try {
    size = statSync(file).size;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ResolverError(`cannot read record ${file}: ${detail}`, {
      code: 'malformed',
      cause: err,
    });
  }
  if (size > MAX_RECORD_BYTES) {
    throw new ResolverError(
      `${file}: record is ${size} bytes, over the ${MAX_RECORD_BYTES} byte limit`,
      { code: 'malformed' },
    );
  }
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
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const data = frontmatter(text, file);
  if (!data) return undefined;

  const idValue = data.id;
  if (typeof idValue !== 'string') {
    throw new ResolverError(`${file}: id must be a non-empty string`, { code: 'malformed' });
  }
  const id = assertRecordId(idValue, file);
  const measurementClass = measurementClassOf(data, file);
  delete data.id;
  delete data.measurement_class;
  delete data.measurementClass;
  return { id, record: { measurementClass, attributes: data } };
}

function frontmatter(text: string, file: string): Record<string, unknown> | undefined {
  if (!text.startsWith('---')) return undefined;
  if (/^---\r?\n---(?:\r?\n|$)/.test(text)) {
    throw new ResolverError(`${file}: frontmatter is empty`, { code: 'malformed' });
  }
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
  return plainRecord(parsed);
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
