// Reference signal verifiers shipped with the agent target.
//
// Verifier interface (plug-ins implement the same):
//   export async function verify(opts, expect, ctx) -> { ok: true, signal } | { ok: false, reason }
//   opts   = verifier CLI options (--key value)
//   expect = { signal, outcomes, claims, bindCall? } the caller is waiting for.
//            bindCall lists outcomes that must return signal.call.
//   ctx    = { runId, dev, now, usedNonces, signers? } from the state file.
//            signers is absent on a legacy state and an array (possibly
//            empty) when the run recorded a pinned sign-off set.
// signal = { signal, outcome, claims, verifier, subject, at, evidence,
//            run?, expires?, nonce?, callId?, call?, signer?, signers? }
// call is the sha256 hex of canonical({tool, input}) for a call-bound
// sign-off. signal.mjs requires it on those outcomes and refuses it on
// every other outcome (including clear-pending). A bad shape denies.
// file-drop sets signer from the pinned key that verified. A call hash is
// not a trust anchor: the signature is still checked against ctx.signers.

export function emitCliVerifier(): string {
  return `/**
 * CLI signal verifier — DEV ONLY.
 *
 * Trusts whoever runs it: evidence is a local user name + timestamp. Any
 * process that can run a shell command can use it, so an agent with shell
 * access could approve its own work. signal.mjs refuses it unless the state
 * file was created with \`signal.mjs init --dev\`; this verifier also refuses
 * on its own when ctx.dev is not true. Production must use a signed verifier.
 *
 * Options: --outcome <name> --as <subject> [--reviewer <id>] [--claim key=value]
 *          [--claim_<key> <value>] [--call_id <id>]   (clear-pending)
 *          [--call <64-hex>]  (call-bound sign-off; sha256 of the canonical call)
 */
import os from 'node:os';
import crypto from 'node:crypto';

export const devOnly = true;

export async function verify(opts, expect, ctx = {}) {
  if (ctx.dev !== true) {
    return { ok: false, reason: 'cli verifier is DEV ONLY (state was not created with init --dev); use a signed verifier' };
  }
  const outcomes = (expect && expect.outcomes) || [];
  const outcome = typeof opts.outcome === 'string' ? opts.outcome
    : (outcomes.length === 1 ? outcomes[0] : undefined);
  if (!outcome) {
    return { ok: false, reason: 'cli verifier requires --outcome' };
  }
  const subject = (typeof opts.as === 'string' ? opts.as : (os.userInfo().username || 'local'));
  const claims = {};
  if (typeof opts.claim === 'string') {
    const eq = opts.claim.indexOf('=');
    if (eq > 0) claims[opts.claim.slice(0, eq)] = opts.claim.slice(eq + 1);
  }
  for (const [k, v] of Object.entries(opts)) {
    if (k.startsWith('claim_') && typeof v === 'string') {
      claims[k.slice('claim_'.length)] = v;
    }
  }
  if (typeof opts.reviewer === 'string') claims.reviewer = opts.reviewer;

  if (opts.call !== undefined && (typeof opts.call !== 'string' || !/^[0-9a-fA-F]{64}$/.test(opts.call))) {
    return { ok: false, reason: 'cli verifier --call must be a 64-char sha256 hex digest' };
  }
  const at = new Date(typeof ctx.now === 'number' ? ctx.now : Date.now()).toISOString();
  const evidence = 'cli:' + subject + ':' + outcome + ':' + at + ':' + crypto.randomBytes(8).toString('hex');
  const signal = {
    signal: expect.signal,
    outcome,
    claims,
    verifier: 'cli-DEV',
    subject,
    at,
    evidence,
    callId: typeof opts.call_id === 'string' ? opts.call_id : undefined,
  };
  if (typeof opts.call === 'string') signal.call = opts.call.toLowerCase();
  return { ok: true, signal };
}
`;
}

export function emitFileDropVerifier(): string {
  return `/**
 * File-drop signal verifier (ed25519).
 *
 * JSON body (all of signal/run/expires/nonce are required):
 *   { "signal": "...", "outcome": "...", "claims": {...}, "subject": "...",
 *     "at": "ISO-8601",
 *     "run": "<run id printed by signal.mjs init>",
 *     "expires": "ISO-8601",          // refused at or after this instant
 *     "nonce": "<unique, 8-200 chars>", // single use per state file
 *     "call_id": "...",               // clear-pending only
 *     "call": "<64 hex>" }            // call-bound sign-off only: sha256 of the canonical call
 * Detached signature over the raw file bytes at <file>.sig
 * (64-byte raw, hex, or base64).
 *
 * Options:
 *   --file <path>             required
 *   --pubkey <path>           which key to check. On a run with pinned signers
 *                             it must be one of those keys (it is not a new
 *                             trust anchor). On a legacy state (no signers
 *                             field) it is still the per-call trust anchor.
 *   --signer <name>           check this pinned signer only
 *   --sig <path>              optional (default <file>.sig)
 *   --allow-unsigned true     DEV ONLY; also needs a state created with init --dev
 *
 * With pinned signers and neither --pubkey nor --signer, every pinned key is
 * tried. An empty pinned set refuses every signature. A signature that only
 * verifies under a key that is not pinned is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function decodeKey(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  if (buf.length === 32) return buf;
  const text = buf.toString('utf-8').trim().replace(/-----[^-]+-----/g, '').replace(/\\s+/g, '');
  if (/^[0-9a-fA-F]+$/.test(text) && text.length === 64) return Buffer.from(text, 'hex');
  const b64 = Buffer.from(text, 'base64');
  if (b64.length === 32) return b64;
  throw new Error('pubkey must be 32-byte ed25519 key (raw, hex, or base64)');
}

function decodeSig(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  if (buf.length === 64) return buf;
  const text = buf.toString('utf-8').trim().replace(/\\s+/g, '');
  if (/^[0-9a-fA-F]+$/.test(text) && text.length === 128) return Buffer.from(text, 'hex');
  const b64 = Buffer.from(text, 'base64');
  if (b64.length === 64) return b64;
  throw new Error('signature must be 64-byte ed25519 (raw, hex, or base64)');
}

function ed25519PublicKey(raw32) {
  // SPKI DER prefix for ed25519 public keys
  return crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw32]),
    format: 'der',
    type: 'spki',
  });
}

export async function verify(opts, expect, ctx = {}) {
  const file = opts.file;
  if (!file || typeof file !== 'string') {
    return { ok: false, reason: 'file-drop verifier requires --file' };
  }
  if (!fs.existsSync(file)) {
    return { ok: false, reason: 'file not found: ' + file };
  }
  const body = fs.readFileSync(file);
  const allowUnsigned = opts['allow-unsigned'] === true || opts['allow-unsigned'] === 'true';

  let payload;
  try {
    payload = JSON.parse(body.toString('utf-8'));
  } catch {
    return { ok: false, reason: 'file is not JSON' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload must be a JSON object' };
  }

  let signerName;
  if (!allowUnsigned) {
    const pinned = ctx.signers;
    const legacy = pinned === undefined;
    if (!legacy && !Array.isArray(pinned)) {
      return { ok: false, reason: 'pinned signer set is malformed' };
    }
    if (!legacy) {
      for (const s of pinned) {
        if (!s || typeof s.name !== 'string' || typeof s.key !== 'string' || !/^[0-9a-f]{64}$/.test(s.key)) {
          return { ok: false, reason: 'pinned signer set is malformed' };
        }
      }
      if (pinned.length === 0) {
        return { ok: false, reason: 'no sign-off signers pinned for this run' };
      }
    }
    const signerOpt = opts.signer;
    if (Array.isArray(signerOpt)) return { ok: false, reason: 'pass one --signer' };
    if (signerOpt !== undefined && typeof signerOpt !== 'string') return { ok: false, reason: 'bad --signer' };

    // Keys the signature may verify under. A presented --pubkey never adds one.
    let keys;
    if (!legacy) {
      if (typeof opts.pubkey === 'string' && opts.pubkey) {
        if (!fs.existsSync(opts.pubkey)) return { ok: false, reason: 'pubkey not found: ' + opts.pubkey };
        let presented;
        try { presented = decodeKey(fs.readFileSync(opts.pubkey)); }
        catch (e) { return { ok: false, reason: e.message }; }
        const match = pinned.find(s => s.key === presented.toString('hex'));
        if (!match) return { ok: false, reason: 'pubkey is not a pinned sign-off signer' };
        if (typeof signerOpt === 'string' && signerOpt !== match.name) {
          return { ok: false, reason: 'signer name does not match --pubkey' };
        }
        keys = [{ name: match.name, raw: presented }];
      } else if (opts.pubkey !== undefined && typeof opts.pubkey !== 'string') {
        return { ok: false, reason: 'file-drop --pubkey must be a path' };
      } else if (typeof signerOpt === 'string') {
        const match = pinned.find(s => s.name === signerOpt);
        if (!match) return { ok: false, reason: 'unknown pinned signer: ' + signerOpt };
        keys = [{ name: match.name, raw: Buffer.from(match.key, 'hex') }];
      } else {
        keys = pinned.map(s => ({ name: s.name, raw: Buffer.from(s.key, 'hex') }));
      }
    } else {
      const pubkeyPath = opts.pubkey;
      if (!pubkeyPath || typeof pubkeyPath !== 'string') {
        return { ok: false, reason: 'file-drop requires --pubkey (unsigned drops are DEV ONLY: --allow-unsigned true with a state created by init --dev)' };
      }
      if (!fs.existsSync(pubkeyPath)) return { ok: false, reason: 'pubkey not found: ' + pubkeyPath };
      try { keys = [{ name: undefined, raw: decodeKey(fs.readFileSync(pubkeyPath)) }]; }
      catch (e) { return { ok: false, reason: e.message }; }
    }

    const sigPath = typeof opts.sig === 'string' ? opts.sig : (file + '.sig');
    if (!fs.existsSync(sigPath)) return { ok: false, reason: 'signature file not found: ' + sigPath };
    let sig;
    try { sig = decodeSig(fs.readFileSync(sigPath)); }
    catch (e) { return { ok: false, reason: e.message }; }
    let matched = null;
    for (const k of keys) {
      let ok = false;
      try { ok = crypto.verify(null, body, ed25519PublicKey(k.raw), sig); }
      catch (e) { return { ok: false, reason: 'signature verify error: ' + e.message }; }
      if (ok) { matched = k; break; }
    }
    if (!matched) return { ok: false, reason: 'bad signature' };
    signerName = matched.name;
  } else {
    if (ctx.dev !== true) {
      return { ok: false, reason: 'unsigned drops are DEV ONLY (state was not created with init --dev)' };
    }
    process.stderr.write('WARN: file-drop accepting UNSIGNED drop (--allow-unsigned); DEV ONLY\\n');
  }

  // The signed body must name its signal; never default it from the await,
  // or one signed drop could answer any signal.
  const signal = payload.signal;
  if (!signal || typeof signal !== 'string') return { ok: false, reason: 'payload missing signal' };

  // Bind the drop to this run, an expiry, and a single-use nonce so an
  // approval cannot be carried to another run or replayed.
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

  let call;
  if (payload.call !== undefined) {
    if (typeof payload.call !== 'string' || !/^[0-9a-fA-F]{64}$/.test(payload.call)) {
      return { ok: false, reason: 'payload call must be a 64-char sha256 hex digest' };
    }
    call = payload.call.toLowerCase();
  }

  const outcomes = (expect && expect.outcomes) || [];
  const outcome = payload.outcome !== undefined ? payload.outcome
    : (outcomes.length === 1 ? outcomes[0] : undefined);
  if (!outcome || typeof outcome !== 'string') return { ok: false, reason: 'payload missing outcome' };
  const claims = (payload.claims && typeof payload.claims === 'object') ? payload.claims : {};
  const subject = payload.subject || path.basename(file);
  const at = payload.at || new Date(now).toISOString();

  const evidence = 'file:' + crypto.createHash('sha256').update(body).digest('hex');
  const verified = {
    signal,
    outcome,
    claims,
    verifier: allowUnsigned ? 'file-drop-unsigned-DEV' : 'file-drop',
    subject,
    at,
    evidence,
    run: payload.run,
    expires: payload.expires,
    nonce,
    callId: typeof payload.call_id === 'string' ? payload.call_id : undefined,
    signer: signerName,
    signers: payload.signal === 'rotate-signers' ? payload.signers : undefined,
  };
  if (call !== undefined) verified.call = call;
  return { ok: true, signal: verified };
}
`;
}
