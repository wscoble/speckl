/**
 * Sigstore signal verifier: a Speckl verifier plug-in.
 *
 * The approver keyless-signs the signal drop (the same JSON body the
 * file-drop verifier reads) with Sigstore, for example:
 *
 *   cosign sign-blob drop.json --bundle drop.json.sigstore.json
 *
 * and the operator applies it:
 *
 *   node signal.mjs apply --state state.json --verifier plugin:sigstore \
 *     --file drop.json [--bundle drop.json.sigstore.json]
 *
 * Checks, all through @sigstore/verify (no crypto is done here):
 *   - the bundle signature covers the exact bytes of the drop file;
 *   - the signing certificate chains to a Fulcio CA in the trusted root, and
 *     carries the configured number of SCTs from a CT log in the trusted root;
 *   - the bundle carries a Rekor entry whose signed entry timestamp or
 *     inclusion proof verifies against a Rekor key in the trusted root, and
 *     that entry matches this signature and certificate;
 *   - the certificate's OIDC issuer and identity (SAN) match the policy that
 *     was pinned in the signed state at init for the awaited signal. The drop
 *     and the command line can't supply or widen the identity.
 * Then the same bindings as file-drop: signal, run id, expiry, single-use
 * nonce, and an outcome in the awaited signal's outcomes.
 *
 * Config (pinned in the state by `signal.mjs init --plugins <file>`):
 *   {
 *     "trustedRoot": "/etc/speckl/sigstore/trusted_root.json",  // offline root
 *     "trustedRootSha256": "<hex sha256 of that file>",          // required with trustedRoot
 *     // or, instead of trustedRoot: the public-good root over TUF (network):
 *     "tuf": { "cachePath": "/var/lib/speckl/tuf", "mirrorURL": "...", "rootPath": "...", "forceCache": false },
 *     "tlogThreshold": 1,      // >= 1, default 1
 *     "ctlogThreshold": 1,     // >= 0, default 1
 *     "signals": {
 *       "review": { "issuer": "https://github.com/login/oauth", "identity": "carol@example.com" },
 *       "clear-pending": { "issuer": "...", "identityRegExp": "^https://github\\.com/acme/ops/\\.github/workflows/approve\\.yml@refs/heads/main$" }
 *     }
 *   }
 * `identity` is compared exactly. `identityRegExp` is used only when given and
 * must be anchored with ^ and $.
 *
 * Evidence: "sigstore:<sha256 of bundle bytes>:rekor:<log index>:<entry uuid>".
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify';

export const name = 'sigstore';

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IDENTITY_KEYS = ['identity', 'issuer', 'identity-regexp', 'certificate-identity', 'certificate-oidc-issuer', 'trusted-root'];

/** Validate the pinned config. Returns { ok: true } or { ok: false, reason }. */
export function checkConfig(config) {
  if (!isObj(config)) return { ok: false, reason: 'sigstore config must be an object' };
  const hasRoot = config.trustedRoot !== undefined;
  const hasTuf = config.tuf !== undefined;
  if (hasRoot === hasTuf) return { ok: false, reason: 'sigstore config needs exactly one of trustedRoot (offline file) or tuf (public-good root)' };
  if (hasRoot) {
    if (typeof config.trustedRoot !== 'string' || !config.trustedRoot) return { ok: false, reason: 'trustedRoot must be a file path' };
    if (typeof config.trustedRootSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(config.trustedRootSha256)) {
      return { ok: false, reason: 'trustedRootSha256 (64 lowercase hex chars) is required with trustedRoot' };
    }
  } else {
    if (!isObj(config.tuf) || typeof config.tuf.cachePath !== 'string' || !config.tuf.cachePath) {
      return { ok: false, reason: 'tuf.cachePath is required (a directory the agent cannot write)' };
    }
    for (const k of ['mirrorURL', 'rootPath']) {
      if (config.tuf[k] !== undefined && typeof config.tuf[k] !== 'string') return { ok: false, reason: 'tuf.' + k + ' must be a string' };
    }
  }
  if (config.tlogThreshold !== undefined && !(Number.isInteger(config.tlogThreshold) && config.tlogThreshold >= 1)) {
    return { ok: false, reason: 'tlogThreshold must be an integer >= 1 (a Rekor entry is required)' };
  }
  if (config.ctlogThreshold !== undefined && !(Number.isInteger(config.ctlogThreshold) && config.ctlogThreshold >= 0)) {
    return { ok: false, reason: 'ctlogThreshold must be an integer >= 0' };
  }
  if (!isObj(config.signals) || Object.keys(config.signals).length === 0) {
    return { ok: false, reason: 'sigstore config needs signals: { <signal>: { issuer, identity | identityRegExp } }' };
  }
  for (const [sig, p] of Object.entries(config.signals)) {
    const r = checkPolicy(p);
    if (r) return { ok: false, reason: 'signals.' + sig + ': ' + r };
  }
  return { ok: true };
}

function checkPolicy(p) {
  if (!isObj(p)) return 'policy must be an object';
  if (typeof p.issuer !== 'string' || !p.issuer) return 'issuer (OIDC issuer URL) is required';
  const hasId = p.identity !== undefined;
  const hasRe = p.identityRegExp !== undefined;
  if (hasId === hasRe) return 'exactly one of identity (exact) or identityRegExp is required';
  if (hasId && (typeof p.identity !== 'string' || !p.identity)) return 'identity must be a non-empty string';
  if (hasRe) {
    if (typeof p.identityRegExp !== 'string' || !p.identityRegExp.startsWith('^') || !p.identityRegExp.endsWith('$')) {
      return 'identityRegExp must be a string anchored with ^ and $';
    }
    try { new RegExp(p.identityRegExp); } catch (e) { return 'identityRegExp is not a valid regular expression: ' + e.message; }
  }
  return null;
}

/**
 * Refuse a trusted root with an authority whose validity has no start.
 * @sigstore/verify 3.x treats a missing start as unbounded; the Sigstore
 * conformance suite (trust-root-tlog-missing-validity-start_fail) requires a
 * rejection.
 */
function checkValidity(json) {
  const groups = [
    ['certificateAuthorities', a => a.validFor],
    ['timestampAuthorities', a => a.validFor],
    ['tlogs', a => a.publicKey && a.publicKey.validFor],
    ['ctlogs', a => a.publicKey && a.publicKey.validFor],
  ];
  for (const [key, validFor] of groups) {
    for (const [i, a] of (json[key] || []).entries()) {
      const v = validFor(a);
      if (!v || !Number.isFinite(Date.parse(v.start))) throw new Error('malformed trusted root: ' + key + '[' + i + '] has no validFor.start');
    }
  }
}

async function loadTrustedRoot(config) {
  let json;
  if (config.trustedRoot !== undefined) {
    if (!fs.existsSync(config.trustedRoot)) throw new Error('trusted root not found: ' + config.trustedRoot);
    const buf = fs.readFileSync(config.trustedRoot);
    if (sha256(buf) !== config.trustedRootSha256) throw new Error('trusted root sha256 mismatch: ' + config.trustedRoot);
    json = JSON.parse(buf.toString('utf-8'));
  } else {
    // Public-good root over TUF. Loaded only when configured, so offline use
    // never touches the network.
    const { getTrustedRoot } = await import('@sigstore/tuf');
    json = TrustedRoot.toJSON(await getTrustedRoot({
      cachePath: config.tuf.cachePath,
      mirrorURL: config.tuf.mirrorURL,
      rootPath: config.tuf.rootPath,
      forceCache: config.tuf.forceCache === true,
    }));
  }
  if (!isObj(json)) throw new Error('malformed trusted root: not a JSON object');
  checkValidity(json);
  return TrustedRoot.fromJSON(json);
}

/** Rekor entry UUID = RFC 6962 leaf hash of the canonicalized entry body. */
function entryUuid(tlogEntry) {
  return sha256(Buffer.concat([Buffer.from([0]), Buffer.from(tlogEntry.canonicalizedBody)]));
}

export async function verify(opts, expect, ctx = {}) {
  try {
    return await verifyInner(opts || {}, expect || {}, ctx);
  } catch (e) {
    // Library errors, bad JSON, unreadable files: never an approval.
    return { ok: false, reason: 'sigstore verification failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

async function verifyInner(opts, expect, ctx) {
  const config = ctx.config;
  const cfg = checkConfig(config);
  if (!cfg.ok) return { ok: false, reason: 'sigstore config: ' + cfg.reason };
  for (const k of IDENTITY_KEYS) {
    if (opts[k] !== undefined) return { ok: false, reason: '--' + k + ' is not accepted: identity policy and trust root are pinned in the state at init' };
  }
  const policy = config.signals[expect.signal];
  if (!policy) return { ok: false, reason: 'no identity policy pinned for signal ' + expect.signal };

  const file = opts.file;
  if (typeof file !== 'string' || !file) return { ok: false, reason: 'sigstore verifier requires --file' };
  if (!fs.existsSync(file)) return { ok: false, reason: 'file not found: ' + file };
  const bundlePath = typeof opts.bundle === 'string' ? opts.bundle : file + '.sigstore.json';
  if (!fs.existsSync(bundlePath)) return { ok: false, reason: 'bundle not found: ' + bundlePath };
  const body = fs.readFileSync(file);
  const bundleBytes = fs.readFileSync(bundlePath);

  let bundle;
  try {
    bundle = bundleFromJSON(JSON.parse(bundleBytes.toString('utf-8')));
  } catch (e) {
    return { ok: false, reason: 'invalid Sigstore bundle: ' + e.message };
  }
  if (bundle.content.$case !== 'messageSignature') {
    return { ok: false, reason: 'bundle must be a message signature over the drop file (cosign sign-blob), not ' + bundle.content.$case };
  }
  const tlogEntries = bundle.verificationMaterial.tlogEntries || [];
  if (tlogEntries.length === 0) return { ok: false, reason: 'bundle has no Rekor transparency-log entry' };

  const root = await loadTrustedRoot(config);
  const verifier = new Verifier(toTrustMaterial(root), {
    tlogThreshold: config.tlogThreshold ?? 1,
    ctlogThreshold: config.ctlogThreshold ?? 1,
  });
  // @sigstore/verify treats the SAN policy as an unanchored regular
  // expression, so an exact identity is escaped and anchored here and then
  // compared again as a plain string.
  const sanPattern = policy.identity !== undefined ? '^' + escapeRe(policy.identity) + '$' : policy.identityRegExp;
  const signer = verifier.verify(toSignedEntity(bundle, body), {
    subjectAlternativeName: sanPattern,
    extensions: { issuer: policy.issuer },
  });
  const san = signer.identity && signer.identity.subjectAlternativeName;
  const issuer = signer.identity && signer.identity.extensions && signer.identity.extensions.issuer;
  if (typeof san !== 'string' || (policy.identity !== undefined ? san !== policy.identity : !new RegExp(policy.identityRegExp).test(san))) {
    return { ok: false, reason: 'certificate identity mismatch: ' + san };
  }
  if (issuer !== policy.issuer) return { ok: false, reason: 'certificate issuer mismatch: ' + issuer };

  let payload;
  try {
    payload = JSON.parse(body.toString('utf-8'));
  } catch {
    return { ok: false, reason: 'file is not JSON' };
  }
  if (!isObj(payload)) return { ok: false, reason: 'payload must be a JSON object' };
  const signal = payload.signal;
  if (typeof signal !== 'string' || !signal) return { ok: false, reason: 'payload missing signal' };
  if (signal !== expect.signal) return { ok: false, reason: 'wrong signal: expected ' + expect.signal + ' got ' + signal };
  if (typeof payload.run !== 'string' || !payload.run) return { ok: false, reason: 'payload missing run (run id from signal.mjs init)' };
  if (!ctx.runId) return { ok: false, reason: 'state has no run id; re-create it with signal.mjs init' };
  if (payload.run !== ctx.runId) return { ok: false, reason: 'run mismatch: drop is for run ' + payload.run };
  if (typeof payload.expires !== 'string' || !payload.expires) return { ok: false, reason: 'payload missing expires' };
  const exp = Date.parse(payload.expires);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'payload expires is not a valid ISO-8601 time' };
  const now = typeof ctx.now === 'number' ? ctx.now : Date.now();
  if (now >= exp) return { ok: false, reason: 'expired at ' + payload.expires };
  const nonce = payload.nonce;
  if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 200) {
    return { ok: false, reason: 'payload nonce must be a string of 8-200 chars' };
  }
  if ((ctx.usedNonces || []).includes(nonce)) return { ok: false, reason: 'nonce already used: ' + nonce };
  const outcome = payload.outcome;
  if (typeof outcome !== 'string' || !outcome) return { ok: false, reason: 'payload missing outcome' };
  if (!(expect.outcomes || []).includes(outcome)) return { ok: false, reason: 'disallowed outcome: ' + outcome };
  const claims = isObj(payload.claims) ? payload.claims : {};

  const entry = tlogEntries[0];
  const rekor = {
    logIndex: String(entry.logIndex),
    logId: Buffer.from(entry.logId.keyId).toString('hex'),
    entryUuid: entryUuid(entry),
    integratedTime: new Date(Number(entry.integratedTime) * 1000).toISOString(),
  };
  return {
    ok: true,
    signal: {
      signal,
      outcome,
      claims,
      verifier: 'sigstore',
      // Who signed comes from the verified certificate, never from the drop.
      subject: san,
      issuer,
      at: rekor.integratedTime,
      evidence: 'sigstore:' + sha256(bundleBytes) + ':rekor:' + rekor.logIndex + ':' + rekor.entryUuid,
      rekor,
      run: payload.run,
      expires: payload.expires,
      nonce,
      callId: typeof payload.call_id === 'string' ? payload.call_id : undefined,
    },
  };
}
