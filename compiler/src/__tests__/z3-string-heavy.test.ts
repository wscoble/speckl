// String-heavy spec corpus (greybeard-specks): Z3 backend regressions.
//
// These cases cover the compiler-bug Z3-ERRORs ledgered in
// greybeard-specks ops/verify-ledger.json at speckl 644fc31 (GRE-988):
//   1. list literals lowered to bare (Array ...) applications
//      (GmailJobLeads, JobAlerts, MercorDomainInterviewBrief)
//   2. duplicate speckl_len_<Sort> declarations for two lists with the
//      same element sort (MercorDomainInterviewBrief)
//   3. member `.length` on a list lowered to (select v "length") with a
//      String key on an Int-domain array (MercorDomainInterviewBrief)
//   4. forall over a bare map domain bound to Int while iterated keys are
//      String, with `u in <map>` membership in the body (ReadingQueue)
//
// Each case compiles a minimal spec shaped like its real counterpart and
// asserts the emitted SMT runs clean under the real solver, plus
// file-level assertions pinning the emitted encodings.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileSpec } from '../compile.js';

const hasZ3 = spawnSync('z3', ['--version']).status === 0;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

/** Compile with the AST Z3 target (emits both .smt2 and .ir.smt2) and read all outputs. */
function emit(name: string, src: string): { dir: string; files: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-strheavy-'));
  const spec = join(dir, `${name}.speckdl`);
  writeFileSync(spec, src);
  const out = join(dir, 'out');
  compileSpec(spec, { outputDir: out, target: 'z3', bomFormat: 'cdx', verifyDepth: 6 });
  const files: Record<string, string> = {};
  for (const f of readdirSync(out).filter((f2) => f2.endsWith('.smt2'))) {
    files[f] = readFileSync(join(out, f), 'utf-8');
  }
  return { dir, files };
}

function z3CleanError(smt: string): string {
  const r = spawnSync('z3', ['-smt2', '-in', '-T:60'], { input: smt, encoding: 'utf-8' });
  const err = `${r.stderr ?? ''} ${r.stdout ?? ''}`.includes('(error')
    ? [...`${r.stderr ?? ''} ${r.stdout ?? ''}`.matchAll(/\(error ([^\n]*)/g)].map((m) => m[1]).join(' | ')
    : '';
  return err;
}

const leads = `speck Leads {
    author: "T" <"t@example.com">

    state {
        role: Map(String, String)
        recommended: List(String)
        tracked: List(String)
    }

    init {
        recommended := ["alpha-a", "beta-b", "gamma-c"]
    }

    invariant RecommendedHas { forall r in recommended: r in role.keys }
    invariant RecommendedCounted { recommended.length == 3 }
}
`;

describe.skipIf(!hasZ3)('Z3 backends: string-heavy spec regressions (GRE-988)', () => {
  it('list literals lower to Seq construction, never a bare (Array ...) application', () => {
    const { files } = emit('Leads', leads);
    const ir = files['Leads.ir.smt2'];
    expect(ir).toContain('(declare-const recommended (Seq String))');
    expect(ir).toContain('(seq.unit "alpha-a")');
    expect(ir).toContain('(seq.++');
    expect(ir).not.toMatch(/= recommended \(Array /);
    expect(z3CleanError(ir)).toBe('');
  }, 60_000);

  it('the AST backend declares speckl_len_String exactly once and lowers .length to it', () => {
    const { files } = emit('Leads', leads);
    const ast = files['Leads.smt2'];
    const declarations = ast.match(/declare-fun speckl_len_String/g) ?? [];
    expect(declarations.length).toBe(1);
    expect(ast).toContain('speckl_len_String recommended');
    expect(ast).not.toMatch(/"length"/);
    expect(z3CleanError(ast)).toBe('');
  }, 60_000);

  it('a zero-element list literal degrades to an explicit skipped-init, never invalid SMT', () => {
    const empty = leads.replace('recommended := ["alpha-a", "beta-b", "gamma-c"]', 'recommended := []');
    const { files } = emit('LeadsEmpty', empty);
    const ir = files['Leads.ir.smt2'];
    // `[]` has no parseable IR literal yet; the honest degradation is a
    // named skipped-init comment, not a malformed (Array) application.
    expect(ir).toMatch(/skipped init recommended: expression failed to parse: \[\]/);
    expect(z3CleanError(ir)).toBe('');
    expect(ir).not.toMatch(/\(Array\)/);
  }, 60_000);

  it('a forall over a bare map domain binds the key sort and map-key membership degrades to an explicit sanitizer skip', () => {
    const queue = `speck Queue {
    author: "T" <"t@example.com">

    type Status = Queued | Done

    state {
        status: Map(String, Status)
        title: Map(String, String)
        note: Map(String, String)
    }

    init {
        status := emptyMap
        title := emptyMap
        note := emptyMap
    }

    action MarkRead(url: String) {
        require url in status
        status[url] := Done
    }

    invariant TitledAndSummarized { forall u in status: u in title and u in note }
}
`;
    const { files } = emit('Queue', queue);
    const ast = files['Queue.smt2'];
    // A String-valued map select must never appear where a Bool is required;
    // the invariant body degrades via the sanitizer's undeclared-identifier
    // path, exactly like the `.keys` sugar (AccountLedger precedent).
    expect(ast).not.toMatch(/select title |select note |select title_keys|select note_keys/);
    expect(ast).toMatch(/skipped: references undeclared identifier\(s\): (title_keys|note_keys|TitledAndSummarized)/);
    expect(z3CleanError(ast)).toBe('');
    const ir = files['Queue.ir.smt2'];
    expect(z3CleanError(ir)).toBe('');
  }, 60_000);
});

describe.skipIf(!hasZ3)('Z3 backends: fail-closed paths for string-heavy shapes (GRE-988)', () => {
  it('the deduped speckl_len_<Sort> declaration generalizes to a record element sort', () => {
    // Two List(Row) variables with member `.length` invariants must declare
    // speckl_len_Row exactly once (the dedup is per element sort, not per
    // variable), and both length lowerings must reference it.
    const rows = `speck Rows {
    type Row = { id: Nat, label: String }

    state {
        left: List(Row)
        right: List(Row)
    }

    invariant CountedLeft { left.length == 2 }
    invariant CountedRight { right.length == 2 }
}
`;
    const { files } = emit('Rows', rows);
    const ast = files['Rows.smt2'];
    const declarations = ast.match(/declare-fun speckl_len_Row/g) ?? [];
    expect(declarations.length).toBe(1);
    expect(ast).toContain('speckl_len_Row left');
    expect(ast).toContain('speckl_len_Row right');
    expect(z3CleanError(ast)).toBe('');
  }, 60_000);

  it('an AST-backend invariant holding a list literal fails loudly, never as a claimed check', () => {
    // Known, documented limit (CHANGELOG): the AST backend cannot lower a
    // list literal inside an invariant. The emitted form is invalid SMT, so
    // z3 errors and the verifier fails the spec: fail closed. The invariant
    // must never silently vanish and never silently pass. The IR backend,
    // on the Seq list model, lowers the same literal and runs clean.
    const exact = `speck ExactProbe {
    state {
        recommended: List(String)
    }

    init {
        recommended := ["alpha-a", "beta-b"]
    }

    invariant ExactContents { recommended == ["alpha-a", "beta-b"] }
}
`;
    const { files } = emit('ExactProbe', exact);
    const ast = files['ExactProbe.smt2'];
    expect(z3CleanError(ast)).not.toBe('');
    const ir = files['ExactProbe.ir.smt2'];
    expect(ir).toContain('(seq.++');
    expect(z3CleanError(ir)).toBe('');
  }, 60_000);
});
