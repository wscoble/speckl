// The agent target emits its machine as plain JavaScript (no `typescript`
// at compile time or runtime). stripTypes must agree with ts.transpileModule
// on every example's generated machine.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parseSpeckFile } from '../parser.js';
import { generateTypeScriptStateMachine } from '../generators/typescript-state-machine.js';
import { stripTypes } from '../generators/agent/strip-types.js';
import { transpileTsToMjs } from '../generators/agent/index.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const examplesDir = join(compilerDir, '..', 'examples');

const printer = ts.createPrinter({ removeComments: true });
/** Canonical JS: parse, drop redundant parens, reprint. */
function canon(js: string): string {
  const sf = ts.createSourceFile('x.js', js, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const r = ts.transform(sf, [ctx => root => {
    const v = (n: ts.Node): ts.Node => ts.isParenthesizedExpression(n) ? ts.visitNode(n.expression, v) as ts.Node : ts.visitEachChild(n, v, ctx);
    return ts.visitNode(root, v) as ts.SourceFile;
  }]);
  return printer.printFile(r.transformed[0] as ts.SourceFile);
}
const viaTs = (src: string) => ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

describe('stripTypes vs ts.transpileModule on every example', () => {
  const out = mkdtempSync(join(tmpdir(), 'speckl-strip-'));
  const specs = readdirSync(examplesDir).filter(f => f.endsWith('.speckdl'));
  for (const f of specs) generateTypeScriptStateMachine(parseSpeckFile(join(examplesDir, f)), out);
  const machines = readdirSync(out).filter(f => f.endsWith('.ts'));

  it('covers all examples', () => {
    expect(machines.length).toBe(specs.length);
  });

  // TEF's generated TS is not valid TypeScript today (record literals like
  // `Customer { ... }`), so the two error-recovery paths differ; skip it.
  it.each(machines.filter(m => m !== 'TEF.ts'))('%s', (m) => {
    const src = readFileSync(join(out, m), 'utf-8');
    expect(canon(stripTypes(src))).toBe(canon(viaTs(src)));
  });
});

describe('stripTypes constructs', () => {
  const same = (src: string) => expect(canon(stripTypes(src))).toBe(canon(viaTs(src)));

  it.each([
    ['interfaces and type aliases', 'export interface A { x: number; f(a: string): void }\ntype B<T> = T | null;\nexport type C = typeof k[keyof typeof k];\nexport const k = 1;'],
    ['as casts incl. nested types', 'const a = (x as unknown as Record<string, (...a: unknown[]) => unknown>)[k];\nconst b = { y: 1 } as const;\nconst c = v as { d: unknown };\nconst e = w as A | B & C;'],
    ['non-null and definite assignment', 'class M { a!: number; b?: string; c: any[] = []; f() { return this.m.get(k)!.x!; } }'],
    ['modifiers and return types', 'export class K { static readonly T = { a: [] } as const; private p: number = 1; public q(): true | string { return true; } protected async r(): Promise<boolean> { return false; } static s(x: K): K { return x; } }'],
    ['functions with optional/default params', 'function f(s: string, method?: string, n: number = 3, { a, b }: { a: number; b: number } = { a: 1, b: 2 }): string { return s; }'],
    ['typed arrow functions', 'const f = (a: number, b: string): number => a; const g = ([k, x]) => k; const h = p => p;'],
    ['strings, templates and regex survive', "const s = 'a: b as c'; const t = `x ${y as number} ${`n ${z!}`}`; const r = /a:b as[}]/g.test(s) ? 1 : 2; const q = \"it's\";"],
    ['comments survive and do not confuse', '/* as : interface */ const a = 1; // b as c\nconst o = { a: 1, b: a ? 2 : 3 };'],
    ['ternaries and object literals keep colons', 'const o = { a: c ? d : e, f: { g: 1 } }; switch (o.a) { case 1: break; default: break; }'],
    ['logical not and inequality are kept', 'const a = !b; const c = d !== e; const f = !(g); if (!x) {}'],
  ])('%s', (_n, src) => same(src));

  it('throws on an unbalanced or unsupported type', () => {
    expect(() => stripTypes('const a = b as (c;')).toThrow(/unbalanced/);
    expect(() => stripTypes('const a = b as ;')).toThrow(/unexpected/);
    expect(() => stripTypes('const a = b as')).toThrow(/type expected/);
  });
});

describe('transpileTsToMjs', () => {
  it('writes runnable JS for a generated machine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-mjs-'));
    generateTypeScriptStateMachine(parseSpeckFile(join(examplesDir, 'ToggleSwitch.speckdl')), dir);
    transpileTsToMjs(join(dir, 'ToggleSwitch.ts'), join(dir, 'ToggleSwitch.mjs'));
    const mod = await import(join(dir, 'ToggleSwitch.mjs'));
    expect(typeof mod.ToggleSwitchMachine).toBe('function');
  });

  it('fails the compile, not the hook, when the result is not valid JS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-mjs-bad-'));
    writeFileSync(join(dir, 'Bad.ts'), 'export const x = {;\n');
    expect(() => transpileTsToMjs(join(dir, 'Bad.ts'), join(dir, 'Bad.mjs'))).toThrow(/failed a syntax check/);
  });

  it('the agent generator no longer loads typescript', () => {
    const agentSrc = readdirSync(join(compilerDir, 'src', 'generators', 'agent'))
      .filter(f => f.endsWith('.ts'))
      .map(f => readFileSync(join(compilerDir, 'src', 'generators', 'agent', f), 'utf-8'))
      .join('\n');
    expect(agentSrc).not.toMatch(/require\(['"]typescript['"]\)|from ['"]typescript['"]|createRequire/);
  });
});
