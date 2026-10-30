import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { constructFromEvents, EVENT_ALIAS, parseEvents } from 'js-yaml';
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
 * The root is `realpathSync.native`'d once, so `..` is resolved after
 * symlinks the way the operating system resolves it. Symlinks on the way
 * to that directory,
 * including a symlink such as macOS `/tmp`, are followed and are not
 * errors. Every read uses that resolved path. A symlink found under the
 * resolved root fails the load, including one swapped in after the listing.
 * Each listed entry's device and inode are recorded with `lstat`. The open
 * uses `O_RDONLY | O_NONBLOCK` and `O_NOFOLLOW` where the platform has it.
 * `fstat` on that descriptor must be the same device and inode, and a
 * record must be a regular file. On Linux, `readlink` of `/proc/self/fd/N`
 * must still point inside the resolved root. A mismatch, or a check that
 * cannot be done, is `malformed`. Without `O_NOFOLLOW` (Windows), the open
 * may follow a symlink and the device/inode check then fails closed.
 * A hard link has no symlink bit and no second name the kernel will report,
 * so it loads. A Markdown file whose first line is blank, before `---`,
 * has no frontmatter and is skipped. Replacing a file's bytes without
 * changing its device and inode is not detected.
 *
 * A file over {@link MAX_RECORD_BYTES}, or a directory nested deeper than
 * {@link MAX_DIRECTORY_DEPTH}, fails the load. YAML anchors and aliases are
 * rejected from the parser's event stream, before the document is built, so
 * a shared node is never expanded into a tree. `team: R&D`, a query string,
 * `rto*2`, and `&` inside a block scalar are ordinary text and load.
 *
 * Record ids are map keys, never paths. `lookup` returns a deep copy.
 * Nested attributes are not shared with the stored record, and a `__proto__`
 * key stays an own property.
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
  const resolved = resolveRecordRoot(rootDir);

  const records = new Map<string, StoredRecord>();
  const origins = new Map<string, string>();
  for (const file of markdownFiles(resolved, 0, resolved)) {
    const stored = readRecord(file, resolved);
    if (!stored) continue;
    const previous = origins.get(stored.id);
    if (previous) {
      throw new ResolverError(
        `${file.path}: record id "${stored.id}" is already defined in ${previous}`,
        { code: 'malformed', recordId: stored.id },
      );
    }
    origins.set(stored.id, file.path);
    records.set(stored.id, stored.record);
  }
  return records;
}

interface ListedEntry {
  path: string;
  dev: number;
  ino: number;
}

function markdownFiles(dir: string, depth: number, root: string): ListedEntry[] {
  if (depth > MAX_DIRECTORY_DEPTH) {
    throw new ResolverError(
      `record directory is nested more than ${MAX_DIRECTORY_DEPTH} levels: ${dir}`,
      { code: 'malformed' },
    );
  }
  const found: ListedEntry[] = [];
  for (const entry of listDirectory(dir)) {
    if (entry.kind === 'dir') {
      const fd = openListed(entry, root, true);
      closeSync(fd);
      found.push(...markdownFiles(entry.path, depth + 1, root));
    } else if (entry.kind === 'file' && isMarkdownName(entry.name)) {
      found.push(entry);
    }
  }
  found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return found;
}

function listDirectory(dir: string): Array<ListedEntry & { name: string; kind: 'dir' | 'file' | 'other' }> {
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
  const listed = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    let st;
    try {
      st = lstatSync(entryPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ResolverError(`cannot read record ${entryPath}: ${detail}`, {
        code: 'malformed',
        cause: err,
      });
    }
    if (st.isSymbolicLink() || entry.isSymbolicLink()) {
      throw new ResolverError(
        `${entryPath}: symlink in a record directory is not followed and is not skipped`,
        { code: 'malformed' },
      );
    }
    const kind = st.isDirectory() ? 'dir' as const : st.isFile() ? 'file' as const : 'other' as const;
    listed.push({ name: entry.name, path: entryPath, dev: st.dev, ino: st.ino, kind });
  }
  return listed;
}

function isMarkdownName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

function readRecord(file: ListedEntry, root: string): { id: string; record: StoredRecord } | undefined {
  let text = readRecordDescriptor(file, root);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const data = frontmatter(text, file.path);
  if (!data) return undefined;

  const idValue = data.id;
  if (typeof idValue !== 'string') {
    throw new ResolverError(`${file.path}: id must be a non-empty string`, { code: 'malformed' });
  }
  const id = assertRecordId(idValue, file.path);
  const measurementClass = assertMeasurementClass(measurementClassOf(data, file.path), file.path);
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
  const parsed = loadYamlDocument(body, file);
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

function readRecordDescriptor(file: ListedEntry, root: string): string {
  const fd = openListed(file, root, false);
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function openListed(entry: ListedEntry, root: string, directory: boolean): number {
  let flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
  if (constants.O_NOFOLLOW) flags |= constants.O_NOFOLLOW;
  if (directory && constants.O_DIRECTORY) flags |= constants.O_DIRECTORY;
  let fd: number;
  try {
    fd = openSync(entry.path, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const detail = err instanceof Error ? err.message : String(err);
    if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EAGAIN') {
      throw new ResolverError(
        `${entry.path}: symlink in a record directory is not followed and is not skipped`,
        { code: 'malformed', cause: err },
      );
    }
    throw new ResolverError(`cannot read record ${entry.path}: ${detail}`, {
      code: 'malformed',
      cause: err,
    });
  }
  try {
    const st = fstatSync(fd);
    if (st.dev !== entry.dev || st.ino !== entry.ino) {
      throw new ResolverError(
        `${entry.path}: directory entry changed after listing`,
        { code: 'malformed' },
      );
    }
    if (directory) {
      if (!st.isDirectory()) {
        throw new ResolverError(`${entry.path}: record directory is not a directory`, {
          code: 'malformed',
        });
      }
    } else if (!st.isFile()) {
      throw new ResolverError(`${entry.path}: record is not a regular file`, { code: 'malformed' });
    } else if (st.size > MAX_RECORD_BYTES) {
      throw new ResolverError(
        `${entry.path}: record is ${st.size} bytes, over the ${MAX_RECORD_BYTES} byte limit`,
        { code: 'malformed' },
      );
    }
    assertFdInsideRoot(fd, root, entry.path);
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

function assertFdInsideRoot(fd: number, root: string, label: string): void {
  if (process.platform !== 'linux') return;
  let linked: string;
  try {
    linked = readlinkSync(`/proc/self/fd/${fd}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ResolverError(`${label}: cannot verify the opened path: ${detail}`, {
      code: 'malformed',
      cause: err,
    });
  }
  let resolved: string;
  try {
    resolved = realpathSync.native(linked);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ResolverError(`${label}: cannot verify the opened path: ${detail}`, {
      code: 'malformed',
      cause: err,
    });
  }
  if (resolved !== root && !resolved.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new ResolverError(`${label}: opened path is outside the record root`, { code: 'malformed' });
  }
}

function loadYamlDocument(text: string, file: string): unknown {
  let events: ReturnType<typeof parseEvents>;
  try {
    events = parseEvents(text, { filename: file });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ResolverError(`${file}: frontmatter is not valid YAML: ${detail}`, {
      code: 'malformed',
      cause: err,
    });
  }
  for (const event of events) {
    if (event.type === EVENT_ALIAS || ('anchorStart' in event && event.anchorStart >= 0)) {
      throw new ResolverError(`${file}: YAML anchors and aliases are not allowed`, {
        code: 'malformed',
      });
    }
  }
  let documents: unknown[];
  try {
    documents = constructFromEvents(events, { source: text });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ResolverError(`${file}: frontmatter is not valid YAML: ${detail}`, {
      code: 'malformed',
      cause: err,
    });
  }
  if (documents.length !== 1) {
    throw new ResolverError(`${file}: frontmatter must be a single YAML document`, {
      code: 'malformed',
    });
  }
  return documents[0];
}

function resolveRecordRoot(rootDir: string): string {
  let resolved: string;
  try {
    resolved = realpathSync.native(rootDir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ResolverError(`cannot read record directory ${rootDir}: ${detail}`, {
      code: 'malformed',
      cause: err,
    });
  }
  let st;
  try {
    st = lstatSync(resolved);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ResolverError(`cannot read record directory ${rootDir}: ${detail}`, {
      code: 'malformed',
      cause: err,
    });
  }
  if (!st.isDirectory()) {
    throw new ResolverError(`record directory is not a directory: ${rootDir}`, {
      code: 'malformed',
    });
  }
  return resolved;
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
