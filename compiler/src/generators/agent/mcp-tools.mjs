#!/usr/bin/env node
/**
 * MCP tool-definition pin (generated). Node built-ins only.
 *
 * Snapshot a server's tools/list into one canonical JSON file, then check
 * the live list against that file and a cosign sign-blob bundle:
 *
 *   node mcp-tools.mjs snapshot --server <name> --out <file> -- <command> [args...]
 *   node mcp-tools.mjs verify --state <file> [--key <file>] [--server <name>]
 *
 * The file bytes are the canonical document (sorted keys, tools sorted by
 * name, no trailing newline). sha256 of those bytes is the digest. Signing
 * is cosign's job; this file only verifies, through the plug-in pinned in
 * the state. A session check (hook.mjs session) records the verdict. A
 * mapped call does not fetch the list again.
 *
 * Stdio transport is newline-delimited JSON-RPC (MCP, 2025-03-26 and later).
 * The child is started with the pinned env plus PATH, never the caller's
 * full environment.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, keyPathFrom, verifyState } from './state-integrity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Canonical document for one server. Throws if the list is not a tool list. */
export function toolsDocument(server, tools) {
  if (typeof server !== 'string' || !server) throw new Error('server name is required');
  if (!Array.isArray(tools)) throw new Error('tools must be an array');
  if (tools.length > 500) throw new Error('tools/list has more than 500 tools');
  const seen = new Set();
  const copy = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('tool is not an object');
    if (typeof t.name !== 'string' || !t.name) throw new Error('tool is missing a name');
    if (seen.has(t.name)) throw new Error('duplicate tool name: ' + t.name);
    seen.add(t.name);
    copy.push(t);
  }
  copy.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { server, speckl: 'mcp-tools/v1', tools: copy };
}

/** Exact file bytes of a snapshot. No trailing newline. */
export function snapshotBytes(server, tools) {
  return canonical(toolsDocument(server, tools));
}

function drift(pinned, live) {
  const names = (list) => (Array.isArray(list) ? list.map(t => (t && typeof t.name === 'string' ? t.name : '')) : []);
  const pn = names(pinned);
  const ln = names(live);
  const added = ln.filter(n => n && !pn.includes(n));
  const removed = pn.filter(n => n && !ln.includes(n));
  const bits = [];
  if (added.length) bits.push('tool added: ' + added.join(', '));
  if (removed.length) bits.push('tool removed: ' + removed.join(', '));
  const both = pn.filter(n => ln.includes(n));
  for (const n of both) {
    const a = pinned.find(t => t && t.name === n);
    const b = live.find(t => t && t.name === n);
    if (canonical(a) === canonical(b)) continue;
    if (a.description !== b.description) bits.push(n + ' description changed');
    else bits.push(n + ' definition changed');
  }
  return bits.join('; ') || 'digest mismatch';
}

function childEnv(pin) {
  const env = {};
  const pinned = pin.env && typeof pin.env === 'object' ? pin.env : {};
  for (const k of Object.keys(pinned)) env[k] = String(pinned[k]);
  if (env.PATH === undefined && typeof process.env.PATH === 'string') env.PATH = process.env.PATH;
  return env;
}

/**
 * Speak MCP stdio and return the tools array, following nextCursor.
 * Rejects on timeout, a protocol error, or a list that is not tools.
 */
export function fetchTools(pin) {
  const timeoutMs = pin.timeoutMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = '';
    const lines = [];
    let waiter = null;
    let errBuf = '';
    const finish = (err, tools) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      if (err) reject(err);
      else resolve(tools);
    };
    const note = () => (errBuf ? ': ' + errBuf.replace(/\s+/g, ' ').trim() : '');
    const child = spawn(pin.command, pin.args, {
      cwd: pin.cwd || undefined,
      env: childEnv(pin),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => finish(new Error('timed out after ' + timeoutMs + 'ms' + note())), timeoutMs);
    child.on('error', (e) => finish(new Error('could not start MCP server (' + (e && e.code ? e.code : 'error') + ')')));
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('data', (c) => {
      if (errBuf.length < 300) errBuf += String(c).slice(0, 300 - errBuf.length);
    });
    const pushLine = (line) => {
      if (waiter) { const w = waiter; waiter = null; w(line); }
      else lines.push(line);
    };
    const nextLine = () => {
      if (lines.length) return Promise.resolve(lines.shift());
      return new Promise((r) => { waiter = r; });
    };
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.trim()) pushLine(line);
      }
    });
    child.on('close', () => {
      if (!settled) finish(new Error('MCP server exited before tools/list completed' + note()));
    });

    let nextId = 1;
    const request = async (method, params) => {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
      for (;;) {
        const line = await nextLine();
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!msg || msg.id !== id) continue;
        if (msg.error) {
          const code = msg.error && msg.error.code !== undefined ? String(msg.error.code) : 'error';
          throw new Error('MCP ' + method + ' failed (' + code + ')');
        }
        return msg.result;
      }
    };

    (async () => {
      try {
        const init = await request('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'speckl', version: '0' },
        });
        if (!init || typeof init !== 'object') throw new Error('initialize returned no result');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        const tools = [];
        let cursor;
        const seen = new Set();
        for (let page = 0; page < 20; page++) {
          const result = await request('tools/list', cursor ? { cursor } : {});
          if (!result || typeof result !== 'object' || !Array.isArray(result.tools)) {
            throw new Error('tools/list did not return a tools array');
          }
          for (const t of result.tools) tools.push(t);
          if (typeof result.nextCursor !== 'string' || !result.nextCursor) {
            finish(null, tools);
            return;
          }
          if (seen.has(result.nextCursor)) throw new Error('tools/list cursor repeated');
          seen.add(result.nextCursor);
          cursor = result.nextCursor;
        }
        throw new Error('tools/list pagination exceeded 20 pages');
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });
}

async function loadArtifactVerifier(state, name) {
  const pin = state.plugins && Object.prototype.hasOwnProperty.call(state.plugins, name) ? state.plugins[name] : null;
  if (!pin) return { ok: false, reason: 'verifier plug-in not pinned: ' + name };
  let real;
  try { real = fs.realpathSync(pin.module); } catch { return { ok: false, reason: 'plug-in module not found' }; }
  if (real !== pin.module) return { ok: false, reason: 'plug-in module path changed (symlink?)' };
  const before = sha256(fs.readFileSync(real));
  if (before !== pin.sha256) return { ok: false, reason: 'plug-in module sha256 mismatch' };
  let mod;
  try { mod = await import(pathToFileURL(real).href); }
  catch (e) { return { ok: false, reason: 'plug-in module failed to load: ' + (e && e.message ? e.message : String(e)) }; }
  const after = sha256(fs.readFileSync(real));
  if (after !== pin.sha256) return { ok: false, reason: 'plug-in module changed while loading' };
  if (typeof mod.verifyArtifact !== 'function') return { ok: false, reason: 'plug-in does not export verifyArtifact' };
  return { ok: true, mod, pin };
}

async function runArtifact(loaded, opts, name) {
  const { mod, pin } = loaded;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('plug-in ' + name + ' timed out after ' + pin.timeoutMs + 'ms')), pin.timeoutMs);
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => mod.verifyArtifact(opts, { config: pin.config, plugin: name, now: Date.now() })),
      timeout,
    ]);
    if (!result || result.ok !== true) {
      const reason = result && result.ok === false && typeof result.reason === 'string'
        ? result.reason
        : 'plug-in returned a malformed result';
      return { ok: false, reason };
    }
    if (typeof result.evidence !== 'string' || !result.evidence || result.evidence.length > 1000) {
      return { ok: false, reason: 'plug-in returned a malformed artifact result (needs evidence)' };
    }
    return {
      ok: true,
      subject: typeof result.subject === 'string' ? result.subject : '',
      issuer: typeof result.issuer === 'string' ? result.issuer : '',
      evidence: result.evidence,
    };
  } catch (e) {
    return { ok: false, reason: (e && e.message ? e.message : String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

/** Check one pinned server. Does not read or write the state file. */
export async function checkServer(state, name) {
  const pin = state && state.mcpTools && state.mcpTools[name];
  if (!pin) return { ok: false, reason: 'server is not pinned: ' + name };
  let snap;
  try { snap = fs.readFileSync(pin.snapshot); }
  catch { return { ok: false, reason: 'signed snapshot not found' }; }
  if (snap.length > 2_000_000) return { ok: false, reason: 'signed snapshot is larger than 2MB' };
  const snapDigest = sha256(snap);
  if (snapDigest !== pin.snapshotSha256) return { ok: false, reason: 'signed snapshot was modified after it was pinned' };
  let bundle;
  try { bundle = fs.readFileSync(pin.bundle); }
  catch { return { ok: false, reason: 'bundle not found' }; }
  if (bundle.length > 2_000_000) return { ok: false, reason: 'bundle is larger than 2MB' };
  if (sha256(bundle) !== pin.bundleSha256) return { ok: false, reason: 'bundle was modified after it was pinned' };
  const loaded = await loadArtifactVerifier(state, pin.verifier);
  if (!loaded.ok) return { ok: false, reason: loaded.reason };
  const verified = await runArtifact(loaded, { file: pin.snapshot, bundle: pin.bundle, policy: pin.policy }, pin.verifier);
  if (!verified.ok) return { ok: false, reason: verified.reason };
  let live;
  try { live = await fetchTools(pin); }
  catch (e) { return { ok: false, reason: 'tools/list failed: ' + (e && e.message ? e.message : String(e)) }; }
  let liveBody;
  try { liveBody = snapshotBytes(name, live); }
  catch (e) { return { ok: false, reason: 'live tools/list is not a tool list: ' + (e && e.message ? e.message : String(e)) }; }
  const liveDigest = sha256(liveBody);
  if (liveDigest !== snapDigest) {
    let detail = 'live tools/list does not match the signed snapshot';
    try {
      const pinnedDoc = JSON.parse(snap.toString('utf8'));
      detail += ' (' + drift(pinnedDoc.tools, live) + ')';
    } catch { /* the digest mismatch is the reason */ }
    return { ok: false, reason: detail };
  }
  return {
    ok: true,
    digest: liveDigest,
    evidence: verified.evidence,
    subject: verified.subject,
    issuer: verified.issuer,
  };
}

/** Check every pinned server, or one named server. Fail closed: one failure fails the set. */
export async function checkPinned(state, only) {
  const pins = state && state.mcpTools;
  if (!pins || typeof pins !== 'object' || Array.isArray(pins) || Object.keys(pins).length === 0) {
    return { ok: true, servers: {} };
  }
  if (only !== undefined && !Object.prototype.hasOwnProperty.call(pins, only)) {
    return { ok: false, servers: { [only]: { ok: false, reason: 'server is not pinned: ' + only } } };
  }
  const names = only !== undefined ? [only] : Object.keys(pins).sort();
  const servers = {};
  let ok = true;
  for (const name of names) {
    const row = await checkServer(state, name);
    servers[name] = row;
    if (!row.ok) ok = false;
  }
  return { ok, servers };
}

function fail(msg, code) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function parseCli(argv) {
  const cmd = argv[2] || '';
  const opt = {};
  const rest = [];
  let dd = false;
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { dd = true; continue; }
    if (dd) { rest.push(a); continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      opt[key] = v;
    }
  }
  return { cmd, opt, rest };
}

async function cmdSnapshot(opt, rest) {
  if (typeof opt.server !== 'string' || !opt.server) fail('snapshot needs --server <name>', 1);
  if (typeof opt.out !== 'string' || !opt.out) fail('snapshot needs --out <file>', 1);
  if (rest.length === 0) fail('snapshot needs a command after --', 1);
  const timeoutMs = opt['timeout-ms'] === undefined ? 10000 : Number(opt['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) fail('--timeout-ms must be an integer 100..300000', 1);
  const pin = {
    command: rest[0],
    args: rest.slice(1),
    cwd: typeof opt.cwd === 'string' ? opt.cwd : undefined,
    env: {},
    timeoutMs,
  };
  let tools;
  try { tools = await fetchTools(pin); }
  catch (e) { fail('snapshot failed: ' + (e && e.message ? e.message : String(e)), 1); }
  let body;
  try { body = snapshotBytes(opt.server, tools); }
  catch (e) { fail('snapshot failed: ' + (e && e.message ? e.message : String(e)), 1); }
  const out = path.resolve(opt.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body);
  const digest = sha256(body);
  fs.writeFileSync(out + '.sha256', digest + '\n');
  const names = JSON.parse(body).tools.map(t => t.name);
  process.stdout.write(JSON.stringify({ ok: true, server: opt.server, file: out, sha256: digest, tools: names }) + '\n');
}

async function cmdVerify(opt) {
  if (typeof opt.state !== 'string' || !opt.state) fail('verify needs --state <file>', 1);
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-config.json'), 'utf-8'));
  let text;
  try { text = fs.readFileSync(opt.state, 'utf-8'); }
  catch (e) { fail(e && e.code === 'ENOENT' ? 'state file missing' : 'state file could not be read', 2); }
  let state;
  try { state = JSON.parse(text); }
  catch { fail('state file is not JSON', 2); }
  const mod = await import(pathToFileURL(path.join(__dirname, config.machineModule)).href);
  const Machine = mod[config.machineExport];
  const v = verifyState(state, { keyPath: keyPathFrom(typeof opt.key === 'string' ? opt.key : ''), Machine, config });
  if (!v.ok) fail('state integrity: ' + v.reason, 2);
  const only = typeof opt.server === 'string' ? opt.server : undefined;
  const report = await checkPinned(state, only);
  process.stdout.write(JSON.stringify({ ok: report.ok, servers: report.servers }) + '\n');
  if (!report.ok) process.exit(2);
}

async function main() {
  const { cmd, opt, rest } = parseCli(process.argv);
  if (cmd === 'snapshot') await cmdSnapshot(opt, rest);
  else if (cmd === 'verify') await cmdVerify(opt);
  else {
    fail('usage: mcp-tools.mjs snapshot --server <name> --out <file> [--cwd <dir>] [--timeout-ms <n>] -- <command> [args...]\n'
      + '       mcp-tools.mjs verify --state <file> [--key <file>] [--server <name>]', 1);
  }
}

const invoked = process.argv[1] && fs.existsSync(process.argv[1])
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch((e) => fail(e && e.message ? e.message : String(e), 1));
}
