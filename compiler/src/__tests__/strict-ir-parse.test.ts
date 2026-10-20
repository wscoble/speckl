// The IR never acts on part of an expression or statement.
//
// The lenient expression parser stopped at the first token it could not use
// and the statement parser joined lines until the next recognised keyword, so
// six examples (AccountLedger, Paxos, Raft, RetryHandler, SQLiteWAL, tef) lost
// the tails of expressions and whole statements without a diagnostic. Each
// case below is a form that used to be dropped. It must now either be carried
// through in full or reach every IR backend as an explicit, labelled
// placeholder (UNCHECKED in Z3, a throwing expression in TypeScript, a marked
// fail-closed `false` in Java).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpeckContent } from '../parser.js';
import { lower } from '../ir/lower.js';
import { parseActionStatements } from '../expr/stmt-parser.js';
import { parseExpressionComplete, Tokenizer, TokenType } from '../expr/index.js';
import { exprToSource } from '../expr/print.js';
import { generateZ3FromIR } from '../generators/z3-from-ir.js';
import { generateTypeScriptFromIR } from '../generators/typescript-from-ir.js';
import { generateCamel } from '../generators/camel.js';
import type { IR, IRSpeck } from '../ir/types.js';

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

function lowerSrc(src: string): IR {
  const filePath = join(mkdtempSync(join(tmpdir(), 'speckl-strict-')), 'T.speckdl');
  writeFileSync(filePath, src);
  return lower(parseSpeckContent(src, filePath), { filePath, resolveImports: false });
}

const spec = (constraints: string[], body: string[] = ['x := x + 1']) => `speck T {
    state {
        x: Nat
        flag: Bool
    }
    init {
        x := 0
        flag := false
    }
${constraints.map(c => `    constraint ${c}`).join('\n')}
    action Step() {
${body.map(l => `        ${l}`).join('\n')}
    }
    next: Step
}
`;

function stmtsOf(body: string[]) {
  return parseActionStatements(body);
}

/** Every file under `dir`, concatenated. */
function readTree(dir: string): string {
  let out = '';
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out += statSync(p).isDirectory() ? readTree(p) : readFileSync(p, 'utf-8') + '\n';
  }
  return out;
}

describe('expression parser: forms that used to lose their tail', () => {
  it('infix implies is an operator (SQLiteWAL: `walResetNeeded implies (nReaders == 0)`)', () => {
    const e = parseExpressionComplete('walResetNeeded implies (nReaders == 0)');
    expect(e).toMatchObject({ kind: 'binary', op: 'implies', left: { kind: 'ident', name: 'walResetNeeded' } });
  });

  it('implies binds looser than or/and and groups to the right', () => {
    expect(parseExpressionComplete('a or b implies c')).toMatchObject({
      op: 'implies', left: { op: 'or' }, right: { kind: 'ident', name: 'c' },
    });
    expect(parseExpressionComplete('a implies b implies c')).toMatchObject({
      op: 'implies', left: { name: 'a' }, right: { op: 'implies', left: { name: 'b' }, right: { name: 'c' } },
    });
  });

  it('`n-1` is a subtraction, not `n` followed by the literal -1 (RetryHandler: `delay(n-1)`)', () => {
    const types = new Tokenizer('n-1').tokenize().map(t => t.type);
    expect(types).toEqual([TokenType.IDENT, TokenType.SUB, TokenType.NUMBER, TokenType.EOF]);
    expect(parseExpressionComplete('delay(n-1) * 2')).toMatchObject({ op: 'mul', left: { kind: 'call', args: [{ op: 'sub' }] } });
    // A negative literal is still a literal after an operator or `(`.
    expect(parseExpressionComplete('f(-1) + -2')).toMatchObject({ op: 'add', left: { args: [{ kind: 'literal', value: '-1' }] }, right: { kind: 'literal', value: '-2' } });
  });

  it('an operator after a call respects the enclosing precedence (KafkaKRaft, Raft: `i <= length(log) && ...`)', () => {
    expect(parseExpressionComplete('i <= length(log) && ok')).toMatchObject({ op: 'and', left: { op: 'lte', right: { kind: 'call' } } });
    expect(parseExpressionComplete('a * f(x) + 1')).toMatchObject({ op: 'add', left: { op: 'mul', right: { kind: 'call' } } });
    // Postfix chaining on a call still binds to the call.
    expect(parseExpressionComplete('f(x).y == 1')).toMatchObject({ op: 'eq', left: { kind: 'member', property: 'y' } });
  });

  it('a character the tokenizer does not know is an error, not the end of the input', () => {
    expect(() => parseExpressionComplete('x \u2264 3')).toThrow(/Unexpected character/);
  });

  it('a unit suffix is an error, not a dropped token (RetryHandler: `totalDelay <= 30s`)', () => {
    expect(() => parseExpressionComplete('totalDelay <= 30s')).toThrow(/trailing input/);
  });
});

describe('IR constraints: whole expression or an explicit placeholder', () => {
  it('a constraint with infix implies is lowered in full and asserted as an implication', () => {
    const ir = lowerSrc(spec(['Guard: flag implies (x > 0)']));
    expect(ir.specks[0].facets.formal_spec.constraints[0].expr).toMatchObject({ kind: 'call', fn: 'implies' });
    const out = mkdtempSync(join(tmpdir(), 'speckl-strict-'));
    generateZ3FromIR(ir, { outputDir: out });
    expect(readFileSync(join(out, 'T.ir.smt2'), 'utf-8')).toContain('(assert (=> flag (> x 0)))');
  });

  it('a quantified constraint is a labelled placeholder with a warning and is skipped in Z3 (SQLiteWAL, tef)', () => {
    const src = 'forall r in [0..4]: (x == 0) or (r <= x)';
    const ir = lowerSrc(spec([`ReadConsistency: ${src}`]));
    expect(ir.specks[0].facets.formal_spec.constraints[0].expr).toMatchObject({ kind: 'bool_lit', parseFailed: true, source: src });
    expect(ir.diagnostics.some(d => d.level === 'warning' && d.message.includes(src))).toBe(true);
    const out = mkdtempSync(join(tmpdir(), 'speckl-strict-'));
    generateZ3FromIR(ir, { outputDir: out });
    const smt = readFileSync(join(out, 'T.ir.smt2'), 'utf-8');
    expect(smt).toContain(`; skipped constraint ReadConsistency: expression failed to parse: ${src}`);
    expect(smt).not.toMatch(/\(assert forall\b|\(assert false\)/);
  });
});

describe('action statements: no statement is swallowed or dropped', () => {
  it('an assignment does not swallow the next map-index assignment (AccountLedger)', () => {
    const s = stmtsOf(['accounts := accounts union {acctId}', 'balances[acctId] := 0']);
    expect(s.map(x => x.type)).toEqual(['assign', 'assign']);
    expect(s[0]).toMatchObject({ target: { kind: 'plain', name: 'accounts' }, expr: { kind: 'binary', op: 'union', right: { kind: 'set' } } });
    expect(s[1]).toMatchObject({ target: { kind: 'map_index', mapName: 'balances' }, expr: { kind: 'literal', value: '0' } });
  });

  it('an assignment does not swallow a following record-keyed assignment (Raft)', () => {
    const s = stmtsOf(['lastLogIndex := lastLogIndex + 1', 'matchIndex[{ leader: leader, follower: s }] := 0']);
    expect(s.map(x => x.type)).toEqual(['assign', 'assign']);
    expect(s[0]).toMatchObject({ expr: { kind: 'binary', op: 'add' } });
    expect(s[1]).toMatchObject({ target: { kind: 'map_index', mapName: 'matchIndex', index: { kind: 'object' } } });
  });

  it('an assignment whose value starts on the next line takes that value (Paxos)', () => {
    const s = stmtsOf(['ballots[bnum] :=', '{ number: bnum, value: null, proposer: prop }', 'votedValue[acSlot] := value']);
    expect(s.map(x => x.type)).toEqual(['assign', 'assign']);
    expect(s[0]).toMatchObject({ target: { mapName: 'ballots' }, expr: { kind: 'object' } });
    expect(s[1]).toMatchObject({ target: { mapName: 'votedValue' } });
  });

  it('a multi-line quantified require is one statement with its full text (SQLiteWAL)', () => {
    const s = stmtsOf([
      'require frameId > checkpointSeq  // not already checkpointed',
      'require forall r in [0..4]:',
      '    (readerEndMark[r] == 0) or (frameId <= readerEndMark[r])',
      'nFrames := nFrames + 1',
    ]);
    expect(s.map(x => x.type)).toEqual(['require', 'require', 'assign']);
    expect(s[0]).toMatchObject({ expr: { kind: 'binary', op: 'gt' } });
    expect(s[1]).toMatchObject({
      expr: { kind: 'unparsed', source: 'forall r in [0..4]: (readerEndMark[r] == 0) or (frameId <= readerEndMark[r])' },
    });
  });

  it('consecutive map-index assignments each survive (SQLiteWAL AppendFrame)', () => {
    const s = stmtsOf(['nFrames := nFrames + 1', 'walFrames[nFrames] := pageId', 'walFrameSeq[nFrames] := nFrames', 'writerFrames[pageId] := pageId']);
    expect(s.map(x => (x as any).target?.mapName ?? (x as any).target?.name)).toEqual(['nFrames', 'walFrames', 'walFrameSeq', 'writerFrames']);
  });

  it('a record constructor is carried as unparsed source, not cut to its type name (tef)', () => {
    const s = stmtsOf(['let c := Customer {', '    name: name,', '    tier: "gold"', '}', 'customers := customers']);
    expect(s.map(x => x.type)).toEqual(['let', 'assign']);
    expect(s[0]).toMatchObject({ expr: { kind: 'unparsed', source: 'Customer { name: name, tier: "gold" }' } });
  });

  it('a bare call statement is kept as raw text, not swallowed by the line above (tef)', () => {
    const s = stmtsOf(['let p := products[name]', 'transitionProductPhase(productName, Rejected, reason)']);
    expect(s.map(x => x.type)).toEqual(['let', 'ifblock']);
    expect(s[0]).toMatchObject({ expr: { kind: 'index' } });
    expect(s[1]).toMatchObject({ raw: 'transitionProductPhase(productName, Rejected, reason)' });
  });

  it('a multi-line emit keeps every field', () => {
    const s = stmtsOf(['emit Requested {', '    client_id: client,', '    scope: f(a, b)', '}', 'x := 1']);
    expect(s.map(x => x.type)).toEqual(['emit', 'assign']);
    expect((s[0] as any).fields.map((f: any) => f.name)).toEqual(['client_id', 'scope']);
    expect((s[0] as any).fields[1].value).toMatchObject({ kind: 'call', args: [{}, {}] });
  });

  it('a typed let continues onto lines that start with an operator', () => {
    const s = stmtsOf(['let logOk: Bool = prevLogIndex == 0', '    || (prevLogIndex <= n)', 'x := 1']);
    expect(s.map(x => x.type)).toEqual(['let', 'assign']);
    expect(s[0]).toMatchObject({ name: 'logOk', expr: { kind: 'binary', op: 'or' } });
  });

  it('indented comments are skipped, not reported as statements', () => {
    expect(stmtsOf(['    // a comment', 'x := 1']).map(x => x.type)).toEqual(['assign']);
  });

  it('a dotted-path assignment is kept as raw text (no IR form yet)', () => {
    expect(stmtsOf(['p.status.phase := newPhase'])).toEqual([{ type: 'ifblock', raw: 'p.status.phase := newPhase' }]);
  });
});

describe('IR backends say what they could not translate', () => {
  const body = [
    'let c := Customer { name: "a" }',
    'require forall r in [0..4]: r <= x',
    'transitionProductPhase(x, flag)',
    'x := x + 1',
  ];
  let ir: IR;
  let speck: IRSpeck;
  beforeAll(() => {
    ir = lowerSrc(spec(['Pos: x >= 0'], body));
    speck = ir.specks[0];
  });

  it('lowering keeps the source of every placeholder and every raw statement', () => {
    const stmts = speck.facets.behavior.actions[0].statements;
    expect(stmts.map(s => s.kind)).toEqual(['let', 'require', 'if', 'assign']);
    expect(stmts[0].value).toMatchObject({ parseFailed: true, source: 'Customer { name: "a" }' });
    expect(stmts[1].value).toMatchObject({ parseFailed: true, source: 'forall r in [0..4]: r <= x' });
    expect(stmts[2]).toMatchObject({ raw: 'transitionProductPhase(x, flag)' });
  });

  it('TypeScript throws with the source instead of computing `false`', () => {
    const out = mkdtempSync(join(tmpdir(), 'speckl-strict-'));
    generateTypeScriptFromIR(ir, out);
    const ts = readFileSync(join(out, 'T.ts'), 'utf-8');
    expect(ts).toContain('throw new Error("speckl: untranslated expression: Customer { name: \\"a\\" }")');
    expect(ts).toContain('throw new Error("speckl: untranslated expression: forall r in [0..4]: r <= x")');
    expect(ts).toContain('// SPECKL-UNTRANSLATED statement (not lowered): transitionProductPhase(x, flag)');
  });

  it('Camel fails closed with the source: the action throws before touching state', () => {
    const out = mkdtempSync(join(tmpdir(), 'speckl-strict-'));
    generateCamel(ir, { outputDir: out });
    const java = readTree(out);
    expect(java).toContain('SpecklRuntime.untranslated("let c := Customer { name: \\"a\\" }");');
    expect(java).toContain('SpecklRuntime.untranslated("require forall r in [0..4]: r <= x");');
    expect(java).toContain('SpecklRuntime.untranslated("transitionProductPhase(x, flag)");');
    // One guard at the top refuses the whole action before any effect.
    expect(java).toMatch(/public void process\(Exchange exchange\) throws Exception \{\n\s+\/\/ This action cannot run[^\n]*\n\s+SpecklRuntime\.untranslated\("\w+: 3 untranslated statements, first: let c := Customer/);
    // The translatable statement still goes through the state bean.
    expect(java).toMatch(/State\.setX\(\(\w+State\.getX\(\) \+ 1L\)\);/);
    // The old renderings: a fail-closed `false` inside the code, and an undeclared `forall`.
    expect(java).not.toContain('false /* SPECKL-UNTRANSLATED');
    expect(java).not.toMatch(/\(!\(forall\)\)/);
  });

  it('a placeholder whose source would close a Java comment cannot break out of it', () => {
    const ir2 = lowerSrc(spec(['Pos: x >= 0'], ['let c := Rec { note: "*/ evil" }']));
    const out = mkdtempSync(join(tmpdir(), 'speckl-strict-'));
    generateCamel(ir2, { outputDir: out });
    const java = readTree(out);
    expect(java).toContain('// SPECKL-UNTRANSLATED: let c := Rec { note: "* / evil" }');
    expect(java).toContain('SpecklRuntime.untranslated("let c := Rec { note: \\"*/ evil\\" }");');
  });
});

describe('placeholder labels', () => {
  it('render the parsed expression back as readable source', () => {
    const src = '{ a: -x, b: { 1 -> f(y) }, r: [0..n], p: (not y), s: { 1, 2 }, i: if c: m[k].v else "z", u: { ...base, q: null } }';
    expect(exprToSource(parseExpressionComplete(src))).toBe(src);
  });
});
