import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, parse as parsePath, resolve, sep } from 'node:path';
import * as yaml from 'js-yaml';
import { plainCopy, plainRecord } from './plain.js';
import { assertMeasurementClass, assertRecordId } from './record-id.js';
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
 * A symlink anywhere in the root's path, a symlink entry under the root, a
 * file over {@link MAX_RECORD_BYTES}, a directory nested deeper than
 * {@link MAX_DIRECTORY_DEPTH}, or YAML anchors and aliases also fail the
 * load. Those cases are not skipped. A hard link is an ordinary file: the
 * kernel does not say it has another name, so containment cannot see it,
 * and the record loads.
 *
 * Symlinks are not followed. Record ids are map keys, never paths.
 * `lookup` returns a deep copy. Nested attributes are not shared with the
 * stored record, and a `__proto__` key stays an own property. A YAML alias
 * is rejected before the copy, so a shared document is not expanded into a tree.
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
  assertNoSymlinkInPath(rootDir);
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
  const measurementClass = assertMeasurementClass(measurementClassOf(data, file), file);
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
  const body = match[1] ?? '';
  assertNoYamlAliases(body, file);
  let parsed: unknown;
  try {
    parsed = yaml.load(body);
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
  try {
    return plainRecord(parsed);
  } catch (err) {
    if (err instanceof ResolverError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new ResolverError(`${file}: frontmatter cannot be copied: ${detail}`, {
      code: 'malformed',
      cause: err,
    });
  }
}

function assertNoYamlAliases(text: string, file: string): void {
  let i = 0;
  let quote: '"' | "'" | null = null;
  while (i < text.length) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'" && text[i + 1] === "'") { i += 2; continue; }
      if (c === "'") quote = null;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') quote = null;
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; i += 1; continue; }
    if ((c === '&' || c === '*') && i + 1 < text.length && /[A-Za-z0-9_]/.test(text[i + 1]!)) {
      throw new ResolverError(`${file}: YAML anchors and aliases are not allowed`, {
        code: 'malformed',
      });
    }
    i += 1;
  }
}

function assertNoSymlinkInPath(rootDir: string): void {
  const abs = resolve(rootDir);
  const parts = abs.split(sep).filter((part) => part.length > 0);
  let cur = parsePath(abs).root;
  for (const part of parts) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ResolverError(`cannot read record directory ${rootDir}: ${detail}`, {
        code: 'malformed',
        cause: err,
      });
    }
    if (st.isSymbolicLink()) {
      throw new ResolverError(`record path contains a symlink: ${cur}`, { code: 'malformed' });
    }
  }
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
