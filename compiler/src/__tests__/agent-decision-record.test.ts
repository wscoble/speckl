// Decision record: every hook allow and deny is appended to a keyed hash
// chain beside state.json. Denials must not advance or rewrite the spec
// state, a broken or unwritable record must deny, and `signal.mjs verify`
// must walk the whole chain (including the prefix the hook stops re-reading
// once the log is past the full-check bound).
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { useStateKey, writeSigned } from './helpers/agent-state.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'AgentPolicy.speckdl');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');
const FULL_CHECK_BYTES = 262144;

useStateKey();
const noKeyEnv = () => { const e = { ...process.env }; delete e.SPECKL_STATE_KEY_FILE; return e; };

type R = { status: number | null; stdout: string; stderr: string };
let agentDir = '';
let integ: {
  canonical: (v: unknown) => string;
  decisionPaths: (s: string) => { dir: string; head: string; log: string };
  decisionGenesis: (s: Record<string, unknown>) => string;
  genesis: (s: Record<string, unknown>) => string;
  digestInput: (v: unknown) => string;
  readKey: (p: string) => Buffer;
  appendDecision: (file: string, key: Buffer | null, state: Record<string, unknown>, fields: Record<string, unknown>) => unknown;
  verifyDecisions: (file: string, key: Buffer | null, state: Record<string, unknown>, opts?: { full?: boolean }) => { ok: boolean; reason?: string; count?: number; uncommitted?: number; head?: string };
};

function run(file: string, args: string[], input?: string, env: NodeJS.ProcessEnv = process.env): R {
  const r = spawnSync(process.execPath, [file, ...args], { input, encoding: 'utf-8', env });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const hook = (cmd: string, s: string, msg: object, env?: NodeJS.ProcessEnv) =>
  run(join(agentDir, 'hook.mjs'), [cmd, '--state', s], JSON.stringify(msg), env);
const signal = (args: string[], env?: NodeJS.ProcessEnv) => run(join(agentDir, 'signal.mjs'), args, undefined, env);
const read = (s: string) => JSON.parse(readFileSync(s, 'utf-8'));
const sha256 = (x: string) => crypto.createHash('sha256').update(x).digest('hex');

function newState(opts: { dev?: boolean; env?: NodeJS.ProcessEnv } = {}): string {
  const s = join(mkdtempSync(join(tmpdir(), 'speckl-dec-')), 'state.json');
  const r = signal(['init', '--state', s, ...(opts.dev ? ['--dev'] : [])], opts.env);
  expect(r.status, r.stderr).toBe(0);
  return s;
}

function linesOf(s: string): Record<string, unknown>[] {
  const log = integ.decisionPaths(s).log;
  if (!existsSync(log)) return [];
  const text = readFileSync(log, 'utf-8');
  if (!text) return [];
  return text.trimEnd().split('\n').map(l => JSON.parse(l));
}

function expectChain(s: string, key: Buffer | null) {
  const lines = linesOf(s);
  const st = read(s);
  let prev = integ.decisionGenesis(st);
  lines.forEach((raw, i) => {
    const line = raw as Record<string, unknown>;
    const hash = String(line.hash);
    const mac = line.mac;
    const body: Record<string, unknown> = {};
    for (const k of Object.keys(line)) {
      if (k !== 'hash' && k !== 'mac') body[k] = line[k];
    }
    expect(body.seq, 'seq').toBe(i);
    expect(body.prev, 'prev').toBe(prev);
    expect(hash).toBe(sha256(integ.canonical(body)));
    if (key) {
      const want = crypto.createHmac('sha256', key).update(hash).digest('hex');
      expect(mac).toBe(want);
    } else {
      expect(mac).toBeUndefined();
    }
    prev = hash;
  });
  const head = JSON.parse(readFileSync(integ.decisionPaths(s).head, 'utf-8'));
  expect(head.seq).toBe(lines.length - 1);
  expect(head.hash).toBe(prev);
  expect(head.genesis).toBe(integ.decisionGenesis(st));
  if (key) {
    const { mac, ...rest } = head;
    expect(mac).toBe(crypto.createHmac('sha256', key).update(integ.canonical(rest)).digest('hex'));
  }
  return lines;
}

/** Fill the decision log past the hook's full-walk bound without spawning once per line. */
function growPastFullCheck(s: string, key: Buffer) {
  const st = read(s);
  const log = integ.decisionPaths(s).log;
  let i = 0;
  do {
    integ.appendDecision(s, key, st, {
      phase: 'pre', tool: 'nope', call_id: 'flood-' + i, action: null,
      verdict: 'deny', reason: ('flood ' + i).padEnd(500, 'x'), input_sha256: integ.digestInput({ i }),
    });
    i++;
  } while (!existsSync(log) || statSync(log).size <= FULL_CHECK_BYTES);
  return i;
}

beforeAll(async () => {
  const out = mkdtempSync(join(tmpdir(), 'speckl-dec-out-'));
  const r = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), example, '-t', 'agent', '-o', out],
    { cwd: compilerDir, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(r.stderr);
  agentDir = join(out, 'agent');
  integ = await import(pathToFileURL(join(agentDir, 'state-integrity.mjs')).href);
}, 60_000);

describe('allows and denies are both sealed', () => {
  it('records the verdict, the deny reason and an input digest, and a deny does not touch state.json', () => {
    const s = newState();
    const key = integ.readKey(process.env.SPECKL_STATE_KEY_FILE!);
    const before = readFileSync(s);
    const secret = 'super-secret-token-value';
    const denied = hook('pre', s, { tool: 'open_pr', input: { token: secret }, call_id: 'd1' });
    expect(denied.status).toBe(2);
    expect(denied.stdout).toContain('can() refused');
    expect(readFileSync(s).equals(before)).toBe(true);
    expect(read(s).log).toEqual([]);

    const allowed = hook('pre', s, { tool: 'read_file', input: { path: secret }, call_id: 'a1' });
    expect(allowed.status).toBe(0);
    expect(hook('post', s, { tool: 'read_file', call_id: 'a1', ok: true }).status).toBe(0);

    const badPost = hook('pre', s, { tool: 'run_tests', input: {}, call_id: 'p1' });
    expect(badPost.status).toBe(0);
    const postDeny = hook('post', s, { tool: 'open_pr', call_id: 'p1', ok: true });
    expect(postDeny.status).toBe(2);
    expect(postDeny.stdout).toContain('does not match pending');
    expect(read(s).pending.call_id).toBe('p1');
    expect(read(s).machine.state.stage).toBe(0);

    const lines = expectChain(s, key);
    expect(lines.map(l => l.verdict)).toEqual(['deny', 'allow', 'allow', 'allow', 'deny']);
    expect(lines[0]).toMatchObject({ phase: 'pre', tool: 'open_pr', action: 'OpenPR', call_id: 'd1', verdict: 'deny' });
    expect(String(lines[0].reason)).toContain('can() refused');
    expect(lines[0].input_sha256).toBe(integ.digestInput({ token: secret }));
    expect(readFileSync(integ.decisionPaths(s).log, 'utf-8')).not.toContain(secret);
    expect(lines[4]).toMatchObject({ phase: 'post', tool: 'open_pr', verdict: 'deny', call_id: 'p1' });
    // The spec log only has the calls that were allowed to commit.
    expect(read(s).log.map((e: { kind: string }) => e.kind)).toEqual(['pre', 'post', 'pre']);

    const v = signal(['verify', '--state', s]);
    expect(v.status, v.stderr).toBe(0);
    expect(JSON.parse(v.stdout)).toMatchObject({ ok: true, decisions: 5, uncommitted: 0 });
  });

  it('a recorded deny stores no key path, key file contents, or signer key', () => {
    const keyFile = process.env.SPECKL_STATE_KEY_FILE!;
    const keyHex = readFileSync(keyFile, 'utf-8').trim();
    const dir = mkdtempSync(join(tmpdir(), 'speckl-dec-key-'));
    const rel = './state-sekret.key';
    writeFileSync(join(dir, 'state-sekret.key'), readFileSync(keyFile));
    const abs = path.resolve(dir, rel);
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const signerHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const s = join(dir, 'state.json');
    const init = signal(['init', '--state', s, '--key', abs, '--signer', 'alice=' + signerHex]);
    expect(init.status, init.stderr).toBe(0);
    const tool = [rel, abs, keyFile, keyHex, signerHex].join(' ');
    const denied = spawnSync(process.execPath, [join(agentDir, 'hook.mjs'), 'pre', '--state', s, '--key', rel], {
      cwd: dir,
      input: JSON.stringify({ tool, input: { leak: tool }, call_id: rel }),
      encoding: 'utf-8',
    });
    expect(denied.status, denied.stderr).toBe(2);
    const log = readFileSync(integ.decisionPaths(s).log, 'utf-8');
    const shown = (denied.stdout || '') + (denied.stderr || '') + log;
    for (const secret of [rel, abs, keyFile, keyHex, signerHex, path.basename(dir)]) {
      expect(shown, secret).not.toContain(secret);
    }
    expect(shown).toContain('<keyfile>');
    expect(log).toContain('unknown tool');
    expect(String(linesOf(s)[0].tool)).not.toContain('sekret');
    expect(String(linesOf(s)[0].call_id)).toBe('<keyfile>');
  });

  it('a fresh state verifies as an empty decision record', () => {
    const s = newState();
    const v = signal(['verify', '--state', s]);
    expect(v.status, v.stderr).toBe(0);
    const body = JSON.parse(v.stdout);
    expect(body).toMatchObject({ ok: true, decisions: 0, uncommitted: 0 });
    expect(body.head).toBe(integ.decisionGenesis(read(s)));
    expect(existsSync(integ.decisionPaths(s).log)).toBe(false);
  });

  it('clips a deny reason at 500 characters and refuses to store the raw input', () => {
    const s = newState();
    const key = integ.readKey(process.env.SPECKL_STATE_KEY_FILE!);
    const reason = 'R'.repeat(600);
    integ.appendDecision(s, key, read(s), {
      phase: 'pre', tool: 'open_pr', call_id: 'c', action: 'OpenPR',
      verdict: 'deny', reason, input_sha256: integ.digestInput({ blob: reason }),
    });
    const [line] = linesOf(s);
    expect(line.reason).toBe('R'.repeat(500));
    expect(readFileSync(integ.decisionPaths(s).log, 'utf-8')).not.toContain('R'.repeat(501));
  });

  it('a specHash mismatch denies; it is recorded only when the state chain still verifies', () => {
    const broken = newState();
    const snap = read(broken);
    snap.specHash = 'deadbeef';
    writeSigned(broken, snap);
    const r = hook('pre', broken, { tool: 'run_tests', input: {}, call_id: '1' });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('specHash mismatch');
    // Genesis covers specHash, so this re-sign does not verify. Nothing is appended.
    expect(existsSync(broken + '.decisions')).toBe(false);
    expect(read(broken).log).toEqual([]);

    const consistent = newState();
    const st = read(consistent);
    st.specHash = 'deadbeef';
    st.head = integ.genesis(st);
    writeSigned(consistent, st);
    const recorded = hook('pre', consistent, { tool: 'run_tests', input: {}, call_id: '1' });
    expect(recorded.status).toBe(2);
    expect(recorded.stdout).toContain('specHash mismatch');
    const [line] = expectChain(consistent, integ.readKey(process.env.SPECKL_STATE_KEY_FILE!));
    expect(line.verdict).toBe('deny');
    expect(String(line.reason)).toContain('specHash mismatch');
    expect(read(consistent).log).toEqual([]);
  });

  it('a state the hook cannot verify is denied and creates no decision record', () => {
    const s = newState();
    const snap = read(s);
    snap.machine.state.stage = 3;
    writeFileSync(s, JSON.stringify(snap));
    const r = hook('pre', s, { tool: 'open_pr', input: {}, call_id: '1' });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('state integrity');
    expect(existsSync(s + '.decisions')).toBe(false);
  });
});

describe('tamper and write failure deny, and do not advance the machine', () => {
  it('an edited line is refused by the hook and by verify', () => {
    const s = newState();
    expect(hook('pre', s, { tool: 'open_pr', input: {}, call_id: 'd' }).status).toBe(2);
    const log = integ.decisionPaths(s).log;
    const text = readFileSync(log, 'utf-8');
    writeFileSync(log, text.replace('open_pr', 'run_tests'));
    const before = readFileSync(s);
    const r = hook('pre', s, { tool: 'run_tests', input: {}, call_id: 'next' });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('decision record');
    expect(r.stdout).toContain('decision chain broken');
    expect(readFileSync(s).equals(before)).toBe(true);
    const v = signal(['verify', '--state', s]);
    expect(v.status).toBe(2);
    expect(v.stderr).toContain('decision chain broken');
  });

  it('a truncated log and a head signed for another run are refused', () => {
    const s = newState();
    expect(hook('pre', s, { tool: 'read_file', input: { path: 'a' }, call_id: '1' }).status).toBe(0);
    expect(hook('post', s, { tool: 'read_file', call_id: '1', ok: true }).status).toBe(0);
    const paths = integ.decisionPaths(s);
    writeFileSync(paths.log, linesOf(s).slice(0, 1).map(l => JSON.stringify(l)).join('\n') + '\n');
    const truncated = hook('pre', s, { tool: 'run_tests', input: {}, call_id: '2' });
    expect(truncated.status).toBe(2);
    expect(truncated.stdout).toContain('truncated');
    expect(read(s).log.map((e: { kind: string }) => e.kind)).toEqual(['pre', 'post']);

    const other = newState();
    expect(hook('pre', other, { tool: 'open_pr', input: {}, call_id: 'z' }).status).toBe(2);
    writeFileSync(paths.head, readFileSync(integ.decisionPaths(other).head));
    const moved = hook('pre', s, { tool: 'run_tests', input: {}, call_id: '3' });
    expect(moved.status).toBe(2);
    expect(moved.stdout).toContain('different state');
    expect(read(s).machine.state.stage).toBe(0);
  });

  it('drops a torn unfinished line and still records the next denial', () => {
    const s = newState();
    const key = integ.readKey(process.env.SPECKL_STATE_KEY_FILE!);
    expect(hook('pre', s, { tool: 'open_pr', input: {}, call_id: 'd' }).status).toBe(2);
    const log = integ.decisionPaths(s).log;
    appendFileSync(log, '{"not":"finished"');
    const r = hook('pre', s, { tool: 'open_pr', input: {}, call_id: 'd2' });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('can() refused');
    expect(linesOf(s).map(l => l.call_id)).toEqual(['d', 'd2']);
    expect(readFileSync(log, 'utf-8')).not.toContain('finished');
    expectChain(s, key);
    appendFileSync(log, '\n');
    const blank = hook('pre', s, { tool: 'run_tests', input: {}, call_id: 'nope' });
    expect(blank.status).toBe(2);
    expect(blank.stdout).toContain('blank line');
    expect(read(s).log).toEqual([]);
  });

  it('adopts a valid line whose head was not updated, and verify reports it until then', () => {
    const s = newState();
    expect(hook('pre', s, { tool: 'open_pr', input: {}, call_id: 'd' }).status).toBe(2);
    const paths = integ.decisionPaths(s);
    const head = readFileSync(paths.head);
    const key = integ.readKey(process.env.SPECKL_STATE_KEY_FILE!);
    integ.appendDecision(s, key, read(s), {
      phase: 'pre', tool: 'open_pr', call_id: 'torn', action: 'OpenPR',
      verdict: 'deny', reason: 'adopt me', input_sha256: integ.digestInput(null),
    });
    writeFileSync(paths.head, head);
    const before = signal(['verify', '--state', s]);
    expect(before.status, before.stderr).toBe(0);
    expect(JSON.parse(before.stdout)).toMatchObject({ decisions: 1, uncommitted: 1 });
    const next = hook('pre', s, { tool: 'open_pr', input: {}, call_id: 'd2' });
    expect(next.status).toBe(2);
    expect(next.stdout).toContain('can() refused');
    const after = signal(['verify', '--state', s]);
    expect(after.status, after.stderr).toBe(0);
    const body = JSON.parse(after.stdout);
    expect(body).toMatchObject({ decisions: 3, uncommitted: 0 });
    expect(linesOf(s).map(l => l.call_id)).toEqual(['d', 'torn', 'd2']);
    expectChain(s, key);
  });

  it('if the decision record cannot be written, an allow becomes a deny and state.json stays put', () => {
    const s = newState();
    expect(hook('pre', s, { tool: 'open_pr', input: {}, call_id: 'd' }).status).toBe(2);
    const log = integ.decisionPaths(s).log;
    const before = readFileSync(s);
    const logBefore = readFileSync(log);
    chmodSync(log, 0o444);
    let frozen = false;
    try { appendFileSync(log, 'x'); }
    catch { frozen = true; }
    expect(frozen, 'could not make the decision log unwritable').toBe(true);
    try {
      const r = hook('pre', s, { tool: 'run_tests', input: {}, call_id: '1' });
      expect(r.status).toBe(2);
      expect(r.stdout).toContain('decision record unavailable');
      expect(readFileSync(s).equals(before)).toBe(true);
      expect(readFileSync(log).equals(logBefore)).toBe(true);
      expect(read(s).log).toEqual([]);
      expect(read(s).pending).toBeNull();
    } finally {
      chmodSync(log, 0o644);
    }
  });

  it('a tampered decision record blocks signal.mjs before it changes the machine', () => {
    const s = newState({ dev: true });
    expect(hook('pre', s, { tool: 'run_tests', input: {}, call_id: '1' }).status).toBe(0);
    expect(hook('post', s, { tool: 'run_tests', call_id: '1', ok: true }).status).toBe(0);
    expect(hook('pre', s, { tool: 'request_review', input: {}, call_id: '2' }).status).toBe(0);
    expect(hook('post', s, { tool: 'request_review', call_id: '2', ok: true }).status).toBe(0);
    const log = integ.decisionPaths(s).log;
    writeFileSync(log, readFileSync(log, 'utf-8').replace('run_tests', 'open_pr'));
    const stage = read(s).machine.state.stage;
    const r = signal(['apply', '--state', s, '--verifier', 'cli', '--outcome', 'approve', '--claim_reviewer', 'a']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('decision record');
    expect(read(s).machine.state.stage).toBe(stage);
  });
});

describe('flood, tail check, concurrency', () => {
  it('a long run of denials does not grow state.json, and verify sees a prefix edit the hook tail-check does not', () => {
    const s = newState();
    const key = integ.readKey(process.env.SPECKL_STATE_KEY_FILE!);
    const stateBytes = readFileSync(s);
    const n = growPastFullCheck(s, key);
    expect(n).toBeGreaterThan(10);
    expect(readFileSync(s).equals(stateBytes)).toBe(true);
    expect(read(s).log).toEqual([]);
    expect(statSync(integ.decisionPaths(s).log).size).toBeGreaterThan(FULL_CHECK_BYTES);

    const log = integ.decisionPaths(s).log;
    const raw = readFileSync(log);
    const marker = Buffer.from('flood 0');
    const at = raw.indexOf(marker);
    expect(at, raw.subarray(0, 200).toString()).toBeGreaterThanOrEqual(0);
    const edited = Buffer.from(raw);
    edited[at + marker.length - 2] = edited[at + marker.length - 2] === 0x30 ? 0x31 : 0x30;
    writeFileSync(log, edited);

    const denied = hook('pre', s, { tool: 'open_pr', input: {}, call_id: 'after-flood' });
    expect(denied.status).toBe(2);
    expect(denied.stdout).toContain('can() refused');
    expect(denied.stdout).not.toContain('decision chain broken');
    expect(readFileSync(s).equals(stateBytes)).toBe(true);

    const verified = signal(['verify', '--state', s]);
    expect(verified.status).toBe(2);
    expect(verified.stderr).toContain('decision chain broken at seq 0');

    // The tail is still checked on the hot path. A second state, same size,
    // with the last line's MAC flipped, denies before any spec update.
    const s2 = newState();
    const bytes2 = readFileSync(s2);
    growPastFullCheck(s2, key);
    const log2 = integ.decisionPaths(s2).log;
    const text2 = readFileSync(log2, 'utf-8');
    const macAt = text2.lastIndexOf('"mac":"');
    expect(macAt).toBeGreaterThan(0);
    const flip = text2[macAt + 7] === 'a' ? 'b' : 'a';
    writeFileSync(log2, text2.slice(0, macAt + 7) + flip + text2.slice(macAt + 8));
    const tail = hook('pre', s2, { tool: 'run_tests', input: {}, call_id: 'tail' });
    expect(tail.status).toBe(2);
    expect(tail.stdout).toContain('decision record');
    expect(readFileSync(s2).equals(bytes2)).toBe(true);
    expect(read(s2).pending).toBeNull();
  }, 60_000);

  it('concurrent calls take distinct sequence numbers and leave one pending call', async () => {
    const s = newState();
    const call = (id: string) => new Promise<R>((resolve) => {
      const child = spawn(process.execPath, [join(agentDir, 'hook.mjs'), 'pre', '--state', s], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', status => resolve({ status, stdout, stderr }));
      child.stdin.end(JSON.stringify({ tool: id === 'allow' ? 'run_tests' : 'open_pr', input: {}, call_id: id }));
    });
    const ids = ['allow', 'd1', 'd2', 'd3', 'd4', 'd5'];
    const results = await Promise.all(ids.map(call));
    const allows = results.filter(r => r.status === 0);
    expect(allows).toHaveLength(1);
    for (const r of results) {
      if (r.status !== 0) {
        expect(r.status).toBe(2);
        expect(r.stdout).toMatch(/can\(\) refused|already pending/);
      }
    }
    expect(read(s).pending.tool).toBe('run_tests');
    expect(read(s).log.map((e: { kind: string }) => e.kind)).toEqual(['pre']);
    const lines = expectChain(s, integ.readKey(process.env.SPECKL_STATE_KEY_FILE!));
    expect(lines).toHaveLength(ids.length);
    expect(lines.filter(l => l.verdict === 'allow')).toHaveLength(1);
    expect(signal(['verify', '--state', s]).status).toBe(0);
    expect(existsSync(s + '.lock')).toBe(false);
  }, 20_000);
});

describe('unsigned dev state', () => {
  it('chains decisions without a MAC, and still refuses a rewritten line', () => {
    const env = noKeyEnv();
    const s = newState({ dev: true, env });
    const r = hook('pre', s, { tool: 'open_pr', input: {}, call_id: 'd' }, env);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('can() refused');
    const lines = expectChain(s, null);
    expect(lines[0].verdict).toBe('deny');
    expect(read(s).mac).toBeUndefined();
    const ok = signal(['verify', '--state', s], env);
    expect(ok.status, ok.stderr).toBe(0);
    const log = integ.decisionPaths(s).log;
    writeFileSync(log, readFileSync(log, 'utf-8').replace('deny', 'allow'));
    const again = hook('pre', s, { tool: 'run_tests', input: {}, call_id: '1' }, env);
    expect(again.status).toBe(2);
    expect(again.stdout).toContain('decision record');
    expect(read(s).log).toEqual([]);
  });
});
