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

export interface VerifyFileResult {
  file: string;
  expect: string;
  got: string;
  verdict: 'pass' | 'violated' | 'contradictory' | 'unexpected' | 'error';
  detail?: string;
}

export interface VerifyResult {
  ok: boolean;
  report: string;
  files: VerifyFileResult[];
}

/** Compile a spec to Z3 and run the real solver over every emitted .smt2 file. */
export async function verifySpec(sessionDir: string, name: string): Promise<VerifyResult> {
  if (!NAME_RE.test(name)) {
    return { ok: false, files: [], report: `Error: invalid spec name "${name}"` };
  }
  const specPath = join(sessionDir, 'specs', `${name}.speckdl`);
  let specContent: string;
  try {
    specContent = await readFile(specPath, 'utf8');
  } catch {
    return { ok: false, files: [], report: `Error: spec "${name}" not found. Write it first with write_spec.` };
  }
  const outDir = join(sessionDir, 'out', name);
  const r = await compile(specPath, outDir, 'z3');
  if (r.code !== 0) {
    return { ok: false, files: [], report: `Spec "${name}" failed to compile to Z3.\n\n${fmtRun('compile (z3)', r)}` };
  }

  const smtFiles = await findFiles(outDir, /\.smt2$/);
  if (smtFiles.length === 0) {
    return { ok: false, files: [], report: `Compile succeeded but no .smt2 files were emitted for "${name}".` };
  }

  const files: VerifyFileResult[] = [];
  for (const f of smtFiles) {
    const rel = f.slice(outDir.length + 1);
    const text = await readFile(f, 'utf8');
    const m = text.match(/;\s*speckl-expect:\s*(\w+)\s*(\([^\n]*\))?/);
    const expect = m?.[1] ?? 'unknown';
    const note = m?.[2] ?? '';
    const isBmc = /Checking:/.test(text);
    let zr: RunResult;
    try {
      zr = await run(Z3_BIN, [f], undefined, 60_000);
    } catch (e: any) {
      files.push({ file: rel, expect, got: 'error', verdict: 'error', detail: String(e.message ?? e) });
      continue;
    }
    const gotLine = zr.stdout.split('\n').map((l) => l.trim()).find((l) => l === 'sat' || l === 'unsat' || l === 'unknown');
    const got = gotLine ?? `exit ${zr.code}`;
    let verdict: VerifyFileResult['verdict'];
    if (expect === 'unsat' && got === 'unsat') verdict = 'pass';
    else if (expect === 'sat' && got === 'sat') {
      // Degraded BMC files: expect was downgraded to a consistency check, but a sat
      // result on an unrolled Always(...) check is still a bounded counterexample.
      verdict = isBmc && got === 'sat' ? 'violated' : 'pass';
    }
    else if (expect === 'unsat' && got === 'sat') verdict = 'violated';
    else if (expect === 'sat' && got === 'unsat') verdict = 'contradictory';
    else if (zr.code !== 0) verdict = 'error';
    else verdict = 'unexpected';
    files.push({
      file: rel,
      expect: note ? `${expect} ${note}` : expect,
      got,
      verdict,
      detail: verdict === 'violated' ? zr.stdout : verdict === 'error' ? zr.stderr || zr.stdout : undefined,
    });
  }

  const degraded = /; skipped:|degraded/.test(specContent);
  const lines = files.map((f) => {
    const mark =
      f.verdict === 'pass' ? 'PASS' :
      f.verdict === 'violated' ? 'VIOLATED' :
      f.verdict === 'contradictory' ? 'CONTRADICTORY (constraints unsatisfiable)' :
      f.verdict === 'error' ? 'SOLVER ERROR' : 'UNEXPECTED';
    const advisory = /degraded/.test(f.expect) ? ' [advisory - degraded model: counterexample may be spurious due to skipped constructs]' : '';
    let line = `- ${mark}${advisory}: ${f.file} (expect ${f.expect}, got ${f.got})`;
    if (f.verdict === 'violated' && f.detail) {
      // include a bounded counterexample trace
      const trace = f.detail.split('\n').slice(0, 40).join('\n');
      line += `\n  Counterexample (bounded):\n${trace.split('\n').map((l) => '  ' + l).join('\n')}`;
    }
    if (f.verdict === 'error' && f.detail) line += `\n  ${f.detail.split('\n').slice(0, 20).join('\n  ')}`;
    return line;
  });
  const ok = files.every((f) => f.verdict === 'pass');
  const report =
    `Verification of "${name}": ${ok ? 'ALL PASS' : 'FAILURES PRESENT'}\n\n${lines.join('\n')}\n` +
    (degraded ? '\nNote: the spec or output contains skipped/degraded constructs; results are advisory where marked.\n' : '');
  return { ok, files, report };
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