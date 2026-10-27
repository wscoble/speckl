// Read, lower, and merge `import` files. Cycles, missing files, hash
// mismatches, and speck-name clashes are errors that name the file.
// `version` is stored on the IR import and is not resolved against a
// registry (there isn't one). That lookup is not yet implemented.

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { parseSpeckContent, type AST, type ImportNode } from '../parser.js';
import type { IR, IRDiagnostic, IRImport, IRSpeck } from './types.js';
import type { LowerOptions } from './lower.js';

export interface LowerCtx {
  /** Canonical paths of files currently being lowered, outermost first. */
  stack: string[];
  cache: Map<string, IR>;
}

export type LowerFile = (ast: AST, options: LowerOptions, ctx: LowerCtx) => IR;

export function canonical(p: string): string {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) return abs;
  return fs.realpathSync.native(abs);
}

export function dedupeDiagnostics(diagnostics: IRDiagnostic[]): void {
  const seen = new Set<string>();
  let w = 0;
  for (const d of diagnostics) {
    const key = `${d.level}\n${d.message}\n${d.speck ?? ''}\n${d.line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics[w++] = d;
  }
  diagnostics.length = w;
}

function pushError(diagnostics: IRDiagnostic[], message: string, speck?: string, line?: number): void {
  diagnostics.push({ level: 'error', message, ...(speck ? { speck } : {}), ...(line ? { line } : {}) });
}

/**
 * Resolve every import in `nodes`. On success, `unit` is the lowered
 * imported compilation (cached). On failure, `unit` is null and an error
 * naming the file is already in `diagnostics`.
 */
export function resolveImportNodes(
  nodes: ImportNode[],
  owner: string | undefined,
  options: LowerOptions,
  ctx: LowerCtx,
  diagnostics: IRDiagnostic[],
  lowerFile: LowerFile,
): { imports: IRImport[]; units: IR[] } {
  const imports: IRImport[] = [];
  const units: IR[] = [];
  for (const node of nodes) {
    const one = resolveOne(node, owner, options, ctx, diagnostics, lowerFile);
    imports.push(...one.imports);
    if (one.unit) units.push(one.unit);
  }
  return { imports, units };
}

function resolveOne(
  node: ImportNode,
  owner: string | undefined,
  options: LowerOptions,
  ctx: LowerCtx,
  diagnostics: IRDiagnostic[],
  lowerFile: LowerFile,
): { imports: IRImport[]; unit: IR | null } {
  const fromFile = canonical(options.filePath);
  const target = path.resolve(path.dirname(fromFile), node.path);
  const where = owner ? ` in speck ${owner}` : '';
  let bytes: Buffer;
  try {
    const st = fs.statSync(target);
    if (!st.isFile()) {
      pushError(diagnostics, `import: cannot read "${node.path}" from ${fromFile} (resolved to ${target}; not a file)${where}`, owner, node.startLine);
      return { imports: [], unit: null };
    }
    bytes = fs.readFileSync(target);
  } catch (e) {
    pushError(diagnostics, `import: cannot read "${node.path}" from ${fromFile} (resolved to ${target}): ${(e as Error).message}${where}`, owner, node.startLine);
    return { imports: [], unit: null };
  }

  const id = canonical(target);
  if (node.hash && !hashMatches(node.hash, bytes)) {
    pushError(diagnostics, `import: hash mismatch for "${node.path}" from ${fromFile} (file ${id})`, owner, node.startLine);
    return { imports: [], unit: null };
  }
  if (ctx.stack.includes(id)) {
    pushError(diagnostics, `import: cycle involving ${[...ctx.stack, id].join(' -> ')}`, owner, node.startLine);
    return { imports: [], unit: null };
  }

  let importedAst: AST;
  try {
    importedAst = parseSpeckContent(bytes.toString('utf8'), id);
  } catch (e) {
    pushError(diagnostics, `import: failed to parse "${node.path}" (${id}): ${(e as Error).message}`, owner, node.startLine);
    return { imports: [], unit: null };
  }

  const unit = lowerFile(importedAst, { ...options, filePath: id, resolveImports: true }, ctx);
  const direct = unit.specks.filter(s => canonical(s.sourcePath) === id);
  const imports: IRImport[] = direct.map(s => ({
    path: node.path,
    alias: aliasFor(node, s.name, direct.length),
    ...(node.version ? { version: node.version } : {}),
    ...(node.hash ? { hash: node.hash } : {}),
    resolved: s,
  }));
  return { imports, unit };
}

function aliasFor(node: ImportNode, speckName: string, count: number): string {
  if (!node.alias) return speckName;
  if (count === 1) return node.alias;
  return `${node.alias}.${speckName}`;
}

function hashMatches(declared: string, bytes: Buffer): boolean {
  const want = (declared.startsWith('sha256:') ? declared.slice('sha256:'.length) : declared).toLowerCase();
  const got = createHash('sha256').update(bytes).digest('hex');
  return want === got;
}

export function mergeUnit(
  unit: IR,
  specks: IRSpeck[],
  diagnostics: IRDiagnostic[],
): void {
  for (const s of unit.specks) addSpeck(specks, s, diagnostics);
  for (const d of unit.diagnostics) diagnostics.push(d);
}

function addSpeck(into: IRSpeck[], speck: IRSpeck, diagnostics: IRDiagnostic[]): void {
  const clash = into.find(s => s.name === speck.name && canonical(s.sourcePath) !== canonical(speck.sourcePath));
  if (clash) {
    pushError(diagnostics, `import: speck ${speck.name} is declared in both ${clash.sourcePath} and ${speck.sourcePath}`);
    return;
  }
  if (into.some(s => s.name === speck.name && canonical(s.sourcePath) === canonical(speck.sourcePath))) return;
  into.push(speck);
}
