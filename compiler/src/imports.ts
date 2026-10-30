// Resolve `import "path"` against the directory of the file that writes it.
// Nested imports use the imported file's directory. There is no package registry.
//
// The default root is the entry file's directory. An import must be a relative
// path, and its real path (after symlinks) must stay inside the root. Pass
// `rootDir` — the CLI's `--root` — to widen that directory.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { AST, ImportNode, parseSpeckContent, parsedSource, SpeckNode } from './parser.js';

export interface ImportLink {
  /** Speck that declared the import, or `*` for a file-level import on the root. */
  owner: string;
  node: ImportNode;
  /** Absolute path of the imported file. */
  file: string;
  /** Speck names declared by that file. */
  speckNames: string[];
}

export interface ExpandOptions {
  /**
   * Directory imports may resolve inside, after symlinks.
   * Default: the directory of `entryPath`.
   */
  rootDir?: string;
}

/** A chain longer than this is an error, not a stack overflow. */
const MAX_IMPORT_DEPTH = 64;

interface CachedFile {
  buf: Buffer;
  text: string;
  ast: AST;
}

/**
 * Verified text for one expand, keyed by realpath and tied to the AST
 * `expandImports` returned. A later parse is a different object and does
 * not see this text.
 */
const sourceOf = new WeakMap<AST, Map<string, string>>();

export function verifiedSource(ast: AST, filePath: string): string | undefined {
  const files = sourceOf.get(ast);
  if (!files) return undefined;
  const hit = files.get(filePath);
  if (hit !== undefined) return hit;
  try {
    return files.get(realpathSync(filePath));
  } catch {
    return undefined;
  }
}

const linksOf = new WeakMap<AST, ImportLink[]>();
const originOf = new WeakMap<AST, Map<string, string>>();
const expanded = new WeakSet<AST>();

export function importsExpanded(ast: AST): boolean {
  return expanded.has(ast);
}

export function importLinks(ast: AST): ImportLink[] {
  return linksOf.get(ast) ?? [];
}

export function speckSourceFile(ast: AST, name: string, fallback: string): string {
  return originOf.get(ast)?.get(name) ?? fallback;
}

/**
 * Read imported files and append their specks. Throws on a missing file,
 * a cycle, a too-deep chain, a hash mismatch, an empty or short hash,
 * a path that leaves the import root, a duplicate alias, or the same
 * speck name twice. The entry tree is the AST that was passed in. Imported
 * files are read from disk. A file with no imports is that same AST.
 */
export function expandImports(ast: AST, entryPath: string, options: ExpandOptions = {}): AST {
  if (importsExpanded(ast)) return ast;
  let entryAbs: string;
  try {
    entryAbs = realpathSync(entryPath);
  } catch {
    throw cannotRead(entryPath, entryPath);
  }
  const entryText = parsedSource(ast);
  const files = new Map<string, string>();
  if (entryText !== undefined) files.set(entryAbs, entryText);
  const rootDir = realpathSync(options.rootDir ? resolve(options.rootDir) : dirname(entryAbs));
  const rootHas = (ast.imports?.length ?? 0) > 0
    || ast.specks.some(s => s.members.some(m => m.type === 'import'));
  if (!rootHas) {
    sourceOf.set(ast, files);
    linksOf.set(ast, []);
    originOf.set(ast, new Map(ast.specks.map(s => [s.name, entryAbs])));
    expanded.add(ast);
    return ast;
  }

  const origin = new Map<string, string>();
  const specks: SpeckNode[] = [];
  const links: ImportLink[] = [];
  const stack: string[] = [];
  const stackSet = new Set<string>();
  const done = new Set<string>();
  const cache = new Map<string, CachedFile>();
  const aliasAt = new Set<string>();

  function remember(real: string, buf: Buffer, parsed?: AST): CachedFile {
    const hit = cache.get(real);
    if (hit) return hit;
    const text = buf.toString('utf8');
    const parsedAst = parsed ?? parseSpeckContent(text, real);
    const entry = { buf, text, ast: parsedAst };
    cache.set(real, entry);
    files.set(real, text);
    return entry;
  }

  function importsIn(parsed: AST, abs: string): { owner: string; node: ImportNode }[] {
    const out: { owner: string; node: ImportNode }[] = [];
    for (const node of parsed.imports ?? []) {
      noteAlias(abs, node);
      if (abs === entryAbs) out.push({ owner: '*', node });
      else for (const speck of parsed.specks) out.push({ owner: speck.name, node });
    }
    for (const speck of parsed.specks) {
      for (const member of speck.members) {
        if (member.type === 'import') {
          noteAlias(abs, member);
          out.push({ owner: speck.name, node: member });
        }
      }
    }
    return out;
  }

  function fetchChild(fromAbs: string, node: ImportNode): string {
    if (isAbsolute(node.path)) {
      throw new Error(`Parse error: import "${node.path}" must be a relative path`);
    }
    const target = resolve(dirname(fromAbs), node.path);
    const child = readViaFd(target, rootDir, node.path);
    if (!cache.has(child.real)) remember(child.real, child.buf);
    if (node.hash) verifyHash(cache.get(child.real)!.buf, node.hash, node.path);
    return child.real;
  }

  function noteAlias(abs: string, node: ImportNode): void {
    if (!node.alias) return;
    const key = `${abs}\0${node.alias}`;
    if (aliasAt.has(key)) {
      throw new Error(`Parse error: import alias ${node.alias} is used twice in ${abs}`);
    }
    aliasAt.add(key);
  }

  function load(abs: string, depth: number): void {
    if (done.has(abs)) return;
    if (depth > MAX_IMPORT_DEPTH) {
      throw new Error(`Parse error: import chain is too deep (limit ${MAX_IMPORT_DEPTH}): ${[...stack, abs].join(' -> ')}`);
    }
    if (stackSet.has(abs)) {
      throw new Error(`Parse error: import cycle: ${[...stack, abs].join(' -> ')}`);
    }
    stackSet.add(abs);
    stack.push(abs);
    const parsed = cache.get(abs)!.ast;
    if (abs !== entryAbs && parsed.specks.length === 0) {
      throw new Error(`Parse error: import "${abs}" declares no specks`);
    }
    const seenHere = new Set<string>();
    for (const speck of parsed.specks) {
      if (seenHere.has(speck.name)) {
        throw new Error(`Parse error: speck ${speck.name} is declared twice in ${abs}`);
      }
      seenHere.add(speck.name);
      const prev = origin.get(speck.name);
      if (prev && prev !== abs) {
        throw new Error(`Parse error: speck ${speck.name} is declared in ${prev} and ${abs}`);
      }
      if (!prev) {
        origin.set(speck.name, abs);
        specks.push(speck);
      }
    }
    for (const { owner, node } of importsIn(parsed, abs)) {
      const child = fetchChild(abs, node);
      load(child, depth + 1);
      const names = parsedNames(cache.get(child)!.ast);
      if (!links.some(l => l.owner === owner && l.file === child && l.node.path === node.path && l.node.alias === node.alias)) {
        links.push({ owner, node, file: child, speckNames: names });
      }
    }
    stack.pop();
    stackSet.delete(abs);
    done.add(abs);
  }

  cache.set(entryAbs, { buf: Buffer.from(entryText ?? '', 'utf8'), text: entryText ?? '', ast });
  load(entryAbs, 0);

  // Root file-level imports apply to every speck declared in the root file.
  const rootNames = (cache.get(entryAbs)?.ast.specks ?? []).map(s => s.name);
  const lifted: ImportLink[] = [];
  for (const link of links) {
    if (link.owner !== '*') {
      lifted.push(link);
      continue;
    }
    for (const name of rootNames) {
      lifted.push({ ...link, owner: name });
    }
  }

  const out: AST = { specks };
  if (ast.imports?.length) out.imports = ast.imports;
  sourceOf.set(out, files);
  linksOf.set(out, lifted);
  originOf.set(out, origin);
  expanded.add(out);
  return out;
}

function parsedNames(ast: AST): string[] {
  return ast.specks.map(s => s.name);
}

function outsideRoot(rootReal: string, real: string): boolean {
  const rel = relative(rootReal, real);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function errno(err: unknown): string | undefined {
  return err !== null && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : undefined;
}

function cannotRead(specPath: string, candidate: string): Error {
  return new Error(`Parse error: cannot read import "${specPath}" (resolved ${candidate})`);
}

function outsideError(specPath: string, rootReal: string): Error {
  return new Error(`Parse error: import "${specPath}" resolves outside the import root ${rootReal}`);
}

function changedError(specPath: string): Error {
  return new Error(`Parse error: import "${specPath}" changed while reading`);
}

/**
 * Open for reading. `O_NONBLOCK` so a FIFO named `*.speckdl` does not hang.
 * `O_NOFOLLOW` when the platform has it, so the last component is not a symlink.
 * A flag the OS rejects is retried without that flag. `ENXIO` is not retried:
 * that would block on a FIFO.
 */
function openRead(candidate: string): number {
  const nonblock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0;
  const nofollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const sets = [constants.O_RDONLY | nonblock | nofollow];
  if (nofollow !== 0) sets.push(constants.O_RDONLY | nonblock);
  if (nonblock !== 0) sets.push(constants.O_RDONLY);
  let last: unknown;
  for (const flags of sets) {
    try {
      return openSync(candidate, flags);
    } catch (err) {
      last = err;
      const code = errno(err);
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw err;
    }
  }
  throw last;
}

function sameInode(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Open `candidate` and read that fd. `realpath` of the path must stay inside
 * `rootReal` and name the same inode as the fd, before and after the read.
 * On Linux, `/proc/self/fd` is an extra check. A missing `/proc` (macOS,
 * Windows, or a stub that throws `ENOENT`) is not an error.
 */
function readViaFd(candidate: string, rootReal: string | null, specPath: string, followed = false): { real: string; buf: Buffer } {
  let fd: number;
  try {
    fd = openRead(candidate);
  } catch (err) {
    if (errno(err) === 'ELOOP' && !followed) return readSymlink(candidate, rootReal, specPath);
    throw cannotRead(specPath, candidate);
  }
  try {
    return readOpened(fd, candidate, rootReal, specPath);
  } finally {
    closeSync(fd);
  }
}

/** `O_NOFOLLOW` refused a symlink. Follow it only when the target stays inside the root. */
function readSymlink(candidate: string, rootReal: string | null, specPath: string): { real: string; buf: Buffer } {
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw cannotRead(specPath, candidate);
  }
  if (rootReal && outsideRoot(rootReal, real)) throw outsideError(specPath, rootReal);
  return readViaFd(real, rootReal, specPath, true);
}

function readOpened(fd: number, candidate: string, rootReal: string | null, specPath: string): { real: string; buf: Buffer } {
  const st = fstatSync(fd);
  if (!st.isFile()) throw cannotRead(specPath, candidate);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw changedError(specPath);
  }
  if (rootReal && outsideRoot(rootReal, real)) throw outsideError(specPath, rootReal);
  let stReal: { dev: number; ino: number };
  try {
    stReal = statSync(real);
  } catch {
    throw changedError(specPath);
  }
  if (!sameInode(st, stReal)) throw changedError(specPath);
  const buf = readFileSync(fd);
  let stAfter: { dev: number; ino: number };
  try {
    stAfter = statSync(real);
  } catch {
    throw changedError(specPath);
  }
  if (!sameInode(st, stAfter)) throw changedError(specPath);
  assertProcAgrees(fd, real, specPath);
  return { real, buf };
}

function assertProcAgrees(fd: number, real: string, specPath: string): void {
  try {
    const via = realpathSync(`/proc/self/fd/${fd}`);
    if (via !== real) throw changedError(specPath);
  } catch (err) {
    if (errno(err) === 'ENOENT' || errno(err) === 'ENOTDIR' || errno(err) === 'EINVAL'
      || errno(err) === 'EACCES' || errno(err) === 'EPERM' || errno(err) === 'ENOSYS') return;
    throw err;
  }
}

/** Hash the raw file bytes. A pin must be 64 hex digits. */
export function verifyHash(buf: Buffer, pin: string, specPath: string): void {
  const hex = pin.replace(/^sha256:/i, '').trim();
  if (hex === '') {
    throw new Error(`Parse error: empty hash on import "${specPath}"`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`Parse error: hash on import "${specPath}" must be 64 hex characters`);
  }
  const got = createHash('sha256').update(buf).digest('hex');
  if (got.toLowerCase() !== hex.toLowerCase()) {
    throw new Error(`Parse error: hash mismatch for import "${specPath}"`);
  }
}
