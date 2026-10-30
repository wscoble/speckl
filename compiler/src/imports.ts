// Resolve `import "path"` against the directory of the file that writes it.
// Nested imports use the imported file's directory. There is no package registry.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
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
 * a cycle, a hash mismatch, an empty hash, or the same speck name in two files.
 * A file with no imports is returned unchanged.
 */
export function expandImports(ast: AST, entryPath: string): AST {
  if (!existsSync(entryPath)) return ast;
  const entryAbs = realpathSync(entryPath);
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
  const cache = new Map<string, AST>();

  function parseFile(abs: string): AST {
    const hit = cache.get(abs);
    if (hit) return hit;
    const parsed = parseSpeckContent(readFileSync(abs, 'utf8'), abs);
    cache.set(abs, parsed);
    return parsed;
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

  function load(abs: string): void {
    if (stack.includes(abs)) {
      throw new Error(`Parse error: import cycle: ${[...stack, abs].join(' -> ')}`);
    }
    stack.push(abs);
    const parsed = parseFile(abs);
    if (abs !== entryAbs && parsed.specks.length === 0) {
      throw new Error(`Parse error: import "${abs}" declares no specks`);
    }
    for (const speck of parsed.specks) {
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
      const target = resolveImportPath(abs, node.path);
      if (node.hash) verifyHash(target, node.hash, node.path);
      const child = realpathSync(target);
      load(child);
      const names = parsedNames(cache.get(child)!);
      if (!links.some(l => l.owner === owner && l.file === child && l.node.path === node.path && l.node.alias === node.alias)) {
        links.push({ owner, node, file: child, speckNames: names });
      }
    }
    stack.pop();
  }

  load(entryAbs);

  // Root file-level imports apply to every speck declared in the root file.
  const rootNames = (cache.get(entryAbs)?.specks ?? []).map(s => s.name);
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

export function resolveImportPath(fromFile: string, specPath: string): string {
  const target = isAbsolute(specPath) ? specPath : resolve(dirname(fromFile), specPath);
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new Error(`Parse error: cannot read import "${specPath}" (resolved ${target})`);
  }
  return target;
}

export function verifyHash(file: string, pin: string, specPath: string): void {
  const hex = pin.replace(/^sha256:/i, '');
  if (hex === '') {
    throw new Error(`Parse error: empty hash on import "${specPath}"`);
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`Parse error: hash on import "${specPath}" is not sha256 hex`);
  }
  const got = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (got.toLowerCase() !== hex.toLowerCase()) {
    throw new Error(`Parse error: hash mismatch for import "${specPath}" (resolved ${file})`);
  }
}
