// Round 6: Linux /proc errors stay distinct, and a directory swapped for a
// symlink after its fd was checked is rejected by the parent dev/ino recheck.
import { it, expect, vi } from 'vitest';
import * as realFs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const hooks: {
  afterOpen?: (opened: string) => void;
  readlinkMode?: 'enoent' | 'eacces' | 'deleted' | 'missing';
  procProbe?: 'enoent' | 'eacces';
  openCode?: string;
} = {};

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: ((opened: realFs.PathLike, flags: number) => {
      if (hooks.openCode) {
        const err = new Error(hooks.openCode) as NodeJS.ErrnoException;
        err.code = hooks.openCode;
        throw err;
      }
      const fd = actual.openSync(opened, flags);
      hooks.afterOpen?.(String(opened));
      return fd;
    }) as typeof actual.openSync,
    readlinkSync: ((opened: realFs.PathLike) => {
      const name = String(opened);
      if (name.startsWith('/proc/') && hooks.readlinkMode === 'enoent') {
        const err = new Error(`ENOENT: no such file or directory, readlink '${name}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      if (name.startsWith('/proc/') && hooks.readlinkMode === 'eacces') {
        const err = new Error(`EACCES: permission denied, readlink '${name}'`) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      const linked = actual.readlinkSync(opened);
      if (name.startsWith('/proc/self/fd/') && hooks.readlinkMode === 'deleted') {
        return `${linked} (deleted)`;
      }
      if (name.startsWith('/proc/self/fd/') && hooks.readlinkMode === 'missing') {
        return '/no/such/opened-record-path';
      }
      return linked;
    }) as typeof actual.readlinkSync,
    lstatSync: ((opened: realFs.PathLike) => {
      const name = String(opened);
      if (name === '/proc/self' && hooks.procProbe) {
        const err = new Error(`${hooks.procProbe}: lstat '/proc/self'`) as NodeJS.ErrnoException;
        err.code = hooks.procProbe === 'enoent' ? 'ENOENT' : 'EACCES';
        throw err;
      }
      return actual.lstatSync(opened);
    }) as typeof actual.lstatSync,
  };
});

const { filesystemBackend, ResolverError } = await import('../index.js');

function reset(): void {
  hooks.afterOpen = undefined;
  hooks.readlinkMode = undefined;
  hooks.procProbe = undefined;
  hooks.openCode = undefined;
}

function tempDir(): string {
  return realFs.mkdtempSync(path.join(realFs.realpathSync(tmpdir()), 'r6-'));
}

function writeRecord(dir: string, name: string, id: string): void {
  realFs.writeFileSync(
    path.join(dir, name),
    `---\nid: ${id}\nmeasurement_class: c\n---\n`,
  );
}

function loadError(dir: string): { code: string; message: string } {
  try {
    filesystemBackend(dir);
  } catch (err) {
    expect(err).toBeInstanceOf(ResolverError);
    return err as { code: string; message: string };
  }
  throw new Error('load succeeded');
}

const linux = process.platform === 'linux';

it.skipIf(!linux)('names /proc when Linux cannot verify an opened path', () => {
  reset();
  const dir = tempDir();
  writeRecord(dir, 'r.md', 'inside');
  hooks.readlinkMode = 'enoent';
  hooks.procProbe = 'enoent';
  const err = loadError(dir);
  expect(err.code).toBe('malformed');
  expect(err.message).toContain('cannot verify opened path: /proc not mounted');
  reset();
});

it.skipIf(!linux)('keeps a generic message when /proc exists but the fd link is missing', () => {
  reset();
  const dir = tempDir();
  writeRecord(dir, 'r.md', 'inside');
  hooks.readlinkMode = 'enoent';
  const err = loadError(dir);
  expect(err.message).toContain('cannot verify the opened path');
  expect(err.message).not.toContain('/proc not mounted');
  reset();
});

it.skipIf(!linux)('keeps a generic message when /proc cannot be probed', () => {
  reset();
  const dir = tempDir();
  writeRecord(dir, 'r.md', 'inside');
  hooks.readlinkMode = 'enoent';
  hooks.procProbe = 'eacces';
  const err = loadError(dir);
  expect(err.message).toContain('cannot verify the opened path');
  expect(err.message).not.toContain('/proc not mounted');
  hooks.readlinkMode = 'eacces';
  hooks.procProbe = undefined;
  const denied = loadError(dir);
  expect(denied.message).toContain('cannot verify the opened path');
  expect(denied.message).not.toContain('/proc not mounted');
  reset();
});

it.skipIf(!linux)('says the file was renamed when the opened path is deleted', () => {
  reset();
  const dir = tempDir();
  writeRecord(dir, 'r.md', 'inside');
  hooks.readlinkMode = 'deleted';
  const err = loadError(dir);
  expect(err.code).toBe('malformed');
  expect(err.message).toContain('cannot verify opened path: file was renamed during the load');
  hooks.readlinkMode = 'missing';
  const other = loadError(dir);
  expect(other.message).toContain('cannot verify the opened path');
  expect(other.message).not.toContain('renamed during the load');
  reset();
});

it('gives ENOTDIR and EAGAIN their own errors', () => {
  reset();
  const dir = tempDir();
  writeRecord(dir, 'r.md', 'inside');
  hooks.openCode = 'ENOTDIR';
  const notDir = loadError(dir);
  expect(notDir.message).toContain('a path component is not a directory');
  expect(notDir.message).not.toContain('symlink');
  hooks.openCode = 'EAGAIN';
  const again = loadError(dir);
  expect(again.message).toContain('opening the record would block');
  expect(again.message).not.toContain('symlink');
  hooks.openCode = 'ELOOP';
  const loop = loadError(dir);
  expect(loop.message).toContain('symlink in a record directory is not followed and is not skipped');
  reset();
});

it('rejects a subdirectory replaced after its descriptor was checked', () => {
  reset();
  const dir = tempDir();
  const root = path.join(dir, 'root');
  const outside = path.join(dir, 'outside');
  const sub = path.join(root, 'sub');
  realFs.mkdirSync(sub, { recursive: true });
  realFs.mkdirSync(outside);
  writeRecord(sub, 'r.md', 'inside');
  writeRecord(outside, 'r.md', 'outside-secret');
  hooks.afterOpen = (opened) => {
    if (opened !== sub) return;
    hooks.afterOpen = undefined;
    realFs.renameSync(sub, path.join(root, 'sub-held'));
    realFs.symlinkSync(outside, sub);
  };
  const err = loadError(root);
  expect(err.message).toContain('directory changed after it was resolved');
  expect(err.message).not.toContain('outside-secret');
  reset();
});

it('rejects a subdirectory replaced by a new directory or a file', () => {
  reset();
  for (const kind of ['dir', 'file', 'gone'] as const) {
    const dir = tempDir();
    const root = path.join(dir, 'root');
    const sub = path.join(root, 'sub');
    realFs.mkdirSync(sub, { recursive: true });
    writeRecord(sub, 'r.md', 'inside');
    hooks.afterOpen = (opened) => {
      if (opened !== sub) return;
      hooks.afterOpen = undefined;
      realFs.renameSync(sub, path.join(root, 'sub-held'));
      if (kind === 'dir') realFs.mkdirSync(sub);
      if (kind === 'file') realFs.writeFileSync(sub, 'not a directory');
    };
    const err = loadError(root);
    if (kind === 'gone') expect(err.message).toContain(`cannot read record directory ${sub}`);
    else expect(err.message).toContain('directory changed after it was resolved');
    reset();
  }
});
