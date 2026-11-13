// Resolve `import "path"` against the directory of the file that writes it.
// Nested imports use the imported file's directory. There is no package registry.
//
// The default root is the entry file's directory. An import must be a relative
// path, and its real path (after symlinks) must stay inside the root. Pass
// `rootDir` — the CLI's `--root` — to widen that directory.
//
// `\` is a separator and is read as `/` before the path is resolved, so a
// Windows path and a `sub\..\lib.speckdl` path name the same file as their
// `/` form. Letter case is the real path of this operating system: on a
// case-sensitive filesystem `Lib.speckdl` and `lib.speckdl` are different
// files. A failure names the importing file and the line of the import.

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
  let rootDir: string;
  try {
    rootDir = realpathSync(options.rootDir ? resolve(options.rootDir) : dirname(entryAbs));
  } catch (err) {
    const code = errno(err);
    throw new Error(`Parse error: cannot read import root "${options.rootDir ?? dirname(entryAbs)}"${code ? ` (${code})` : ''}`);
  }
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

  function importAt(fromAbs: string, node: ImportNode): string {
    const text = cache.get(fromAbs)?.text ?? '';
    const want = node.path.replace(/\\/g, '/');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\\/g, '/');
      if (/^\s*import\b/.test(line) && line.includes(`"${want}"`)) return `${fromAbs}:${i + 1}`;
    }
    return fromAbs;
  }

  function fetchChild(fromAbs: string, node: ImportNode): string {
    const at = importAt(fromAbs, node);
    const specPath = node.path.replace(/\\/g, '/');
    if (isAbsolute(specPath) || /^[A-Za-z]:\//.test(specPath)) {
      throw new Error(`Parse error at ${at}: import "${node.path}" must be a relative path`);
    }
    const target = resolve(dirname(fromAbs), specPath);
    const child = readViaFd(target, rootDir, specPath, false, at);
    if (!cache.has(child.real)) remember(child.real, child.buf);
    if (node.hash) verifyHash(cache.get(child.real)!.buf, node.hash, specPath, at);
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

function atSuffix(at?: string): string {
  return at ? ` at ${at}` : '';
}

function cannotRead(specPath: string, candidate: string, at?: string): Error {
  return new Error(`Parse error: cannot read import "${specPath}" (resolved ${candidate})${atSuffix(at)}`);
}

function outsideError(specPath: string, rootReal: string, at?: string): Error {
  return new Error(`Parse error: import "${specPath}" resolves outside the import root ${rootReal}${atSuffix(at)}`);
}

function changedError(specPath: string, at?: string): Error {
  return new Error(`Parse error: import "${specPath}" changed while reading${atSuffix(at)}`);
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
 * On Linux, `/proc/self/fd` is an extra check that the fd still names `real`.
 * A missing or unusable `/proc` is not an error. macOS and Windows have no
 * `/proc/self/fd`, and a restricted mount can hide it. The errno values for
 * that are `ENOENT` (the path is absent), `ENOTDIR` (a parent is not a
 * directory), `EINVAL` (the platform rejects the path), `EACCES` or `EPERM`
 * (this process cannot read it), and `ENOSYS` (the call is not implemented).
 * Any other errno, including `EIO`, still throws. A `/proc` result that names
 * a different file throws `changed while reading`.
 */
function readViaFd(candidate: string, rootReal: string | null, specPath: string, followed = false, at?: string): { real: string; buf: Buffer } {
  let fd: number;
  try {
    fd = openRead(candidate);
  } catch (err) {
    if (errno(err) === 'ELOOP' && !followed) return readSymlink(candidate, rootReal, specPath, at);
    throw cannotRead(specPath, candidate, at);
  }
  try {
    return readOpened(fd, candidate, rootReal, specPath, at);
  } finally {
    closeSync(fd);
  }
}

/** `O_NOFOLLOW` refused a symlink. Follow it only when the target stays inside the root. */
function readSymlink(candidate: string, rootReal: string | null, specPath: string, at?: string): { real: string; buf: Buffer } {
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw cannotRead(specPath, candidate, at);
  }
  if (rootReal && outsideRoot(rootReal, real)) throw outsideError(specPath, rootReal, at);
  return readViaFd(real, rootReal, specPath, true, at);
}

function readOpened(fd: number, candidate: string, rootReal: string | null, specPath: string, at?: string): { real: string; buf: Buffer } {
  const st = fstatSync(fd);
  if (!st.isFile()) throw cannotRead(specPath, candidate, at);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw changedError(specPath, at);
  }
  if (rootReal && outsideRoot(rootReal, real)) throw outsideError(specPath, rootReal, at);
  let stReal: { dev: number; ino: number };
  try {
    stReal = statSync(real);
  } catch {
    throw changedError(specPath, at);
  }
  if (!sameInode(st, stReal)) throw changedError(specPath, at);
  const buf = readFileSync(fd);
  let stAfter: { dev: number; ino: number };
  try {
    stAfter = statSync(real);
  } catch {
    throw changedError(specPath, at);
  }
  if (!sameInode(st, stAfter)) throw changedError(specPath, at);
  assertProcAgrees(fd, real, specPath, at);
  return { real, buf };
}

function assertProcAgrees(fd: number, real: string, specPath: string, at?: string): void {
  try {
    const via = realpathSync(`/proc/self/fd/${fd}`);
    if (via !== real) throw changedError(specPath, at);
  } catch (err) {
    // `/proc/self/fd` is a Linux check. These errno values mean it is absent
    // or unusable, which is normal on macOS, Windows, and a mount that hides
    // `/proc`: ENOENT (absent), ENOTDIR (a parent is not a directory), EINVAL
    // (the path is rejected), EACCES and EPERM (not readable here), ENOSYS
    // (not implemented). EIO and every other code still throw. A path that
    // resolves to a different file is `changed while reading`, above.
    if (errno(err) === 'ENOENT' || errno(err) === 'ENOTDIR' || errno(err) === 'EINVAL'
      || errno(err) === 'EACCES' || errno(err) === 'EPERM' || errno(err) === 'ENOSYS') return;
    throw err;
  }
}

/** Hash the raw file bytes. A pin must be 64 hex digits. */
export function verifyHash(buf: Buffer, pin: string, specPath: string, at?: string): void {
  const hex = pin.replace(/^sha256:/i, '').trim();
  const where = atSuffix(at);
  if (hex === '') {
    throw new Error(`Parse error: empty hash on import "${specPath}"${where}`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`Parse error: hash on import "${specPath}" must be 64 hex characters${where}`);
  }
  const got = createHash('sha256').update(buf).digest('hex');
  if (got.toLowerCase() !== hex.toLowerCase()) {
    throw new Error(`Parse error: hash mismatch for import "${specPath}"${where}`);
  }
}
