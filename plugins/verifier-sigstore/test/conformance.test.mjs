// Real Sigstore bundles from the Sigstore conformance suite (see
// fixtures/README.md), verified offline through the plug-in: public-good
// bundles against a pinned snapshot of the public-good trusted root, the rest
// against their own trusted_root.json. Includes Rekor v2 entries (checkpoint +
// RFC 3161 timestamp, no SET).
//
// The artifact is the conformance a.txt, not a Speckl drop, so a bundle that
// passes every Sigstore check stops at the first payload check ("file is not
// JSON"). That reason is the marker that signature, certificate chain, SCTs,
// transparency log, timestamps and identity policy all verified.
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify } from '../index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(here, 'fixtures', 'sigstore-conformance');
const publicGood = path.join(here, 'fixtures', 'public-good-trusted_root.json');
const BEACON = 'https://github.com/sigstore-conformance/extremely-dangerous-public-oidc-beacon/.github/workflows/extremely-dangerous-oidc-beacon.yml@refs/heads/main';
const GHA = 'https://token.actions.githubusercontent.com';
const PASSED_SIGSTORE = 'file is not JSON';
const expectAny = { signal: 'review', outcomes: ['approve'], claims: [] };
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const opt = (dir, f, dflt) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf-8').trim() : dflt);

function caseOf(name, policy = {}) {
  const dir = path.join(base, name);
  const root = fs.existsSync(path.join(dir, 'trusted_root.json')) ? path.join(dir, 'trusted_root.json') : publicGood;
  return {
    opts: {
      file: fs.existsSync(path.join(dir, 'artifact')) ? path.join(dir, 'artifact') : path.join(base, 'a.txt'),
      bundle: path.join(dir, 'bundle.sigstore.json'),
    },
    ctx: {
      runId: 'r'.repeat(32), dev: false, now: Date.now(), usedNonces: [],
      config: {
        trustedRoot: root,
        trustedRootSha256: sha(root),
        signals: { review: { issuer: opt(dir, 'issuer', GHA), identity: opt(dir, 'identity', BEACON), ...policy } },
      },
    },
  };
}

const names = fs.readdirSync(base).filter(d => fs.statSync(path.join(base, d)).isDirectory()).sort();

describe('Sigstore conformance bundles', () => {
  it('has the expected fixture set', () => {
    expect(names.filter(n => !n.endsWith('_fail')).length).toBe(7);
    expect(names.filter(n => n.endsWith('_fail')).length).toBe(16);
  });

  for (const name of names) {
    const fails = name.endsWith('_fail');
    it(`${fails ? 'denies' : 'verifies'} ${name}`, async () => {
      const { opts, ctx } = caseOf(name);
      const r = await verify(opts, expectAny, ctx);
      expect(r.ok).toBe(false); // a.txt is never a valid drop
      if (fails) expect(r.reason).not.toBe(PASSED_SIGSTORE);
      else expect(r.reason).toBe(PASSED_SIGSTORE);
    });
  }

  it('a real public-good bundle is denied for any other identity or issuer', async () => {
    for (const policy of [
      { identity: BEACON.replace('refs/heads/main', 'refs/heads/dev') },
      { identity: BEACON.slice(0, -5) }, // a prefix of the real identity
      { identity: undefined, identityRegExp: '^https://github\\.com/other/.*$' },
      { issuer: 'https://accounts.google.com' },
    ]) {
      const { opts, ctx } = caseOf('happy-path-v0.3', policy);
      const r = await verify(opts, expectAny, ctx);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^sigstore verification failed: /);
    }
  });

  it('an anchored identityRegExp for the beacon workflow verifies', async () => {
    const { opts, ctx } = caseOf('rekor2-happy-path', {
      identity: undefined,
      identityRegExp: '^https://github\\.com/sigstore-conformance/extremely-dangerous-public-oidc-beacon/\\.github/workflows/[a-z-]+\\.yml@refs/heads/main$',
    });
    expect((await verify(opts, expectAny, ctx)).reason).toBe(PASSED_SIGSTORE);
  });
});
