// scripts/lib/obligations.mjs
//
// Per-obligation verdicts for an SMT-LIB2 file with several (check-sat)s.
//
// A Speckl .smt2 file can carry one (check-sat) per `verify` block, each in
// its own (push)/(pop) scope with its own `; speckl-expect:` marker. Every
// one is an independent proof obligation: each solver answer is paired with
// the marker and label that precede *its* check-sat, so a violated earlier
// property can never be masked by a later one that holds.

/** Ordered proof obligations: one per (check-sat), with its own expectation. */
export function obligationsOf(smt) {
  const out = [];
  let expect = null;
  let label = null;
  const lines = smt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let m;
    if ((m = line.match(/^;\s*speckl-expect:\s*(sat|unsat)\b/))) expect = m[1];
    else if ((m = line.match(/^\(echo\s+"Checking:\s*([^"]*)"\)/))) label = m[1].trim();
    else if (/^\(check-sat\b/.test(line)) {
      out.push({ index: out.length, line: i, expect, label: label ?? `check-sat #${out.length + 1}` });
      expect = null;
      label = null;
    }
  }
  return out;
}

/** Ordered solver answers (sat/unsat/unknown) from z3 stdout. */
export function solverAnswers(stdout) {
  return stdout.split('\n').map(l => l.trim()).filter(l => l === 'sat' || l === 'unsat' || l === 'unknown');
}

/**
 * Judge every obligation. Returns { status, obligations: [{label, expect, got, ok}] }
 * where status is 'OK' only when every obligation matched its own expectation.
 */
export function judge(smt, stdout, stderr = '') {
  const combined = stdout + '\n' + stderr;
  const err = combined.match(/\(error "([^"]*)"\)/);
  if (err) return { status: 'Z3-ERROR', detail: err[1], obligations: [] };
  const obligations = obligationsOf(smt);
  const answers = solverAnswers(stdout);
  if (answers.length === 0) return { status: 'NO-RESULT', detail: 'solver returned no result', obligations: [] };
  const judged = obligations.map((o, i) => {
    const got = answers[i] ?? 'missing';
    const ok = got === 'sat' || got === 'unsat' ? (o.expect ? got === o.expect : true) : false;
    return { ...o, got, ok };
  });
  if (answers.length !== obligations.length) {
    return { status: 'NO-RESULT', detail: `${obligations.length} check-sat(s) but ${answers.length} solver answer(s)`, obligations: judged };
  }
  const bad = judged.filter(o => !o.ok);
  if (bad.length === 0) return { status: 'OK', obligations: judged };
  const nores = bad.find(o => o.got === 'unknown' || o.got === 'missing');
  return { status: nores ? 'NO-RESULT' : 'VIOLATED', detail: `${bad.length}/${judged.length} obligation(s) failed`, obligations: judged };
}

/** SMT prefix through obligation `ob`'s check-sat, followed by (get-model). */
export function modelQueryFor(smt, ob) {
  const lines = smt.split('\n').slice(0, ob.line + 1).filter(l => !/^\s*\(get-model\)\s*$/.test(l));
  return lines.join('\n') + '\n(get-model)\n';
}
