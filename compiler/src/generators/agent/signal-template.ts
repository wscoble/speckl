// Emits signal.mjs — init state + apply verified signals.

export function emitSignalMjs(speckName: string): string {
  return `#!/usr/bin/env node
/**
 * Speckl signal tooling for ${speckName}.
 *
 *   node signal.mjs init  --state <file> --key <keyfile> [--dev] [--plugins <plugins.json>]
 *       [--mcp-tools <mcp-tools.json>] [--signer <name>=<pubkey>]...
 *       (pubkey: file path, or raw/hex/base64)
 *       (key created if missing; plug-in verifiers and MCP tool snapshots are pinned by sha256 here)
 *   All commands accept --key <keyfile> (or env SPECKL_STATE_KEY_FILE).
 *   node signal.mjs apply --state <file> --verifier file-drop|cli|plugin:<name> [verifier args...]
 *   node signal.mjs timeout --state <file>   # fire timeout → !-marked reject only
 *   node signal.mjs clear-pending --state <file> --verifier file-drop|cli|plugin:<name> [args...]
 *   node signal.mjs rotate-signers --state <file> --verifier file-drop --file <drop>
 *   node signal.mjs digest          # stdin {"tool","input"} → sha256 of that call
 *   node signal.mjs verify --state <file>    # state chain (signers, pinned plug-ins, any call binding) and the full decision record
 *
 * This is the human channel; the agent must not be able to run it. The cli
 * verifier (and unsigned drops) trust whoever runs them, so they are refused
 * unless the state was created with --dev (DEV ONLY: self-approval risk).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyState, append, sign, keyPathFrom, ensureKey, keyIdOf, genesis, verifyDecisions, callDigest, canonical } from './state-integrity.mjs';

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

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

function parseArgs(argv) {
  const out = { cmd: argv[2] || '', state: '', verifier: '', rest: {} };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') out.state = argv[++i] || '';
    else if (a === '--verifier') out.verifier = argv[++i] || '';
    else if (a === '--signer') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) fail('missing value for --signer');
      i++;
      if (!Array.isArray(out.rest.signer)) out.rest.signer = [];
      out.rest.signer.push(v);
    }
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

let stateKey = null;
function save(file, state) {
  sign(state, stateKey);
  atomicWrite(file, JSON.stringify(state, null, 2));
}

/** Read the state and refuse it unless spec hash, signature and log chain check out. */
async function loadVerified(args) {
  if (!fs.existsSync(args.state)) fail('state file missing: ' + args.state);
  const state = JSON.parse(fs.readFileSync(args.state, 'utf-8'));
  if (state.specHash !== config.specHash) fail('specHash mismatch', 2);
  const { Machine, machine } = await loadMachine(state);
  const v = verifyState(state, { keyPath: keyPathFrom(args.rest.key), Machine, config });
  if (!v.ok) fail('state integrity: ' + v.reason, 2);
  for (const w of v.warnings) process.stderr.write('WARN: ' + w + '\\n');
  stateKey = v.key;
  // Full walk, including a long decision log. A broken record blocks the
  // human channel too, so a signal cannot land while denies are unverifiable.
  const d = verifyDecisions(args.state, stateKey, state, { full: true });
  if (!d.ok) fail('decision record: ' + d.reason, 2);
  return { state, machine, decisions: d };
}

const sha256Hex = b => crypto.createHash('sha256').update(b).digest('hex');
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PLUGIN_TIMEOUT_DEFAULT = 30000;

/**
 * Import a plug-in module only if its bytes still hash to the pinned sha256,
 * and again after import (narrows, but can't close, a swap during import).
 */
async function importPinned(modulePath, pinnedSha) {
  let real;
  try { real = fs.realpathSync(modulePath); } catch { fail('plug-in module not found: ' + modulePath, 2); }
  if (real !== modulePath) fail('plug-in module path changed (symlink?): ' + modulePath + ' -> ' + real, 2);
  const before = sha256Hex(fs.readFileSync(real));
  if (before !== pinnedSha) fail('plug-in module sha256 mismatch: ' + modulePath + ' (pinned ' + pinnedSha + ', found ' + before + ')', 2);
  let mod;
  try { mod = await import(pathToFileURL(real).href); } catch (e) { fail('plug-in module failed to load: ' + (e && e.message ? e.message : String(e)), 2); }
  const after = sha256Hex(fs.readFileSync(real));
  if (after !== pinnedSha) fail('plug-in module changed while loading: ' + modulePath, 2);
  if (!mod || typeof mod.verify !== 'function') fail('plug-in module does not export verify(opts, expect, ctx): ' + modulePath, 2);
  return mod;
}

/** Read --plugins <file> at init: resolve, hash, load and check each entry. */
async function pinPlugins(file, dev) {
  if (typeof file !== 'string' || !file) fail('--plugins needs a JSON file');
  let spec;
  try { spec = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { fail('--plugins: cannot read ' + file + ': ' + e.message); }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || Object.keys(spec).length === 0) {
    fail('--plugins: expected { "<name>": { "module": "<path>", "sha256"?: "<hex>", "timeoutMs"?: n, "config"?: {...} } }');
  }
  const pins = {};
  for (const [name, p] of Object.entries(spec)) {
    if (!PLUGIN_NAME.test(name) || name === 'cli' || name === 'file-drop') fail('--plugins: invalid plug-in name: ' + name);
    if (!p || typeof p !== 'object' || typeof p.module !== 'string' || !p.module) fail('--plugins: ' + name + ': module path required');
    let real;
    try { real = fs.realpathSync(path.resolve(p.module)); } catch { fail('--plugins: ' + name + ': module not found: ' + p.module); }
    const digest = sha256Hex(fs.readFileSync(real));
    if (p.sha256 !== undefined && p.sha256 !== digest) fail('--plugins: ' + name + ': sha256 mismatch (expected ' + p.sha256 + ', found ' + digest + ')');
    const timeoutMs = p.timeoutMs === undefined ? PLUGIN_TIMEOUT_DEFAULT : p.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) fail('--plugins: ' + name + ': timeoutMs must be an integer 100..300000');
    const config = p.config === undefined ? {} : p.config;
    const mod = await importPinned(real, digest);
    if (mod.devOnly === true && !dev) fail('--plugins: ' + name + ' is DEV ONLY; create the state with --dev');
    if (typeof mod.checkConfig === 'function') {
      let r;
      try { r = await mod.checkConfig(config); } catch (e) { r = { ok: false, reason: e && e.message ? e.message : String(e) }; }
      if (!r || r.ok !== true) fail('--plugins: ' + name + ': config rejected: ' + (r && r.reason ? r.reason : 'checkConfig did not return { ok: true }'));
    }
    pins[name] = { module: real, sha256: digest, timeoutMs, config };
  }
  return pins;
}

const SIGNER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_SIGNERS = 32;

function decodePubHex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  if (buf.length === 32) return buf.toString('hex');
  const text = buf.toString('utf-8').trim().replace(/-----[^-]+-----/g, '').replace(/\\s+/g, '');
  if (/^[0-9a-fA-F]+$/.test(text) && text.length === 64) return text.toLowerCase();
  const b64 = Buffer.from(text, 'base64');
  if (b64.length === 32 && text.length > 0) return b64.toString('hex');
  throw new Error('pubkey must be 32-byte ed25519 key (raw, hex, or base64)');
}

function loadSignerMaterial(value) {
  if (typeof value !== 'string' || !value) throw new Error('missing pubkey');
  if (fs.existsSync(value)) return decodePubHex(fs.readFileSync(value));
  return decodePubHex(value);
}

function fingerprintOf(hex) {
  return crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
}

function takeSigner(out, name, key, code) {
  if (typeof name !== 'string' || !SIGNER_NAME.test(name)) fail('bad signer name: ' + name, code);
  if (out.some(s => s.name === name)) fail('duplicate signer name: ' + name, code);
  if (out.some(s => s.key === key)) fail('duplicate signer key: ' + name, code);
  out.push({ name, key });
}

function byName(a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; }

/** \`--signer name=pubkey\` from init. The value is a file path or key bytes. */
function normalizeSignerSpecs(list) {
  if (!Array.isArray(list)) fail('signers must be a list');
  if (list.length > MAX_SIGNERS) fail('too many signers (max ' + MAX_SIGNERS + ')');
  const out = [];
  for (const spec of list) {
    if (typeof spec !== 'string' || spec.indexOf('=') <= 0) fail('--signer must be name=pubkey (a file path or key bytes)');
    const eq = spec.indexOf('=');
    const name = spec.slice(0, eq);
    let key;
    try { key = loadSignerMaterial(spec.slice(eq + 1)); }
    catch (e) { fail('signer ' + name + ': ' + (e && e.message ? e.message : String(e))); }
    takeSigner(out, name, key, 1);
  }
  out.sort(byName);
  return out;
}

/** Signer objects carried inside a signed rotation drop. Key bytes only, never a path. */
function normalizeSignerEntries(list) {
  if (!Array.isArray(list) || list.length === 0) fail('rotation must name at least one signer', 2);
  if (list.length > MAX_SIGNERS) fail('too many signers (max ' + MAX_SIGNERS + ')', 2);
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('signer entry must be an object', 2);
    const name = entry.name;
    const raw = entry.key !== undefined ? entry.key : entry.pubkey;
    if (typeof raw !== 'string' || !raw) fail('signer ' + name + ' missing key', 2);
    let key;
    try { key = decodePubHex(raw); }
    catch (e) { fail('signer ' + name + ': ' + (e && e.message ? e.message : String(e)), 2); }
    takeSigner(out, name, key, 2);
  }
  out.sort(byName);
  return out;
}

const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_MCP = 32;

/** Pin each MCP server's signed tools/list. The bytes are hashed here; the session check re-fetches. */
async function pinMcpTools(file, plugins) {
  if (typeof file !== 'string' || !file) fail('--mcp-tools needs a JSON file');
  let spec;
  try { spec = JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (e) { fail('--mcp-tools: cannot read ' + file + ': ' + (e && e.message ? e.message : String(e))); }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || Object.keys(spec).length === 0) {
    fail('--mcp-tools: expected { "<server>": { "transport": "stdio", "command", "args", "snapshot", "bundle", "verifier", "policy" } }');
  }
  const names = Object.keys(spec);
  if (names.length > MAX_MCP) fail('--mcp-tools: too many servers (max ' + MAX_MCP + ')');
  if (!plugins) fail('--mcp-tools: pin the verifier plug-in first with --plugins <file>');
  const pins = {};
  for (const name of names) {
    if (!MCP_NAME.test(name)) fail('--mcp-tools: invalid server name: ' + name);
    const p = spec[name];
    if (!p || typeof p !== 'object' || Array.isArray(p)) fail('--mcp-tools: ' + name + ': expected an object');
    if (p.transport !== 'stdio') fail('--mcp-tools: ' + name + ': transport must be "stdio"');
    if (typeof p.command !== 'string' || !p.command) fail('--mcp-tools: ' + name + ': command is required');
    if (!Array.isArray(p.args) || p.args.some(a => typeof a !== 'string')) fail('--mcp-tools: ' + name + ': args must be an array of strings');
    if (typeof p.snapshot !== 'string' || !p.snapshot) fail('--mcp-tools: ' + name + ': snapshot file is required');
    if (typeof p.bundle !== 'string' || !p.bundle) fail('--mcp-tools: ' + name + ': bundle file is required');
    if (typeof p.verifier !== 'string' || !plugins[p.verifier]) fail('--mcp-tools: ' + name + ': verifier must be a plug-in pinned with --plugins');
    const verifierMod = await import(pathToFileURL(plugins[p.verifier].module).href);
    if (typeof verifierMod.verifyArtifact !== 'function') fail('--mcp-tools: ' + name + ': plug-in does not export verifyArtifact');
    if (typeof p.policy !== 'string' || !MCP_NAME.test(p.policy)) fail('--mcp-tools: ' + name + ': policy must be a name matching the plug-in artifacts policy');
    const timeoutMs = p.timeoutMs === undefined ? 10000 : p.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) fail('--mcp-tools: ' + name + ': timeoutMs must be an integer 100..300000');
    let env;
    if (p.env !== undefined) {
      if (!p.env || typeof p.env !== 'object' || Array.isArray(p.env)) fail('--mcp-tools: ' + name + ': env must be an object of strings');
      env = {};
      for (const k of Object.keys(p.env)) {
        if (typeof p.env[k] !== 'string') fail('--mcp-tools: ' + name + ': env.' + k + ' must be a string');
        env[k] = p.env[k];
      }
    }
    let cwd;
    if (p.cwd !== undefined) {
      if (typeof p.cwd !== 'string' || !p.cwd) fail('--mcp-tools: ' + name + ': cwd must be a directory');
      try { cwd = fs.realpathSync(p.cwd); }
      catch { fail('--mcp-tools: ' + name + ': cwd not found: ' + p.cwd); }
      if (!fs.statSync(cwd).isDirectory()) fail('--mcp-tools: ' + name + ': cwd is not a directory');
    }
    let command = p.command;
    if (path.isAbsolute(command) || command.includes('/') || command.includes('\\\\')) {
      try { command = fs.realpathSync(command); }
      catch { fail('--mcp-tools: ' + name + ': command not found: ' + p.command); }
    }
    const fileHash = (label, rel) => {
      let real;
      try { real = fs.realpathSync(path.resolve(rel)); }
      catch { fail('--mcp-tools: ' + name + ': ' + label + ' not found: ' + rel); }
      let buf;
      try { buf = fs.readFileSync(real); }
      catch { fail('--mcp-tools: ' + name + ': ' + label + ' could not be read'); }
      if (buf.length > 2000000) fail('--mcp-tools: ' + name + ': ' + label + ' is larger than 2MB');
      return { path: real, sha256: sha256Hex(buf) };
    };
    const snapshot = fileHash('snapshot', p.snapshot);
    const bundle = fileHash('bundle', p.bundle);
    const pin = {
      transport: 'stdio',
      command,
      args: p.args.slice(),
      snapshot: snapshot.path,
      snapshotSha256: snapshot.sha256,
      bundle: bundle.path,
      bundleSha256: bundle.sha256,
      verifier: p.verifier,
      policy: p.policy,
      timeoutMs,
    };
    if (cwd) pin.cwd = cwd;
    if (env) pin.env = env;
    pins[name] = pin;
  }
  return pins;
}

async function cmdInit(stateFile, dev, keyArg, pluginsFile, signerArgs, mcpToolsFile) {
  if (fs.existsSync(stateFile)) fail('state already exists: ' + stateFile);
  const plugins = pluginsFile === undefined ? null : await pinPlugins(pluginsFile, dev);
  const mcpTools = mcpToolsFile === undefined ? null : await pinMcpTools(mcpToolsFile, plugins);
  const initialSigners = normalizeSignerSpecs(signerArgs || []);
  const keyPath = keyPathFrom(keyArg);
  if (!keyPath && !dev) {
    fail('init needs a state key: --key <file> or SPECKL_STATE_KEY_FILE (created if missing; keep it unreadable by the agent). Only --dev states may be unsigned.');
  }
  stateKey = keyPath ? ensureKey(keyPath) : null;
  const mod = await import(pathToFileURL(path.join(__dirname, config.machineModule)).href);
  const Machine = mod[config.machineExport];
  const machine = new Machine();
  const state = {
    specHash: config.specHash,
    speck: config.speck,
    runId: crypto.randomBytes(16).toString('hex'),
    dev: dev === true,
    keyId: stateKey ? keyIdOf(stateKey) : null,
    // Frozen at init (covered by the genesis hash). \`signers\` is the current
    // set, re-derived from this plus any rotate-signers log entries.
    initialSigners,
    signers: initialSigners.map(s => ({ name: s.name, key: s.key })),
    log: [],
    head: null,
    machine: machine.serialize(),
    pending: null,
    appliedEvidence: [],
    usedNonces: [],
    signalLog: [],
    pendingLog: [],
    awaitingSince: null,
    boundCall: null,
  };
  if (plugins) state.plugins = plugins;
  if (mcpTools) state.mcpTools = mcpTools;
  state.head = genesis(state);
  if (currentAwait(machine)) state.awaitingSince = new Date().toISOString();
  save(stateFile, state);
  if (state.dev) {
    process.stderr.write('WARN: DEV state: the cli verifier and unsigned drops are accepted; anyone who can run signal.mjs can approve\\n');
    if (!stateKey) process.stderr.write('WARN: DEV state is unsigned (no state key); hand edits are only caught by the log chain\\n');
  }
  const out = {
    ok: true, state: stateFile, run: state.runId, dev: state.dev, signed: !!stateKey,
    signers: initialSigners.map(s => ({ name: s.name, fingerprint: fingerprintOf(s.key) })),
  };
  if (plugins) out.plugins = Object.fromEntries(Object.entries(plugins).map(([n, p]) => [n, p.sha256]));
  if (mcpTools) out.mcpTools = Object.fromEntries(Object.entries(mcpTools).map(([n, p]) => [n, p.snapshotSha256]));
  process.stdout.write(JSON.stringify(out) + '\\n');
}

async function loadVerifier(kind, state) {
  if (typeof kind === 'string' && kind.startsWith('plugin:')) {
    const name = kind.slice('plugin:'.length);
    const pin = state.plugins && Object.prototype.hasOwnProperty.call(state.plugins, name) ? state.plugins[name] : null;
    if (!pin) fail('plug-in not pinned in this state: ' + name + ' (pin it with signal.mjs init --plugins <file>)', 2);
    const mod = await importPinned(pin.module, pin.sha256);
    if (mod.devOnly === true && state.dev !== true) fail('plug-in ' + name + ' is DEV ONLY (state was not created with init --dev)', 2);
    return { mod, pin, name };
  }
  if (kind === 'cli') {
    return (await import(pathToFileURL(path.join(__dirname, 'verifiers', 'cli.mjs')).href));
  }
  if (kind === 'file-drop') {
    return (await import(pathToFileURL(path.join(__dirname, 'verifiers', 'file-drop.mjs')).href));
  }
  fail('unknown verifier: ' + kind + ' (shipped: cli, file-drop; plug-ins: plugin:<name>, pinned at init with --plugins)');
}

/** Run a pinned plug-in with a timeout; anything but a well-formed ok result denies. */
async function runPlugin({ mod, pin, name }, opts, expect, ctx) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('plug-in ' + name + ' timed out after ' + pin.timeoutMs + 'ms')), pin.timeoutMs);
  });
  let result;
  try {
    result = await Promise.race([
      Promise.resolve().then(() => mod.verify(opts, expect, { ...ctx, config: pin.config, plugin: name })),
      timeout,
    ]);
  } catch (e) {
    fail('verifier rejected: plug-in ' + name + ' threw: ' + (e && e.message ? e.message : String(e)), 2);
  } finally {
    clearTimeout(timer);
  }
  if (!result || typeof result !== 'object') fail('verifier rejected: plug-in ' + name + ' returned no result', 2);
  if (result.ok !== true) {
    fail('verifier rejected: ' + (result.ok === false && typeof result.reason === 'string' ? result.reason : 'plug-in ' + name + ' returned a malformed result'), 2);
  }
  const vs = result.signal;
  const str = v => typeof v === 'string' && v.length > 0;
  if (!vs || typeof vs !== 'object' || !str(vs.signal) || !str(vs.outcome) || !str(vs.evidence) || vs.evidence.length > 1000
    || !vs.claims || typeof vs.claims !== 'object' || Array.isArray(vs.claims)) {
    fail('verifier rejected: plug-in ' + name + ' returned a malformed signal (needs signal, outcome, claims, evidence)', 2);
  }
  // The label comes from the pin, not from the plug-in's own output.
  return { ...vs, verifier: 'plugin:' + name };
}

function verifierCtx(state) {
  return {
    runId: state.runId,
    dev: state.dev === true,
    now: Date.now(),
    usedNonces: state.usedNonces || [],
    // Absent on a legacy state. An array (possibly empty) is the pinned set.
    signers: state.signers,
  };
}

/** Run a verifier with the dev gate and run/nonce/replay checks. */
async function verifySignal(args, state, expect) {
  const listed = args.rest.signer;
  if (Array.isArray(listed)) {
    if (listed.length !== 1) fail('pass one --signer', 2);
    args.rest.signer = listed[0];
  }
  if (args.verifier === 'file-drop' && state.signers === undefined && state.dev !== true
      && args.rest['allow-unsigned'] !== true && args.rest['allow-unsigned'] !== 'true') {
    process.stderr.write('WARN: this state has no pinned sign-off signers (created before signer pinning); --pubkey is trusted for this call. Re-init with --signer to pin them.\\n');
  }
  if (args.verifier === 'cli' && state.dev !== true) {
    fail('cli verifier is DEV ONLY: create the state with signal.mjs init --dev, or use a signed verifier (self-approval risk)', 2);
  }
  const ver = await loadVerifier(args.verifier, state);
  let vs;
  if (ver.pin) {
    vs = await runPlugin(ver, args.rest, expect, verifierCtx(state));
  } else {
    const result = await ver.verify(args.rest, expect, verifierCtx(state));
    if (result.ok === false) fail('verifier rejected: ' + result.reason, 2);
    vs = result.signal;
  }
  // Defense in depth for any verifier that binds to a run / nonce.
  if (vs.run !== undefined && vs.run !== state.runId) fail('run mismatch', 2);
  if (vs.nonce !== undefined && (state.usedNonces || []).includes(vs.nonce)) fail('nonce already used: ' + vs.nonce, 2);
  if ((state.appliedEvidence || []).includes(vs.evidence)) {
    fail('replay: evidence already applied: ' + vs.evidence, 2);
  }
  return vs;
}

/** undefined = absent. A present value must be 64 hex chars; stored lowercase. */
function takenCall(vs) {
  if (vs.call === undefined) return { ok: true, call: undefined };
  if (typeof vs.call !== 'string' || !/^[0-9a-fA-F]{64}$/.test(vs.call)) {
    return { ok: false, reason: 'call hash must be 64 hex chars (sha256 of the canonical tool call)' };
  }
  return { ok: true, call: vs.call.toLowerCase() };
}

function recordSignal(state, vs) {
  state.appliedEvidence = state.appliedEvidence || [];
  state.appliedEvidence.push(vs.evidence);
  if (vs.nonce !== undefined) {
    state.usedNonces = state.usedNonces || [];
    state.usedNonces.push(vs.nonce);
  }
}

async function cmdApply(args) {
  if (!args.state) fail('missing --state');
  if (!args.verifier) fail('missing --verifier');

  await acquireLock(args.state);
  try {
    const { state, machine } = await loadVerified(args);
    const waiting = currentAwait(machine);
    if (!waiting) fail('machine is not in an await state', 2);

    const vs = await verifySignal(args, state, waiting);
    if (vs.signal !== waiting.signal) fail('wrong signal: expected ' + waiting.signal + ' got ' + vs.signal, 2);
    if (!waiting.outcomes.includes(vs.outcome)) fail('disallowed outcome: ' + vs.outcome, 2);
    for (const c of waiting.claims) {
      if (vs.claims[c.name] === undefined || vs.claims[c.name] === null || vs.claims[c.name] === '') {
        fail('missing claim: ' + c.name, 2);
      }
    }
    const on = waiting.on.find(o => o.outcome === vs.outcome);
    if (!on) fail('no on-transition for outcome ' + vs.outcome, 2);

    const needsCall = (waiting.bindCall || []).includes(vs.outcome);
    const taken = takenCall(vs);
    if (!taken.ok) fail(taken.reason, 2);
    if (needsCall && !taken.call) {
      fail('call-bound sign-off requires call (sha256 of the canonical tool call); see signal.mjs digest', 2);
    }
    if (!needsCall && taken.call) fail('stage-level sign-off must not carry a call hash', 2);

    const can = machine.can(on.action, {});
    if (can !== true) fail('synthetic transition refused: ' + can, 2);
    machine[on.action]();

    const entry = { kind: 'signal', signal: vs.signal, outcome: vs.outcome, evidence: vs.evidence, nonce: vs.nonce };
    if (taken.call) entry.call = taken.call;
    append(state, entry);
    recordSignal(state, vs);
    const recorded = { ...vs, at: vs.at || new Date().toISOString() };
    if (taken.call) recorded.call = taken.call;
    else delete recorded.call;
    state.signalLog.push(recorded);
    state.boundCall = taken.call ? { hash: taken.call } : null;
    state.awaitingSince = null;
    // Leave state.pending alone: an in-flight observe tool (HNTL) still owns it.
    state.machine = machine.serialize();
    save(args.state, state);
    const applied = { ok: true, outcome: vs.outcome, evidence: vs.evidence };
    if (taken.call) applied.call = taken.call;
    process.stdout.write(JSON.stringify(applied) + '\\n');
  } finally {
    releaseLock();
  }
}

async function cmdTimeout(args) {
  if (!args.state) fail('missing --state');
  await acquireLock(args.state);
  try {
    const { state, machine } = await loadVerified(args);
    const waiting = currentAwait(machine);
    if (!waiting) fail('machine is not in an await state', 2);
    if (!waiting.timeout) fail('no timeout configured for this await', 2);

    const outcome = waiting.timeout.outcome;
    if (!(waiting.rejects || []).includes(outcome)) {
      fail('timeout may only resolve to a !-marked reject outcome', 2);
    }
    const since = Date.parse(state.awaitingSince || '');
    if (!Number.isFinite(since)) {
      // No recorded start (e.g. the machine began in the await state): start
      // the clock now instead of firing immediately.
      state.awaitingSince = new Date().toISOString();
      save(args.state, state);
      fail('timeout clock started now; not yet elapsed', 2);
    }
    const elapsed = Date.now() - since;
    if (elapsed < waiting.timeout.durationMs) {
      fail('timeout not yet elapsed (' + elapsed + 'ms < ' + waiting.timeout.durationMs + 'ms)', 2);
    }

    const on = waiting.on.find(o => o.outcome === outcome);
    if (!on) fail('no on-transition for timeout outcome ' + outcome, 2);
    const evidence = 'timeout:' + waiting.signal + ':' + state.awaitingSince;
    if ((state.appliedEvidence || []).includes(evidence)) fail('replay', 2);

    machine[on.action]();
    append(state, { kind: 'timeout', signal: waiting.signal, outcome, evidence });
    state.appliedEvidence = state.appliedEvidence || [];
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
    state.boundCall = null;
    state.machine = machine.serialize();
    save(args.state, state);
    process.stdout.write(JSON.stringify({ ok: true, outcome, evidence }) + '\\n');
  } finally {
    releaseLock();
  }
}

async function cmdClearPending(args) {
  if (!args.state) fail('missing --state');
  if (!args.verifier) fail('missing --verifier');
  await acquireLock(args.state);
  try {
    const { state } = await loadVerified(args);
    if (!state.pending) fail('no pending tool call', 2);
    const expect = { signal: 'clear-pending', outcomes: ['clear'], claims: [] };
    const vs = await verifySignal(args, state, expect);
    if (vs.signal !== 'clear-pending') fail('wrong signal: expected clear-pending got ' + vs.signal, 2);
    if (vs.outcome !== 'clear') fail('disallowed outcome: ' + vs.outcome, 2);
    if (vs.call !== undefined) fail('clear-pending does not accept a call hash', 2);
    if (vs.callId === undefined || String(vs.callId) !== String(state.pending.call_id)) {
      fail('call_id does not match the pending call (' + state.pending.call_id + ')', 2);
    }
    append(state, { kind: 'clear', call_id: state.pending.call_id, evidence: vs.evidence, nonce: vs.nonce });
    recordSignal(state, vs);
    state.pendingLog = state.pendingLog || [];
    state.pendingLog.push({
      call_id: state.pending.call_id,
      tool: state.pending.tool,
      since: state.pending.since,
      cleared: 'signal',
      verifier: vs.verifier,
      subject: vs.subject,
      evidence: vs.evidence,
      at: new Date().toISOString(),
    });
    const cleared = state.pending.call_id;
    // Cleared as failed: the machine is not advanced.
    state.pending = null;
    save(args.state, state);
    process.stdout.write(JSON.stringify({ ok: true, cleared, evidence: vs.evidence }) + '\\n');
  } finally {
    releaseLock();
  }
}

async function cmdVerify(args) {
  if (!args.state) fail('missing --state');
  await acquireLock(args.state);
  try {
    const { decisions } = await loadVerified(args);
    process.stdout.write(JSON.stringify({
      ok: true,
      decisions: decisions.count,
      uncommitted: decisions.uncommitted,
      head: decisions.head,
    }) + '\\n');
  } finally {
    releaseLock();
  }
}

/** Print the digest and exact preimage of one spec call. Does not touch state. */
async function cmdDigest() {
  let raw;
  try { raw = await readStdin(); }
  catch (e) { fail('stdin read failed: ' + (e && e.message ? e.message : String(e))); }
  let msg;
  try { msg = JSON.parse(raw || ''); }
  catch { fail('stdin is not JSON'); }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) fail('digest input must be a JSON object');
  if (typeof msg.tool !== 'string' || msg.tool.length === 0) fail('digest requires tool (the spec tool name)');
  if (!Object.prototype.hasOwnProperty.call(msg, 'input')) fail('digest requires input (an arguments object; use {} when the call has none)');
  let digest;
  let preimage;
  try {
    digest = callDigest(msg.tool, msg.input);
    preimage = canonical({ tool: msg.tool, input: msg.input });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  process.stdout.write(JSON.stringify({ ok: true, digest, canonical: preimage }) + '\\n');
}

async function cmdRotate(args) {
  if (!args.state) fail('missing --state');
  if (!args.verifier) fail('missing --verifier');
  if (args.verifier !== 'file-drop') fail('rotate-signers requires --verifier file-drop signed by a current pinned signer', 2);
  if (args.rest['allow-unsigned'] === true || args.rest['allow-unsigned'] === 'true') {
    fail('rotate-signers refuses unsigned drops', 2);
  }
  await acquireLock(args.state);
  try {
    // loadVerified replays state.log (including earlier signers entries) and
    // walks the whole decision record. A rotation is not a decision line.
    const { state } = await loadVerified(args);
    if (!Array.isArray(state.signers)) {
      fail('this state has no pinned signers (it predates signer pinning); re-init with --signer', 2);
    }
    if (state.signers.length === 0) {
      fail('no sign-off signers are pinned, so a rotation cannot be authorized; re-init with --signer', 2);
    }
    const vs = await verifySignal(args, state, { signal: 'rotate-signers', outcomes: ['rotate'], claims: [] });
    if (vs.signal !== 'rotate-signers') fail('wrong signal: expected rotate-signers got ' + vs.signal, 2);
    if (vs.outcome !== 'rotate') fail('disallowed outcome: ' + vs.outcome, 2);
    if (!Array.isArray(vs.signers)) fail('rotation drop missing signers', 2);
    const next = normalizeSignerEntries(vs.signers);
    append(state, { kind: 'signers', signers: next, by: typeof vs.signer === 'string' ? vs.signer : undefined, evidence: vs.evidence, nonce: vs.nonce });
    recordSignal(state, vs);
    state.signers = next.map(s => ({ name: s.name, key: s.key }));
    state.signalLog.push({ ...vs, at: vs.at || new Date().toISOString() });
    save(args.state, state);
    process.stdout.write(JSON.stringify({
      ok: true,
      signers: state.signers.map(s => ({ name: s.name, fingerprint: fingerprintOf(s.key) })),
    }) + '\\n');
  } finally {
    releaseLock();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  try {
    if (args.cmd === 'init') {
      if (!args.state) fail('missing --state');
      await cmdInit(
        args.state,
        args.rest.dev === true || args.rest.dev === 'true',
        args.rest.key,
        args.rest.plugins,
        Array.isArray(args.rest.signer) ? args.rest.signer : [],
        args.rest['mcp-tools'],
      );
    } else if (args.cmd === 'apply') await cmdApply(args);
    else if (args.cmd === 'timeout') await cmdTimeout(args);
    else if (args.cmd === 'clear-pending') await cmdClearPending(args);
    else if (args.cmd === 'rotate-signers') await cmdRotate(args);
    else if (args.cmd === 'digest') await cmdDigest();
    else if (args.cmd === 'verify') await cmdVerify(args);
    else fail('usage: signal.mjs init|apply|timeout|clear-pending|rotate-signers|digest|verify --state <file> ...');
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
