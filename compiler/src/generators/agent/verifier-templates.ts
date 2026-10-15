// Reference signal verifiers shipped with the agent target.

export function emitCliVerifier(): string {
  return `/**
 * CLI signal verifier (low-assurance).
 * Evidence = local user + timestamp. Suitable for demos / local gates,
 * not high-assurance production.
 *
 * Options: --outcome <name> --as <subject> [--reviewer <id>] [--claim key=value]
 */
import os from 'node:os';
import crypto from 'node:crypto';

export async function verify(opts, expect) {
  const outcome = opts.outcome;
  if (!outcome || typeof outcome !== 'string') {
    return { ok: false, reason: 'cli verifier requires --outcome' };
  }
  const subject = (opts.as || os.userInfo().username || 'local').toString();
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

  const at = new Date().toISOString();
  const evidence = 'cli:' + subject + ':' + outcome + ':' + at + ':' + crypto.randomBytes(8).toString('hex');
  return {
    ok: true,
    signal: {
      signal: expect.signal,
      outcome,
      claims,
      verifier: 'cli',
      subject,
      at,
      evidence,
    },
  };
}
`;
}

export function emitFileDropVerifier(): string {
  return `/**
 * File-drop signal verifier (ed25519).
 *
 * JSON body:
 *   { "signal": "...", "outcome": "...", "claims": {...}, "subject": "...", "at": "ISO-8601" }
 * Detached signature over the raw file bytes at <file>.sig
 * (64-byte raw, hex, or base64).
 *
 * Options:
 *   --file <path>             required
 *   --pubkey <path>           required unless --allow-unsigned true
 *   --sig <path>              optional (default <file>.sig)
 *   --allow-unsigned true     DEV ONLY; default off
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

export async function verify(opts, expect) {
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

  if (!allowUnsigned) {
    const pubkeyPath = opts.pubkey;
    if (!pubkeyPath || typeof pubkeyPath !== 'string') {
      return { ok: false, reason: 'file-drop requires --pubkey (unsigned drops are off by default; pass --allow-unsigned true only for local DEV)' };
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
    process.stderr.write('WARN: file-drop accepting UNSIGNED drop (--allow-unsigned); DEV ONLY\\n');
  }

  const signal = payload.signal || expect.signal;
  const outcome = payload.outcome;
  const claims = payload.claims || {};
  const subject = payload.subject || path.basename(file);
  const at = payload.at || new Date().toISOString();
  if (!outcome) return { ok: false, reason: 'payload missing outcome' };

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
    },
  };
}
`;
}
