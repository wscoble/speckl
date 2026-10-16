// Reference signal verifiers shipped with the agent target.
//
// Verifier interface (plug-ins implement the same):
//   export async function verify(opts, expect, ctx) -> { ok: true, signal } | { ok: false, reason }
//   opts   = verifier CLI options (--key value)
//   expect = { signal, outcomes, claims } the caller is waiting for
//   ctx    = { runId, dev, now, usedNonces } from the state file
// signal = { signal, outcome, claims, verifier, subject, at, evidence,
//            run?, expires?, nonce?, callId? }

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

  const at = new Date(typeof ctx.now === 'number' ? ctx.now : Date.now()).toISOString();
  const evidence = 'cli:' + subject + ':' + outcome + ':' + at + ':' + crypto.randomBytes(8).toString('hex');
  return {
    ok: true,
    signal: {
      signal: expect.signal,
      outcome,
      claims,
      verifier: 'cli-DEV',
      subject,
      at,
      evidence,
      callId: typeof opts.call_id === 'string' ? opts.call_id : undefined,
    },
  };
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
 *     "call_id": "..." }              // clear-pending only
 * Detached signature over the raw file bytes at <file>.sig
 * (64-byte raw, hex, or base64).
 *
 * Options:
 *   --file <path>             required
 *   --pubkey <path>           required unless --allow-unsigned true
 *   --sig <path>              optional (default <file>.sig)
 *   --allow-unsigned true     DEV ONLY; also needs a state created with init --dev
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

  if (!allowUnsigned) {
    const pubkeyPath = opts.pubkey;
    if (!pubkeyPath || typeof pubkeyPath !== 'string') {
      return { ok: false, reason: 'file-drop requires --pubkey (unsigned drops are DEV ONLY: --allow-unsigned true with a state created by init --dev)' };
    }
    if (!fs.existsSync(pubkeyPath)) {
      return { ok: false, reason: 'pubkey not found: ' + pubkeyPath };
    }
    const sigPath = typeof opts.sig === 'string' ? opts.sig : (file + '.sig');
    if (!fs.existsSync(sigPath)) {
      return { ok: false, reason: 'signature file not found: ' + sigPath };
    }
    let pub;
    let sig;
    try {
      pub = decodeKey(fs.readFileSync(pubkeyPath));
      sig = decodeSig(fs.readFileSync(sigPath));
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    let ok = false;
    try {
      ok = crypto.verify(null, body, ed25519PublicKey(pub), sig);
    } catch (e) {
      return { ok: false, reason: 'signature verify error: ' + e.message };
    }
    if (!ok) return { ok: false, reason: 'bad signature' };
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

  const outcomes = (expect && expect.outcomes) || [];
  const outcome = payload.outcome !== undefined ? payload.outcome
    : (outcomes.length === 1 ? outcomes[0] : undefined);
  if (!outcome || typeof outcome !== 'string') return { ok: false, reason: 'payload missing outcome' };
  const claims = (payload.claims && typeof payload.claims === 'object') ? payload.claims : {};
  const subject = payload.subject || path.basename(file);
  const at = payload.at || new Date(now).toISOString();

  const evidence = 'file:' + crypto.createHash('sha256').update(body).digest('hex');
  return {
    ok: true,
    signal: {
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
    },
  };
}
`;
}
