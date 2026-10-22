// Call-bound sign-off: an await outcome can authorize one exact tool call,
// once, instead of every later call can() allows. The hash is sha256 of the
// canonical spec tool name and mapped arguments. A mismatch denies.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import crypto from 'node:crypto';
import { parseSpeckContent } from '../parser.js';
import { printAST } from '../printer.js';
import { lower } from '../ir/lower.js';
import { generateAgent } from '../generators/agent/index.js';
import { canonical, useStateKey, writeSigned } from './helpers/agent-state.js';

const SPEC = `speck CallBound {
    state {
        stage: Nat
    }
    init {
        stage := 0
    }
    action Go {
        require stage == 0
        stage := 1
    }
    action Ship(branch: String) {
        require stage == 2
        stage := 4
    }
    action Note(msg: String) {
        require stage == 2
        return true
    }
    action Look {
        return true
    }
    agent {
        stages stage {
            Idle = 0
            Wait = 1
            Ready = 2
            Shipped = 4
        }
        tool go -> Go effect act
        tool ship -> Ship effect act
        tool note -> Note effect act
        tool look -> Look effect observe
        await Wait {
            signal review
            mode near
            require outcome in { approve, reject! }
            bind call on approve
            on approve -> Ready
            on reject -> Wait
            timeout 24h -> reject
        }
    }
    next: Go | Ship | Note | Look
}
`;

type R = { status: number | null; stdout: string; stderr: string };

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

let agentDir = '';
let n = 0;
useStateKey();

function run(script: string, args: string[], input?: unknown): R {
  const r = spawnSync(process.execPath, [join(agentDir, script), ...args], {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf-8',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const read = (s: string) => JSON.parse(readFileSync(s, 'utf-8'));
const write = (s: string, v: Record<string, unknown>) => writeSigned(s, v);

function init(dev = false, pin = !dev): string {
  const state = join(mkdtempSync(join(tmpdir(), 'speckl-call-')), 'state.json');
  const args = ['init', '--state', state, ...(dev ? ['--dev'] : [])];
  // Production file-drop accepts only keys pinned at init. Dev cli tests
  // pass pin=false; an empty set is not a trust anchor.
  if (pin) args.push('--signer', 'reviewer=' + pubRaw.toString('hex'));
  const r = run('signal.mjs', args);
  expect(r.status, r.stderr).toBe(0);
  return state;
}
function hook(state: string, cmd: string, msg: unknown): R {
  return run('hook.mjs', [cmd, '--state', state], msg);
}
function pre(state: string, tool: string, input: unknown, id: string): R {
  return hook(state, 'pre', { tool, input, call_id: id });
}
function post(state: string, tool: string, input: unknown, id: string, ok: boolean): R {
  return hook(state, 'post', { tool, input, call_id: id, ok });
}
function go(state: string): void {
  expect(pre(state, 'go', {}, 'go').status).toBe(0);
  expect(post(state, 'go', {}, 'go', true).status).toBe(0);
}
function digestOf(tool: string, input: unknown): { digest: string; canonical: string } {
  const r = run('signal.mjs', ['digest'], { tool, input });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}
function drop(state: string, body: Record<string, unknown>, opts: { sign?: boolean } = {}): string[] {
  const dir = path.dirname(state);
  const full = {
    run: read(state).runId,
    expires: new Date(Date.now() + 3600_000).toISOString(),
    nonce: crypto.randomUUID(),
    ...body,
  };
  const file = join(dir, `drop-${n++}.json`);
  const buf = Buffer.from(JSON.stringify(full));
  writeFileSync(file, buf);
  if (opts.sign !== false) writeFileSync(file + '.sig', crypto.sign(null, buf, privateKey));
  const pub = join(dir, 'reviewer.pub');
  writeFileSync(pub, pubRaw.toString('base64'));
  return opts.sign === false
    ? ['apply', '--state', state, '--verifier', 'file-drop', '--file', file]
    : ['apply', '--state', state, '--verifier', 'file-drop', '--file', file, '--pubkey', pub];
}
function approve(state: string, call: string, extra: Record<string, unknown> = {}): R {
  return run('signal.mjs', drop(state, { signal: 'review', outcome: 'approve', claims: {}, call, ...extra }));
}
function otherKey(): { privateKey: crypto.KeyObject; raw: Buffer; hex: string } {
  const keys = crypto.generateKeyPairSync('ed25519');
  const raw = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey: keys.privateKey, raw, hex: raw.toString('hex') };
}
function signedBy(
  state: string,
  body: Record<string, unknown>,
  key: { privateKey: crypto.KeyObject; raw: Buffer },
  cmd = 'apply',
): string[] {
  const dir = path.dirname(state);
  const full = {
    run: read(state).runId,
    expires: new Date(Date.now() + 3600_000).toISOString(),
    nonce: crypto.randomUUID(),
    ...body,
  };
  const file = join(dir, `drop-${n++}.json`);
  const buf = Buffer.from(JSON.stringify(full));
  writeFileSync(file, buf);
  writeFileSync(file + '.sig', crypto.sign(null, buf, key.privateKey));
  const pub = join(dir, `key-${n}.pub`);
  writeFileSync(pub, key.raw.toString('base64'));
  return [cmd, '--state', state, '--verifier', 'file-drop', '--file', file, '--pubkey', pub];
}

beforeAll(() => {
  const out = mkdtempSync(join(tmpdir(), 'speckl-call-out-'));
  const file = join(out, 'CallBound.speckdl');
  writeFileSync(file, SPEC);
  generateAgent(parseSpeckContent(SPEC, file), { outputDir: out, sourcePath: file });
  agentDir = join(out, 'agent');
});

describe('spec declaration', () => {
  function spec(awaitLines: string): string {
    return SPEC.replace(
      /require outcome in \{ approve, reject! \}\n            bind call on approve/,
      awaitLines,
    );
  }
  function parseAgent(src: string) {
    const ast = parseSpeckContent(src);
    const agent = ast.specks[0].members.find(m => m.type === 'agent');
    if (!agent || agent.type !== 'agent') throw new Error('no agent');
    return agent;
  }

  it('bind call on names only those accepting outcomes', () => {
    expect(parseAgent(SPEC).awaits[0].bindCall).toEqual(['approve']);
  });

  it('bare bind call expands to every accepting outcome, and the printer is stable', () => {
    const src = spec('require outcome in { approve, reject! }\n            bind call');
    const ast = parseSpeckContent(src);
    expect(parseAgent(src).awaits[0].bindCall).toEqual(['approve']);
    const once = printAST(ast);
    expect(once).toContain('bind call on approve');
    expect(once).not.toMatch(/bind call\s*$/m);
    expect(printAST(parseSpeckContent(once))).toBe(once);
    expect(parseSpeckContent(once).specks[0].members.find(m => m.type === 'agent')).toMatchObject({
      awaits: [expect.objectContaining({ bindCall: ['approve'] })],
    });
  });

  it('lists several outcomes in source order', () => {
    const src = spec(
      'require outcome in { approve, ship, reject! }\n            bind call on ship, approve\n            on ship -> Ready',
    );
    expect(parseAgent(src).awaits[0].bindCall).toEqual(['ship', 'approve']);
    const once = printAST(parseSpeckContent(src));
    expect(once).toContain('bind call on ship, approve');
    expect(printAST(parseSpeckContent(once))).toBe(once);
  });

  it('bare bind call with only a reject outcome is an error', () => {
    const src = SPEC
      .replace('require outcome in { approve, reject! }', 'require outcome in { reject! }')
      .replace('            bind call on approve\n', '            bind call\n')
      .replace('            on approve -> Ready\n', '');
    expect(() => parseSpeckContent(src)).toThrow(/matches no accepting outcome/);
  });

  it.each([
    ['duplicate clause', 'require outcome in { approve, reject! }\n            bind call\n            bind call on approve', /duplicate bind call/],
    ['second bare clause', 'require outcome in { approve, reject! }\n            bind call\n            bind call', /duplicate bind call/],
    ['duplicate name', 'require outcome in { approve, reject! }\n            bind call on approve, approve', /duplicate bind call outcome approve/],
    ['unknown outcome', 'require outcome in { approve, reject! }\n            bind call on ship', /bind call outcome ship is not in require outcome/],
    ['reject outcome', 'require outcome in { approve, reject! }\n            bind call on reject', /reject authorizes no call/],
    ['trailing junk', 'require outcome in { approve, reject! }\n            bind call on approve please', /unexpected line/],
  ] as [string, string, RegExp][])('refuses %s', (_n, lines, re) => {
    expect(() => parseSpeckContent(spec(lines))).toThrow(re);
  });

  it('lowers bindCall onto the IR and into the runtime config', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'speckl-call-ir-')), 'x.speckdl');
    writeFileSync(file, SPEC);
    const ir = lower(parseSpeckContent(SPEC, file), { filePath: file, resolveImports: false });
    expect(ir.diagnostics.filter(d => d.level === 'error')).toEqual([]);
    expect(ir.specks[0].facets.behavior.agent?.awaits[0].bindCall).toEqual(['approve']);
    const cfg = JSON.parse(readFileSync(join(agentDir, 'agent-config.json'), 'utf-8'));
    expect(cfg.awaits[0].bindCall).toEqual(['approve']);
    const md = readFileSync(join(agentDir, 'AGENTS.md'), 'utf-8');
    expect(md).toContain('Call-bound: `approve`');
    expect(md).toContain('sha256 of one canonical tool call');
    expect(readFileSync(join(agentDir, 'README.md'), 'utf-8')).toContain('signal.mjs digest');
  });
});

describe('canonical call digest', () => {
  it('sorts keys at every depth and keeps array order and raw strings', () => {
    const a = digestOf('ship', { branch: 'main', meta: { z: 1, a: [1, 2] } });
    const b = digestOf('ship', { meta: { a: [1, 2], z: 1 }, branch: 'main' });
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toEqual(b);
    expect(a.canonical).toBe(canonical({ tool: 'ship', input: { branch: 'main', meta: { z: 1, a: [1, 2] } } }));
    expect(digestOf('ship', { branch: 'main', meta: { z: 1, a: [2, 1] } }).digest).not.toBe(a.digest);
    expect(digestOf('note', { branch: 'main', meta: { z: 1, a: [1, 2] } }).digest).not.toBe(a.digest);
    expect(digestOf('ship', { branch: 'main' }).digest).not.toBe(digestOf('ship', { branch: 'main', extra: true }).digest);
    const nfc = digestOf('ship', { branch: '\u00e9' });
    const nfd = digestOf('ship', { branch: 'e\u0301' });
    expect(nfc.digest).not.toBe(nfd.digest);
  });

  it('refuses a digest it cannot compute and writes no hash', () => {
    for (const input of [undefined, ['main'], 'main', null, 1]) {
      const body = input === undefined ? { tool: 'ship' } : { tool: 'ship', input };
      const r = run('signal.mjs', ['digest'], body);
      expect(r.status, JSON.stringify(body)).toBe(1);
      expect(r.stdout).not.toContain('"digest"');
    }
    const noTool = run('signal.mjs', ['digest'], { input: {} });
    expect(noTool.status).toBe(1);
    expect(noTool.stderr).toContain('requires tool');
    const notObject = run('signal.mjs', ['digest'], '');
    expect(notObject.status).toBe(1);
    expect(notObject.stdout).not.toContain('"digest"');
    const empty = spawnSync(process.execPath, [join(agentDir, 'signal.mjs'), 'digest'], { input: '', encoding: 'utf-8' });
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('not JSON');
    expect(empty.stdout || '').not.toContain('"digest"');
  });
});

describe('file-drop call binding', () => {
  const ship = { branch: 'main', meta: { z: 1, a: [1, 2] } };

  it('shows the human the exact preimage while waiting, then allows that call once', () => {
    const state = init();
    go(state);
    const denied = pre(state, 'ship', ship, 's0');
    expect(denied.status).toBe(2);
    expect(denied.stderr).toContain('HNTL: act tool refused while awaiting signal review');
    const hint = denied.stderr.match(/sign call ([0-9a-f]{64}) canonical (\S+)/);
    expect(hint, denied.stderr).not.toBeNull();
    const shown = digestOf('ship', ship);
    expect(hint![1]).toBe(shown.digest);
    expect(hint![2]).toBe(shown.canonical);

    const upper = shown.digest.toUpperCase();
    const applied = approve(state, upper);
    expect(applied.status, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout).call).toBe(shown.digest);
    const st = read(state);
    expect(st.machine.state.stage).toBe(2);
    expect(st.boundCall).toEqual({ hash: shown.digest });
    expect(st.signalLog[0].signer).toBe('reviewer');
    expect(st.log.some((e: { kind: string; call?: string }) => e.kind === 'signal' && e.call === shown.digest)).toBe(true);
    expect(st.usedNonces).toHaveLength(1);

    // Same mapped arguments, different key order: one digest across producers.
    const reordered = { meta: { a: [1, 2], z: 1 }, branch: 'main' };
    expect(digestOf('ship', reordered).digest).toBe(shown.digest);
    const look = pre(state, 'look', {}, 'obs');
    expect(look.status).toBe(2);
    expect(look.stderr).toContain('does not cover this call');
    expect(look.stderr).toContain('want ' + shown.digest);
    const swapped = pre(state, 'ship', { branch: 'main', meta: { z: 1, a: [2, 1] } }, 'bad');
    expect(swapped.status).toBe(2);
    expect(read(state).boundCall).toEqual({ hash: shown.digest });
    expect(read(state).log).toHaveLength(st.log.length);

    expect(pre(state, 'ship', reordered, 's1').status).toBe(0);
    expect(read(state).boundCall).toEqual({ hash: shown.digest }); // consumed on post ok
    expect(post(state, 'ship', reordered, 's1', true).status).toBe(0);
    expect(read(state).boundCall).toBeNull();
    expect(read(state).machine.state.stage).toBe(4);
    expect(pre(state, 'ship', ship, 's2').status).toBe(2);
    expect(pre(state, 'ship', ship, 's2').stderr).toContain('can() refused');
    expect(pre(state, 'look', {}, 'obs2').status).toBe(0);

    const again = approve(state, shown.digest);
    expect(again.status).toBe(2);
    expect(read(state).signalLog).toHaveLength(1);
  });

  it('records the bound-call mismatch deny and the matching allow, and the deny leaves the binding', () => {
    const state = init();
    go(state);
    const ship = { branch: 'main' };
    const shown = digestOf('ship', ship);
    expect(approve(state, shown.digest).status, 'approve').toBe(0);
    const stateBefore = readFileSync(state, 'utf-8');
    const logPath = state + '.decisions/log.jsonl';
    const before = readFileSync(logPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));

    const miss = pre(state, 'look', {}, 'obs');
    expect(miss.status).toBe(2);
    expect(miss.stderr).toContain('does not cover this call');
    expect(readFileSync(state, 'utf-8')).toBe(stateBefore);
    const afterMiss = readFileSync(logPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(afterMiss).toHaveLength(before.length + 1);
    expect(afterMiss.at(-1)).toMatchObject({ phase: 'pre', tool: 'look', action: 'Look', verdict: 'deny' });
    expect(String(afterMiss.at(-1).reason)).toContain('does not cover this call');
    expect(String(afterMiss.at(-1).reason)).toContain(shown.digest);
    expect(afterMiss.at(-1).input_sha256).toBe(sha(canonical({})));

    expect(pre(state, 'ship', ship, 's1').status).toBe(0);
    const allowed = readFileSync(logPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(allowed.at(-1)).toMatchObject({ phase: 'pre', tool: 'ship', action: 'Ship', verdict: 'allow', reason: null });
    expect(read(state).boundCall).toEqual({ hash: shown.digest });

    expect(post(state, 'ship', ship, 's1', true).status).toBe(0);
    const posted = readFileSync(logPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(posted.at(-1)).toMatchObject({ phase: 'post', tool: 'ship', verdict: 'allow', reason: null });
    expect(read(state).boundCall).toBeNull();
    expect(read(state).machine.state.stage).toBe(4);

    const v = run('signal.mjs', ['verify', '--state', state]);
    expect(v.status, v.stderr).toBe(0);
    expect(JSON.parse(v.stdout)).toMatchObject({ ok: true, decisions: posted.length, uncommitted: 0 });
  });

  it('a failed or expired attempt does not unlock a different call', () => {
    const state = init();
    go(state);
    const note = digestOf('note', { msg: 'a' });
    expect(approve(state, note.digest).status).toBe(0);
    expect(pre(state, 'note', { msg: 'a' }, 'n1').status).toBe(0);
    expect(post(state, 'note', { msg: 'a' }, 'n1', false).status).toBe(0);
    expect(read(state).boundCall).toEqual({ hash: note.digest });
    expect(read(state).machine.state.stage).toBe(2);
    expect(pre(state, 'note', { msg: 'b' }, 'n2').status).toBe(2);

    expect(pre(state, 'note', { msg: 'a' }, 'n3').status).toBe(0);
    const st = read(state);
    st.pending.since = new Date(Date.now() - 11 * 60_000).toISOString();
    write(state, st);
    const other = pre(state, 'note', { msg: 'b' }, 'n4');
    expect(other.status).toBe(2);
    expect(other.stderr).toContain('does not cover this call');
    expect(read(state).pending).toBeNull();
    expect(read(state).boundCall).toEqual({ hash: note.digest });

    expect(pre(state, 'note', { msg: 'a' }, 'n5').status).toBe(0);
    expect(post(state, 'note', { msg: 'a' }, 'n5', true).status).toBe(0);
    expect(read(state).boundCall).toBeNull();
    // The spent sign-off no longer pins arguments. can() still allows Note.
    expect(pre(state, 'note', { msg: 'b' }, 'n6').status).toBe(0);
  });

  it('an in-flight observe call can finish without consuming the binding', () => {
    const state = init();
    go(state);
    expect(pre(state, 'look', { path: 'a' }, 'L').status).toBe(0);
    const shipHash = digestOf('ship', { branch: 'main' }).digest;
    expect(approve(state, shipHash).status).toBe(0);
    expect(post(state, 'look', { path: 'a' }, 'L', true).status).toBe(0);
    expect(read(state).boundCall).toEqual({ hash: shipHash });
    expect(pre(state, 'ship', { branch: 'other' }, 'no').status).toBe(2);
    expect(pre(state, 'ship', { branch: 'main' }, 'yes').status).toBe(0);
  });

  it('a matching hash does not bypass can()', () => {
    const state = init();
    go(state);
    const goHash = digestOf('go', {}).digest;
    expect(approve(state, goHash).status).toBe(0);
    const r = pre(state, 'go', {}, 'g2');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('can() refused');
    expect(read(state).boundCall).toEqual({ hash: goHash });
    expect(read(state).pending).toBeNull();
  });

  it('omitted and null input are the empty arguments object', () => {
    const state = init();
    go(state);
    const empty = digestOf('look', {});
    expect(approve(state, empty.digest).status).toBe(0);
    expect(pre(state, 'look', null, 'a').status).toBe(0);
    expect(post(state, 'look', null, 'a', false).status).toBe(0);
    const omitted = hook(state, 'pre', { tool: 'look', call_id: 'b' });
    expect(omitted.status, omitted.stderr).toBe(0);
  });

  it('refuses a non-object call, a missing hash, a reject carrying a hash, and a bad hash', () => {
    const state = init();
    go(state);
    const badShape = pre(state, 'ship', ['main'], 'arr');
    expect(badShape.status).toBe(2);
    expect(badShape.stderr).toContain('HNTL');
    expect(badShape.stderr).toContain('arguments object');
    expect(read(state).machine.state.stage).toBe(1);

    const missing = run('signal.mjs', drop(state, { signal: 'review', outcome: 'approve', claims: {} }));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('call-bound sign-off requires call');
    expect(read(state).machine.state.stage).toBe(1);
    expect(read(state).usedNonces).toEqual([]);

    const onReject = run('signal.mjs', drop(state, {
      signal: 'review', outcome: 'reject', claims: {}, call: 'ab'.repeat(32),
    }));
    expect(onReject.status).toBe(2);
    expect(onReject.stderr).toContain('stage-level sign-off must not carry a call hash');
    expect(read(state).machine.state.stage).toBe(1);

    for (const call of ['abc', 'g'.repeat(64), { sha: 'no' }, 1]) {
      const r = run('signal.mjs', drop(state, { signal: 'review', outcome: 'approve', claims: {}, call: call as never }));
      expect(r.status, JSON.stringify(call)).toBe(2);
      expect(r.stderr).toContain('payload call must be a 64-char sha256 hex digest');
      expect(read(state).machine.state.stage).toBe(1);
    }
  });

  it('still refuses a bad run, an expired drop, a bad signature, and a replay', () => {
    const state = init();
    go(state);
    const call = digestOf('ship', { branch: 'main' }).digest;
    const other = init();
    const wrongRun = run('signal.mjs', drop(state, {
      signal: 'review', outcome: 'approve', claims: {}, call, run: read(other).runId,
    }));
    expect(wrongRun.status).toBe(2);
    expect(wrongRun.stderr).toContain('run mismatch');

    const expired = run('signal.mjs', drop(state, {
      signal: 'review', outcome: 'approve', claims: {}, call,
      expires: new Date(Date.now() - 1000).toISOString(),
    }));
    expect(expired.status).toBe(2);
    expect(expired.stderr).toContain('expired');

    const unsigned = run('signal.mjs', drop(state, {
      signal: 'review', outcome: 'approve', claims: {}, call,
    }, { sign: false }));
    expect(unsigned.status).toBe(2);
    expect(read(state).machine.state.stage).toBe(1);

    const rejectArgs = drop(state, { signal: 'review', outcome: 'reject', claims: {} });
    expect(run('signal.mjs', rejectArgs).status).toBe(0);
    expect(read(state).machine.state.stage).toBe(1);
    expect(read(state).boundCall).toBeNull();
    const replay = run('signal.mjs', rejectArgs);
    expect(replay.status).toBe(2);
    expect(replay.stderr).toMatch(/replay|nonce already used/);
    expect(read(state).signalLog).toHaveLength(1);
  });

  it('clear-pending refuses a call hash', () => {
    const state = init();
    go(state);
    expect(pre(state, 'look', {}, 'pend').status).toBe(0);
    const r = run('signal.mjs', drop(state, {
      signal: 'clear-pending', outcome: 'clear', call_id: 'pend', call: 'ab'.repeat(32),
    }).map(a => a === 'apply' ? 'clear-pending' : a));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('clear-pending does not accept a call hash');
    expect(read(state).pending.call_id).toBe('pend');
  });

  it('the dev cli verifier can carry call, and a bad --call denies', () => {
    const state = init(true);
    go(state);
    const call = digestOf('ship', { branch: 'main' }).digest;
    const bad = run('signal.mjs', ['apply', '--state', state, '--verifier', 'cli', '--outcome', 'approve', '--call', 'nope']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('64-char');
    expect(read(state).machine.state.stage).toBe(1);
    const ok = run('signal.mjs', ['apply', '--state', state, '--verifier', 'cli', '--outcome', 'approve', '--call', call]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(read(state).boundCall).toEqual({ hash: call });
    expect(read(state).signalLog[0].verifier).toBe('cli-DEV');

    const prod = init();
    go(prod);
    const refused = run('signal.mjs', ['apply', '--state', prod, '--verifier', 'cli', '--outcome', 'approve', '--call', call]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('DEV ONLY');
  });

  it('a state without boundCall still verifies, and a hand-edited binding does not', () => {
    const fresh = init();
    const st = read(fresh);
    delete st.boundCall;
    write(fresh, st);
    expect(pre(fresh, 'go', {}, 'g').status).toBe(0);

    const state = init();
    go(state);
    const call = digestOf('ship', { branch: 'main' }).digest;
    expect(approve(state, call).status).toBe(0);
    const edited = read(state);
    edited.boundCall = { hash: 'ab'.repeat(32) };
    write(state, edited);
    const denied = pre(state, 'ship', { branch: 'main' }, 's');
    expect(denied.status).toBe(2);
    expect(denied.stdout).toContain('bound call does not match the log');

    const second = init();
    go(second);
    expect(approve(second, call).status).toBe(0);
    const log = read(second);
    const last = log.log[log.log.length - 1];
    const body = { ...last };
    delete body.hash;
    body.call = 'zzzz';
    const hash = sha(canonical(body));
    log.log[log.log.length - 1] = { ...body, hash };
    log.head = hash;
    write(second, log);
    const replay = pre(second, 'ship', { branch: 'main' }, 's');
    expect(replay.status).toBe(2);
    expect(replay.stdout).toContain('signal call hash is not 64 hex chars');
  });

  it('a call-bound file-drop is accepted only from a current pinned signer', () => {
    const state = init();
    go(state);
    const call = digestOf('ship', { branch: 'main' }).digest;
    const outsider = otherKey();
    const foreign = run('signal.mjs', signedBy(state, {
      signal: 'review', outcome: 'approve', claims: {}, call,
    }, outsider));
    expect(foreign.status).toBe(2);
    expect(foreign.stderr).toContain('pubkey is not a pinned sign-off signer');
    expect(read(state).machine.state.stage).toBe(1);
    expect(read(state).usedNonces).toEqual([]);
    expect(read(state).boundCall).toBeNull();

    const empty = init(false, false);
    go(empty);
    const none = approve(empty, call);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('no sign-off signers pinned');
    expect(read(empty).boundCall).toBeNull();
    expect(read(empty).machine.state.stage).toBe(1);

    const next = otherKey();
    const rotated = run('signal.mjs', signedBy(state, {
      signal: 'rotate-signers',
      outcome: 'rotate',
      signers: [{ name: 'next', key: next.hex }],
    }, { privateKey, raw: pubRaw }, 'rotate-signers'));
    expect(rotated.status, rotated.stderr).toBe(0);
    expect(read(state).initialSigners).toEqual([{ name: 'reviewer', key: pubRaw.toString('hex') }]);
    expect(read(state).signers).toEqual([{ name: 'next', key: next.hex }]);

    const stale = approve(state, call);
    expect(stale.status).toBe(2);
    expect(stale.stderr).toContain('pubkey is not a pinned sign-off signer');
    expect(read(state).machine.state.stage).toBe(1);
    expect(read(state).boundCall).toBeNull();

    const applied = run('signal.mjs', signedBy(state, {
      signal: 'review', outcome: 'approve', claims: {}, call,
    }, next));
    expect(applied.status, applied.stderr).toBe(0);
    const logged = read(state).signalLog;
    expect(logged[logged.length - 1].signer).toBe('next');
    expect(read(state).boundCall).toEqual({ hash: call });

    // Rotation after apply does not revoke the stored binding.
    const later = otherKey();
    const again = run('signal.mjs', signedBy(state, {
      signal: 'rotate-signers',
      outcome: 'rotate',
      signers: [{ name: 'later', key: later.hex }],
    }, next, 'rotate-signers'));
    expect(again.status, again.stderr).toBe(0);
    expect(read(state).signers).toEqual([{ name: 'later', key: later.hex }]);
    expect(read(state).boundCall).toEqual({ hash: call });
    expect(pre(state, 'ship', { branch: 'main' }, 'still').status).toBe(0);
  });

  it('does not recheck expiry when the bound call runs', async () => {
    const state = init();
    go(state);
    const call = digestOf('note', { msg: 'a' }).digest;
    const expires = new Date(Date.now() + 1500).toISOString();
    const applied = run('signal.mjs', drop(state, {
      signal: 'review', outcome: 'approve', claims: {}, call, expires,
    }));
    expect(applied.status, applied.stderr).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 1700));
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(expires));
    expect(pre(state, 'note', { msg: 'a' }, 'late').status).toBe(0);
    expect(read(state).boundCall).toEqual({ hash: call });
  });
});
