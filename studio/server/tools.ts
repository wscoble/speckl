import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { EXAMPLES_DIR, REPO } from './prompt.ts';

export const SPECKL_BIN = process.env.SPECKL_BIN ?? join(REPO, 'compiler', 'dist', 'index.js');
const Z3_BIN = process.env.Z3_BIN ?? 'z3';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], cwd?: string, timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// ---------- compiler ----------

async function compile(specPath: string, outDir: string, target: string): Promise<RunResult> {
  await mkdir(outDir, { recursive: true });
  return run('node', [SPECKL_BIN, specPath, '-o', outDir, '-t', target]);
}

function fmtRun(label: string, r: RunResult): string {
  const out = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
  return `### ${label} (exit ${r.code})\n${out || '(no output)'}`;
}

// ---------- counterexample formatting ----------

interface ParsedModel {
  banner: string;
  errors: string[];
  vars: Map<string, string>;
}

/** Return the full balanced s-expression starting at the '(' at s[start]. */
function readSexpr(s: string, start: number): string {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start);
}

/** Normalize a Z3 value: (- 1) → -1, records stay as-is. */
function z3Value(raw: string): string {
  const v = raw.trim().replace(/\s+/g, ' ');
  const neg = v.match(/^\(\s*-\s+(-?[\d.]+)\s*\)$/);
  if (neg) return '-' + neg[1];
  return v;
}

function parseZ3Model(stdout: string): ParsedModel {
  const banner = stdout.split('\n').find((l) => l.includes('Checking:'))?.trim() ?? '';
  const errors = stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('(error'))
    .map((l) => l.trim());
  const vars = new Map<string, string>();
  const re = /\(define-fun\s+([\w'.!-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout))) {
    const sexpr = readSexpr(stdout, m.index);
    // shape: (define-fun NAME () SORT VALUE?) - strip outer parens and header
    const inner = sexpr.slice(1, -1).replace(/^define-fun\s+/, '');
    const pm = inner.match(/^([\w'.!-]+)\s*\(\)\s*(\S+)\s*([\s\S]*)$/);
    if (!pm) continue;
    const value = z3Value(pm[3]);
    if (value) vars.set(pm[1], value);
  }
  return { banner, errors, vars };
}

/**
 * Render a solver counterexample as a per-step state table:
 * variables down the side, BMC steps across the top. Filters helper
 * symbols (speckl_*) and opaque uninterpreted-sort values that carry
 * no readable meaning.
 */
function formatCounterexample(stdout: string): string {
  const { banner, errors, vars } = parseZ3Model(stdout);

  // group step-suffixed variables: phase_0, phase_1, ... → phase
  const stepVars = new Map<string, Map<number, string>>();
  const tail = new Map<string, { final?: string; post?: string }>(); // per-base unsuffixed/_post bindings
  for (const [name, value] of vars) {
    if (name.startsWith('speckl_')) continue;
    if (value.includes('!val!')) continue; // opaque sort value - not readable
    if (!/^[\w.+-]+$/.test(value)) continue; // formula definitions, records - not state
    const sm = name.match(/^(.+)_(\d+)$/);
    if (sm) {
      const base = sm[1];
      if (!stepVars.has(base)) stepVars.set(base, new Map());
      stepVars.get(base)!.set(Number(sm[2]), value);
    } else {
      const base = name.replace(/_post$/, '');
      if (!tail.has(base)) tail.set(base, {});
      if (name.endsWith('_post')) tail.get(base)!.post = value;
      else tail.get(base)!.final = value;
    }
  }

  const hasFinal = [...tail.values()].some((t) => t.final !== undefined);
  const hasPost = [...tail.values()].some((t) => t.post !== undefined);
  const maxStep = Math.max(0, ...[...stepVars.values()].flatMap((m) => [...m.keys()]));
  const cols: string[] = [];
  for (let s = 0; s <= maxStep; s++) cols.push(String(s));
  if (hasFinal) cols.push('final');
  if (hasPost) cols.push('post');

  // rows: base name → value per column (blank when absent)
  const rows: Array<[string, string[]]> = [];
  for (const [base, steps] of [...stepVars.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const vals = cols.map((c) => {
      if (c === 'final') return tail.get(base)?.final ?? '';
      if (c === 'post') return tail.get(base)?.post ?? '';
      return steps.get(Number(c)) ?? '';
    });
    rows.push([base, vals]);
  }

  const nameW = Math.max(10, ...rows.map(([n]) => n.length));
  const colW = Math.max(6, ...rows.flatMap(([, vs]) => vs.map((v) => v.length)), ...cols.map((c) => c.length));
  const head = 'variable'.padEnd(nameW) + cols.map((c) => c.padStart(colW)).join('');
  const body = rows
    .map(([n, vs]) => n.padEnd(nameW) + vs.map((v) => v.padStart(colW)).join(''))
    .slice(0, 30)
    .join('\n');

  const parts: string[] = [];
  if (banner) parts.push(banner);
  parts.push('The solver found a state sequence that breaks the property within the search depth.');
  if (errors.length) parts.push(`Solver warnings (the emitted model may be incomplete):\n  ${errors.join('\n  ')}`);
  if (rows.length) {
    parts.push(`\nCounterexample trace - variable values per step:\n\n${head}\n${'-'.repeat(head.length)}\n${body}`);
    if (rows.length > 30) parts.push(`… (${rows.length - 30} more variables)`);
  }
  return parts.join('\n');
}

// ---------- tools ----------

export function listExamples(): string {
  let examples: string[] = [];
  try {
    examples = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.speckdl'));
  } catch {}
  return `Available example specs:\n${examples.map((f) => `- ${basename(f, '.speckdl')}`).join('\n')}`;
}

export async function readExample(name: string): Promise<string> {
  if (!NAME_RE.test(name)) return `Error: invalid example name "${name}"`;
  const p = join(EXAMPLES_DIR, `${name}.speckdl`);
  try {
    const content = await readFile(p, 'utf8');
    return `// ${name}.speckdl\n${content}`;
  } catch {
    return `Error: example "${name}" not found. ${listExamples()}`;
  }
}

export interface WriteSpecResult {
  ok: boolean;
  report: string;
  specPath: string;
}

export async function writeSpec(sessionDir: string, name: string, content: string): Promise<WriteSpecResult> {
  if (!NAME_RE.test(name)) {
    return { ok: false, specPath: '', report: `Error: spec name must match ${NAME_RE} (got "${name}")` };
  }
  if (!content.includes('speck ')) {
    return { ok: false, specPath: '', report: 'Error: content does not look like a SpeckDL spec (no `speck` declaration).' };
  }
  const specsDir = join(sessionDir, 'specs');
  const outDir = join(sessionDir, 'out', name);
  await mkdir(specsDir, { recursive: true });
  const specPath = join(specsDir, `${name}.speckdl`);
  await writeFile(specPath, content.endsWith('\n') ? content : content + '\n');
  const r = await compile(specPath, outDir, 'typescript');
  return {
    ok: r.code === 0,
    specPath,
    report: `Saved ${name}.speckdl.\n\n${fmtRun(`compile (typescript)`, r)}`,
  };
}

export interface VerifyCheck {
  file: string;
  /** e.g. "Always(PhaseInDomain) for 6 steps" or "(consistency check)" */
  check: string;
  expect: string;
  got: string;
  verdict: 'pass' | 'violated' | 'contradictory' | 'unexpected' | 'error';
  /** degraded model - result is advisory, not a proof */
  advisory: boolean;
  detail?: string;
}

export interface VerifyResult {
  ok: boolean;
  report: string;
  checks: VerifyCheck[];
}

/**
 * Declared checks, in file order: each verify block emits an
 * `(echo "Checking: …")` banner followed by a `; speckl-expect:` marker.
 * A file with only a bare `(check-sat)` is a single consistency check.
 */
function parseDeclaredChecks(text: string): Array<{ check: string; expect: string; note: string; bmc: boolean }> {
  const re = /\(echo\s+"Checking:\s*([^"]+)"\)|;\s*speckl-expect:\s*(\w+)(\s*\([^)]*\))?/g;
  const checks: Array<{ check: string; expect: string; note: string; bmc: boolean }> = [];
  let pendingName: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) {
      pendingName = m[1].trim();
    } else if (m[2] !== undefined) {
      checks.push({
        check: pendingName ?? '(consistency check)',
        expect: m[2],
        note: m[3]?.trim() ?? '',
        bmc: pendingName !== null,
      });
      pendingName = null;
    }
  }
  return checks;
}

/** Split solver output into per-check segments: banner, result, raw text. */
function parseResultSegments(stdout: string): Array<{ banner: string | null; result: string | null; errors: string[]; raw: string }> {
  const segs: Array<{ banner: string | null; result: string | null; errors: string[]; raw: string }> = [];
  let cur: { banner: string | null; result: string | null; errors: string[]; raw: string } | null = null;
  for (const l of stdout.split('\n')) {
    const t = l.trim();
    const bm = t.match(/^Checking:\s*(.+)$/);
    if (bm) {
      cur = { banner: bm[1].trim(), result: null, errors: [], raw: l + '\n' };
      segs.push(cur);
      continue;
    }
    if (t === 'sat' || t === 'unsat' || t === 'unknown') {
      if (!cur) {
        cur = { banner: null, result: null, errors: [], raw: '' };
        segs.push(cur);
      }
      if (cur.result === null) cur.result = t;
      cur.raw += l + '\n';
      continue;
    }
    if (cur) {
      cur.raw += l + '\n';
      if (t.startsWith('(error')) cur.errors.push(t);
    }
  }
  return segs;
}

function verdictFor(expect: string, got: string, bmc: boolean): VerifyCheck['verdict'] {
  if (expect === 'unsat' && got === 'unsat') return 'pass';
  if (expect === 'sat' && got === 'sat') {
    // Degraded BMC files: expect was downgraded to a consistency check, but a sat
    // result on an unrolled Always(...) check is still a bounded counterexample.
    return bmc ? 'violated' : 'pass';
  }
  if (expect === 'unsat' && got === 'sat') return 'violated';
  if (expect === 'sat' && got === 'unsat') return 'contradictory';
  return 'unexpected';
}

/** Compile a spec to Z3 and run the real solver over every emitted .smt2 file. */
export async function verifySpec(sessionDir: string, name: string): Promise<VerifyResult> {
  if (!NAME_RE.test(name)) {
    return { ok: false, checks: [], report: `Error: invalid spec name "${name}"` };
  }
  const specPath = join(sessionDir, 'specs', `${name}.speckdl`);
  let specContent: string;
  try {
    specContent = await readFile(specPath, 'utf8');
  } catch {
    return { ok: false, checks: [], report: `Error: spec "${name}" not found. Write it first with write_spec.` };
  }
  const outDir = join(sessionDir, 'out', name);
  const r = await compile(specPath, outDir, 'z3');
  if (r.code !== 0) {
    return { ok: false, checks: [], report: `Spec "${name}" failed to compile to Z3.\n\n${fmtRun('compile (z3)', r)}` };
  }

  const smtFiles = await findFiles(outDir, /\.smt2$/);
  if (smtFiles.length === 0) {
    return { ok: false, checks: [], report: `Compile succeeded but no .smt2 files were emitted for "${name}".` };
  }

  const checks: VerifyCheck[] = [];
  for (const f of smtFiles) {
    const rel = f.slice(outDir.length + 1);
    const text = await readFile(f, 'utf8');
    const declared = parseDeclaredChecks(text);
    let zr: RunResult;
    try {
      zr = await run(Z3_BIN, [f], undefined, 60_000);
    } catch (e: any) {
      checks.push({ file: rel, check: declared[0]?.check ?? '(solver run)', expect: declared[0]?.expect ?? 'unknown', got: 'error', verdict: 'error', advisory: /degraded/.test(declared[0]?.note ?? ''), detail: String(e.message ?? e) });
      continue;
    }
    const segs = parseResultSegments(zr.stdout);
    const count = Math.max(declared.length, segs.length);
    if (count === 0) {
      checks.push({ file: rel, check: '(no checks emitted)', expect: ' - ', got: `exit ${zr.code}`, verdict: zr.code === 0 ? 'unexpected' : 'error', advisory: false, detail: zr.stderr || zr.stdout });
      continue;
    }
    for (let i = 0; i < count; i++) {
      const d = declared[i];
      const s = segs[i];
      const check = d?.check ?? s?.banner ?? `check ${i + 1}`;
      const expect = d ? (d.note ? `${d.expect} ${d.note}` : d.expect) : 'unknown';
      const bmc = d?.bmc ?? !!s?.banner;
      const advisory = /degraded/.test(d?.note ?? '');
      const got = s?.result ?? (zr.code !== 0 ? `exit ${zr.code}` : 'unknown');
      const verdict = s?.result ? verdictFor(d?.expect ?? 'unknown', got, bmc) : 'error';
      checks.push({
        file: rel,
        check,
        expect,
        got,
        verdict,
        advisory,
        detail:
          verdict === 'violated' ? formatCounterexample(s!.raw) :
          verdict === 'error' ? (s?.errors.join('\n') || zr.stderr || zr.stdout) :
          undefined,
      });
    }
  }

  const lines = checks.map((c) => {
    const mark =
      c.verdict === 'pass' ? 'PASS' :
      c.verdict === 'violated' ? 'VIOLATED' :
      c.verdict === 'contradictory' ? 'CONTRADICTORY (constraints unsatisfiable)' :
      c.verdict === 'error' ? 'SOLVER ERROR' : 'UNEXPECTED';
    const adv = c.advisory ? ' [advisory - degraded model: counterexample may be spurious due to skipped constructs]' : '';
    let line = `- ${mark}${adv}: ${c.check} - ${c.file} (expect ${c.expect}, got ${c.got})`;
    if (c.verdict === 'violated' && c.detail) {
      line += '\n' + c.detail.split('\n').map((l) => '  ' + l).join('\n');
    }
    if (c.verdict === 'error' && c.detail) line += `\n  ${c.detail.split('\n').slice(0, 20).join('\n  ')}`;
    return line;
  });
  const ok = checks.every((c) => c.verdict === 'pass');
  const degraded = /; skipped:|degraded/.test(specContent);
  const report =
    `Verification of "${name}": ${ok ? 'ALL PASS' : 'FAILURES PRESENT'}\n\n${lines.join('\n')}\n` +
    (degraded ? '\nNote: the spec or output contains skipped/degraded constructs; results are advisory where marked.\n' : '');
  return { ok, checks, report };
}

async function findFiles(dir: string, re: RegExp): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (re.test(e.name)) out.push(p);
    }
  }
  await walk(dir);
  return out.sort();
}

export async function readSpecFile(specPath: string): Promise<string | null> {
  try {
    return await readFile(specPath, 'utf8');
  } catch {
    return null;
  }
}

export async function listSpecs(sessionDir: string): Promise<string[]> {
  try {
    return (await readdir(join(sessionDir, 'specs')))
      .filter((f) => f.endsWith('.speckdl'))
      .map((f) => basename(f, '.speckdl'));
  } catch {
    return [];
  }
}

export { dirname };