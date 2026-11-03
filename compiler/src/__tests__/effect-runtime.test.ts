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
});
