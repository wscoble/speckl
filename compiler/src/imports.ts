// Resolve `import "path"` against the directory of the file that writes it.
// Nested imports use the imported file's directory. There is no package registry.
//
// The default root is the entry file's directory. An import must be a relative
// path, and its real path (after symlinks) must stay inside the root. Pass
// `rootDir` — the CLI's `--root` — to widen that directory.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { AST, ImportNode, parseSpeckContent, SpeckNode } from './parser.js';

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
  text: string;
  ast: AST;
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
 * speck name twice. A file with no imports is returned unchanged.
 */
export function expandImports(ast: AST, entryPath: string, options: ExpandOptions = {}): AST {
  if (!existsSync(entryPath)) return ast;
  const entryAbs = realpathSync(entryPath);
  const rootDir = realpathSync(options.rootDir ? resolve(options.rootDir) : dirname(entryAbs));
  const rootHas = (ast.imports?.length ?? 0) > 0
    || ast.specks.some(s => s.members.some(m => m.type === 'import'));
  if (!rootHas) {
    if (!linksOf.has(ast)) {
      linksOf.set(ast, []);
      originOf.set(ast, new Map(ast.specks.map(s => [s.name, entryAbs])));
    }
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

  function ensure(abs: string): CachedFile {
    const hit = cache.get(abs);
    if (hit) return hit;
    const text = readFileSync(abs, 'utf8');
    const parsed = parseSpeckContent(text, abs);
    const entry = { text, ast: parsed };
    cache.set(abs, entry);
    return entry;
  }

  function importsIn(parsed: AST, abs: string): { owner: string; node: ImportNode }[] {
    const out: { owner: string; node: ImportNode }[] = [];
    if (abs === entryAbs) {
      for (const node of parsed.imports ?? []) out.push({ owner: '*', node });
    } else {
      for (const node of parsed.imports ?? []) {
        for (const speck of parsed.specks) out.push({ owner: speck.name, node });
      }
    }
    for (const speck of parsed.specks) {
      for (const member of speck.members) {
        if (member.type === 'import') out.push({ owner: speck.name, node: member });
      }
    }
    return out;
  }

  function noteAlias(abs: string, node: ImportNode): void {
    if (!node.alias) return;
    const key = `${abs}\0${node.alias}`;
    if (aliasAt.has(key)) {
      throw new Error(`Parse error: import alias ${node.alias} is used twice in ${abs}`);
    }
    aliasAt.add(key);
  }

  function load(abs: string, depth: number, pin?: { hash: string; specPath: string }): void {
    if (done.has(abs)) {
      if (pin) verifyHash(cache.get(abs)!.text, pin.hash, pin.specPath);
      return;
    }
    if (depth > MAX_IMPORT_DEPTH) {
      throw new Error(`Parse error: import chain is too deep (limit ${MAX_IMPORT_DEPTH}): ${[...stack, abs].join(' -> ')}`);
    }
    if (stackSet.has(abs)) {
      throw new Error(`Parse error: import cycle: ${[...stack, abs].join(' -> ')}`);
    }
    stackSet.add(abs);
    stack.push(abs);
    const { ast: parsed } = ensure(abs);
    if (pin) verifyHash(cache.get(abs)!.text, pin.hash, pin.specPath);
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
      noteAlias(abs, node);
      const child = resolveImportPath(abs, node.path, rootDir);
      load(child, depth + 1, node.hash ? { hash: node.hash, specPath: node.path } : undefined);
      const names = parsedNames(cache.get(child)!.ast);
      if (!links.some(l => l.owner === owner && l.file === child && l.node.path === node.path && l.node.alias === node.alias)) {
        links.push({ owner, node, file: child, speckNames: names });
      }
    }
    stack.pop();
    stackSet.delete(abs);
    done.add(abs);
  }

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
  linksOf.set(out, lifted);
  originOf.set(out, origin);
  expanded.add(out);
  return out;
}

function parsedNames(ast: AST): string[] {
  return ast.specks.map(s => s.name);
}

export function resolveImportPath(fromFile: string, specPath: string, rootDir: string): string {
  if (isAbsolute(specPath)) {
    throw new Error(`Parse error: import "${specPath}" must be a relative path`);
  }
  const target = resolve(dirname(fromFile), specPath);
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new Error(`Parse error: cannot read import "${specPath}" (resolved ${target})`);
  }
  const real = realpathSync(target);
  const rootReal = realpathSync(rootDir);
  const rel = relative(rootReal, real);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Parse error: import "${specPath}" resolves outside the import root ${rootReal}`);
  }
  return real;
}

/** Hash `buf`, the same bytes that were parsed. A pin must be 64 hex digits. */
export function verifyHash(buf: string | Buffer, pin: string, specPath: string): void {
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
