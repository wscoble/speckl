// Runtime checks for the Effect target. tsc is not enough: these specs
// typecheck while booting the wrong value, dropping an operand, or
// refusing to load. Each case runs the generated module.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent, parseSpeckFile } from '../parser.js';
import { lower } from '../ir/lower.js';
import { EffectTargetError, generateEffect } from '../generators/effect.js';

const require = createRequire(import.meta.url);
const viteNode = require.resolve('vite-node/vite-node.mjs');
const nodeModules = join(dirname(require.resolve('effect/package.json')), '..');
const tscBin = require.resolve('typescript/bin/tsc');

function generate(src: string, filePath?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'speckl-eff-run-'));
  const file = filePath ?? join(root, 'spec.speckdl');
  if (!filePath) writeFileSync(file, src);
  const ast = filePath ? parseSpeckFile(filePath) : parseSpeckContent(src, file);
  const out = join(root, 'out');
  generateEffect(lower(ast, { filePath: file, resolveImports: false }), out, ast);
  symlinkSync(nodeModules, join(root, 'node_modules'));
  return root;
}

function runProgram(root: string, program: string): unknown {
  const runner = join(root, 'run.ts');
  writeFileSync(runner, program);
  const r = spawnSync(process.execPath, [viteNode, runner], { cwd: root, encoding: 'utf-8', timeout: 60_000 });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) throw new Error(text);
  const line = text.split('\n').filter((l) => l.startsWith('RESULT ')).pop();
  if (!line) throw new Error(text);
  return JSON.parse(line.slice('RESULT '.length));
}

function boot(src: string, speck: string): Record<string, unknown> {
  const root = generate(src);
  return runProgram(root, `
import * as Effect from "effect";
import * as M from "./out/${speck}/src/index.ts";
const machine = await Effect.Effect.runPromise(M.$$boot);
console.log("RESULT " + JSON.stringify(machine.state));
`) as Record<string, unknown>;
}

function typechecks(root: string, speck: string): boolean {
  const r = spawnSync(process.execPath, [tscBin, '--noEmit', '--strict', '-p', join(root, 'out', speck)], { encoding: 'utf-8' });
  return r.status === 0;
}

describe('Effect runtime', () => {
  it('honors == initializers, including the shipped Kafka and WAL specs', () => {
    expect(boot(`
speck InitEq {
  type Mode = Follower | Candidate | Leader
  state {
    currentTerm: Nat
    mode: Mode
    flag: Bool
  }
  init {
    currentTerm == 1
    mode == Leader
    flag == true
  }
}
`, 'InitEq')).toEqual({ currentTerm: 1, mode: 'Leader', flag: true });

    const kafka = generate('', join(process.cwd(), '..', 'examples', 'KafkaKRaft.speckdl'));
    const kraft = runProgram(kafka, `
import * as Effect from "effect";
import * as M from "./out/KafkaKRaft/src/index.ts";
const machine = await Effect.Effect.runPromise(M.$$boot);
console.log("RESULT " + JSON.stringify({ currentTerm: machine.state.currentTerm, state: machine.state.state }));
`) as { currentTerm: number; state: string };
    expect(kraft.currentTerm).toBe(1);
    expect(kraft.state).toBe('Follower');

    const wal = generate('', join(process.cwd(), '..', 'examples', 'SQLiteWAL.speckdl'));
    const frames = runProgram(wal, `
import * as Effect from "effect";
import * as M from "./out/SQLiteWAL/src/index.ts";
const machine = await Effect.Effect.runPromise(M.$$boot);
console.log("RESULT " + JSON.stringify({ maxFrames: machine.state.maxFrames }));
`) as { maxFrames: number };
    expect(frames.maxFrames).toBe(100);
  });

  it('compares nullable strings by value', async () => {
    const root = generate(`
speck NullEq {
  state {
    left: String | null
    right: String | null
  }
  init {
    left == nil
    right == nil
  }
  action Both(): Bool {
    left := "a"
    right := "a"
    return left == right
  }
  action Mixed(): Bool {
    left := nil
    right := "b"
    return left == right
  }
  action Nones(): Bool {
    left := nil
    right := nil
    return left == right
  }
}
`);
    const result = runProgram(root, `
import * as Effect from "effect";
import * as M from "./out/NullEq/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.NullEqCapability;
  const both = yield* svc.both();
  const mixed = yield* svc.mixed();
  const nones = yield* svc.nones();
  return { both, mixed, nones };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.nullEqLive)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toEqual({ both: true, mixed: false, nones: true });
  });

  it('keeps an inline Map as a HashMap', () => {
    const root = generate(`
speck InlineMap {
  state {
    box: { m: Map(String, Nat), n: Nat }
  }
}
`);
    const src = readFileSync(join(root, 'out', 'InlineMap', 'src', 'index.ts'), 'utf-8');
    expect(src).toContain('HashMap');
    expect(src).not.toContain('SpecklUnparsed');
    const result = runProgram(root, `
import * as Effect from "effect";
import { HashMap } from "effect";
import * as M from "./out/InlineMap/src/index.ts";
const machine = await Effect.Effect.runPromise(M.$$boot);
console.log("RESULT " + JSON.stringify({
  map: HashMap.isHashMap(machine.state.box.m),
  size: HashMap.size(machine.state.box.m),
  n: machine.state.box.n,
}));
`);
    expect(result).toEqual({ map: true, size: 0, n: 0 });
  });

  it('renames machine, current, ref, and a type named boot so the module loads', () => {
    const root = generate(`
speck Names {
  state { n: Nat }
  init { n := 0 }
  action Go(machine: Nat, current: Nat, ref: Nat) {
    n := machine + current + ref
    return n
  }
}
`);
    expect(typechecks(root, 'Names')).toBe(true);
    const result = runProgram(root, `
import * as Effect from "effect";
import * as M from "./out/Names/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.NamesCapability;
  const value = yield* svc.go(1, 2, 3);
  const state = yield* svc.getState;
  return { value, n: state.n };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.namesLive)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toEqual({ value: 6, n: 6 });

    const clash = generate(`
speck BootClash {
  type boot = String
  state { label: boot }
  init { label == "ok" }
}
`);
    expect(typechecks(clash, 'BootClash')).toBe(true);
    const booted = runProgram(clash, `
import * as Effect from "effect";
import * as M from "./out/BootClash/src/index.ts";
const machine = await Effect.Effect.runPromise(M.$$boot);
console.log("RESULT " + JSON.stringify(machine.state));
`);
    expect(booted).toEqual({ label: 'ok' });
  });

  it('keeps each speck\'s aliases inside that speck', () => {
    const root = generate(`
speck A {
  type Color = "red" | "blue"
  state { c: Color }
  init { c := "red" }
}
speck B {
  type Color = "green" | "yellow"
  state { c: Color }
  init { c := "green" }
}
`);
    const result = runProgram(root, `
import * as Effect from "effect";
import * as A from "./out/A/src/index.ts";
import * as B from "./out/B/src/index.ts";
const a = await Effect.Effect.runPromise(A.$$boot);
const b = await Effect.Effect.runPromise(B.$$boot);
console.log("RESULT " + JSON.stringify({ a: a.state.c, b: b.state.c }));
`);
    expect(result).toEqual({ a: 'red', b: 'green' });
    expect(readFileSync(join(root, 'out', 'A', 'src', 'index.ts'), 'utf-8')).toContain('Schema.Literal("red", "blue")');
    expect(readFileSync(join(root, 'out', 'B', 'src', 'index.ts'), 'utf-8')).toContain('Schema.Literal("green", "yellow")');
  });

  it('refuses an action that would break an invariant and leaves the ref', () => {
    const root = generate(`
speck Inv {
  state { n: Nat }
  init { n := 0 }
  invariant BelowTen { n < 10 }
  action Inc() { n := n + 1 return n }
}
`);
    const result = runProgram(root, `
import * as Effect from "effect";
import * as M from "./out/Inv/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.InvCapability;
  const steps = [];
  for (let i = 0; i < 12; i++) {
    const step = yield* Effect.Effect.either(svc.inc());
    const state = yield* svc.getState;
    steps.push(step._tag === "Left" ? { fail: step.left._tag, n: state.n } : { ok: step.right, n: state.n });
  }
  return { n: (yield* svc.getState).n, fails: steps.filter((s) => "fail" in s).length };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.invLive)));
console.log("RESULT " + JSON.stringify(value));
`) as { n: number; fails: number };
    expect(result.n).toBe(9);
    expect(result.fails).toBe(3);
  });

  it('rejects Nat writes that are not non-negative integers', () => {
    const root = generate(`
speck DivNat {
  state { n: Nat }
  init { n := 5 }
  action Half() { n := n / 2 return n }
  action Down() { n := n - 10 return n }
}
`);
    const result = runProgram(root, `
import * as Effect from "effect";
import * as M from "./out/DivNat/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.DivNatCapability;
  const half = yield* Effect.Effect.either(svc.half());
  const afterHalf = yield* svc.getState;
  const down = yield* Effect.Effect.either(svc.down());
  const afterDown = yield* svc.getState;
  return {
    half: half._tag === "Left" ? half.left._tag : "ok",
    down: down._tag === "Left" ? down.left._tag : "ok",
    n: afterDown.n,
    afterHalf: afterHalf.n,
  };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.divNatLive)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toEqual({ half: 'SchemaViolation', down: 'SchemaViolation', n: 5, afterHalf: 5 });
  });

  it('typechecks old() in an invariant and checks it against the pre-state', () => {
    const root = generate(`
speck OldPost {
  state { n: Nat }
  init { n := 2 }
  invariant UsesOld { old(n) <= n }
  action Inc() {
    n := n + 1
    postcondition: n == old(n) + 1
    return n
  }
}
`);
    expect(typechecks(root, 'OldPost')).toBe(true);
    const result = runProgram(root, `
import * as Effect from "effect";
import * as M from "./out/OldPost/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.OldPostCapability;
  const value = yield* svc.inc();
  const state = yield* svc.getState;
  return { value, n: state.n };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.oldPostLive)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toEqual({ value: 3, n: 3 });
  });

  it('assigns this.balance and rolls back a failing precondition', () => {
    const root = generate('', join(process.cwd(), '..', 'examples', 'PreconditionTest.speckdl'));
    const result = runProgram(root, `
import * as Effect from "effect";
import * as M from "./out/PreconditionTest/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.PreconditionTestCapability;
  const ok = yield* Effect.Effect.either(svc.setBalance(5));
  const bad = yield* Effect.Effect.either(svc.setBalance(-1));
  const state = yield* svc.getState;
  return { ok: ok._tag, bad: bad._tag === "Left" ? bad.left._tag : "ok", balance: state.balance };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.preconditionTestLive)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toEqual({ ok: 'Right', bad: 'PreconditionFailed', balance: 5 });
  });

  it('round-trips a __proto__ field', () => {
    const root = generate(`
speck Proto {
  state { __proto__: String, constructor: String, n: Nat }
  init {
    __proto__ := "p"
    constructor := "c"
    n := 1
  }
  action Read(): String { return __proto__ }
}
`);
    const result = runProgram(root, `
import * as Effect from "effect";
import * as M from "./out/Proto/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const machine = yield* M.$$boot;
  const own = Object.prototype.hasOwnProperty.call(machine.state, "__proto__");
  const svc = yield* M.ProtoCapability;
  const read = yield* svc.read();
  return { own, proto: machine.state["__proto__"], ctor: machine.state.constructor, n: machine.state.n, read };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.protoLive)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toEqual({ own: true, proto: 'p', ctor: 'c', n: 1, read: 'p' });
  });

  it('marks an undeclared service type instead of a bare unknown', () => {
    const root = generate(`
speck Svc {
  state { n: Nat }
  service Echo {
    rpc Ping(MissingReq) returns (MissingRes);
  }
}
`);
    const src = readFileSync(join(root, 'out', 'Svc', 'src', 'index.ts'), 'utf-8');
    expect(src).toContain('SPECKL-UNRESOLVED: type MissingReq is not declared');
    expect(src).toContain('SPECKL-UNRESOLVED: type MissingRes is not declared');
    expect(src).toContain('export const MissingReq = $$effect.Schema.Unknown');
    const result = runProgram(root, `
import * as Effect from "effect";
import * as M from "./out/Svc/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const echo = yield* M.Echo;
  const step = yield* Effect.Effect.either(echo.ping(1));
  return step._tag === "Left" ? step.left._tag : "ok";
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.echoUnimplemented)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toBe('AdapterUnimplemented');
  });

  it('rejects a union arm that is not a declared type', () => {
    const bad = `
speck UnionTypo {
  type Note = { body: String }
  type Typo = String | Ntoe
  state { b: Typo }
}
`;
    const root = mkdtempSync(join(tmpdir(), 'speckl-eff-throw-'));
    const file = join(root, 'spec.speckdl');
    writeFileSync(file, bad);
    const ast = parseSpeckContent(bad, file);
    expect(() => generateEffect(lower(ast, { filePath: file, resolveImports: false }), join(root, 'out'), ast))
      .toThrow(EffectTargetError);
    try {
      generateEffect(lower(ast, { filePath: file, resolveImports: false }), join(root, 'out'), ast);
    } catch (e) {
      expect((e as Error).message).toMatch(/Ntoe/);
    }

    const ok = generate(`
speck UnionOk {
  type Note = { body: String }
  type Mixed = String | Note
  state { a: Mixed }
  init { a == "" }
}
`);
    expect(readFileSync(join(ok, 'out', 'UnionOk', 'src', 'index.ts'), 'utf-8')).toContain('Schema.Union');
    expect(readFileSync(join(ok, 'out', 'UnionOk', 'src', 'index.ts'), 'utf-8')).not.toContain('Literal("Ntoe")');
  });

  it('ignores type aliases inside block comments and orders forward init', () => {
    const root = generate(`
speck Notes {
  /* type Hidden = String */
  state { a: Nat, b: Nat, 1st: Nat }
  init {
    b := a + 1
    a := 1
    1st := 3
  }
  action Read(): Nat { return 1st }
}
`);
    const src = readFileSync(join(root, 'out', 'Notes', 'src', 'index.ts'), 'utf-8');
    expect(src).not.toContain('Hidden');
    const result = runProgram(root, `
import * as Effect from "effect";
import * as M from "./out/Notes/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.NotesCapability;
  const read = yield* svc.read();
  const state = yield* svc.getState;
  return { a: state.a, b: state.b, read };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.notesLive)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toEqual({ a: 1, b: 2, read: 3 });
  });

  it('keeps braces inside strings and comments inside init', () => {
    expect(boot(`
speck Brace {
  state { s: String, n: Nat }
  init {
    s == "a}b" // }
    n == 5
  }
}
`, 'Brace')).toEqual({ s: 'a}b', n: 5 });

    expect(boot(`
speck BraceOpen {
  state { s: String, n: Nat }
  init {
    s == "a{b"
    n == 5
  }
}
`, 'BraceOpen')).toEqual({ s: 'a{b', n: 5 });

    expect(boot(`
speck BraceType {
  state { mode: "a}" | "b" }
  init { mode == "a}" }
}
`, 'BraceType')).toEqual({ mode: 'a}' });
  });

  it('rejects a Nat stored by append or by copying a local map', () => {
    const root = generate(`
speck App {
  state { xs: List(Nat), m: Map(String, Nat) }
  init {
    xs := emptyList()
    m := emptyMap()
  }
  action Push(v: Int) { xs := append(xs, v) return v }
  action Put(v: Int) {
    let tmp := m
    tmp["a"] := v
    m := tmp
    return v
  }
}
`);
    const result = runProgram(root, `
import * as Effect from "effect";
import { HashMap } from "effect";
import * as M from "./out/App/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.AppCapability;
  const badPush = yield* Effect.Effect.either(svc.push(-1));
  const afterBad = yield* svc.getState;
  const okPush = yield* Effect.Effect.either(svc.push(2));
  const afterOk = yield* svc.getState;
  const badPut = yield* Effect.Effect.either(svc.put(-4));
  const afterPut = yield* svc.getState;
  const okPut = yield* Effect.Effect.either(svc.put(3));
  const done = yield* svc.getState;
  const got = HashMap.get(done.m, "a");
  return {
    badPush: badPush._tag === "Left" ? badPush.left._tag : "ok",
    lenAfterBad: afterBad.xs.length,
    okPush: okPush._tag,
    lenAfterOk: afterOk.xs.length,
    badPut: badPut._tag === "Left" ? badPut.left._tag : "ok",
    sizeAfterBad: HashMap.size(afterPut.m),
    okPut: okPut._tag,
    stored: got._tag === "Some" ? got.value : null,
  };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.appLive)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toEqual({
      badPush: 'SchemaViolation',
      lenAfterBad: 0,
      okPush: 'Right',
      lenAfterOk: 1,
      badPut: 'SchemaViolation',
      sizeAfterBad: 0,
      okPut: 'Right',
      stored: 3,
    });
  });

  it('fails every action while an invariant cannot be translated', () => {
    const root = generate(`
speck SkipInv {
  state { n: Nat }
  init { n := 0 }
  invariant AllNonNeg { forall x in xs: x >= 0 }
  action Inc() { n := n + 1 return n }
}
`);
    const result = runProgram(root, `
import * as Effect from "effect";
import * as M from "./out/SkipInv/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.SkipInvCapability;
  const step = yield* Effect.Effect.either(svc.inc());
  const state = yield* svc.getState;
  return { tag: step._tag === "Left" ? step.left._tag : "ok", n: state.n };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.skipInvLive)));
console.log("RESULT " + JSON.stringify(value));
`) as { tag: string; n: number };
    expect(result).toEqual({ tag: 'Untranslated', n: 0 });
  });

  it('range-checks a returned Nat', () => {
    const root = generate(`
speck RetNat {
  state { n: Nat }
  init { n := 0 }
  action Bad() { return n - 10 }
  action Write(x: Int) { n := x return n }
}
`);
    const result = runProgram(root, `
import * as Effect from "effect";
import * as M from "./out/RetNat/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.RetNatCapability;
  const bad = yield* Effect.Effect.either(svc.bad());
  const afterBad = yield* svc.getState;
  const write = yield* Effect.Effect.either(svc.write(-3));
  const afterWrite = yield* svc.getState;
  return {
    bad: bad._tag === "Left" ? bad.left._tag : bad.right,
    n: afterBad.n,
    write: write._tag === "Left" ? write.left._tag : "ok",
    afterWrite: afterWrite.n,
  };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.retNatLive)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toEqual({ bad: 'SchemaViolation', n: 0, write: 'SchemaViolation', afterWrite: 0 });
  });

  it('updates a nested record field and checks Nat', () => {
    const root = generate(`
speck Nest {
  type Box = { n: Nat }
  state { box: Box }
  action Set(v: Int) { box.n := v return box.n }
}
`);
    const result = runProgram(root, `
import * as Effect from "effect";
import * as M from "./out/Nest/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.NestCapability;
  const ok = yield* Effect.Effect.either(svc.set(4));
  const afterOk = yield* svc.getState;
  const bad = yield* Effect.Effect.either(svc.set(-1));
  const afterBad = yield* svc.getState;
  return {
    ok: ok._tag === "Right" ? ok.right : ok.left._tag,
    n: afterOk.box.n,
    bad: bad._tag === "Left" ? bad.left._tag : "ok",
    after: afterBad.box.n,
  };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.nestLive)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toEqual({ ok: 4, n: 4, bad: 'SchemaViolation', after: 4 });
  });

  it('keeps a block-comment lookalike inside a string', () => {
    expect(boot(`
speck StrComment {
  state { s: String, n: Nat }
  init {
    s == "/* } */"
    n == 5
  }
}
`, 'StrComment')).toEqual({ s: '/* } */', n: 5 });
  });

  it('rejects a nested block comment and an unclosed string', () => {
    const nested = `
speck NestC {
  state { n: Nat, m: Nat }
  init {
    n == 1
    /* outer /* inner */ }
    m == 2
  }
}
`;
    const open = `
speck OpenStr {
  state { s: String, n: Nat }
  init {
    s == "unterminated
    n == 5
  }
}
`;
    for (const src of [nested, open]) {
      const root = mkdtempSync(join(tmpdir(), 'speckl-eff-throw-'));
      const file = join(root, 'spec.speckdl');
      writeFileSync(file, src);
      const ast = parseSpeckContent(src, file);
      expect(() => generateEffect(lower(ast, { filePath: file, resolveImports: false }), join(root, 'out'), ast)).toThrow(EffectTargetError);
    }
    const root = mkdtempSync(join(tmpdir(), 'speckl-eff-throw-'));
    const file = join(root, 'spec.speckdl');
    writeFileSync(file, nested);
    const ast = parseSpeckContent(nested, file);
    try {
      generateEffect(lower(ast, { filePath: file, resolveImports: false }), join(root, 'out'), ast);
    } catch (e) {
      expect((e as Error).message).toMatch(/nested/);
    }
    writeFileSync(file, open);
    const ast2 = parseSpeckContent(open, file);
    try {
      generateEffect(lower(ast2, { filePath: file, resolveImports: false }), join(root, 'out'), ast2);
    } catch (e) {
      expect((e as Error).message).toMatch(/string literal is not closed/);
    }
  });

  it('range-checks a Nat returned through a let', () => {
    const root = generate(`
speck LetNat {
  state { n: Nat }
  init { n := 0 }
  action Bad() {
    let v := n - 10
    return v
  }
}
`);
    expect(typechecks(root, 'LetNat')).toBe(true);
    const src = readFileSync(join(root, 'out', 'LetNat', 'src', 'index.ts'), 'utf-8');
    expect(src).toContain('LetNatDecision<number>');
    const result = runProgram(root, `
import * as Effect from "effect";
import * as M from "./out/LetNat/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.LetNatCapability;
  const step = yield* Effect.Effect.either(svc.bad());
  const state = yield* svc.getState;
  return { tag: step._tag === "Left" ? step.left._tag : step.right, n: state.n };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.letNatLive)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toEqual({ tag: 'SchemaViolation', n: 0 });
  });

  it('enforces a forall over a set and set membership', () => {
    const root = generate(`
speck ForallSet {
  state { xs: Set(Nat), flag: Bool }
  init {
    xs := emptySet()
    flag := false
  }
  invariant Small { forall x in xs: x < 10 }
  invariant Flag { flag in {true, false} }
  action Add(v: Nat) {
    xs := xs union {v}
    return v
  }
  action Turn() {
    flag := true
    return flag
  }
}
`);
    const result = runProgram(root, `
import * as Effect from "effect";
import { HashSet } from "effect";
import * as M from "./out/ForallSet/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.ForallSetCapability;
  const ok = yield* Effect.Effect.either(svc.add(3));
  const mid = yield* svc.getState;
  const bad = yield* Effect.Effect.either(svc.add(10));
  const after = yield* svc.getState;
  const turn = yield* Effect.Effect.either(svc.turn());
  const end = yield* svc.getState;
  return {
    ok: ok._tag,
    has3: HashSet.has(mid.xs, 3),
    bad: bad._tag === "Left" ? bad.left._tag : "ok",
    still3: HashSet.has(after.xs, 3),
    has10: HashSet.has(after.xs, 10),
    turn: turn._tag,
    flag: end.flag,
  };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.forallSetLive)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toEqual({ ok: 'Right', has3: true, bad: 'InvariantViolated', still3: true, has10: false, turn: 'Right', flag: true });
  });

  it('restores an outer quantifier binding shadowed by an inner one', () => {
    const root = generate(`
speck Shadow {
  state { xs: Set(Nat), ys: Set(Nat) }
  init {
    xs := emptySet()
    ys := emptySet()
  }
  invariant Both { forall x in xs: (forall x in ys: x > 0) and x > 10 }
  action AddX(v: Nat) {
    xs := xs union {v}
    return v
  }
  action AddY(v: Nat) {
    ys := ys union {v}
    return v
  }
}
`);
    const src = readFileSync(join(root, 'out', 'Shadow', 'src', 'index.ts'), 'utf-8');
    expect(src).not.toContain('untranslated invariant: Both');
    const result = runProgram(root, `
import * as Effect from "effect";
import { HashSet } from "effect";
import * as M from "./out/Shadow/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.ShadowCapability;
  const y = yield* Effect.Effect.either(svc.addY(1));
  const x = yield* Effect.Effect.either(svc.addX(11));
  const mid = yield* svc.getState;
  const bad = yield* Effect.Effect.either(svc.addX(5));
  const end = yield* svc.getState;
  return {
    y: y._tag,
    x: x._tag,
    has11: HashSet.has(mid.xs, 11),
    bad: bad._tag === "Left" ? bad.left._tag : "ok",
    still11: HashSet.has(end.xs, 11),
    has5: HashSet.has(end.xs, 5),
  };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.shadowLive)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toEqual({ y: 'Right', x: 'Right', has11: true, bad: 'InvariantViolated', still11: true, has5: false });
  });

  it('keeps a missing map key and a bad list index on the typed channel', () => {
    const root = generate(`
speck Miss {
  state { accounts: Set(Nat), balances: Map(Nat, Nat), xs: List(Nat) }
  init {
    accounts := emptySet()
    balances := emptyMap()
    xs := emptyList()
  }
  invariant NonNeg { forall id in accounts: balances[id] >= 0 }
  action Open(id: Nat) {
    accounts := accounts union {id}
    return id
  }
  action Read(id: Nat): Nat {
    return balances[id]
  }
  action At(i: Nat): Nat {
    return xs[i]
  }
  action Need(id: Nat): Nat {
    require balances[id] >= 0
    return balances[id]
  }
}
`);
    const result = runProgram(root, `
import * as Effect from "effect";
import { HashSet } from "effect";
import * as M from "./out/Miss/src/index.ts";
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.MissCapability;
  const open = yield* Effect.Effect.either(svc.open(1));
  const afterOpen = yield* svc.getState;
  const read = yield* Effect.Effect.either(svc.read(1));
  const at = yield* Effect.Effect.either(svc.at(0));
  const need = yield* Effect.Effect.either(svc.need(1));
  return {
    open: open._tag === "Left" ? open.left._tag : "ok",
    accounts: HashSet.size(afterOpen.accounts),
    read: read._tag === "Left" ? read.left._tag : "ok",
    at: at._tag === "Left" ? at.left._tag : "ok",
    need: need._tag === "Left" ? need.left._tag : "ok",
  };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.missLive)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toEqual({ open: 'InvariantViolated', accounts: 0, read: 'IndexOutOfRange', at: 'IndexOutOfRange', need: 'GuardFailed' });
  });

  it('treats a missing map read as unknown and fails a let before the Nat check', () => {
    const root = generate(`
speck Kleene {
  state { accounts: Set(Nat), balances: Map(Nat, Nat), xs: List(Nat), n: Nat }
  init {
    accounts := emptySet()
    balances := emptyMap()
    xs := emptyList()
    n := 0
  }
  invariant Hit { exists id in accounts: balances[id] >= 0 }
  invariant Ok { forall id in accounts: balances[id] >= 0 or true }
  invariant Mix { forall id in accounts: (not (false and balances[id] >= 0)) implies true }
  action Seed() {
    accounts := accounts union {1}
    accounts := accounts union {2}
    balances[2] := 5
    return 0
  }
  action Guard(id: Nat) {
    require balances[id] >= 0 or true
    n := n + 1
    return n
  }
  action Bound(id: Nat): Nat {
    let v := balances[id]
    return v
  }
  action MissGuard(id: Nat) {
    require balances[id] >= 0
    n := n + 1
    return n
  }
  action TooSmall(id: Nat) {
    require balances[id] >= 10
    n := n + 1
    return n
  }
  action Wipe() {
    balances := emptyMap()
    return 0
  }
  action AtGuard() {
    require xs[0] >= 0 or true
    return 0
  }
  action Plain(): Bool {
    if n >= 0 or n >= 1 {
      n := n
    }
    if n >= 0 and n >= 0 {
      n := n
    }
    if n >= 0 implies true {
      n := n
    }
    if not (n >= 0) {
      n := n
    }
    return implies(n >= 0, true)
  }
  action AsBool(): Bool {
    return forall id in accounts: balances[id] >= 0 or true
  }
  action AsSome(): Bool {
    return exists id in accounts: not (balances[id] >= 0 and false) implies true
  }
}
`);
    expect(typechecks(root, 'Kleene')).toBe(true);
    const src = readFileSync(join(root, 'out', 'Kleene', 'src', 'index.ts'), 'utf-8');
    expect(src).toContain('$$kExists');
    expect(src).toContain('$$kForall');
    expect(src).toContain('$$kOr');
    expect(src).toContain('$$kAnd');
    expect(src).toContain('$$kNot');
    expect(src).toContain('$$kImplies');
    expect(src).toContain('$$specklBoolGet');
    expect(src).toContain('$$specklBoolAt');
    const result = runProgram(root, `
import * as Effect from "effect";
import { HashMap, HashSet, Option } from "effect";
import * as M from "./out/Kleene/src/index.ts";
const tag = (e: { _tag: string } & { left?: { _tag: string; detail?: string } }) =>
  e._tag === "Left" ? { tag: e.left!._tag, detail: e.left!.detail ?? "" } : { tag: "Right", detail: "" };
const program = Effect.Effect.gen(function* () {
  const svc = yield* M.KleeneCapability;
  const seed = tag(yield* Effect.Effect.either(svc.seed()));
  const guard = tag(yield* Effect.Effect.either(svc.guard(1)));
  const afterGuard = yield* svc.getState;
  const bound = tag(yield* Effect.Effect.either(svc.bound(1)));
  const miss = tag(yield* Effect.Effect.either(svc.missGuard(1)));
  const small = tag(yield* Effect.Effect.either(svc.tooSmall(2)));
  const wipe = tag(yield* Effect.Effect.either(svc.wipe()));
  const end = yield* svc.getState;
  const got = HashMap.get(end.balances, 2);
  return {
    seed, guard, nGuard: afterGuard.n,
    bound, miss, small, wipe,
    n: end.n,
    has1: HashSet.has(end.accounts, 1),
    has2: HashSet.has(end.accounts, 2),
    bal2: Option.isSome(got) ? got.value : null,
  };
});
const value = await Effect.Effect.runPromise(program.pipe(Effect.Effect.provide(M.kleeneLive)));
console.log("RESULT " + JSON.stringify(value));
`);
    expect(result).toEqual({
      seed: { tag: 'Right', detail: '' },
      guard: { tag: 'Right', detail: '' },
      nGuard: 1,
      bound: { tag: 'IndexOutOfRange', detail: 'missing map key' },
      miss: { tag: 'GuardFailed', detail: 'missing map key' },
      small: { tag: 'GuardFailed', detail: 'balances[id] >= 10' },
      wipe: { tag: 'InvariantViolated', detail: 'missing map key' },
      n: 1,
      has1: true,
      has2: true,
      bal2: 5,
    });
  });
});
