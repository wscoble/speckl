// scripts/lib/obligations.mjs
//
// Per-obligation verdicts for an SMT-LIB2 file with several (check-sat)s.
//
// A Speckl .smt2 file can carry one (check-sat) per `verify` block, each in
// its own (push)/(pop) scope with its own `; speckl-expect:` marker. Every
// one is an independent proof obligation: each solver answer is paired with
// the marker and label that precede *its* check-sat, so a violated earlier
// property can never be masked by a later one that holds.

/**
 * Ordered proof obligations: one per (check-sat), with its own expectation.
 *
 * `key` names the verify block a check-sat stands for (`; speckl-obligation:`
 * marker). `degraded` is the reason when the generator could only lower it to
 * a consistency check (`; speckl-expect: sat (degraded: <reason>)`): such a
 * check still has to answer sat, but it proves nothing about the verify block.
 */
export function obligationsOf(smt) {
  const out = [];
  let expect = null;
  let degraded = null;
  let label = null;
  let key = null;
  const lines = smt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let m;
    if ((m = line.match(/^;\s*speckl-expect:\s*(sat|unsat)\b(.*)$/))) {
      expect = m[1];
      const d = m[2].match(/\(degraded:\s*(.*)\)\s*$/);
      degraded = d ? d[1].trim() : null;
    } else if ((m = line.match(/^;\s*speckl-obligation:\s*(\S.*)$/))) key = m[1].trim();
    else if ((m = line.match(/^\(echo\s+"Checking:\s*([^"]*)"\)/))) label = m[1].trim();
    else if (/^\(check-sat\b/.test(line)) {
      out.push({ index: out.length, line: i, expect, degraded, key, label: label ?? `check-sat #${out.length + 1}` });
      expect = null;
      degraded = null;
      label = null;
      key = null;
    }
  }
  return out;
}

/** Verify blocks a file declares but has no check for: `; speckl-unchecked: <key>: <reason>`. */
export function uncheckedOf(smt) {
  const out = [];
  for (const raw of smt.split('\n')) {
    const m = raw.trim().match(/^;\s*speckl-unchecked:\s*(.*)$/);
    if (!m) continue;
    // Reasons are generator text without ': ', so the key is everything
    // before the last ': ' (keys may contain colons).
    const cut = m[1].lastIndexOf(': ');
    const key = (cut >= 0 ? m[1].slice(0, cut) : m[1]).trim();
    const reason = cut >= 0 ? m[1].slice(cut + 2).trim() : '';
    if (key) out.push({ key, reason: reason || 'not lowered' });
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
    // Fail closed: a check-sat with no expectation marker proves nothing.
    const ok = (got === 'sat' || got === 'unsat') && o.expect !== null && got === o.expect;
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

/**
 * Obligation accounting across every SMT file compiled from one spec.
 *
 * Every verify block a file declares (a keyed check-sat or a
 * `speckl-unchecked` marker) must be proven by some file: a keyed,
 * non-degraded check that expected unsat and got unsat. Anything else is
 * unchecked, and unchecked fails. A skipped or unlowered obligation never
 * counts as a pass.
 *
 * `files` is [{ smt, obligations }] where obligations are judge() results.
 * Returns { proven: [key], unchecked: [{ key, reasons }] }.
 */
export function accountObligations(files) {
  const declared = new Map(); // key -> reasons[]
  const proven = new Set();
  const failing = new Set(); // already reported as a failed check
  const note = (key, reason) => {
    if (!declared.has(key)) declared.set(key, []);
    if (reason && !declared.get(key).includes(reason)) declared.get(key).push(reason);
  };
  for (const f of files) {
    for (const u of uncheckedOf(f.smt)) note(u.key, u.reason);
    for (const o of f.obligations ?? []) {
      if (!o.key) continue;
      if (o.ok && o.expect === 'unsat' && !o.degraded) {
        note(o.key, null);
        proven.add(o.key);
      } else if (!o.ok) {
        failing.add(o.key);
      } else {
        note(o.key, o.degraded ?? `not a proof (expected ${o.expect})`);
      }
    }
  }
  const unchecked = [];
  for (const [key, reasons] of declared) {
    if (proven.has(key) || failing.has(key)) continue;
    // "Delegated" only explains one backend; show the reason the obligation
    // still has no proof when another backend gave one.
    const own = reasons.filter(r => !/delegated/.test(r));
    const shown = own.length ? own : reasons;
    unchecked.push({ key, reasons: shown.length ? shown : ['no proof'] });
  }
  return { proven: [...proven].sort(), unchecked };
}
