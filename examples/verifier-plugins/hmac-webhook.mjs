/**
 * Example Speckl verifier plug-in: an HMAC-SHA256 signed webhook.
 *
 * An approvals service POSTs the signal body (the same JSON a file drop
 * carries: signal, outcome, claims, run, expires, nonce) with a header
 * `X-Speckl-Signature: sha256=<hex HMAC of the raw body>`. The operator's
 * receiver writes the raw body to <file> and the header value to <file>.sig,
 * then runs:
 *
 *   node signal.mjs apply --state state.json --verifier plugin:hmac-webhook --file body.json
 *
 * Config (pinned at init):
 *   { "secretFile": "/etc/speckl/webhook.secret",   // 32+ bytes, hex; agent must not read it
 *     "sender": "approvals.example.com" }           // recorded as the subject
 *
 * A shared secret proves the body came from someone holding the secret, not
 * which person approved. The subject is therefore the configured sender, never
 * a name taken from the body.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const name = 'hmac-webhook';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function checkConfig(config) {
  if (!isObj(config) || typeof config.secretFile !== 'string' || !config.secretFile) return { ok: false, reason: 'secretFile is required' };
  if (typeof config.sender !== 'string' || !config.sender) return { ok: false, reason: 'sender is required' };
  return { ok: true };
}

function readSecret(file) {
  const text = fs.readFileSync(file, 'utf-8').trim();
  if (!/^[0-9a-fA-F]{64,}$/.test(text)) throw new Error('secret must be at least 32 bytes as hex');
  return Buffer.from(text, 'hex');
}

export async function verify(opts, expect, ctx) {
  const cfg = checkConfig(ctx.config);
  if (!cfg.ok) return { ok: false, reason: 'hmac-webhook config: ' + cfg.reason };
  if (typeof opts.file !== 'string' || !fs.existsSync(opts.file)) return { ok: false, reason: 'hmac-webhook requires --file <body>' };
  const sigPath = opts.file + '.sig';
  if (!fs.existsSync(sigPath)) return { ok: false, reason: 'signature not found: ' + sigPath };
  const body = fs.readFileSync(opts.file);
  const header = fs.readFileSync(sigPath, 'utf-8').trim();
  const m = /^sha256=([0-9a-f]{64})$/.exec(header);
  if (!m) return { ok: false, reason: 'signature must be sha256=<64 hex chars>' };

  let secret;
  try { secret = readSecret(ctx.config.secretFile); } catch (e) { return { ok: false, reason: 'secret: ' + e.message }; }
  const want = crypto.createHmac('sha256', secret).update(body).digest();
  if (!crypto.timingSafeEqual(want, Buffer.from(m[1], 'hex'))) return { ok: false, reason: 'bad signature' };

  let p;
  try { p = JSON.parse(body.toString('utf-8')); } catch { return { ok: false, reason: 'body is not JSON' }; }
  if (!isObj(p)) return { ok: false, reason: 'body must be a JSON object' };
  if (p.signal !== expect.signal) return { ok: false, reason: 'wrong signal: ' + p.signal };
  if (p.run !== ctx.runId || !ctx.runId) return { ok: false, reason: 'run mismatch' };
  const exp = Date.parse(p.expires);
  if (!Number.isFinite(exp) || ctx.now >= exp) return { ok: false, reason: 'expired or missing expires' };
  if (typeof p.nonce !== 'string' || p.nonce.length < 8 || p.nonce.length > 200) return { ok: false, reason: 'nonce must be 8-200 chars' };
  if (ctx.usedNonces.includes(p.nonce)) return { ok: false, reason: 'nonce already used' };
  if (!expect.outcomes.includes(p.outcome)) return { ok: false, reason: 'disallowed outcome: ' + p.outcome };

  return {
    ok: true,
    signal: {
      signal: p.signal,
      outcome: p.outcome,
      claims: isObj(p.claims) ? p.claims : {},
      subject: ctx.config.sender,
      at: new Date(ctx.now).toISOString(),
      evidence: 'hmac-webhook:' + crypto.createHash('sha256').update(body).digest('hex'),
      run: p.run,
      expires: p.expires,
      nonce: p.nonce,
      callId: typeof p.call_id === 'string' ? p.call_id : undefined,
    },
  };
}
