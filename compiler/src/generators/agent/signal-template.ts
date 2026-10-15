// Emits signal.mjs — init state + apply verified signals.

export function emitSignalMjs(speckName: string): string {
  return `#!/usr/bin/env node
/**
 * Speckl signal tooling for ${speckName}.
 *
 *   node signal.mjs init  --state <file>
 *   node signal.mjs apply --state <file> --verifier cli|file-drop [verifier args...]
 *   node signal.mjs timeout --state <file>   # fire timeout → reject-class only
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-config.json'), 'utf-8'));

let lockHeld = null;

function releaseLock() {
  if (lockHeld) {
    try { fs.unlinkSync(lockHeld); } catch { /* ignore */ }
    lockHeld = null;
  }
}

function fail(msg, code = 1) {
  const err = new Error(msg);
  err.exitCode = code;
  throw err;
}

function parseArgs(argv) {
  const out = { cmd: argv[2] || '', state: '', verifier: '', rest: {} };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') out.state = argv[++i] || '';
    else if (a === '--verifier') out.verifier = argv[++i] || '';
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      out.rest[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return out;
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp.' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function lockPath(s) { return s + '.lock'; }

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
      if (e && e.code !== 'EEXIST') throw e;
      // Break a lock left behind by a crashed holder (older than 30s).
      try {
        if (Date.now() - fs.statSync(lp).mtimeMs > 30000) { fs.unlinkSync(lp); continue; }
      } catch { /* raced with release; retry */ }
      if (Date.now() - start > 5000) throw new Error('state lock timeout');
      await new Promise(r => setTimeout(r, 10));
    }
  }
}

async function loadMachine(state) {
  const mod = await import(pathToFileURL(path.join(__dirname, config.machineModule)).href);
  const Machine = mod[config.machineExport];
  if (!state.machine) return { Machine, machine: new Machine() };
  return { Machine, machine: Machine.restore(state.machine) };
}

function currentAwait(machine) {
  const stage = machine[config.stageVariable];
  return config.awaits.find(a => a.stateValue === stage) || null;
}

async function cmdInit(stateFile) {
  if (fs.existsSync(stateFile)) fail('state already exists: ' + stateFile);
  const mod = await import(pathToFileURL(path.join(__dirname, config.machineModule)).href);
  const Machine = mod[config.machineExport];
  const machine = new Machine();
  const state = {
    specHash: config.specHash,
    speck: config.speck,
    machine: machine.serialize(),
    pending: null,
    appliedEvidence: [],
    signalLog: [],
    awaitingSince: null,
  };
  if (currentAwait(machine)) state.awaitingSince = new Date().toISOString();
  atomicWrite(stateFile, JSON.stringify(state, null, 2));
  process.stdout.write(JSON.stringify({ ok: true, state: stateFile }) + '\\n');
}

async function loadVerifier(kind) {
  if (kind === 'cli') {
    return (await import(pathToFileURL(path.join(__dirname, 'verifiers', 'cli.mjs')).href));
  }
  if (kind === 'file-drop') {
    return (await import(pathToFileURL(path.join(__dirname, 'verifiers', 'file-drop.mjs')).href));
  }
  fail('unknown verifier: ' + kind + ' (shipped: cli, file-drop; others are plug-ins)');
}

async function cmdApply(args) {
  if (!args.state) fail('missing --state');
  if (!args.verifier) fail('missing --verifier');

  await acquireLock(args.state);
  try {
    const state = JSON.parse(fs.readFileSync(args.state, 'utf-8'));
    if (state.specHash !== config.specHash) fail('specHash mismatch', 2);
    const { machine } = await loadMachine(state);
    const waiting = currentAwait(machine);
    if (!waiting) fail('machine is not in an await state', 2);

    const ver = await loadVerifier(args.verifier);
    const result = await ver.verify(args.rest, waiting);
    if (result.ok === false) fail('verifier rejected: ' + result.reason, 2);

    const vs = result.signal;
    if (vs.signal !== waiting.signal) fail('wrong signal: expected ' + waiting.signal + ' got ' + vs.signal, 2);
    if (!waiting.outcomes.includes(vs.outcome)) fail('disallowed outcome: ' + vs.outcome, 2);
    for (const c of waiting.claims) {
      if (vs.claims[c.name] === undefined || vs.claims[c.name] === null || vs.claims[c.name] === '') {
        fail('missing claim: ' + c.name, 2);
      }
    }
    if (state.appliedEvidence.includes(vs.evidence)) {
      fail('replay: evidence already applied: ' + vs.evidence, 2);
    }

    const on = waiting.on.find(o => o.outcome === vs.outcome);
    if (!on) fail('no on-transition for outcome ' + vs.outcome, 2);

    const can = machine.can(on.action, {});
    if (can !== true) fail('synthetic transition refused: ' + can, 2);
    machine[on.action]();

    state.appliedEvidence.push(vs.evidence);
    state.signalLog.push({ ...vs, at: vs.at || new Date().toISOString() });
    state.awaitingSince = null;
    // Leave state.pending alone: an in-flight observe tool (HNTL) still owns it.
    state.machine = machine.serialize();
    atomicWrite(args.state, JSON.stringify(state, null, 2));
    process.stdout.write(JSON.stringify({ ok: true, outcome: vs.outcome, evidence: vs.evidence }) + '\\n');
  } finally {
    releaseLock();
  }
}

async function cmdTimeout(args) {
  if (!args.state) fail('missing --state');
  await acquireLock(args.state);
  try {
    const state = JSON.parse(fs.readFileSync(args.state, 'utf-8'));
    if (state.specHash !== config.specHash) fail('specHash mismatch', 2);
    const { machine } = await loadMachine(state);
    const waiting = currentAwait(machine);
    if (!waiting) fail('machine is not in an await state', 2);
    if (!waiting.timeout) fail('no timeout configured for this await', 2);

    const outcome = waiting.timeout.outcome;
    if (!/reject/i.test(outcome)) {
      fail('timeout may only resolve to a reject-class outcome', 2);
    }
    const since = Date.parse(state.awaitingSince || '');
    if (!Number.isFinite(since)) {
      // No recorded start (e.g. the machine began in the await state): start
      // the clock now instead of firing immediately.
      state.awaitingSince = new Date().toISOString();
      atomicWrite(args.state, JSON.stringify(state, null, 2));
      fail('timeout clock started now; not yet elapsed', 2);
    }
    const elapsed = Date.now() - since;
    if (elapsed < waiting.timeout.durationMs) {
      fail('timeout not yet elapsed (' + elapsed + 'ms < ' + waiting.timeout.durationMs + 'ms)', 2);
    }

    const on = waiting.on.find(o => o.outcome === outcome);
    if (!on) fail('no on-transition for timeout outcome ' + outcome, 2);
    const evidence = 'timeout:' + waiting.signal + ':' + state.awaitingSince;
    if (state.appliedEvidence.includes(evidence)) fail('replay', 2);

    machine[on.action]();
    state.appliedEvidence.push(evidence);
    state.signalLog.push({
      signal: waiting.signal,
      outcome,
      claims: {},
      verifier: 'timeout',
      subject: 'system',
      at: new Date().toISOString(),
      evidence,
    });
    state.awaitingSince = null;
    state.machine = machine.serialize();
    atomicWrite(args.state, JSON.stringify(state, null, 2));
    process.stdout.write(JSON.stringify({ ok: true, outcome, evidence }) + '\\n');
  } finally {
    releaseLock();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  try {
    if (args.cmd === 'init') {
      if (!args.state) fail('missing --state');
      await cmdInit(args.state);
    } else if (args.cmd === 'apply') await cmdApply(args);
    else if (args.cmd === 'timeout') await cmdTimeout(args);
    else fail('usage: signal.mjs init|apply|timeout --state <file> ...');
  } catch (e) {
    releaseLock();
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e && typeof e.exitCode === 'number') ? e.exitCode : 1;
    process.stderr.write(msg + '\\n');
    process.exit(code);
  }
}

main();
`;
}
