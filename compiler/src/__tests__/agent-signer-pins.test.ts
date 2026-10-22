// Pinned sign-off signers: the keys file-drop will accept are fixed at init,
// sealed into the state, and a per-call --pubkey that is not in that set is
// refused. Rotation is a signed log entry, not an edit of the genesis set.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { canonical, useStateKey, writeSigned } from './helpers/agent-state.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = join(compilerDir, '..', 'examples', 'AgentPolicy.speckdl');
const viteNode = join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs');

type R = { status: number | null; stdout: string; stderr: string };
type Key = { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject; raw: Buffer; hex: string };

function compile(out: string): void {
  const r = spawnSync(process.execPath, [viteNode, join(compilerDir, 'src', 'index.ts'), example, '-t', 'agent', '-o', out],
    { cwd: compilerDir, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
}
function signal(args: string[]): R {
  const r = spawnSync(process.execPath, [join(agentDir, 'signal.mjs'), ...args], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function hook(state: string, cmd: string, msg: object): R {
  const r = spawnSync(process.execPath, [join(agentDir, 'hook.mjs'), cmd, '--state', state],
    { input: JSON.stringify(msg), encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const read = (s: string) => JSON.parse(readFileSync(s, 'utf-8'));
const sha = (x: string | Buffer) => crypto.createHash('sha256').update(x).digest('hex');
useStateKey();

let agentDir = '';
let n = 0;

function pair(): Key {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { publicKey, privateKey, raw, hex: raw.toString('hex') };
}
function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'speckl-pin-')), 'state.json');
}
function init(signers: string[] = [], dev = false): { state: string; out: R } {
  const state = statePath();
  const args = ['init', '--state', state, ...(dev ? ['--dev'] : [])];
  for (const s of signers) args.push('--signer', s);
  const out = signal(args);
  return { state, out };
}
function mustInit(signers: string[] = [], dev = false): string {
  const { state, out } = init(signers, dev);
  expect(out.status, out.stderr).toBe(0);
  return state;
}
function step(state: string, tool: string, id: string): void {
  expect(hook(state, 'pre', { tool, input: tool === 'read_file' ? { path: 'a' } : {}, call_id: id }).status).toBe(0);
  expect(hook(state, 'post', { tool, input: tool === 'read_file' ? { path: 'a' } : {}, call_id: id, ok: true }).status).toBe(0);
}
function awaiting(signers: string[], dev = false): string {
  const state = mustInit(signers, dev);
  step(state, 'run_tests', '1');
  step(state, 'request_review', '2');
  return state;
}
function drop(state: string, body: Record<string, unknown>, key: Key, opts: { bind?: boolean } = {}): string {
  const full = opts.bind === false ? body : {
    run: read(state).runId,
    expires: new Date(Date.now() + 3600_000).toISOString(),
    nonce: crypto.randomUUID(),
    ...body,
  };
  const file = join(path.dirname(state), `drop-${n++}.json`);
  const buf = Buffer.from(JSON.stringify(full));
  writeFileSync(file, buf);
  writeFileSync(file + '.sig', crypto.sign(null, buf, key.privateKey));
  return file;
}
function pubFile(state: string, key: Key, name: string): string {
  const file = join(path.dirname(state), name);
  writeFileSync(file, key.hex);
  return file;
}
const approve = { signal: 'review', outcome: 'approve', claims: { reviewer: 'carol' } };

/** The genesis formula from before signer pinning. */
function legacyGenesis(st: { runId: string; specHash: string; dev?: boolean; keyId?: string | null }): string {
  return sha('speckl-state-v1:' + canonical({
    run: st.runId, spec: st.specHash, dev: st.dev === true, keyId: st.keyId || null,
  }));
}
function asLegacy(state: string): void {
  const st = read(state);
  delete st.initialSigners;
  delete st.signers;
  let prev = legacyGenesis(st);
  st.log = st.log.map((e: { hash?: string; [k: string]: unknown }, i: number) => {
    const { hash: _h, ...body } = e;
    body.seq = i;
    body.prev = prev;
    const h = sha(canonical(body));
    prev = h;
    return { ...body, hash: h };
  });
  st.head = prev;
  writeSigned(state, st);
}

beforeAll(() => {
  const out = mkdtempSync(join(tmpdir(), 'speckl-pin-out-'));
  compile(out);
  agentDir = join(out, 'agent');
}, 60_000);

describe('init records the signer set', () => {
  const alice = pair();
  const bob = pair();

  it('sorts signers by name and prints the sha256 of each raw key', () => {
    const wrapped = join(mkdtempSync(join(tmpdir(), 'speckl-pin-key-')), 'bob.pub');
    writeFileSync(wrapped, `-----BEGIN PUBLIC KEY-----\n${bob.hex}\n-----END PUBLIC KEY-----\n`);
    const { state, out } = init([`bob=${wrapped}`, `alice=${alice.hex}`]);
    expect(out.status, out.stderr).toBe(0);
    const printed = JSON.parse(out.stdout).signers;
    expect(printed).toEqual([
      { name: 'alice', fingerprint: sha(alice.raw) },
      { name: 'bob', fingerprint: sha(bob.raw) },
    ]);
    const st = read(state);
    expect(st.initialSigners).toEqual(st.signers);
    expect(st.signers).toEqual([
      { name: 'alice', key: alice.hex },
      { name: 'bob', key: bob.hex },
    ]);
    // A fresh run with no --signer records an empty set, which is not the
    // pre-pinning genesis (that one omitted the field).
    const empty = mustInit();
    const est = read(empty);
    expect(est.initialSigners).toEqual([]);
    expect(est.signers).toEqual([]);
    expect(est.head).not.toBe(legacyGenesis(est));
  });

  it('accepts raw, hex and base64 encodings of the same key shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-pin-enc-'));
    const rawFile = join(dir, 'raw.pub');
    const b64File = join(dir, 'b64.pub');
    writeFileSync(rawFile, alice.raw);
    writeFileSync(b64File, `  ${alice.raw.toString('base64')}  \n`);
    const hexState = mustInit([`carol=${alice.hex}`]);
    const rawState = mustInit([`carol=${rawFile}`]);
    const b64State = mustInit([`carol=${alice.raw.toString('base64')}`]);
    const spaced = mustInit([`carol=${b64File}`]);
    for (const s of [hexState, rawState, b64State, spaced]) {
      expect(read(s).signers).toEqual([{ name: 'carol', key: alice.hex }]);
    }
  });

  it.each([
    ['a name with a space', ['bad name=' + alice.hex], /bad signer name/],
    ['a name that does not start with an alphanumeric', ['-no=' + alice.hex], /bad signer name/],
    ['no equals', ['carol'], /name=pubkey/],
    ['a duplicate name', [`carol=${alice.hex}`, `carol=${bob.hex}`], /duplicate signer name/],
    ['the same key under two names', [`carol=${alice.hex}`, `dave=${alice.raw.toString('base64')}`], /duplicate signer key/],
    ['a missing key file', ['carol=/no/such/reviewer.pub'], /signer carol:/],
    ['an empty pubkey', ['carol='], /signer carol:/],
  ])('refuses %s and writes no state', (_label, signers, re) => {
    const { state, out } = init(signers);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(re);
    expect(existsSync(state)).toBe(false);
  });

  it('refuses a 33rd signer', () => {
    const signers = Array.from({ length: 33 }, (_, i) => `s${i}=${crypto.randomBytes(32).toString('hex')}`);
    const { state, out } = init(signers);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('too many signers');
    expect(existsSync(state)).toBe(false);
  });
});

describe('file-drop accepts only pinned keys', () => {
  const alice = pair();
  const bob = pair();
  const carol = pair();
  const pins = () => [`alice=${alice.hex}`, `bob=${bob.hex}`];

  it('a signature from either pin is accepted, and the log names which one', () => {
    const s = awaiting(pins());
    const file = drop(s, approve, bob);
    const r = signal(['apply', '--state', s, '--verifier', 'file-drop', '--file', file]);
    expect(r.status, r.stderr).toBe(0);
    expect(read(s).machine.state.stage).toBe(3);
    expect(read(s).signalLog[0].signer).toBe('bob');

    const s2 = awaiting(pins());
    const named = drop(s2, approve, alice);
    const r2 = signal(['apply', '--state', s2, '--verifier', 'file-drop', '--file', named, '--signer', 'alice']);
    expect(r2.status, r2.stderr).toBe(0);
    expect(read(s2).signalLog[0].signer).toBe('alice');
  });

  it('a per-call key that is not pinned is refused, dev or not, and the state stays put', () => {
    for (const dev of [false, true]) {
      const s = awaiting(pins(), dev);
      const file = drop(s, approve, carol);
      const pub = pubFile(s, carol, 'carol.pub');
      const stage = read(s).machine.state.stage;
      const presented = signal(['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--pubkey', pub]);
      expect(presented.status).toBe(2);
      expect(presented.stderr).toContain('pubkey is not a pinned sign-off signer');
      const omitted = signal(['apply', '--state', s, '--verifier', 'file-drop', '--file', file]);
      expect(omitted.status).toBe(2);
      expect(omitted.stderr).toContain('bad signature');
      expect(read(s).machine.state.stage).toBe(stage);
      expect(read(s).signalLog).toEqual([]);
    }
  });

  it('selecting one pin does not let the other pin\'s signature through', () => {
    const s = awaiting(pins());
    const file = drop(s, approve, bob);
    const pub = pubFile(s, alice, 'alice.pub');
    const wrongKey = signal(['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--pubkey', pub]);
    expect(wrongKey.status).toBe(2);
    expect(wrongKey.stderr).toContain('bad signature');
    const mismatch = signal(['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--signer', 'alice', '--pubkey', pubFile(s, bob, 'bob.pub')]);
    expect(mismatch.stderr).toContain('signer name does not match --pubkey');
    const unknown = signal(['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--signer', 'carol']);
    expect(unknown.stderr).toContain('unknown pinned signer: carol');
    const two = signal(['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--signer', 'alice', '--signer', 'bob']);
    expect(two.stderr).toContain('pass one --signer');
    const flag = signal(['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--pubkey']);
    expect(flag.stderr).toContain('--pubkey must be a path');
    expect(read(s).machine.state.stage).toBe(2);
  });

  it('an empty set refuses file-drop on a production state and on a dev state', () => {
    for (const dev of [false, true]) {
      const s = awaiting([], dev);
      const file = drop(s, approve, alice);
      const r = signal(['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--pubkey', pubFile(s, alice, 'a.pub')]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('no sign-off signers pinned');
      expect(read(s).signalLog).toEqual([]);
    }
  });

  it('clear-pending uses the same pin', () => {
    const s = mustInit(pins());
    expect(hook(s, 'pre', { tool: 'run_tests', input: {}, call_id: 'c1' }).status).toBe(0);
    const outsider = drop(s, { signal: 'clear-pending', outcome: 'clear', call_id: 'c1' }, carol);
    const denied = signal(['clear-pending', '--state', s, '--verifier', 'file-drop', '--file', outsider, '--pubkey', pubFile(s, carol, 'c.pub')]);
    expect(denied.stderr).toContain('not a pinned sign-off signer');
    expect(read(s).pending.call_id).toBe('c1');
    const ok = drop(s, { signal: 'clear-pending', outcome: 'clear', call_id: 'c1' }, alice);
    expect(signal(['clear-pending', '--state', s, '--verifier', 'file-drop', '--file', ok]).status).toBe(0);
    expect(read(s).pending).toBeNull();
  });

  it('the verifier itself denies a malformed pin and an unpinned key', async () => {
    const s = awaiting(pins());
    const file = drop(s, approve, alice);
    const mod = await import(pathToFileURL(join(agentDir, 'verifiers', 'file-drop.mjs')).href);
    const expectSpec = { signal: 'review', outcomes: ['approve', 'reject'], claims: [] };
    const ctx = { runId: read(s).runId, dev: false, signers: read(s).signers };
    expect((await mod.verify({ file, pubkey: pubFile(s, carol, 'nope.pub') }, expectSpec, ctx)).reason)
      .toContain('not a pinned sign-off signer');
    expect((await mod.verify({ file }, expectSpec, { ...ctx, signers: 'nope' })).reason).toContain('malformed');
    expect((await mod.verify({ file }, expectSpec, { ...ctx, signers: [{ name: 'alice', key: 'zz' }] })).reason).toContain('malformed');
    expect((await mod.verify({ file }, expectSpec, { ...ctx, signers: null })).reason).toContain('malformed');
  });
});

describe('legacy states keep per-call --pubkey', () => {
  const alice = pair();

  it('stripping the pin fields restores the old genesis and trusts --pubkey, with a warning', async () => {
    const s = awaiting([`alice=${alice.hex}`]);
    const mod = await import(pathToFileURL(join(agentDir, 'state-integrity.mjs')).href);
    const before = read(s);
    expect(mod.genesis(before)).toBe(before.log[0].prev);
    asLegacy(s);
    const st = read(s);
    expect(st.initialSigners).toBeUndefined();
    expect(mod.genesis(st)).toBe(legacyGenesis(st));
    expect(mod.genesis(st)).toBe(st.log[0].prev);
    // The hook still accepts it: the chain was rebuilt, not broken.
    expect(hook(s, 'pre', { tool: 'read_file', input: { path: 'a' }, call_id: 'rf' }).status).toBe(0);

    const other = pair();
    const file = drop(s, approve, other);
    const r = signal(['apply', '--state', s, '--verifier', 'file-drop', '--file', file, '--pubkey', pubFile(s, other, 'other.pub')]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('no pinned sign-off signers');
    expect(r.stderr).toContain('Re-init with --signer');
    expect(read(s).machine.state.stage).toBe(3);
  });

  it('a legacy state cannot grow a pin through rotate-signers', () => {
    const s = awaiting([`alice=${alice.hex}`]);
    asLegacy(s);
    const file = drop(s, {
      signal: 'rotate-signers', outcome: 'rotate',
      signers: [{ name: 'alice', key: alice.hex }],
    }, alice);
    const r = signal(['rotate-signers', '--state', s, '--verifier', 'file-drop', '--file', file]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('predates signer pinning');
    expect(read(s).signers).toBeUndefined();
    expect(read(s).log.some((e: { kind: string }) => e.kind === 'signers')).toBe(false);
  });
});

describe('rotate-signers', () => {
  const alice = pair();
  const bob = pair();
  const carol = pair();
  const dave = pair();

  it('a current pin can replace the set; the removed keys stop verifying and the hook still loads the log', () => {
    const s = awaiting([`bob=${bob.hex}`, `alice=${alice.hex}`]);
    const stage = read(s).machine.state.stage;
    const file = drop(s, {
      signal: 'rotate-signers', outcome: 'rotate',
      signers: [{ name: 'carol', key: carol.hex.toUpperCase() }],
    }, alice);
    const r = signal(['rotate-signers', '--state', s, '--verifier', 'file-drop', '--file', file]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).signers).toEqual([{ name: 'carol', fingerprint: sha(carol.raw) }]);
    const st = read(s);
    expect(st.machine.state.stage).toBe(stage);
    expect(st.initialSigners.map((x: { name: string }) => x.name)).toEqual(['alice', 'bob']);
    expect(st.signers).toEqual([{ name: 'carol', key: carol.hex }]);
    expect(st.log.at(-1)).toMatchObject({ kind: 'signers', by: 'alice' });
    expect(hook(s, 'pre', { tool: 'read_file', input: { path: 'a' }, call_id: 'rf' }).status, 'hook after rotation').toBe(0);

    const bobDrop = drop(s, approve, bob);
    expect(signal(['apply', '--state', s, '--verifier', 'file-drop', '--file', bobDrop]).stderr).toContain('bad signature');
    // carol, now the only pin, rotates once more. alice cannot.
    const again = drop(s, {
      signal: 'rotate-signers', outcome: 'rotate',
      signers: [{ name: 'dave', key: dave.hex }],
    }, alice);
    expect(signal(['rotate-signers', '--state', s, '--verifier', 'file-drop', '--file', again]).stderr).toContain('bad signature');
    const byCarol = drop(s, {
      signal: 'rotate-signers', outcome: 'rotate',
      signers: [{ name: 'dave', key: dave.hex }],
    }, carol);
    expect(signal(['rotate-signers', '--state', s, '--verifier', 'file-drop', '--file', byCarol]).status).toBe(0);
    const final = drop(s, approve, dave);
    expect(signal(['apply', '--state', s, '--verifier', 'file-drop', '--file', final]).status).toBe(0);
    expect(read(s).machine.state.stage).toBe(3);
    expect(read(s).initialSigners).toHaveLength(2);
  });

  it('a rotation that does not verify leaves the set untouched', () => {
    const s = awaiting([`alice=${alice.hex}`]);
    const before = read(s);
    const cases: [string[], RegExp][] = [];
    const outsider = drop(s, {
      signal: 'rotate-signers', outcome: 'rotate', signers: [{ name: 'carol', key: carol.hex }],
    }, carol);
    cases.push([['rotate-signers', '--state', s, '--verifier', 'file-drop', '--file', outsider, '--pubkey', pubFile(s, carol, 'c.pub')], /not a pinned sign-off signer/]);
    const edited = drop(s, {
      signal: 'rotate-signers', outcome: 'rotate', signers: [{ name: 'alice', key: alice.hex }],
    }, alice);
    const buf = readFileSync(edited);
    const tampered = JSON.parse(buf.toString('utf-8'));
    tampered.signers = [{ name: 'carol', key: carol.hex }];
    writeFileSync(edited, JSON.stringify(tampered));
    cases.push([['rotate-signers', '--state', s, '--verifier', 'file-drop', '--file', edited], /bad signature/]);
    const empty = drop(s, { signal: 'rotate-signers', outcome: 'rotate', signers: [] }, alice);
    cases.push([['rotate-signers', '--state', s, '--verifier', 'file-drop', '--file', empty], /at least one signer/]);
    const dup = drop(s, {
      signal: 'rotate-signers', outcome: 'rotate',
      signers: [{ name: 'carol', key: carol.hex }, { name: 'carol', key: dave.hex }],
    }, alice);
    cases.push([['rotate-signers', '--state', s, '--verifier', 'file-drop', '--file', dup], /duplicate signer name/]);
    const badKey = drop(s, {
      signal: 'rotate-signers', outcome: 'rotate', signers: [{ name: 'carol', key: 'zzzz' }],
    }, alice);
    cases.push([['rotate-signers', '--state', s, '--verifier', 'file-drop', '--file', badKey], /signer carol:/]);
    const noSet = drop(s, { signal: 'rotate-signers', outcome: 'rotate' }, alice);
    cases.push([['rotate-signers', '--state', s, '--verifier', 'file-drop', '--file', noSet], /missing signers/]);
    const wrongOutcome = drop(s, {
      signal: 'rotate-signers', outcome: 'approve', signers: [{ name: 'carol', key: carol.hex }],
    }, alice);
    cases.push([['rotate-signers', '--state', s, '--verifier', 'file-drop', '--file', wrongOutcome], /disallowed outcome/]);
    const asCli = ['rotate-signers', '--state', s, '--verifier', 'cli', '--outcome', 'rotate'];
    cases.push([asCli, /requires --verifier file-drop/]);
    for (const [args, re] of cases) {
      const r = signal(args);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(re);
    }
    const after = read(s);
    expect(after.signers).toEqual(before.signers);
    expect(after.log).toHaveLength(before.log.length);
    expect(after.usedNonces).toEqual(before.usedNonces);
  });

  it('unsigned and empty-set rotations are refused', () => {
    const dev = mustInit([`alice=${alice.hex}`], true);
    const file = join(path.dirname(dev), 'unsigned.json');
    writeFileSync(file, JSON.stringify({
      signal: 'rotate-signers', outcome: 'rotate', signers: [{ name: 'carol', key: carol.hex }],
      run: read(dev).runId, expires: new Date(Date.now() + 3600_000).toISOString(), nonce: crypto.randomUUID(),
    }));
    const unsigned = signal(['rotate-signers', '--state', dev, '--verifier', 'file-drop', '--file', file, '--allow-unsigned', 'true']);
    expect(unsigned.status).toBe(2);
    expect(unsigned.stderr).toContain('refuses unsigned');
    expect(read(dev).signers).toEqual([{ name: 'alice', key: alice.hex }]);

    const empty = mustInit();
    const r = signal(['rotate-signers', '--state', empty, '--verifier', 'file-drop', '--file', file]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no sign-off signers are pinned');
    expect(signal(['rotate-signers', '--state', empty]).stderr).toContain('missing --verifier');
  });

  it('a hand edit of either signer field is denied even when re-signed', () => {
    const s = awaiting([`alice=${alice.hex}`]);
    const swapped = read(s);
    swapped.signers = [{ name: 'carol', key: carol.hex }];
    writeSigned(s, swapped);
    expect(hook(s, 'pre', { tool: 'read_file', input: { path: 'a' }, call_id: 'q' }).stdout).toContain('pinned signers do not match the log');

    const s2 = awaiting([`alice=${alice.hex}`]);
    const genesisEdit = read(s2);
    genesisEdit.initialSigners = [{ name: 'carol', key: carol.hex }];
    genesisEdit.signers = [{ name: 'carol', key: carol.hex }];
    writeSigned(s2, genesisEdit);
    expect(hook(s2, 'pre', { tool: 'read_file', input: { path: 'a' }, call_id: 'q' }).stdout).toContain('log chain broken');
  });

  it('a rotation leaves the decision record untouched, and verify replays the signers entry', () => {
    const s = awaiting([`alice=${alice.hex}`, `bob=${bob.hex}`]);
    const logPath = join(s + '.decisions', 'log.jsonl');
    const headPath = join(s + '.decisions', 'head.json');
    const logBefore = readFileSync(logPath, 'utf-8');
    const headBefore = readFileSync(headPath, 'utf-8');
    const decisions = logBefore.trim().split('\n').length;
    const file = drop(s, {
      signal: 'rotate-signers', outcome: 'rotate',
      signers: [{ name: 'carol', key: carol.hex }],
    }, bob);
    const r = signal(['rotate-signers', '--state', s, '--verifier', 'file-drop', '--file', file]);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(logPath, 'utf-8')).toBe(logBefore);
    expect(readFileSync(headPath, 'utf-8')).toBe(headBefore);
    expect(read(s).log.at(-1)).toMatchObject({ kind: 'signers', by: 'bob' });
    expect(read(s).initialSigners.map((x: { name: string }) => x.name)).toEqual(['alice', 'bob']);
    const v = signal(['verify', '--state', s]);
    expect(v.status, v.stderr).toBe(0);
    expect(JSON.parse(v.stdout)).toMatchObject({ ok: true, decisions, uncommitted: 0 });

    const pinned = read(s).signers;
    const logLen = read(s).log.length;
    const broken = logBefore.replace('"verdict":"allow"', '"verdict":"deny"');
    expect(broken).not.toBe(logBefore);
    writeFileSync(logPath, broken);
    const again = drop(s, {
      signal: 'rotate-signers', outcome: 'rotate',
      signers: [{ name: 'dave', key: dave.hex }],
    }, carol);
    const blocked = signal(['rotate-signers', '--state', s, '--verifier', 'file-drop', '--file', again]);
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('decision record');
    expect(read(s).signers).toEqual(pinned);
    expect(read(s).log).toHaveLength(logLen);

    writeFileSync(logPath, logBefore);
    const st = read(s);
    const last = st.log[st.log.length - 1] as Record<string, unknown>;
    delete last.signers;
    const { hash: _hash, ...body } = last;
    const h = sha(canonical(body));
    st.log[st.log.length - 1] = { ...body, hash: h };
    st.head = h;
    writeSigned(s, st);
    const replay = signal(['verify', '--state', s]);
    expect(replay.status).toBe(2);
    expect(replay.stderr).toContain('signers entry missing set');
  });
});

describe('generated docs name the pin', () => {
  it('AGENTS.md and the agent README tell the operator to pin keys', () => {
    const agents = readFileSync(join(agentDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('init --signer name=pubkey');
    expect(agents).toContain('rotate-signers');
    const readme = readFileSync(join(agentDir, 'README.md'), 'utf-8');
    expect(readme).toContain('--signer carol=./keys/carol.pub');
    expect(readme).toContain('does not add a trust anchor');
  });
});
