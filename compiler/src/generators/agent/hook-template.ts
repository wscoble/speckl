// Emits hook.mjs — runtime-agnostic pre/post tool gate.

import { DENY_REASON_FUNCTIONS } from './deny-reason.js';

export function emitHookMjs(speckName: string): string {
  const denyFns = DENY_REASON_FUNCTIONS.map(fn => fn.toString()).join('\n\n');
  return `#!/usr/bin/env node
/**
 * Speckl agent hook (generic). Generated for ${speckName}.
 *
 *   node hook.mjs pre  --state <file>   # stdin JSON {tool,input,call_id}
 *   node hook.mjs post --state <file>   # stdin JSON {tool,input,call_id,ok}
 *   [--key <file>]  state key (or env SPECKL_STATE_KEY_FILE); keep it unreadable by the agent
 *
 * exit 0 allow · exit 2 deny · exit 1 error (=deny)
 *
 * A denial names why, then the next step: not allowed in this stage, waiting
 * on a sign-off (the signal and the signal.mjs command), a failed
 * precondition, or an internal error (fail closed). The text never includes
 * the state key, the key path (given, resolved, or the symlink target), the
 * key file contents, a signer key, or the state contents. A key path shorter
 * than 8 characters (as given, as resolved, or as realpath of the file or
 * its parent directory) is refused before the hook runs, and exits 2.
 * 64-hex key material is also removed in base64, base64url, and SPKI form.
 * The same redacted sentence is what the decision record stores. Building
 * it cannot change the decision: a throw
 * while building it still denies.
 *
 * The hook never records human answers; signal.mjs does, through a verifier.
 * Keep signal.mjs and any signing key out of the agent's reach: the cli
 * verifier (DEV ONLY, state created with init --dev) trusts whoever runs it,
 * so an agent with shell access could approve its own work.
 *
 * A pending call (pre without post) older than the pending timeout is
 * cleared as failed and the state is not advanced.
 *
 * The state file is tamper-evident: every change is appended to a
 * hash-chained log that is replayed and checked on load, and the whole
 * state is HMAC-signed with a key the agent must not be able to read.
 * Any mismatch, a missing signature or a missing key (non-dev) denies.
 *
 * After the state verifies, each allow and deny is appended to a separate
 * decision record (<state>.decisions/), SHA-256 chained and HMAC-SHA256'd
 * with the same key. That is a keyed record, not a signature a third party
 * can check. A denial does not modify state.json. Calls that fail before
 * the state verifies are denied and not recorded. If the record cannot be
 * written, the call is denied.
 *
 *   node hook.mjs deny --state <file>   # stdin JSON {class,reason,phase,tool,call_id,input}
 *
 * \`deny\` records a refusal the adapter already made (unmapped tool, shell
 * metacharacters, a protected path, a bad payload, or other) and does not
 * run the tool or change state.json. The line is a deny with that \`class\`.
 * Exit 0 means the line was appended. Exit 2 means it was not. The adapter
 * still denies the harness call either way.
 * Whoever can read the state key can append deny lines here. There is no
 * provenance beyond the HMAC. That is the same trust as \`pre\` and \`post\`.
 * A class or reason the hook does not accept is not appended.
 * A busy state lock gives up after 5 seconds. The adapter stops waiting
 * after SPECKL_HOOK_TIMEOUT_MS (default 20 seconds) and says the denial
 * was not recorded.
 *
 * A call-bound sign-off (await \`bind call\`) allows one later call whose
 * digest matches the signed \`call\` hash, and only once that call's post
 * succeeds. Any other call is denied and that denial is recorded. The hash
 * is sha256 of the canonical spec tool name and mapped arguments (see
 * state-integrity.mjs callDigest). The binding itself stays in state.log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyState, append, sign, keyPathFrom, verifyDecisions, appendDecision, digestInput, callDigest, canonical } from './state-integrity.mjs';

${denyFns}

let hookKeyArg = '';
function secretPaths(state) {
  const out = [];
  const addReal = (p) => {
    try {
      const real = fs.realpathSync(p);
      if (typeof real !== 'string' || !real) return;
      out.push(real);
      const parent = path.dirname(real);
      if (parent && parent !== real) out.push(parent);
    } catch { /* realpath failed: add nothing */ }
  };
  const add = (p) => {
    if (typeof p !== 'string' || !p) return;
    out.push(p);
    let abs = '';
    try {
      abs = path.resolve(p);
      if (abs) out.push(abs);
    } catch { /* a bad path must not stop the deny */ }
    addReal(p);
    if (abs && abs !== p) addReal(abs);
  };
  add(hookKeyArg);
  const envKey = process.env.SPECKL_STATE_KEY_FILE;
  add(envKey);
  const files = [];
  if (typeof hookKeyArg === 'string' && hookKeyArg) files.push(hookKeyArg);
  if (typeof envKey === 'string' && envKey) files.push(envKey);
  for (let i = 0; i < files.length; i++) {
    try {
      const text = fs.readFileSync(files[i], 'utf-8');
      if (typeof text === 'string' && text) {
        out.push(text);
        const trimmed = text.trim();
        if (trimmed) out.push(trimmed);
      }
    } catch { /* missing or unreadable key */ }
  }
  const signers = state && state.signers;
  if (Array.isArray(signers)) {
    for (let i = 0; i < signers.length; i++) {
      const entry = signers[i];
      if (entry && typeof entry.key === 'string' && entry.key) out.push(entry.key);
    }
  }
  return out;
}
function keyPathTooShort(p) {
  if (typeof p !== 'string' || !p) return false;
  if (p.length < 8) return true;
  const candidates = [p];
  try {
    const abs = path.resolve(p);
    if (typeof abs === 'string' && abs) {
      if (abs.length < 8) return true;
      if (abs !== p) candidates.push(abs);
    }
  } catch { /* a path that will not resolve is not treated as short */ }
  for (let i = 0; i < candidates.length; i++) {
    try {
      const real = fs.realpathSync(candidates[i]);
      if (typeof real !== 'string' || !real) continue;
      if (real.length < 8) return true;
      const parent = path.dirname(real);
      if (typeof parent === 'string' && parent.length < 8) return true;
    } catch { /* realpath failed: not treated as short */ }
  }
  return false;
}
function finishDeny(exitCode, build) {
  const text = safeDenyText(build);
  if (audit && !audit.sealed) {
    try { seal('deny', text); }
    catch (e) { decisionUnavailable(e, exitCode); }
  }
  respond('deny', text, exitCode);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-config.json'), 'utf-8'));

let lockHeld = null;

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

function releaseLock() {
  if (lockHeld) {
    try { fs.unlinkSync(lockHeld); } catch { /* ignore */ }
    lockHeld = null;
  }
}

function respond(decision, reason, code) {
  const body = reason ? { decision, reason } : { decision };
  process.stdout.write(JSON.stringify(body) + '\\n');
  if (decision === 'deny' && reason) process.stderr.write(reason + '\\n');
  releaseLock();
  process.exit(code);
}

// Set once the state has verified. Absent for usage, stdin, lock and
// integrity failures: those deny, but there is no trustworthy chain to extend.
let audit = null;

function seal(verdict, reason) {
  if (!audit || audit.sealed) return;
  const secrets = secretPaths(audit.state);
  const keep = audit.keep || [];
  const clean = (v) => v == null ? null : redactSecrets(String(v), secrets, keep);
  const fields = {
    phase: audit.phase,
    tool: clean(audit.tool),
    call_id: audit.callId == null || audit.callId === '' ? null : clean(audit.callId),
    action: audit.action,
    verdict,
    reason: verdict === 'deny' ? clean(reason) : reason,
    input_sha256: digestInput(audit.input),
  };
  // Set only for hook.mjs deny. Absent on pre/post, so those lines stay
  // the same shape. A trace object, if one is added later, is a sibling.
  // Clip after redaction so a long tool name cannot keep a cut-off key path.
  if (audit.class) {
    fields.class = audit.class;
    if (typeof fields.tool === 'string' && fields.tool.length > 200) fields.tool = fields.tool.slice(0, 200);
    if (typeof fields.call_id === 'string' && fields.call_id.length > 200) fields.call_id = fields.call_id.slice(0, 200);
  }
  appendDecision(audit.file, audit.key, audit.state, fields);
  audit.sealed = true;
  audit.verdict = verdict;
}

function decisionUnavailable(_e, code) {
  const state = audit && audit.state;
  audit = null;
  // appendDecision throws Node errors whose message is the file it could not
  // write. The sentence stays fixed; the path is not printed.
  const text = safeDenyText(() => renderDenyReason('internal', 'decision record unavailable', internalNext('default'), secretPaths(state)));
  respond('deny', text, code);
}

// Record the allow before state.json is replaced. A record failure denies
// and leaves the spec state untouched. A later save failure is recorded as
// a deny when it can be, and the process still exits non-zero.
function commitAllow(stateFile, state) {
  try { seal('allow', null); }
  catch (e) { decisionUnavailable(e, 2); }
  save(stateFile, state);
  respond('allow', undefined, 0);
}

function parseArgs(argv) {
  const out = { cmd: '', state: '', key: '' };
  out.cmd = argv[2] || '';
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--state') out.state = argv[++i] || '';
    else if (argv[i] === '--key') out.key = argv[++i] || '';
  }
  return out;
}

function lockPath(stateFile) { return stateFile + '.lock'; }

async function acquireLock(stateFile) {
  const lp = lockPath(stateFile);
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lp, 'wx');
      fs.closeSync(fd);
      lockHeld = lp;
      return;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw new Error('state lock could not be taken');
      // Break a lock left behind by a crashed holder (older than 30s).
      try {
        if (Date.now() - fs.statSync(lp).mtimeMs > 30000) { fs.unlinkSync(lp); continue; }
      } catch { /* raced with release; retry */ }
      if (Date.now() - start > 5000) throw new Error('state lock timeout');
      await new Promise(r => setTimeout(r, 10));
    }
  }
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp.' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function loadState(stateFile) {
  let text;
  try { text = fs.readFileSync(stateFile, 'utf-8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') throw new Error('state file missing');
    throw new Error('state file could not be read');
  }
  try { return JSON.parse(text); }
  catch { throw new Error('state file is not JSON'); }
}

function pendingTimeoutMs() {
  const t = config.pendingTimeout && config.pendingTimeout.durationMs;
  return typeof t === 'number' && t > 0 ? t : 600000;
}

/** 'expired' | 'live' | 'unstamped' for state.pending. */
function pendingStatus(pending, now) {
  const since = Date.parse(pending.since || '');
  if (!Number.isFinite(since)) return 'unstamped';
  return now - since >= pendingTimeoutMs() ? 'expired' : 'live';
}

let stateKey = null;
function save(file, state) {
  sign(state, stateKey);
  atomicWrite(file, JSON.stringify(state, null, 2));
}

function clearPendingAsFailed(state, reason) {
  append(state, { kind: 'expire', call_id: state.pending.call_id });
  state.pendingLog = state.pendingLog || [];
  state.pendingLog.push({
    call_id: state.pending.call_id,
    tool: state.pending.tool,
    since: state.pending.since,
    cleared: reason,
    at: new Date().toISOString(),
  });
  state.pending = null;
}

// Guard text in spec terms: "this.stage === 3" becomes "stage == Approved", plus
// where the machine is now, using the agent block's stage labels.
function describeGuard(reason, machine, cfg) {
  const labels = cfg.stages || {};
  const nameOf = {};
  for (const [name, v] of Object.entries(labels)) nameOf[String(v)] = name;
  const sv = cfg.stageVariable;
  let text = reason.replace(/\\bthis\\.(\\w+)\\s*(===|!==)\\s*(-?\\d+)\\b/g, (m, v, op, n) => {
    const eq = op === '===' ? '==' : '!=';
    return v === sv && nameOf[n] !== undefined ? v + ' ' + eq + ' ' + nameOf[n] : v + ' ' + eq + ' ' + n;
  });
  text = text.replace(/\\bthis\\.(\\w+)/g, '$1').replace(/ === /g, ' == ').replace(/ !== /g, ' != ');
  if (sv && machine && machine[sv] !== undefined) {
    const now = machine[sv];
    text += ' (' + sv + ' is ' + (nameOf[String(now)] !== undefined ? nameOf[String(now)] : String(now)) + ')';
  }
  return text;
}

function currentAwait(machine, cfg) {
  const stage = machine[cfg.stageVariable];
  return cfg.awaits.find(a => a.stateValue === stage) || null;
}

/** Digest of the call the hook will judge. input is already coerced (null/missing → {}). */
function describeCall(tool, input) {
  try {
    return { ok: true, digest: callDigest(tool, input), canonical: canonical({ tool, input }) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    const safe = msg === 'call digest needs a tool name' || msg === 'call digest needs an arguments object'
      ? msg : 'call digest could not be computed';
    return { ok: false, reason: safe };
  }
}

async function loadMachine(state) {
  const mod = await import(pathToFileURL(path.join(__dirname, config.machineModule)).href);
  const Machine = mod[config.machineExport];
  if (!Machine) throw new Error('missing export ' + config.machineExport);
  if (!state.machine) return { Machine, machine: new Machine() };
  return { Machine, machine: Machine.restore(state.machine) };
}

async function main() {
  const args = parseArgs(process.argv);
  hookKeyArg = args.key || '';
  if (keyPathTooShort(hookKeyArg) || keyPathTooShort(process.env.SPECKL_STATE_KEY_FILE)) {
    respond('deny', 'Speckl denied (internal error, fail closed): the state key path is shorter than 8 characters, so it cannot be redacted. Next: the call stays denied. Use a longer key path. Do not retry this call.', 2);
  }
  if (args.cmd !== 'pre' && args.cmd !== 'post' && args.cmd !== 'deny') {
    finishDeny(1, () => renderDenyReason('internal', 'usage: hook.mjs pre|post|deny --state <file>', internalNext('usage'), secretPaths()));
  }
  if (!args.state) {
    finishDeny(1, () => renderDenyReason('internal', 'missing --state', internalNext('usage'), secretPaths()));
  }

  let raw;
  try { raw = await readStdin(); }
  catch { finishDeny(1, () => renderDenyReason('internal', 'stdin read failed', internalNext('stdin'), secretPaths())); }
  let msg;
  try { msg = JSON.parse(raw || '{}'); }
  catch { finishDeny(1, () => renderDenyReason('internal', 'stdin is not JSON', internalNext('stdin'), secretPaths())); }

  try {
    await acquireLock(args.state);
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    const known = msg === 'state lock timeout' ? msg : 'state lock could not be taken';
    finishDeny(1, () => renderDenyReason('internal', known, internalNext(known === 'state lock timeout' ? 'lock' : 'default'), secretPaths()));
  }

  try {
    const state = loadState(args.state);
    const { Machine, machine } = await loadMachine(state);
    const v = verifyState(state, { keyPath: keyPathFrom(args.key), Machine, config });
    // A stale spec is reported as such even when the chain no longer matches
    // (genesis covers specHash). Record that denial only when the state and
    // the decision record both verify; otherwise there is nothing trustworthy
    // to append to, and the call is still denied.
    if (!v.ok) {
      if (state.specHash !== config.specHash) {
        finishDeny(2, () => renderDenyReason('internal', 'specHash mismatch: state is stale relative to compiled spec', internalNext('spec-hash'), secretPaths(state)));
      }
      finishDeny(2, () => renderDenyReason('internal', 'state integrity: ' + v.reason, internalNext('integrity'), secretPaths(state)));
    }
    for (const w of v.warnings) process.stderr.write('WARN: ' + w + '\\n');
    stateKey = v.key;
    const decisions = verifyDecisions(args.state, stateKey, state, { full: false });
    if (!decisions.ok) {
      if (state.specHash !== config.specHash) {
        finishDeny(2, () => renderDenyReason('internal', 'specHash mismatch: state is stale relative to compiled spec', internalNext('spec-hash'), secretPaths(state)));
      }
      finishDeny(2, () => renderDenyReason('internal', 'decision record: ' + decisions.reason, internalNext('default'), secretPaths(state)));
    }
    const runId = typeof state.runId === 'string' ? state.runId : '';
    audit = {
      file: args.state,
      key: stateKey,
      state,
      phase: args.cmd,
      tool: typeof msg.tool === 'string' ? msg.tool : (msg.tool == null ? null : String(msg.tool)),
      callId: msg.call_id === undefined || msg.call_id === null || msg.call_id === '' ? null : msg.call_id,
      action: null,
      input: msg.input === undefined ? null : msg.input,
      keep: [],
      sealed: false,
      verdict: null,
      class: null,
    };
    // Adapter-stage denial. The adapter already refused the call. Record
    // that refusal and exit 0. Do not run the tool, and do not touch state.json.
    // A missing class or reason is not appended; the adapter still denies.
    // This runs before the specHash check on purpose. deny never allows a
    // call. A stale compiled spec must not drop a refusal when the state
    // chain itself still verifies. The class is the adapter's literal, not
    // something read out of the tool name.
    // Anyone who can read the state key can call deny and append lines.
    // Those lines have no provenance beyond the HMAC, the same as pre/post.
    if (args.cmd === 'deny') {
      const cls = typeof msg.class === 'string' ? msg.class : '';
      const known = cls === 'unmapped' || cls === 'metachar' || cls === 'protected-path' || cls === 'bad-payload' || cls === 'other';
      const given = typeof msg.reason === 'string' ? msg.reason : '';
      if (!known || !given) {
        respond('deny', 'Speckl denied (internal error, fail closed): adapter denial was not recorded. Next: the call stays denied. Do not retry it.', 2);
      }
      audit.class = cls;
      audit.phase = msg.phase === 'post' ? 'post' : 'pre';
      // A non-string tool name must not become "[object Object]".
      audit.tool = typeof msg.tool === 'string' ? msg.tool : null;
      audit.callId = typeof msg.call_id === 'string' && msg.call_id !== '' ? msg.call_id : null;
      // Distinct from a real null input, whose digest is sha256("null").
      if (msg.input_withheld === 'size') audit.input = '<input too large>';
      else if (msg.input_withheld === 'depth') audit.input = '<input too deep>';
      else if (msg.input_withheld === 'wide') audit.input = '<input too wide>';
      finishDeny(0, () => given);
    }
    if (state.specHash !== config.specHash) {
      finishDeny(2, () => renderDenyReason('internal', 'specHash mismatch: state is stale relative to compiled spec', internalNext('spec-hash'), secretPaths(state)));
    }
    const toolByName = new Map(config.tools.map(t => [t.name, t]));

    if (args.cmd === 'pre') {
      const tool = msg.tool;
      const input = msg.input || {};
      audit.input = input;
      const callId = msg.call_id;
      if (!tool || callId === undefined || callId === null || callId === '') {
        finishDeny(2, () => renderDenyReason('internal', 'pre: tool and call_id are required', internalNext('stdin'), secretPaths(state)));
      }
      const binding = toolByName.get(tool);
      if (!binding) finishDeny(2, () => renderDenyReason('internal', 'unknown tool: ' + tool, internalNext('unknown-tool'), secretPaths(state)));
      audit.action = binding.action;
      if (state.pending) {
        const st = pendingStatus(state.pending, Date.now());
        if (st === 'expired') {
          // The earlier call never posted (crash/hang): clear it as failed
          // without advancing, persist that, then judge this call fresh.
          clearPendingAsFailed(state, 'timeout');
          save(args.state, state);
        } else {
          const dur = config.pendingTimeout ? config.pendingTimeout.durationText : '10m';
          const pendingText = safeDenyText(() => renderDenyReason('precondition',
            'another tool call is already pending (' + state.pending.call_id + '); it clears as failed after '
              + dur + ' or via signal.mjs clear-pending',
            pendingNext(state.pending.call_id, dur,
              applyCommand(path.join(__dirname, 'signal.mjs'), args.state, 'clear-pending', state.signers),
              runId, signerNote(state.signers)),
            secretPaths(state)));
          if (st === 'unstamped') {
            // Pending from an older state file: start its clock now. The
            // denial is sealed first, so a record failure does not write state.
            state.pending.since = new Date().toISOString();
            try { seal('deny', pendingText); }
            catch (e) { decisionUnavailable(e, 2); }
            save(args.state, state);
            respond('deny', pendingText, 2);
          }
          finishDeny(2, () => pendingText);
        }
      }

      const waiting = currentAwait(machine, config);
      // mode in refuses every tool (HITL). mode near refuses act tools only (HNTL).
      // A trailing space keeps a call digest a single token, ahead of ". Next:".
      if (waiting && (waiting.mode === 'in' || binding.effect === 'act')) {
        const bound = (waiting.bindCall || []).length > 0;
        const described = bound ? describeCall(tool, input) : null;
        const suffix = !bound ? ''
          : (described.ok
            ? '; call-bound sign-off: sign call ' + described.digest + ' canonical ' + described.canonical + ' '
            : '; call-bound sign-off refused: ' + described.reason + ' ');
        const detail = (waiting.mode === 'in'
          ? 'HITL: no tools while awaiting signal ' + waiting.signal
          : 'HNTL: act tool refused while awaiting signal ' + waiting.signal) + suffix;
        const keep = described && described.ok ? [described.digest] : [];
        audit.keep = keep;
        finishDeny(2, () => renderDenyReason('signoff', detail, signoffNext(
          waiting.mode, waiting.signal, waiting.outcomes, waiting.claims,
          applyCommand(path.join(__dirname, 'signal.mjs'), args.state, 'apply', state.signers),
          runId, signerNote(state.signers),
        ), secretPaths(state), keep));
      }

      // Outstanding call-bound sign-off: only the matching call may proceed.
      // A mismatch is denied and the approval is kept. It is consumed on post ok.
      if (state.boundCall != null) {
        if (typeof state.boundCall.hash !== 'string') {
          finishDeny(2, () => renderDenyReason('internal', 'call-bound sign-off is malformed', internalNext('default'), secretPaths(state)));
        }
        const d = describeCall(tool, input);
        if (!d.ok) {
          finishDeny(2, () => renderDenyReason('internal', 'call-bound sign-off refused: ' + d.reason, internalNext('default'), secretPaths(state)));
        }
        if (d.digest !== state.boundCall.hash) {
          audit.keep = [state.boundCall.hash, d.digest];
          finishDeny(2, () => renderDenyReason('precondition',
            'call-bound sign-off does not cover this call (denied): want ' + state.boundCall.hash
              + ' got ' + d.digest + ' canonical ' + d.canonical,
            'run the call that was signed. This call stays denied. Do not edit the state file to change the binding.',
            secretPaths(state), audit.keep));
        }
      }

      const can = machine.can(binding.action, input);
      if (can !== true) {
        finishDeny(2, () => {
          const described = describeGuard(String(can), machine, config);
          const kind = classifyCanRefusal(described, config.stageVariable || '');
          const next = kind === 'stage'
            ? stageNext(stageNameOf(machine[config.stageVariable], config.stages))
            : kind === 'precondition' ? preconditionNext() : internalNext('default');
          return renderDenyReason(kind, 'can() refused: ' + described, next, secretPaths(state));
        });
      }

      append(state, { kind: 'pre', call_id: callId, tool, action: binding.action, input });
      state.pending = { call_id: callId, tool, action: binding.action, input, since: new Date().toISOString() };
      state.machine = machine.serialize();
      commitAllow(args.state, state);
    }

    // post
    const tool = msg.tool;
    const callId = msg.call_id;
    const ok = msg.ok === true;
    if (!tool || callId === undefined || callId === null || callId === '') {
      finishDeny(2, () => renderDenyReason('internal', 'post: tool and call_id are required', internalNext('stdin'), secretPaths(state)));
    }
    const postBinding = toolByName.get(tool);
    if (postBinding) audit.action = postBinding.action;
    if (!state.pending || state.pending.call_id !== callId) {
      finishDeny(2, () => renderDenyReason('internal', 'post: no matching pending call_id', internalNext('post-mismatch'), secretPaths(state)));
    }
    if (state.pending.tool !== tool) {
      finishDeny(2, () => renderDenyReason('internal', 'post: tool does not match pending', internalNext('post-mismatch'), secretPaths(state)));
    }
    if (pendingStatus(state.pending, Date.now()) === 'expired') {
      clearPendingAsFailed(state, 'timeout');
      const expiredText = safeDenyText(() => renderDenyReason('internal', 'post: pending call expired; cleared as failed (state not advanced)', internalNext('post-expired'), secretPaths(state)));
      try { seal('deny', expiredText); }
      catch (e) { decisionUnavailable(e, 2); }
      save(args.state, state);
      respond('deny', expiredText, 2);
    }

    if (!ok) {
      append(state, { kind: 'post', call_id: callId, ok: false });
      state.pending = null;
      state.machine = machine.serialize();
      commitAllow(args.state, state);
      return;
    }

    if (!postBinding) finishDeny(2, () => renderDenyReason('internal', 'unknown tool: ' + tool, internalNext('unknown-tool'), secretPaths(state)));
    if (state.boundCall != null) {
      if (typeof state.boundCall.hash !== 'string') {
        finishDeny(2, () => renderDenyReason('internal', 'call-bound sign-off is malformed', internalNext('default'), secretPaths(state)));
      }
      // Only the matching call consumes the approval. A different pending
      // call was allowed before the sign-off (observe, while waiting) and
      // must be able to finish; the binding stays for the approved call.
      // The allow or deny of this post is sealed by commitAllow / deny.
      let digest = null;
      try { digest = callDigest(state.pending.tool, state.pending.input); } catch { digest = null; }
      if (digest === state.boundCall.hash) state.boundCall = null;
    }
    const params = (machine.constructor.ACTIONS || {})[postBinding.action] || [];
    const argsList = params.map(p => (state.pending.input || {})[p]);
    machine[postBinding.action](...argsList);
    append(state, { kind: 'post', call_id: callId, ok: true });
    state.pending = null;
    const waitingAfter = currentAwait(machine, config);
    state.awaitingSince = waitingAfter ? (state.awaitingSince || new Date().toISOString()) : null;
    state.machine = machine.serialize();
    commitAllow(args.state, state);
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    let code = 'default';
    let detail = 'hook failed closed';
    if (msg === 'state file missing') { code = 'missing-state'; detail = msg; }
    else if (msg === 'state file is not JSON' || msg === 'state file could not be read') detail = msg;
    else if (msg === 'state lock timeout' || msg === 'state lock could not be taken') { code = 'lock'; detail = msg; }
    if (audit && audit.sealed && audit.verdict === 'allow') detail = 'state save failed';
    const text = safeDenyText(() => renderDenyReason('internal', detail, internalNext(code), secretPaths(audit && audit.state)));
    if (audit && audit.sealed && audit.verdict === 'allow') {
      try {
        audit.sealed = false;
        seal('deny', text);
      } catch { /* the call is still denied below */ }
    } else if (audit && !audit.sealed) {
      try { seal('deny', text); }
      catch (e2) { decisionUnavailable(e2, 1); }
    }
    respond('deny', text, 1);
  }
}

main();
`;
}
