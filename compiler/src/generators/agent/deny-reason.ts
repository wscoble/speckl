// Deny text for hook.mjs and the harness adapter.
//
// These functions are emitted verbatim (Function#toString) into the generated
// files, so each one is self-contained: parameters and other emitted
// functions only. No imports, no module-level constants, no classes.
//
// They never decide allow versus deny. The caller has already decided to
// deny; this only builds the sentence. safeDenyText turns a throw into a
// fixed fail-closed sentence so a broken explanation cannot allow the call
// or print the exception (which may hold key material or state).

/** Shell-single-quote one argument of the human's sign-off command. */
export function shellQuote(value: unknown): string {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/**
 * Strip key material and known key paths from a deny sentence.
 * A token shorter than 8 characters is left alone so it cannot erase the
 * sentence. No Speckl secret is that short: the state key is 64 hex
 * characters and a signer key is 32 bytes. The hook and adapter refuse to
 * run when a key path itself is under 8 characters. A 64-hex secret (the
 * state key, or a pinned signer key) is also removed as uppercase and
 * lowercase hex, as base64 and
 * base64url of its 32 bytes (with and without padding), and as the SPKI
 * DER-base64 and PEM of those bytes. Any other PEM block and any other
 * 64-hex token are removed too.
 * Path spellings of a secret are removed too: extra slashes, `.` segments,
 * and a relative path that lands on the secret from one of its ancestor
 * directories (`../keys/state.key`, `<dir>//keys/state.key`,
 * `<dir>/keys/./state.key`). The result is capped so a huge call id
 * cannot dump a state file into the harness.
 */
export function redactSecrets(text: string, secrets: unknown, keep?: unknown): string {
  let s = String(text);
  const list: string[] = [];
  if (Array.isArray(secrets)) {
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret.length >= 8) list.push(secret);
    }
  }
  // Lexical path only. No filesystem. `..` is applied. Duplicate slashes
  // and `.` segments disappear.
  const lexNorm = (p: string): string => {
    const slash = p.replace(/\\/g, '/');
    const abs = slash.charAt(0) === '/';
    const parts = slash.split('/');
    const out: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
        else if (!abs) out.push('..');
        continue;
      }
      out.push(part);
    }
    if (abs) return '/' + out.join('/');
    return out.join('/') || '.';
  };
  const norms: Record<string, boolean> = {};
  const bases: string[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].indexOf('/') === -1 && list[i].indexOf('\\') === -1) continue;
    const n = lexNorm(list[i]);
    if (n.length >= 8) norms[n] = true;
    if (n.charAt(0) !== '/') continue;
    const parts = n.split('/').filter(Boolean);
    // Ancestors of the file, not the file itself, so `../name` is resolved
    // from the directory that contains the secret.
    for (let k = parts.length - 1; k >= 1; k--) {
      const dir = '/' + parts.slice(0, k).join('/');
      if (bases.indexOf(dir) === -1) bases.push(dir);
    }
  }
  // `%2e` `%2f` `%5c` are `.` `/` `\` . Decode a copy for matching only.
  // The stored text keeps the original spelling when nothing was a secret.
  const decodePathEscapes = (src: string): { decoded: string; map: number[] } => {
    let decoded = '';
    const map: number[] = [];
    for (let i = 0; i < src.length;) {
      const three = src.slice(i, i + 3);
      map.push(i);
      if (/^%2e$/i.test(three)) { decoded += '.'; i += 3; }
      else if (/^%2f$/i.test(three)) { decoded += '/'; i += 3; }
      else if (/^%5c$/i.test(three)) { decoded += '\\'; i += 3; }
      else { decoded += src.charAt(i); i++; }
    }
    map.push(src.length);
    return { decoded, map };
  };
  const pathStops = /[\s"'<>|;&,`()\[\]{}]/;
  const hits = (raw: string): boolean => {
    if (raw.length < 4) return false;
    const n = lexNorm(raw);
    if (n.length >= 8 && norms[n]) return true;
    if (n.charAt(0) === '/') return false;
    for (let b = 0; b < bases.length; b++) {
      const joined = lexNorm(bases[b] + '/' + raw);
      if (joined.length >= 8 && norms[joined]) return true;
    }
    return false;
  };
  // Before the exact-string pass. Replacing a parent directory first would
  // leave `<keyfile>/./state.key` for a `/.` spelling of the file.
  const decodedPath = decodePathEscapes(s);
  const spans: number[][] = [];
  const scanned = decodedPath.decoded;
  for (let i = 0; i < scanned.length;) {
    const rel = scanned.startsWith('../', i) || scanned.startsWith('./', i) || scanned.startsWith('..\\', i) || scanned.startsWith('.\\', i);
    const abs = scanned.charAt(i) === '/' || scanned.charAt(i) === '\\';
    if (!rel && !abs) { i++; continue; }
    let j = i + 1;
    while (j < scanned.length && !pathStops.test(scanned.charAt(j))) j++;
    const raw = scanned.slice(i, j);
    let start = i;
    if (abs) {
      while (start > 0) {
        const c = scanned.charAt(start - 1);
        if (c === '_' || c === '/' || c === '\\' || pathStops.test(c)) break;
        if (!/[A-Za-z0-9.~+-]/.test(c)) break;
        start--;
      }
    }
    const wider = start < i ? scanned.slice(start, j) : raw;
    if (hits(raw) || (start < i && hits(wider))) {
      const from = (start < i && hits(wider) && !hits(raw)) ? start : i;
      spans.push([from, j]);
      i = j;
      continue;
    }
    i++;
  }
  for (let n = spans.length - 1; n >= 0; n--) {
    const from = decodedPath.map[spans[n][0]];
    const to = decodedPath.map[spans[n][1]];
    s = s.slice(0, from) + '<keyfile>' + s.slice(to);
  }
  const forms: string[] = [];
  for (const secret of list) {
    if (!/^[0-9a-fA-F]{64}$/.test(secret)) continue;
    const raw = Buffer.from(secret, 'hex');
    const b64 = raw.toString('base64');
    const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_');
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]).toString('base64');
    const pem = (nl: string) => '-----BEGIN PUBLIC KEY-----' + nl + der + nl + '-----END PUBLIC KEY-----';
    forms.push(
      secret.toLowerCase(), secret.toUpperCase(),
      b64, b64.replace(/=+$/, ''),
      b64url, b64url.replace(/=+$/, ''),
      der, der.replace(/=+$/, ''),
      pem('\n'), pem('\r\n'),
    );
  }
  for (const form of forms) list.push(form);
  // Longer first, so a PEM or a resolved absolute path is removed whole and
  // a shorter relative path or inner base64 cannot leave a prefix behind.
  list.sort((a, b) => b.length - a.length);
  for (const secret of list) s = s.split(secret).join('<keyfile>');
  const kept = new Set<string>();
  if (Array.isArray(keep)) {
    for (const token of keep) {
      if (typeof token === 'string' && /^[0-9a-fA-F]{64}$/.test(token)) kept.add(token.toLowerCase());
    }
  }
  s = s.replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, '<redacted>');
  // A call digest is 64 hex too. Keep only tokens named by the caller, and
  // only if a known secret did not already claim them.
  s = s.replace(/\b[0-9a-fA-F]{64}\b/g, (m) => kept.has(m.toLowerCase()) ? m : '<redacted>');
  // A 16-hex run taken from the state key is key material even when it is
  // not the whole key. A kept 64-hex token (a withheld-name hash) is copied
  // through so this pass does not eat it.
  const windows: string[] = [];
  for (let si = 0; si < list.length; si++) {
    const hex = list[si].trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) continue;
    for (let i = 0; i + 16 <= hex.length; i++) {
      const w = hex.slice(i, i + 16);
      if (windows.indexOf(w) === -1) windows.push(w);
    }
  }
  if (windows.length && s.length >= 16) {
    let out = '';
    for (let i = 0; i < s.length;) {
      const maybe = s.slice(i, i + 64);
      const boundaryBefore = i === 0 || !/[0-9a-fA-F]/.test(s.charAt(i - 1));
      const boundaryAfter = i + 64 >= s.length || !/[0-9a-fA-F]/.test(s.charAt(i + 64));
      if (maybe.length === 64 && /^[0-9a-fA-F]{64}$/.test(maybe) && boundaryBefore && boundaryAfter && kept.has(maybe.toLowerCase())) {
        out += maybe;
        i += 64;
        continue;
      }
      const slice = s.slice(i, i + 16);
      if (slice.length === 16 && windows.indexOf(slice.toLowerCase()) !== -1) {
        out += '<keyfile>';
        i += 16;
      } else {
        out += s.charAt(i);
        i++;
      }
    }
    s = out;
  }
  if (s.length > 1800) s = s.slice(0, 1800) + '…';
  return s;
}

/**
 * Names of the pinned file-drop signers, or null when the state has no pin
 * field (a legacy state, which still trusts a per-call --pubkey).
 * Key bytes on each entry are ignored. A pin that is not a list of named
 * objects throws; the caller still denies.
 */
export function pinnedSignerNames(signers: unknown): string[] | null {
  if (signers === undefined) return null;
  if (!Array.isArray(signers)) throw new Error('pinned signer set is not a list');
  const names: string[] = [];
  for (const entry of signers) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('pinned signer is not an object');
    const name = (entry as Record<string, unknown>).name;
    if (typeof name !== 'string' || name.length === 0) throw new Error('pinned signer has no name');
    names.push(name);
  }
  return names;
}

/** Sentence naming who may sign. Empty for a legacy state. */
export function signerNote(signers: unknown): string {
  const pins = pinnedSignerNames(signers);
  if (pins === null) return '';
  if (pins.length === 0) {
    return 'No sign-off signers are pinned for this run, so file-drop cannot accept a signature. A human creates a new state with signal.mjs init --signer name=pubkey. Do not pass --pubkey. ';
  }
  const listed = pins.map(n => JSON.stringify(n)).join(', ');
  if (pins.length === 1) {
    return 'Pinned signer ' + listed + '. The drop must be signed by that key. Do not pass --pubkey. ';
  }
  return 'Pinned signers ' + listed + '. The drop must be signed by one of them. Omit --pubkey, or pass --signer and exactly one of those names. ';
}

/**
 * `node signal.mjs apply|clear-pending ...` with the paths the hook has.
 * Legacy states (no signer field) keep `--pubkey <pubkey>`. A single pin
 * names that signer. Several pins omit `--pubkey` so any of them verifies.
 * An empty pin set has no working file-drop command.
 */
export function applyCommand(signalProgram: string, stateFile: string, sub: string, signers?: unknown): string {
  const pins = pinnedSignerNames(signers);
  if (pins !== null && pins.length === 0) return '';
  let cmd = 'node ' + shellQuote(signalProgram) + ' ' + sub + ' --state ' + shellQuote(stateFile)
    + ' --verifier file-drop --file <drop.json>';
  if (pins === null) cmd += ' --pubkey <pubkey>';
  else if (pins.length === 1) cmd += ' --signer ' + shellQuote(pins[0]);
  return cmd;
}

/**
 * can() refusal → stage | precondition | internal.
 * `require` that names the stage variable is "not allowed in this stage".
 * `precondition:` and a `require` on other state are a failed precondition.
 * Anything else (a postcondition, an unknown action) is fail-closed.
 */
export function classifyCanRefusal(described: string, stageVariable: string): string {
  const text = String(described);
  const close = text.lastIndexOf(' (');
  const head = close >= 0 && text.endsWith(')') ? text.slice(0, close) : text;
  if (head.startsWith('Precondition failed:') || head.startsWith('missing argument(s):')) return 'precondition';
  if (head.startsWith('Guard failed:')) {
    const sv = String(stageVariable || '');
    const expr = head.slice('Guard failed: '.length);
    if (sv && expr.split(/[^A-Za-z0-9_]/).indexOf(sv) !== -1) return 'stage';
    return 'precondition';
  }
  return 'internal';
}

/** Stage label for a machine value, or the raw value when the config has no labels. */
export function stageNameOf(value: unknown, stages: unknown): string {
  const blank = value === undefined || value === null;
  if (!stages || typeof stages !== 'object' || Array.isArray(stages)) return blank ? '' : String(value);
  const nameOf: Record<string, string> = {};
  for (const entry of Object.entries(stages)) nameOf[String(entry[1])] = entry[0];
  if (blank) return '';
  const key = String(value);
  return Object.prototype.hasOwnProperty.call(nameOf, key) ? nameOf[key] : key;
}

export function stageNext(stageName: string): string {
  const place = stageName ? 'stage ' + stageName : 'the current stage';
  return 'do not retry this call in ' + place + '. The spec does not allow it here. Use a tool this stage permits, or wait until an allowed step or a human sign-off moves the stage. Do not edit the state file to skip ahead.';
}

export function preconditionNext(): string {
  return 'do not retry the same input. Satisfy the condition named above, then call again. Do not edit the state file to force it through.';
}

/**
 * Next step when the machine is waiting on a signal. Throws if the await
 * record is not the shape the compiler emits; the caller still denies.
 */
export function signoffNext(mode: string, signalName: string, outcomes: unknown, claims: unknown, command: string, runId: string, who?: unknown): string {
  if (!Array.isArray(outcomes)) throw new Error('await outcomes are not a list');
  const names: string[] = [];
  for (const o of outcomes) names.push(String(o));
  const claimBits: string[] = [];
  const claimDrop: Record<string, string> = {};
  if (Array.isArray(claims)) {
    for (const c of claims) {
      if (!c || typeof c !== 'object') throw new Error('await claim is not an object');
      const n = String((c as Record<string, unknown>)['name']);
      const t = String((c as Record<string, unknown>)['typeName']);
      claimBits.push(n + ': ' + t);
      claimDrop[n] = '<' + t + '>';
    }
  }
  const lead = mode === 'in'
    ? 'No tool call runs until this sign-off is recorded. '
    : 'Act tools stay refused until this sign-off is recorded; an observe tool may still run when the spec allows it. ';
  const drop: Record<string, unknown> = {
    signal: String(signalName),
    outcome: names.length ? '<' + names.join(' or ') + '>' : '<outcome>',
  };
  if (claimBits.length) drop.claims = claimDrop;
  drop.run = runId || '<run id printed by signal.mjs init>';
  drop.expires = '<ISO-8601>';
  drop.nonce = '<unique>';
  const note = typeof who === 'string' ? who : '';
  const runLine = command ? 'A human runs: ' + command + ' . ' : '';
  const tail = command
    ? 'The agent must not run that command or read the state key.'
    : 'The agent must not create a state file or read the state key.';
  return lead
    + 'Sign-off "' + String(signalName) + '" (outcomes: ' + (names.join(', ') || 'see the spec')
    + (claimBits.length ? '; claims: ' + claimBits.join(', ') : '')
    + '). ' + note + runLine + 'The signed drop is ' + JSON.stringify(drop) + '. ' + tail;
}

/** Next step when another call is still in flight. The call id is capped. */
export function pendingNext(callId: unknown, durationText: string, command: string, runId: string, who?: unknown): string {
  const raw = String(callId);
  const id = raw.length > 200 ? raw.slice(0, 200) : raw;
  const drop = JSON.stringify({
    signal: 'clear-pending',
    call_id: id,
    run: runId || '<run id printed by signal.mjs init>',
    expires: '<ISO-8601>',
    nonce: '<unique>',
  });
  const note = typeof who === 'string' ? who : '';
  const how = command
    ? 'A human can clear it sooner by recording signal "clear-pending" for call ' + JSON.stringify(id) + ' with: ' + command + ' . '
    : 'A human cannot clear it with file-drop until a new state is created with pinned signers. ';
  const tail = command
    ? 'The agent must not run that command or read the state key.'
    : 'The agent must not create a state file or read the state key.';
  return 'wait for that call to finish (it clears as failed after ' + durationText
    + '). ' + note + how + 'The signed drop is ' + drop + '. ' + tail;
}

export function internalNext(code: string): string {
  switch (code) {
    case 'spec-hash':
      return 'the state belongs to a different spec. A human creates a new state with signal.mjs init after the rails are deployed. Do not edit the state file and do not retry this call.';
    case 'integrity':
      return 'the state seal failed. A human restores a trusted state or creates a new one with signal.mjs init. Do not edit the state file and do not retry this call.';
    case 'unknown-tool':
      return 'this name is not a spec tool. Do not retry it. Call a tool the spec lists.';
    case 'stdin':
      return 'the hook input was not usable. Send one JSON object with tool, input and call_id. Do not retry the same bytes.';
    case 'usage':
      return 'the hook was started wrong. A human checks the hook command. Do not retry this call.';
    case 'lock':
      return 'the state lock could not be taken (fail closed). Wait and try a new call. Do not delete the lock from the agent.';
    case 'missing-state':
      return 'there is no state file yet. A human runs signal.mjs init. Do not create the file by hand.';
    case 'post-mismatch':
      return 'this result does not match the in-flight call. Do not invent a call id or a tool name. If a call is stuck, a human clears it with signal.mjs clear-pending.';
    case 'post-expired':
      return 'the earlier call did not advance the spec and has been cleared as failed. Start a new call if the spec still allows it. Do not retry this same result.';
    default:
      return 'the hook failed closed. Do not retry this call.';
  }
}

/** Assemble one deny sentence. Throws on a bad kind or an empty part. */
export function renderDenyReason(kind: string, detail: string, next: string, secrets: unknown, keep?: unknown): string {
  const labels: Record<string, string> = {
    stage: 'not allowed in this stage',
    signoff: 'waiting on a sign-off',
    precondition: 'precondition failed',
    internal: 'internal error (fail closed)',
  };
  const label = labels[kind];
  if (!label) throw new Error('unknown deny kind');
  if (typeof detail !== 'string' || detail.length === 0) throw new Error('missing deny detail');
  if (typeof next !== 'string' || next.length === 0) throw new Error('missing deny next step');
  const out = redactSecrets('Speckl denied (' + label + '): ' + detail + '. Next: ' + next, secrets, keep);
  if (out.indexOf('Speckl denied (') !== 0) throw new Error('deny text lost its class');
  return out;
}

export function fallbackDenyText(): string {
  return 'Speckl denied (internal error, fail closed): the explanation could not be built. Next: the call stays denied. Do not retry it.';
}

/** Run a reason builder. A throw, or an empty result, becomes the fixed sentence. */
export function safeDenyText(build: () => string): string {
  try {
    const text = build();
    if (typeof text !== 'string' || !text) throw new Error('empty deny reason');
    return text;
  } catch {
    return fallbackDenyText();
  }
}

/**
 * Adapter-level denial (unmapped tool, shell metacharacters, a protected
 * path, a bad payload). The decision to deny has already been made.
 */
export function explainAdapterDeny(reason: unknown, secrets: unknown): string {
  const r = String(reason);
  let next = 'Next: this call is denied (fail closed). Do not retry it unchanged.';
  if (r.indexOf('unmapped harness tool') !== -1) {
    next = 'Next: this harness tool is not in the spec map, so it is denied (fail closed). A human adds a map line for it and recompiles. Do not send the same work under a different harness tool name.';
  } else if (r.indexOf('shell control characters') !== -1) {
    next = 'Next: the command is not one plain command, so it is denied (fail closed). Send a single command with none of ; & | ` $ < > or a newline.';
  } else if (r.indexOf('Speckl-protected path') !== -1 || r.indexOf('protected path') !== -1) {
    next = 'Next: the rails, the state file and the state key are off limits (fail closed). Do not read or edit them.';
  } else if (r.indexOf('not JSON') !== -1 || r.indexOf('not a JSON') !== -1) {
    next = 'Next: the hook payload could not be read (fail closed). Do not retry the same payload.';
  } else if (r.indexOf('sets cwd') !== -1 || r.indexOf('sets workdir') !== -1) {
    next = 'Next: Speckl only accepts a command run in the project root (fail closed). Drop the other working directory and call again.';
  }
  return redactSecrets('Speckl: ' + r + ' ' + next, secrets);
}

/** Redact a sentence the adapter built around a hook reason or a tool name. */
export function scrubDenyText(text: unknown, secrets: unknown, keep?: unknown): string {
  return redactSecrets(String(text), secrets, keep);
}

/** Emitted into hook.mjs, in order. explainAdapterDeny stays in the adapter. */
export const DENY_REASON_FUNCTIONS = [
  shellQuote, redactSecrets, pinnedSignerNames, signerNote, applyCommand, classifyCanRefusal, stageNameOf,
  stageNext, preconditionNext, signoffNext, pendingNext, internalNext,
  renderDenyReason, fallbackDenyText, safeDenyText,
];
