/**
 * speckl-serve - the agent/harness contract for Speckl (B-12, v0.1 alpha).
 *
 * A dependency-free HTTP API exposing the tool contract so external harnesses,
 * agents, and GPTs can drive spec development:
 *
 *   POST /sessions                                 → { id }  (isolated workspace)
 *   GET  /health                                   → status
 *   GET  /examples                                 → example index
 *   GET  /examples/:name                           → example source
 *   GET  /session/:id/specs/:name                  → spec source
 *   POST /session/:id/specs/:name   { content }    → write + compile diagnostics
 *   POST /session/:id/verify/:name  {}             → per-check Z3 verdicts
 *   GET  /session/:id/folds/:name                  → AST fold ranges (editor tooling)
 *
 * All file I/O is confined to the session directory. Binds 127.0.0.1 only.
 * Run: node serve.ts  (default port 7343)
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

const REPO = process.env.SPECKL_REPO ?? join(homedir(), 'Projects', 'speckl');
const SPECKL_BIN = process.env.SPECKL_BIN ?? join(REPO, 'compiler', 'dist', 'index.js');
const PARSER_JS = join(REPO, 'compiler', 'dist', 'parser.js');
const Z3_BIN = process.env.Z3_BIN ?? 'z3';
const EXAMPLES_DIR = join(REPO, 'examples');
const SESSIONS_DIR = process.env.SPECKL_SESSIONS ?? join(process.cwd(), 'serve-sessions');
const PORT = Number(process.env.PORT ?? 7343);
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

interface RunResult { code: number; stdout: string; stderr: string }

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    child.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    child.on('close', (code: number | null) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

async function compile(specPath: string, outDir: string, target: string): Promise<RunResult> {
  await mkdir(outDir, { recursive: true });
  return run('node', [SPECKL_BIN, specPath, '-o', outDir, '-t', target]);
}

function fmtRun(label: string, r: RunResult): string {
  const out = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
  return `### ${label} (exit ${r.code})\n${out || '(no output)'}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s;
}

interface CheckResult {
  file: string;
  check: string;
  expect: string;
  got: string;
  verdict: 'pass' | 'violated' | 'contradictory' | 'unexpected' | 'error';
  advisory: boolean;
  skipped?: string[];
  detail?: string;
}

// --- per-check Z3 verdicts (mirrors the compiler's multi-check layout) ---

function parseDeclaredChecks(text: string): Array<{ check: string; expect: string; note: string; bmc: boolean }> {
  const re = /\(echo\s+"Checking:\s*([^"]+)"\)|;\s*speckl-expect:\s*(\w+)(\s*\([^)]*\))?/g;
  const checks: Array<{ check: string; expect: string; note: string; bmc: boolean }> = [];
  let pendingName: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) pendingName = m[1].trim();
    else if (m[2] !== undefined) {
      checks.push({ check: pendingName ?? '(consistency check)', expect: m[2], note: m[3]?.trim() ?? '', bmc: pendingName !== null });
      pendingName = null;
    }
  }
  return checks;
}

function parseResultSegments(stdout: string): Array<{ banner: string | null; result: string | null; errors: string[]; raw: string }> {
  const segs: Array<{ banner: string | null; result: string | null; errors: string[]; raw: string }> = [];
  let cur: { banner: string | null; result: string | null; errors: string[]; raw: string } | null = null;
  for (const l of stdout.split('\n')) {
    const t = l.trim();
    const bm = t.match(/^Checking:\s*(.+)$/);
    if (bm) { cur = { banner: bm[1].trim(), result: null, errors: [], raw: l + '\n' }; segs.push(cur); continue; }
    if (t === 'sat' || t === 'unsat' || t === 'unknown') {
      if (!cur) { cur = { banner: null, result: null, errors: [], raw: '' }; segs.push(cur); }
      if (cur.result === null) cur.result = t;
      cur.raw += l + '\n';
      continue;
    }
    if (cur) { cur.raw += l + '\n'; if (t.startsWith('(error')) cur.errors.push(t); }
  }
  return segs;
}

function verdictFor(expect: string, got: string, bmc: boolean): CheckResult['verdict'] {
  if (expect === 'unsat' && got === 'unsat') return 'pass';
  if (expect === 'sat' && got === 'sat') return bmc ? 'violated' : 'pass';
  if (expect === 'unsat' && got === 'sat') return 'violated';
  if (expect === 'sat' && got === 'unsat') return 'contradictory';
  return 'unexpected';
}

async function findFiles(dir: string, re: RegExp): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (re.test(e.name)) out.push(p);
    }
  }
  await walk(dir);
  return out.sort();
}

export async function verifySpec(sessionDir: string, name: string) {
  if (!NAME_RE.test(name)) {
    return { ok: false, checks: [], report: `Error: invalid spec name "${name}"` };
  }
  const specPath = join(sessionDir, 'specs', `${name}.speckdl`);
  let specContent: string;
  try { specContent = await readFile(specPath, 'utf8'); } catch {
    return { ok: false, checks: [], report: `Error: spec "${name}" not found. Write it first.` };
  }
  void specContent;
  const outDir = join(sessionDir, 'out', name);
  const r = await compile(specPath, outDir, 'z3');
  if (r.code !== 0) {
    return { ok: false, checks: [], report: `Spec "${name}" failed to compile to Z3.\n\n${fmtRun('compile (z3)', r)}` };
  }
  const smtFiles = await findFiles(outDir, /\.smt2$/);
  const checks: CheckResult[] = [];
  for (const f of smtFiles) {
    const rel = f.slice(outDir.length + 1);
    const text = await readFile(f, 'utf8');
    const declared = parseDeclaredChecks(text);
    const skipped = [...new Set((text.match(/; skipped:[^\n]*/g) ?? []).map((s) => s.replace('; skipped:', '').trim()))].slice(0, 8);
    let zr: RunResult;
    try { zr = await run(Z3_BIN, [f], undefined, 60_000); }
    catch (e: any) {
      checks.push({ file: rel, check: declared[0]?.check ?? '(solver run)', expect: declared[0]?.expect ?? 'unknown', got: 'error', verdict: 'error', advisory: false, detail: String(e?.message ?? e) });
      continue;
    }
    const segs = parseResultSegments(zr.stdout);
    const count = Math.max(declared.length, segs.length);
    if (count === 0) {
      checks.push({ file: rel, check: '(no checks emitted)', expect: ' - ', got: `exit ${zr.code}`, verdict: 'error', advisory: false, detail: zr.stderr || zr.stdout });
      continue;
    }
    for (let i = 0; i < count; i++) {
      const d = declared[i];
      const s = segs[i];
      const bmc = d?.bmc ?? !!s?.banner;
      const advisory = /degraded/.test(d?.note ?? '');
      const got = s?.result ?? (zr.code !== 0 ? `exit ${zr.code}` : 'unknown');
      const fatalErrors = (s?.errors ?? []).filter((e) => !e.includes('model is not available'));
      const verdict = fatalErrors.length ? 'error' : s?.result ? verdictFor(d?.expect ?? 'unknown', got, bmc) : 'error';
      checks.push({
        file: rel, check: d?.check ?? s?.banner ?? `check ${i + 1}`,
        expect: d ? (d.note ? `${d.expect} ${d.note}` : d.expect) : 'unknown',
        got, verdict, advisory,
        skipped: skipped.length ? skipped : undefined,
        detail:
          verdict === 'violated' ? truncate(s!.raw, 3000) :
          verdict === 'error' ? (fatalErrors.join('\n') || zr.stderr || zr.stdout) :
          undefined,
      });
    }
  }
  const ok = checks.every((c) => c.verdict === 'pass');
  return { ok, checks, report: ok ? 'ALL PASS' : 'FAILURES PRESENT' };
}

// --- HTTP plumbing ---

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function text(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}
async function readBody(req: IncomingMessage): Promise<any> {
  let data = '';
  for await (const c of req) data += c;
  if (!data) return {};
  return JSON.parse(data);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  try {
    const sessionMatch = path.match(/^\/session\/([\w-]+)(\/.*)?$/);
    let sessionDir = SESSIONS_DIR;
    let rest = path;
    if (sessionMatch) {
      sessionDir = join(SESSIONS_DIR, sessionMatch[1]);
      rest = sessionMatch[2] ?? '';
    }

    if (path === '/health') {
      json(res, 200, { ok: true, api: 'speckl-serve', version: '0.1.0', contract: 'v0.1' });
      return;
    }
    if (path === '/sessions' && req.method === 'POST') {
      const id = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 8);
      await mkdir(join(SESSIONS_DIR, id, 'specs'), { recursive: true });
      await mkdir(join(SESSIONS_DIR, id, 'out'), { recursive: true });
      json(res, 200, { id });
      return;
    }
    if (path === '/examples' && req.method === 'GET') {
      const files = await readdir(EXAMPLES_DIR).catch(() => [] as string[]);
      json(res, 200, files.filter((f) => f.endsWith('.speckdl')).map((f) => basename(f, '.speckdl')));
      return;
    }
    const exampleMatch = path.match(/^\/examples\/([\w]+)$/);
    if (exampleMatch && req.method === 'GET') {
      const content = await readFile(join(EXAMPLES_DIR, `${exampleMatch[1]}.speckdl`), 'utf8').catch(() => null);
      if (content === null) { json(res, 404, { error: 'not found' }); return; }
      text(res, 200, content);
      return;
    }
    if (!sessionMatch) { json(res, 404, { error: 'not found' }); return; }

    const foldMatch = rest.match(/^\/specs\/([\w]+)\/folds$/);
    if (foldMatch && req.method === 'GET') {
      const parser = await import(PARSER_JS).catch(() => null);
      if (!parser) { json(res, 500, { error: 'parser unavailable' }); return; }
      const content = await readFile(join(sessionDir, 'specs', `${foldMatch[1]}.speckdl`), 'utf8').catch(() => null);
      if (content === null) { json(res, 404, { error: 'not found' }); return; }
      const ast = parser.parseSpeckContent(content);
      const folds: Array<{ name: string; startLine: number; endLine: number }> = [];
      for (const speck of ast.specks ?? []) {
        if (speck.startLine && speck.endLine) folds.push({ name: speck.name, startLine: speck.startLine, endLine: speck.endLine });
        for (const m of speck.members ?? []) {
          if (m?.startLine && m?.endLine) folds.push({ name: m.name ?? m.type, startLine: m.startLine, endLine: m.endLine });
        }
      }
      json(res, 200, folds);
      return;
    }
    const specMatch = rest.match(/^\/specs\/([\w]+)$/);
    if (specMatch && req.method === 'GET') {
      const content = await readFile(join(sessionDir, 'specs', `${specMatch[1]}.speckdl`), 'utf8').catch(() => null);
      if (content === null) { json(res, 404, { error: 'not found' }); return; }
      text(res, 200, content);
      return;
    }
    if (specMatch && req.method === 'POST') {
      const name = specMatch[1];
      if (!NAME_RE.test(name)) { json(res, 400, { error: 'invalid spec name' }); return; }
      const body = await readBody(req);
      const content = String(body?.content ?? '');
      if (!content.includes('speck ')) { json(res, 400, { error: 'content is not a SpeckDL spec' }); return; }
      const specsDir = join(sessionDir, 'specs');
      await mkdir(specsDir, { recursive: true });
      const specPath = join(specsDir, `${name}.speckdl`);
      await writeFile(specPath, content.endsWith('\n') ? content : content + '\n');
      const r = await compile(specPath, join(sessionDir, 'out', name), 'typescript');
      json(res, r.code === 0 ? 200 : 422, {
        ok: r.code === 0,
        diagnostics: truncate([r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n'), 4000),
      });
      return;
    }
    const verifyMatch = rest.match(/^\/verify\/([\w]+)$/);
    if (verifyMatch && req.method === 'POST') {
      const result = await verifySpec(sessionDir, verifyMatch[1]);
      json(res, 200, result);
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e: any) {
    json(res, 500, { error: e?.message ?? String(e) });
  }
});

server.listen(Number(PORT), '127.0.0.1', () => {
  console.log(`speckl-serve (alpha)  →  http://localhost:${PORT}`);
  console.log('contract: POST /sessions · POST /session/:id/specs/:name · POST /session/:id/verify/:name');
});