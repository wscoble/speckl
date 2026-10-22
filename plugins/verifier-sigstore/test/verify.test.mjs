// Unit tests for the Sigstore verifier plug-in. Every bundle is produced by
// the real @sigstore/sign client against an in-process mock Fulcio CA, CT log
// and Rekor log (test/support/sigstore-env.mjs); nothing touches the network.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verify, checkConfig } from '../index.mjs';
import { createEnv, writeRoot } from './support/sigstore-env.mjs';

const ISS = 'https://issuer.speckl.test';
const WHO = 'carol@example.com';
const RUN = 'a'.repeat(32);
const expectReview = { signal: 'review', outcomes: ['approve', 'reject'], claims: [{ name: 'reviewer' }] };

let env;
let other; // a second, untrusted Sigstore instance
let dir;
let root;
beforeAll(async () => {
  env = await createEnv();
  other = await createEnv({ fulcio: 'https://fulcio.other.test', rekor: 'https://rekor.other.test' });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speckl-sigstore-'));
  root = writeRoot(dir, env.trustedRoot);
});
afterAll(() => { env.close(); other.close(); });

const config = (over = {}) => ({
  trustedRoot: root.path,
  trustedRootSha256: root.sha256,
  signals: { review: { issuer: ISS, identity: WHO } },
  ...over,
});
const ctx = (over = {}) => ({ runId: RUN, dev: false, now: Date.now(), usedNonces: [], config: config(), ...over });
let n = 0;
/** Write a drop + bundle; returns the drop path. */
async function drop(over = {}, signOpts = {}, signer = env) {
  const body = Buffer.from(JSON.stringify({
    signal: 'review', outcome: 'approve', claims: { reviewer: 'carol' }, run: RUN,
    expires: new Date(Date.now() + 3600_000).toISOString(), nonce: crypto.randomUUID(), ...over,
  }));
  const file = path.join(dir, `drop-${n++}.json`);
  fs.writeFileSync(file, body);
  fs.writeFileSync(file + '.sigstore.json', JSON.stringify(await signer.sign(body, { iss: ISS, sub: WHO, ...signOpts })));
  return file;
}
const editBundle = (file, fn) => {
  const b = JSON.parse(fs.readFileSync(file + '.sigstore.json', 'utf-8'));
  fn(b);
  fs.writeFileSync(file + '.sigstore.json', JSON.stringify(b));
};

describe('a valid keyless signature', () => {
  it('passes, with identity from the certificate and Rekor evidence', async () => {
    const file = await drop({ subject: 'mallory' });
    const r = await verify({ file }, expectReview, ctx());
    expect(r.ok, r.reason).toBe(true);
    const bundleSha = crypto.createHash('sha256').update(fs.readFileSync(file + '.sigstore.json')).digest('hex');
    expect(r.signal).toMatchObject({ signal: 'review', outcome: 'approve', claims: { reviewer: 'carol' }, subject: WHO, issuer: ISS, verifier: 'sigstore', run: RUN });
    expect(r.signal.evidence).toBe(`sigstore:${bundleSha}:rekor:${r.signal.rekor.logIndex}:${r.signal.rekor.entryUuid}`);
    expect(r.signal.rekor.entryUuid).toMatch(/^[0-9a-f]{64}$/);
    expect(r.signal.rekor.logId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts --bundle at another path and an anchored identityRegExp when configured', async () => {
    const file = await drop();
    const moved = path.join(dir, 'moved.sigstore.json');
    fs.renameSync(file + '.sigstore.json', moved);
    const c = config({ signals: { review: { issuer: ISS, identityRegExp: '^[a-z]+@example\\.com$' } } });
    const r = await verify({ file, bundle: moved }, expectReview, ctx({ config: c }));
    expect(r.ok, r.reason).toBe(true);
  });

  it('denies a certificate whose SCT comes from a CT log the root does not list', async () => {
    const noCt = writeRoot(fs.mkdtempSync(path.join(dir, 'noct-')), { ...env.trustedRoot, ctlogs: [] });
    const r = await verify({ file: await drop() }, expectReview, ctx({ config: config({ trustedRoot: noCt.path, trustedRootSha256: noCt.sha256 }) }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('SCT verification failed');
  });
});

describe('the signature and the trust chain', () => {
  it('denies a payload changed after signing', async () => {
    const file = await drop();
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('approve', 'reject'));
    const r = await verify({ file }, expectReview, ctx());
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('signature verification failed') });
  });

  it('denies a certificate from a CA that is not in the trusted root', async () => {
    const file = await drop({}, {}, other);
    const r = await verify({ file }, expectReview, ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('sigstore verification failed');
  });

  it('denies a bundle with no Rekor entry', async () => {
    const unlogged = await drop({}, { tlog: false });
    expect(await verify({ file: unlogged }, expectReview, ctx())).toEqual({ ok: false, reason: 'bundle has no Rekor transparency-log entry' });
  });

  it('denies a Rekor entry the trusted root does not vouch for, or one that was altered', async () => {
    const file = await drop();
    const noTlog = writeRoot(fs.mkdtempSync(path.join(dir, 'notlog-')), { ...env.trustedRoot, tlogs: [] });
    const r = await verify({ file }, expectReview, ctx({ config: config({ trustedRoot: noTlog.path, trustedRootSha256: noTlog.sha256 }) }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('sigstore verification failed');
    const forged = await drop();
    editBundle(forged, b => { b.verificationMaterial.tlogEntries[0].integratedTime = String(Number(b.verificationMaterial.tlogEntries[0].integratedTime) + 1); });
    const f = await verify({ file: forged }, expectReview, ctx());
    expect(f.ok).toBe(false);
    expect(f.reason).toContain('sigstore verification failed');
  });

  it('denies a missing, unparsable or DSSE bundle', async () => {
    const file = await drop();
    expect((await verify({ file, bundle: path.join(dir, 'none.json') }, expectReview, ctx())).reason).toContain('bundle not found');
    fs.writeFileSync(file + '.sigstore.json', '{');
    expect((await verify({ file }, expectReview, ctx())).reason).toContain('invalid Sigstore bundle');
    fs.writeFileSync(file + '.sigstore.json', JSON.stringify({ mediaType: 'nope' }));
    expect((await verify({ file }, expectReview, ctx())).reason).toContain('invalid Sigstore bundle');
    const dsse = await drop();
    editBundle(dsse, b => {
      const sig = b.messageSignature.signature;
      delete b.messageSignature;
      b.dsseEnvelope = { payload: 'e30=', payloadType: 'application/json', signatures: [{ sig, keyid: '' }] };
    });
    expect((await verify({ file: dsse }, expectReview, ctx())).reason).toContain('not dsseEnvelope');
  });

  it('denies when the offline trusted root is missing, changed or junk (library throw)', async () => {
    const file = await drop();
    const gone = await verify({ file }, expectReview, ctx({ config: config({ trustedRoot: path.join(dir, 'no-root.json') }) }));
    expect(gone.reason).toContain('trusted root not found');
    const wrongPin = await verify({ file }, expectReview, ctx({ config: config({ trustedRootSha256: '0'.repeat(64) }) }));
    expect(wrongPin.reason).toContain('trusted root sha256 mismatch');
    const junk = writeRoot(fs.mkdtempSync(path.join(dir, 'junk-')), { certificateAuthorities: [{ certChain: { certificates: [{ rawBytes: 'AAAA' }] }, validFor: { start: '2020-01-01T00:00:00Z' } }] });
    const thrown = await verify({ file }, expectReview, ctx({ config: config({ trustedRoot: junk.path, trustedRootSha256: junk.sha256 }) }));
    expect(thrown.ok).toBe(false);
    expect(thrown.reason).toMatch(/^sigstore verification failed: /);
    expect(thrown.reason).not.toContain('malformed trusted root');
    const notObj = writeRoot(fs.mkdtempSync(path.join(dir, 'arr-')), [1]);
    expect((await verify({ file }, expectReview, ctx({ config: config({ trustedRoot: notObj.path, trustedRootSha256: notObj.sha256 }) }))).reason)
      .toContain('malformed trusted root: not a JSON object');
    const noStart = writeRoot(fs.mkdtempSync(path.join(dir, 'nostart-')), { ...env.trustedRoot, ctlogs: env.trustedRoot.ctlogs.map(c => ({ ...c, publicKey: { ...c.publicKey, validFor: {} } })) });
    expect((await verify({ file }, expectReview, ctx({ config: config({ trustedRoot: noStart.path, trustedRootSha256: noStart.sha256 }) }))).reason)
      .toContain('malformed trusted root: ctlogs[0] has no validFor.start');
  });

  it('denies when the public-good root cannot be fetched over TUF (no network in tests)', async () => {
    const file = await drop();
    const c = { tuf: { cachePath: fs.mkdtempSync(path.join(dir, 'tuf-')), mirrorURL: 'https://tuf.speckl.test' }, signals: config().signals };
    const r = await verify({ file }, expectReview, ctx({ config: c }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^sigstore verification failed: /);
  });
});

describe('the identity policy', () => {
  it('denies another identity, including one that only contains the expected one', async () => {
    const r = await verify({ file: await drop({}, { sub: 'mallory@example.com' }) }, expectReview, ctx());
    expect(r.reason).toContain('certificate identity error');
    // @sigstore/verify matches the SAN as an unanchored regex; the plug-in anchors it.
    const sneaky = await verify({ file: await drop({}, { sub: 'xcarol@example.com' }) }, expectReview, ctx());
    expect(sneaky.ok).toBe(false);
    const dot = await verify({ file: await drop({}, { sub: 'carol@exampleXcom' }) }, expectReview, ctx());
    expect(dot.ok).toBe(false);
  });

  it('denies another OIDC issuer', async () => {
    const r = await verify({ file: await drop({}, { iss: 'https://evil.speckl.test' }) }, expectReview, ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('issuer');
  });

  it('denies a signal with no pinned policy, and identity flags on the command line', async () => {
    const file = await drop({ signal: 'clear-pending', outcome: 'clear' });
    expect((await verify({ file }, { signal: 'clear-pending', outcomes: ['clear'], claims: [] }, ctx())).reason)
      .toBe('no identity policy pinned for signal clear-pending');
    for (const k of ['identity', 'issuer', 'certificate-identity', 'trusted-root']) {
      expect((await verify({ file, [k]: 'x' }, expectReview, ctx())).reason).toContain('pinned in the state at init');
    }
  });
});

describe('the same bindings as file-drop', () => {
  const cases = [
    ['wrong run', { run: 'b'.repeat(32) }, 'run mismatch'],
    ['missing run', { run: undefined }, 'payload missing run'],
    ['expired', { expires: new Date(Date.now() - 1000).toISOString() }, 'expired at'],
    ['bad expiry', { expires: 'tomorrow' }, 'not a valid ISO-8601'],
    ['missing expiry', { expires: undefined }, 'payload missing expires'],
    ['short nonce', { nonce: 'abc' }, 'nonce must be'],
    ['outcome not allowed', { outcome: 'merge' }, 'disallowed outcome: merge'],
    ['missing outcome', { outcome: undefined }, 'payload missing outcome'],
    ['wrong signal', { signal: 'deploy' }, 'wrong signal'],
    ['missing signal', { signal: undefined }, 'payload missing signal'],
  ];
  for (const [label, over, msg] of cases) {
    it(`denies: ${label}`, async () => {
      const r = await verify({ file: await drop(over) }, expectReview, ctx());
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(msg);
    });
  }

  it('denies a reused nonce, a state with no run id, and a non-object payload', async () => {
    const file = await drop({ nonce: 'used-nonce-1' });
    expect((await verify({ file }, expectReview, ctx({ usedNonces: ['used-nonce-1'] }))).reason).toBe('nonce already used: used-nonce-1');
    expect((await verify({ file }, expectReview, ctx({ runId: undefined }))).reason).toContain('state has no run id');
    const arr = path.join(dir, 'arr.json');
    fs.writeFileSync(arr, '[1]');
    fs.writeFileSync(arr + '.sigstore.json', JSON.stringify(await env.sign(Buffer.from('[1]'), { iss: ISS, sub: WHO })));
    expect((await verify({ file: arr }, expectReview, ctx())).reason).toBe('payload must be a JSON object');
    const txt = path.join(dir, 'txt.json');
    fs.writeFileSync(txt, 'not json');
    fs.writeFileSync(txt + '.sigstore.json', JSON.stringify(await env.sign(Buffer.from('not json'), { iss: ISS, sub: WHO })));
    expect((await verify({ file: txt }, expectReview, ctx())).reason).toBe('file is not JSON');
  });

  it('denies a missing --file or drop', async () => {
    expect((await verify({}, expectReview, ctx())).reason).toContain('requires --file');
    expect((await verify({ file: path.join(dir, 'nope.json') }, expectReview, ctx())).reason).toContain('file not found');
  });
});

describe('checkConfig', () => {
  const ok = { trustedRoot: '/r.json', trustedRootSha256: 'a'.repeat(64), signals: { review: { issuer: ISS, identity: WHO } } };
  const bad = [
    [null, 'must be an object'],
    [{ signals: ok.signals }, 'exactly one of trustedRoot'],
    [{ ...ok, tuf: { cachePath: '/c' } }, 'exactly one of trustedRoot'],
    [{ ...ok, trustedRoot: '' }, 'trustedRoot must be a file path'],
    [{ ...ok, trustedRootSha256: undefined }, 'trustedRootSha256'],
    [{ tuf: {}, signals: ok.signals }, 'tuf.cachePath is required'],
    [{ tuf: { cachePath: '/c', mirrorURL: 1 }, signals: ok.signals }, 'tuf.mirrorURL must be a string'],
    [{ ...ok, tlogThreshold: 0 }, 'tlogThreshold'],
    [{ ...ok, ctlogThreshold: -1 }, 'ctlogThreshold'],
    [{ ...ok, signals: {} }, 'needs signals'],
    [{ ...ok, signals: { review: 'x' } }, 'policy must be an object'],
    [{ ...ok, signals: { review: { identity: WHO } } }, 'issuer (OIDC issuer URL) is required'],
    [{ ...ok, signals: { review: { issuer: ISS } } }, 'exactly one of identity'],
    [{ ...ok, signals: { review: { issuer: ISS, identity: WHO, identityRegExp: '^a$' } } }, 'exactly one of identity'],
    [{ ...ok, signals: { review: { issuer: ISS, identity: '' } } }, 'identity must be a non-empty string'],
    [{ ...ok, signals: { review: { issuer: ISS, identityRegExp: '.*@example\\.com' } } }, 'anchored with ^ and $'],
    [{ ...ok, signals: { review: { issuer: ISS, identityRegExp: '^(unclosed$' } } }, 'not a valid regular expression'],
  ];
  it('accepts a complete config', () => {
    expect(checkConfig(ok)).toEqual({ ok: true });
    expect(checkConfig({ tuf: { cachePath: '/c' }, tlogThreshold: 2, ctlogThreshold: 0, signals: ok.signals })).toEqual({ ok: true });
  });
  for (const [c, msg] of bad) {
    it(`rejects: ${msg}`, () => {
      const r = checkConfig(c);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(msg);
    });
  }
  it('verify re-checks the config it is handed', async () => {
    expect((await verify({ file: 'x' }, expectReview, ctx({ config: undefined }))).reason).toContain('sigstore config: ');
  });
});
