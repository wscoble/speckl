#!/usr/bin/env node
// scripts/verify-z3.mjs
//
// Runs real Z3 verification over every example spec.
//
// For each examples/*.speckdl:
//   1. Compile to SMT-LIB2 (both the AST-driven and IR-driven Z3 backends).
//   2. Run the z3 binary on each emitted .smt2 / .ir.smt2 file.
//   3. Compare the solver result against the generator's expectation marker
//      (`; speckl-expect: sat` / `; speckl-expect: unsat`).
//   4. On unexpected `sat` (a violated property), render a human-readable
//      counterexample: a per-step state trace from the solver model.
//
// Exit code is nonzero if any file errors in Z3, mismatches its expectation,
// or produces no solver result. Exit 2 means "z3 not available" — CI decides
// whether that is fatal.
//
// Usage: node scripts/verify-z3.mjs [--examples <dir>] [--depth <n>] [--keep]

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const compilerDir = resolve(scriptDir, '..');
const repoDir = resolve(compilerDir, '..');
const compilerBin = process.env.SPECKL_BIN ?? join(compilerDir, 'dist', 'index.js');

// --- CLI args ---
const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
const examplesDir = resolve(argValue('--examples', process.env.SPECKL_EXAMPLES ?? join(repoDir, 'examples')));
const depth = parseInt(argValue('--depth', '10'), 10);
const keep = argv.includes('--keep');

// --- Tool checks ---
const z3Path = process.env.Z3_BIN ?? 'z3';
const z3Check = spawnSync(z3Path, ['--version'], { encoding: 'utf-8' });
if (z3Check.error || z3Check.status !== 0) {
  console.error('verify-z3: z3 binary not found (set Z3_BIN to override).');
  console.error('Install z3 via your package manager (e.g. `sudo pacman -S z3` or `apt-get install z3`).');
  process.exit(2);
}
const z3Version = (z3Check.stdout ?? '').trim().replace('Z3 version ', 'v');

/** Run a command, capturing stdout/stderr. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Compile a spec file with the reference compiler. Throws on failure. */
function compile(file, outDir, target) {
  mkdirSync(outDir, { recursive: true });
  const res = run(process.execPath, [compilerBin, file, '-o', outDir, '-t', target, '-d', String(depth)]);
  if (res.status !== 0) {
    throw new Error(`compile failed (exit ${res.status}):\n${(res.stderr || res.stdout).slice(0, 400)}`);
  }
}

/** Run z3 on a file's contents, with a wall-clock timeout per file. */
const Z3_TIMEOUT_SECONDS = 30;
function runZ3(input) {
  return spawnSync(z3Path, ['-smt2', '-in', `-T:${Z3_TIMEOUT_SECONDS}`], {
    input,
    encoding: 'utf-8',
    timeout: (Z3_TIMEOUT_SECONDS + 10) * 1000,
  });
}

/**
 * Verdict input: the file without (get-model) — requesting a model after an
 * unsat check-sat is itself an error, which would mask the real result.
 * Models are requested separately for counterexample rendering.
 */
function stripGetModel(smt) {
  return smt.replace(/^\s*\(get-model\)\s*$/gm, '');
}

/** Classify z3 output: error / sat / unsat / unknown / no-result. */
function solverResult(stdout, stderr) {
  const combined = stdout + '\n' + stderr;
  const errMatch = combined.match(/\(error "([^"]*)"\)/);
  if (errMatch) return { kind: 'error', message: errMatch[1] };
  const lines = stdout.split('\n').map(l => l.trim());
  const results = lines.filter(l => l === 'sat' || l === 'unsat' || l === 'unknown');
  if (results.length === 0) return { kind: 'no-result' };
  const last = results[results.length - 1];
  return { kind: last };
}

/** Read the last `; speckl-expect:` marker from an SMT file, if any. */
function expectationOf(smt) {
  const matches = [...smt.matchAll(/^;\s*speckl-expect:\s*(sat|unsat)/gm)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

/**
 * Parse `(get-model)` output into { name: value } entries.
 * Handles the common flat cases (Bool/Int/Real values); complex values are
 * truncated by shorten() at render time.
 */
function parseModel(stdout) {
  const model = new Map();
  const re = /\(define-fun\s+(\S+)\s+\(\)\s+(\S+)\s*\n\s*([^\n]*?)\s*\)?\s*(?=\n)/g;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    model.set(m[1], m[3] || '?');
  }
  return model;
}

/** Truncate a rendered value for display. */
function shorten(v) {
  return v.length > 60 ? v.slice(0, 57) + '…' : v;
}

/**
 * Render a counterexample for a violated property.
 * `modelStdout` is raw z3 stdout including the (get-model) block.
 * `smt` is the source file, used to identify invariant-instance define-funs
 * (which must not appear as "state" in the trace).
 * Returns a list of display lines.
 */
function renderCounterexample(modelStdout, smt) {
  const lines = [];
  const invariantBaseNames = new Set(
    [...smt.matchAll(/^;\s*verify\s+"([^"]+)"/gm)].map(m => m[1])
  );
  const model = parseModel(modelStdout);
  if (model.size === 0) return lines;

  // Group state-var bindings by BMC step (var_N suffix), excluding invariant
  // instances and derived define-funs.
  const steps = new Map();
  for (const [name, value] of model) {
    if (invariantBaseNames.has(name)) continue;
    const stepMatch = name.match(/^(.+)_(\d+)$/);
    if (!stepMatch) continue;
    if (invariantBaseNames.has(stepMatch[1])) continue;
    // Skip entries whose value is a compound expression (define-fun body),
    // not an atomic state value.
    if (/^\(/.test(value)) continue;
    const step = parseInt(stepMatch[2], 10);
    if (!steps.has(step)) steps.set(step, []);
    steps.get(step).push([stepMatch[1], value]);
  }

  if (steps.size > 0) {
    lines.push('      counterexample state trace (per BMC step):');
    for (const step of [...steps.keys()].sort((a, b) => a - b)) {
      const entries = steps.get(step).sort((a, b) => a[0].localeCompare(b[0]));
      lines.push(`        step ${step}: ${entries.map(([n, v]) => `${n}=${shorten(v)}`).join(', ')}`);
    }
  } else {
    lines.push('      counterexample model:');
    for (const [name, value] of [...model].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`        ${name} = ${shorten(value)}`);
    }
  }
  return lines;
}

// --- Main ---

const exampleFiles = readdirSync(examplesDir).filter(f => f.endsWith('.speckdl')).sort();
if (exampleFiles.length === 0) {
  console.error(`verify-z3: no .speckdl files found in ${examplesDir}`);
  process.exit(1);
}

console.log(`Speckl Z3 verification — z3 ${z3Version}`);
console.log(`Examples: ${examplesDir} (${exampleFiles.length} files), BMC depth ${depth}`);
console.log('');

const workDir = mkdtempSync(join(tmpdir(), 'speckl-verify-'));
const results = [];
let failed = 0;

for (const file of exampleFiles) {
  const filePath = join(examplesDir, file);
  const base = basename(file, '.speckdl');

  for (const [mode, target] of [['ast', 'z3'], ['ir', 'all-ir']]) {
    const outDir = join(workDir, `${base}.${mode}`);

    try {
      compile(filePath, outDir, target);
    } catch (e) {
      results.push({ file, mode, status: 'COMPILE-FAIL', detail: String(e.message).split('\n')[0].slice(0, 200) });
      failed++;
      continue;
    }

    const smtFiles = readdirSync(outDir).filter(f => f.endsWith('.smt2')).sort();
    if (smtFiles.length === 0) {
      results.push({ file, mode, status: 'NO-SMT', detail: 'no SMT output generated' });
      failed++;
      continue;
    }

    for (const smtName of smtFiles.sort()) {
      const smtPath = join(outDir, smtName);
      const smt = readFileSync(smtPath, 'utf-8');
      if (!smt.includes('(check-sat')) {
        results.push({ file, mode, smt: smtName, status: 'SKIP', detail: 'nothing to check (no check-sat)' });
        continue; // not a failure — nothing verifiable in this speck
      }
      const expect = expectationOf(smt);
      const res = runZ3(stripGetModel(smt));
      if (res.error || res.status === null) {
        results.push({ file, mode, smt: smtName, status: 'Z3-TIMEOUT', detail: `exceeded ${Z3_TIMEOUT_SECONDS}s solver budget` });
        failed++;
        continue;
      }
      const outcome = solverResult(res.stdout, res.stderr);

      if (outcome.kind === 'error') {
        results.push({ file, mode, smt: smtName, status: 'Z3-ERROR', detail: outcome.message });
        failed++;
      } else if (outcome.kind === 'no-result' || outcome.kind === 'unknown') {
        results.push({ file, mode, smt: smtName, status: 'NO-RESULT', detail: `solver returned: ${outcome.kind}` });
        failed++;
      } else if (expect && outcome.kind !== expect) {
        const detail = expect === 'unsat'
          ? 'property VIOLATED — sat (expected unsat)'
          : 'contradiction — unsat (expected sat)';
        results.push({ file, mode, smt: smtName, status: 'VIOLATED', detail });
        failed++;
        if (expect === 'unsat') {
          // Re-run with the model request intact to render the trace.
          const rerun = runZ3(smt);
          for (const line of renderCounterexample(rerun.stdout, smt)) console.log(line);
        }
      } else {
        results.push({
          file, mode, smt: smtName, status: 'OK',
          detail: expect ? `${outcome.kind} (expected ${expect})` : outcome.kind,
        });
      }
    }
  }
}

if (!keep) {
  rmSync(workDir, { recursive: true, force: true });
} else {
  console.log(`\nKept working dir: ${workDir}`);
}

// --- Summary ---
console.log('\n════════════════════════════════════════════════════');
console.log(' Z3 verification summary');
console.log('════════════════════════════════════════════════════');
const label = r => `${r.file} [${r.mode}]${r.smt ? ' ' + r.smt : ''}`;
const width = Math.max(...results.map(r => label(r).length), 30);
for (const r of results) {
  const icon = r.status === 'OK' ? '✓' : '✗';
  console.log(` ${icon} ${label(r).padEnd(width + 2)} ${r.status}${r.detail ? ' — ' + r.detail : ''}`);
}
const ok = results.filter(r => r.status === 'OK').length;
const skipped = results.filter(r => r.status === 'SKIP').length;
console.log('────────────────────────────────────────────────────');
console.log(` ${ok}/${results.length} checks passed, ${failed} failed, ${skipped} skipped`);

if (failed > 0) process.exit(1);