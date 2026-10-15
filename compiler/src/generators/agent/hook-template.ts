// Emits hook.mjs — runtime-agnostic pre/post tool gate.

export function emitHookMjs(speckName: string): string {
  return `#!/usr/bin/env node
/**
 * Speckl agent hook (generic). Generated for ${speckName}.
 *
 *   node hook.mjs pre  --state <file>   # stdin JSON {tool,input,call_id}
 *   node hook.mjs post --state <file>   # stdin JSON {tool,input,call_id,ok}
 *
 * exit 0 allow · exit 2 deny · exit 1 error (=deny)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function allow() { respond('allow', undefined, 0); }
function deny(reason) { respond('deny', reason, 2); }
function error(reason) { respond('deny', reason, 1); }

function parseArgs(argv) {
  const out = { cmd: '', state: '' };
  out.cmd = argv[2] || '';
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--state') out.state = argv[++i] || '';
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

function atomicWrite(file, data) {
  const tmp = file + '.tmp.' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    throw new Error('state file missing; run: node signal.mjs init --state ' + stateFile);
  }
  return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
}

function currentAwait(machine, cfg) {
  const stage = machine[cfg.stageVariable];
  return cfg.awaits.find(a => a.stateValue === stage) || null;
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
  if (args.cmd !== 'pre' && args.cmd !== 'post') {
    error('usage: hook.mjs pre|post --state <file>');
  }
  if (!args.state) error('missing --state');

  let raw;
  try { raw = await readStdin(); }
  catch (e) { error('stdin read failed: ' + e.message); }
  let msg;
  try { msg = JSON.parse(raw || '{}'); }
  catch { error('stdin is not JSON'); }

  try {
    await acquireLock(args.state);
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
  }

  try {
    const state = loadState(args.state);
    if (state.specHash !== config.specHash) {
      deny('specHash mismatch: state is stale relative to compiled spec');
    }
    const { machine } = await loadMachine(state);
    const toolByName = new Map(config.tools.map(t => [t.name, t]));

    if (args.cmd === 'pre') {
      const tool = msg.tool;
      const input = msg.input || {};
      const callId = msg.call_id;
      if (!tool || callId === undefined || callId === null || callId === '') {
        deny('pre: tool and call_id are required');
      }
      const binding = toolByName.get(tool);
      if (!binding) deny('unknown tool: ' + tool);
      if (state.pending) deny('another tool call is already pending');

      const waiting = currentAwait(machine, config);
      if (waiting) {
        if (waiting.mode === 'in') {
          deny('HITL: no tools while awaiting signal ' + waiting.signal);
        }
        if (binding.effect === 'act') {
          deny('HNTL: act tool refused while awaiting signal ' + waiting.signal);
        }
      }

      const can = machine.can(binding.action, input);
      if (can !== true) deny('can() refused: ' + can);

      state.pending = { call_id: callId, tool, action: binding.action, input };
      state.machine = machine.serialize();
      atomicWrite(args.state, JSON.stringify(state, null, 2));
      allow();
    }

    // post
    const tool = msg.tool;
    const callId = msg.call_id;
    const ok = msg.ok === true;
    if (!tool || callId === undefined || callId === null || callId === '') {
      deny('post: tool and call_id are required');
    }
    if (!state.pending || state.pending.call_id !== callId) {
      deny('post: no matching pending call_id');
    }
    if (state.pending.tool !== tool) {
      deny('post: tool does not match pending');
    }

    if (!ok) {
      state.pending = null;
      state.machine = machine.serialize();
      atomicWrite(args.state, JSON.stringify(state, null, 2));
      allow();
      return;
    }

    const binding = toolByName.get(tool);
    if (!binding) deny('unknown tool: ' + tool);
    const params = (machine.constructor.ACTIONS || {})[binding.action] || [];
    const argsList = params.map(p => (state.pending.input || {})[p]);
    machine[binding.action](...argsList);
    state.pending = null;
    const waitingAfter = currentAwait(machine, config);
    state.awaitingSince = waitingAfter ? (state.awaitingSince || new Date().toISOString()) : null;
    state.machine = machine.serialize();
    atomicWrite(args.state, JSON.stringify(state, null, 2));
    allow();
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
  }
}

main();
`;
}
