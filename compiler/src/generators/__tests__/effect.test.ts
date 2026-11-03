// Effect backend tests: the generated source, and the cases that must
// refuse to generate. compiles-effect.test.ts typechecks every example
// plus EffectTranslation.speckdl with tsc against the effect package.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parseSpeckFile, parseSpeckContent } from '../../parser.js';
import { lower } from '../../ir/lower.js';
import { EffectTargetError, generateEffect } from '../effect.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const FIXTURES = resolve(__dirname, '..', '..', '__tests__', 'fixtures');

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function effectFor(file: string): string {
  const out = mkdtempSync(join(tmpdir(), 'speckl-effect-'));
  dirs.push(out);
  const ast = parseSpeckFile(file);
  generateEffect(lower(ast, { filePath: file, resolveImports: false }), out, ast);
  return readFileSync(join(out, ast.specks[0].name, 'src', 'index.ts'), 'utf-8');
}

function effectFrom(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-effect-src-'));
  dirs.push(dir);
  const file = join(dir, 'spec.speckdl');
  writeFileSync(file, src);
  const ast = parseSpeckContent(src, file);
  const out = mkdtempSync(join(tmpdir(), 'speckl-effect-out-'));
  dirs.push(out);
  generateEffect(lower(ast, { filePath: file, resolveImports: false }), out, ast);
  return readFileSync(join(out, ast.specks[0].name, 'src', 'index.ts'), 'utf-8');
}

function mustThrow(src: string): string {
  try {
    effectFrom(src);
  } catch (e) {
    expect(e).toBeInstanceOf(EffectTargetError);
    return (e as Error).message;
  }
  throw new Error('expected EffectTargetError');
}

describe('Effect target — ToggleSwitch', () => {
  const src = effectFor(join(REPO_ROOT, 'examples', 'ToggleSwitch.speckdl'));

  it('emits a Schema for state, a capability, and a Live layer', () => {
    expect(src).toContain('import * as $$effect from "effect"');
    expect(src).toContain('export interface ToggleSwitchState');
    expect(src).toContain('readonly isOn: boolean');
    expect(src).toContain('export class ToggleSwitchCapability extends $$effect.Context.Tag("@speckl/ToggleSwitch")');
    expect(src).toContain('export const toggleSwitchLive: $$effect.Layer.Layer<ToggleSwitchCapability, never>');
    expect(src).toContain('export const nextActions = ["TurnOn","TurnOff"] as const');
  });

  it('returns Effect from decisions and fails a guard with a tagged error', () => {
    expect(src).toContain('export const turnOn = ($$machine: ToggleSwitchMachine): $$effect.Effect.Effect<ToggleSwitchDecision<boolean>, $$GuardFailed | $$InvariantViolated>');
    expect(src).toContain('return yield* new $$GuardFailed({ action: "TurnOn", detail: $$lookup.failed ? $$lookup.detail : "not isOn" })');
    expect(src).toContain('$$state = { ...$$state, isOn: true }');
    expect(src).toContain('class $$GuardFailed extends $$effect.Schema.TaggedError<$$GuardFailed>()("GuardFailed"');
  });

  it('fails an untranslatable rule closed instead of dropping it', () => {
    expect(src).toContain('export const checkSwitchConsistent');
    expect(src).toContain('$$effect.HashSet.has');
    expect(src).not.toContain('untranslated invariant: SwitchConsistent');
  });
});

describe('Effect target — string unions and schemas', () => {
  const src = effectFor(join(FIXTURES, 'EffectTranslation.speckdl'));

  it('maps inline and named string unions to Schema.Literal', () => {
    expect(src).toContain('export const Color = $$effect.Schema.Literal("red", "blue")');
    expect(src).toContain('export const Rank = $$effect.Schema.Literal("Low", "High")');
    expect(src).toContain('status: $$effect.Schema.Literal("open", "closed")');
    expect(src).not.toMatch(/type "open"/);
    expect(src).toContain('export const Phase = $$effect.Schema.Literal("Draft", "Review", "Done")');
  });

  it('maps records, recursion, sets, and nullable fields', () => {
    expect(src).toContain('export interface Note {');
    expect(src).toContain('readonly body: string');
    expect(src).toContain('export interface Node {');
    expect(src).toContain('readonly next: Node | null');
    expect(src).toContain('next: $$effect.Schema.NullOr($$effect.Schema.suspend(() => Node))');
    expect(src).toContain('readonly tags: $$effect.HashSet.HashSet<string>');
    expect(src).toContain('$$effect.Schema.HashSetFromSelf($$effect.Schema.String)');
    expect(src).toContain('readonly note: Note | null');
    expect(src).toContain('readonly type: number');
  });

  it('emits a service Tag whose unimplemented layer fails closed', () => {
    expect(src).toContain('export class Clock extends $$effect.Context.Tag("@speckl/service/Clock")');
    expect(src).toContain('readonly now: (request: Note) => $$effect.Effect.Effect<Schema, $$AdapterUnimplemented>');
    expect(src).toContain('export const clockUnimplemented: $$effect.Layer.Layer<Clock>');
    expect(src).toContain('new $$AdapterUnimplemented({ service: "Clock", method: "Now" })');
  });

  it('translates a decision and refuses an untranslated one before it writes state', () => {
    expect(src).toContain('$$state = { ...$$state, phase: "Review" }');
    expect(src).toContain('$$log = [...$$log, { _tag: "Moved"');
    const unsupported = src.slice(src.indexOf('export const unsupported'));
    const guard = unsupported.indexOf('return yield* new $$Untranslated(');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(unsupported.indexOf('$$state = { ...$$state, type:'));
    expect(unsupported).toContain('tags union { id }');
  });

  it('checks a translated invariant and fails a temporal one closed', () => {
    expect(src).toContain('$$state.type >= 0');
    expect(src).toContain('new $$InvariantViolated({ name: "TypeNonNegative"');
    expect(src).toContain('new $$Untranslated({ where: "verifyLater", detail: "eventually(type > 0)" })');
  });
});

describe('Effect target — names and fail-closed edges', () => {
  it('keeps Effect, Schema, and reserved words from colliding with the import', () => {
    const src = effectFrom(`
speck Effect {
  type Schema = { pipe: Nat, Layer: String }
  type Context = Int
  interface Data {
    Tag
    Yield
  }
  state {
    type: Nat
    class: String
    default: Bool
    yield: Int
    await: String
    of: Bool
    in: Nat
    package: String
    void: String | null
    Schema: Schema
    Context: Context
  }
  init {
    type := 1
    class := "x"
    default := true
    yield := 0
    await := "a"
    of := false
    in := 2
    package := "p"
    void := nil
  }
  action return(type: Nat) {
    require type > 0
    type := type + Context
    return type
  }
}
`);
    expect(src).toContain('import * as $$effect from "effect"');
    expect(src).toContain('export interface Schema {');
    expect(src).toContain('readonly pipe: number');
    expect(src).toContain('export const Data = $$effect.Schema.Literal("Tag", "Yield")');
    expect(src).toContain('readonly type: number');
    expect(src).toContain('export const return_ =');
    expect(src).toContain('type_: number');
    expect(src).not.toMatch(/^import \{[^}]*\bSchema\b/m);
  });

  it('nests records and keeps a nullable field', () => {
    const src = effectFrom(`
speck Nest {
  type Inner = { n: Nat, tag: String | null }
  type Outer = { name: String, inner: Inner, extra: { depth: Nat, leaf: Bool } }
  state {
    box: Outer
    flags: Set(String)
  }
  action Name() {
    return box.name
  }
}
`);
    expect(src).toContain('export interface Inner {');
    expect(src).toContain('readonly tag: string | null');
    expect(src).toContain('export interface Outer {');
    expect(src).toContain('readonly inner: Inner');
    expect(src).toContain('readonly flags: $$effect.HashSet.HashSet<string>');
    expect(src).toContain('return { state: $$state, decisionLog: $$log, value: $$state.box.name }');
  });

  it('still emits a module from the IR when no AST is supplied', () => {
    const file = join(REPO_ROOT, 'examples', 'ToggleSwitch.speckdl');
    const ast = parseSpeckFile(file);
    const out = mkdtempSync(join(tmpdir(), 'speckl-effect-ir-'));
    dirs.push(out);
    generateEffect(lower(ast, { filePath: file, resolveImports: false }), out);
    const src = readFileSync(join(out, 'ToggleSwitch', 'src', 'index.ts'), 'utf-8');
    expect(src).toContain('export const ToggleSwitchState');
    expect(src).toContain('readonly isOn: boolean');
  });

  it('refuses streaming RPCs, imports, and oneof instead of dropping them', () => {
    expect(mustThrow(`
speck Svc {
  state { n: Nat }
  service Echo {
    rpc Chat(stream Msg) returns (stream Msg);
  }
}
`)).toMatch(/cannot map streaming RPC Echo\.Chat/);

    expect(mustThrow(`
speck Imp {
  import "other.speckdl" as other
  state { n: Nat }
}
`)).toMatch(/cannot map import/);

    expect(mustThrow(`
speck Wire {
  type Customer = { id: String }
  oneof Payload { customer: Customer }
  state { n: Nat }
}
`)).toMatch(/cannot map oneof/);

    expect(mustThrow(`
speck Wire {
  transition Transition { prior_state: String }
  state { n: Nat }
}
`)).toMatch(/cannot map transition/);
  });
});
