import { describe, it, expect } from 'vitest';
import {
  shellQuote, redactSecrets, pinnedSignerNames, signerNote, applyCommand, classifyCanRefusal, stageNameOf,
  stageNext, preconditionNext, signoffNext, pendingNext, internalNext,
  renderDenyReason, fallbackDenyText, safeDenyText, explainAdapterDeny,
  DENY_REASON_FUNCTIONS,
} from '../deny-reason.js';

const HEX = 'ab'.repeat(32);
const PEM = '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----';

describe('deny reason text', () => {
  it('quotes a path and keeps an embedded single quote', () => {
    expect(shellQuote("/tmp/state.json")).toBe("'/tmp/state.json'");
    expect(shellQuote("o'brien")).toBe("'o'\\''brien'");
  });

  it('builds the file-drop command with the hook paths and no key flag', () => {
    const cmd = applyCommand('/opt/agent/signal.mjs', '/var/state.json', 'apply');
    expect(cmd).toBe("node '/opt/agent/signal.mjs' apply --state '/var/state.json' --verifier file-drop --file <drop.json> --pubkey <pubkey>");
    expect(cmd).not.toContain('--key');
    expect(applyCommand('/s.mjs', '/st.json', 'clear-pending')).toContain('clear-pending');
    expect(pinnedSignerNames(undefined)).toBeNull();
    expect(signerNote(undefined)).toBe('');
  });

  it('names pinned signers and never prints their keys', () => {
    const hex = 'cd'.repeat(32);
    const one = [{ name: 'alice', key: hex }];
    const two = [{ name: 'alice', key: hex }, { name: "o'brien", key: 'ef'.repeat(32) }];
    expect(pinnedSignerNames(one)).toEqual(['alice']);
    expect(pinnedSignerNames(two)).toEqual(['alice', "o'brien"]);
    const single = applyCommand('/s.mjs', '/st.json', 'apply', one);
    expect(single).toBe("node '/s.mjs' apply --state '/st.json' --verifier file-drop --file <drop.json> --signer 'alice'");
    expect(single).not.toContain('--pubkey');
    expect(single).not.toContain(hex);
    expect(signerNote(one)).toContain('Pinned signer "alice"');
    expect(signerNote(one)).not.toContain(hex);
    const many = applyCommand('/s.mjs', '/st.json', 'clear-pending', two);
    expect(many).toBe("node '/s.mjs' clear-pending --state '/st.json' --verifier file-drop --file <drop.json>");
    expect(many).not.toContain('--signer');
    expect(many).not.toContain('--pubkey');
    expect(signerNote(two)).toContain('"alice", "o\'brien"');
    expect(signerNote(two)).not.toContain(hex);
    expect(applyCommand('/s.mjs', '/st.json', 'apply', [])).toBe('');
    expect(signerNote([])).toContain('No sign-off signers are pinned');
    expect(signerNote([])).toContain('init --signer');
    expect(() => pinnedSignerNames(null)).toThrow(/not a list/);
    expect(() => pinnedSignerNames('alice')).toThrow(/not a list/);
    expect(() => pinnedSignerNames([null])).toThrow(/not an object/);
    expect(() => pinnedSignerNames(['alice'])).toThrow(/not an object/);
    expect(() => pinnedSignerNames([{ key: hex }])).toThrow(/no name/);
    expect(() => pinnedSignerNames([{ name: '' }])).toThrow(/no name/);
    const noted = signoffNext('near', 'review', ['approve'], [], single, 'run', signerNote(one));
    expect(noted).toContain(single);
    expect(noted).toContain('Do not pass --pubkey');
    expect(noted).not.toContain(hex);
    const none = signoffNext('near', 'review', ['approve'], [], '', 'run', signerNote([]));
    expect(none).not.toContain('A human runs:');
    expect(none).toContain('must not create a state file');
    const cleared = pendingNext('c1', '10m', '', 'run', signerNote([]));
    expect(cleared).toContain('cannot clear it with file-drop');
    expect(cleared).toContain('Do not pass --pubkey');
    expect(cleared).not.toContain('--pubkey <pubkey>');
  });

  it('redacts key paths, PEM blocks and 64-hex secrets, and caps length', () => {
    const raw = 'see /etc/speckl/state.key and ' + HEX + ' and ' + PEM + ' and short';
    const out = redactSecrets(raw, ['/etc/speckl/state.key', 'short', 12, null]);
    expect(out).not.toContain('/etc/speckl/state.key');
    expect(out).not.toContain(HEX);
    expect(out).not.toContain('BEGIN PUBLIC KEY');
    expect(out).toContain('<keyfile>');
    expect(out).toContain('<redacted>');
    expect(out).toContain('short');
    const key = '/tmp/proj/keys/state.key';
    const secrets = [key, '/tmp/proj/keys'];
    expect(redactSecrets('mcp__/tmp/proj//keys/state.key', secrets)).toBe('mcp__<keyfile>');
    expect(redactSecrets('../keys/state.key', secrets)).toBe('<keyfile>');
    expect(redactSecrets('/tmp/proj/keys/./state.key', secrets)).toBe('<keyfile>');
    expect(redactSecrets('/tmp/proj/keys/./state.key', secrets)).not.toContain('/./');
    expect(redactSecrets('keys/./state.key', secrets)).toBe('<keyfile>');
    expect(redactSecrets('see keys/../keys/state.key please', secrets)).toBe('see <keyfile> please');
    expect(redactSecrets('mcp__//tmp/proj/keys/state.key', secrets)).toBe('mcp__<keyfile>');
    expect(redactSecrets('..\\keys\\state.key', secrets)).toBe('<keyfile>');
    expect(redactSecrets('%2e%2e%2fkeys%2fstate.key', secrets)).toBe('<keyfile>');
    expect(redactSecrets('mcp__srv__get%2Fitems%2e', secrets)).toBe('mcp__srv__get%2Fitems%2e');
    expect(redactSecrets('plain', null)).toBe('plain');
    expect(redactSecrets('plain', { not: 'an array' })).toBe('plain');
    expect(redactSecrets('x'.repeat(1801), []).endsWith('…')).toBe(true);
    expect(redactSecrets('x'.repeat(1801), []).length).toBe(1801);
    const digest = 'cd'.repeat(32);
    const kept = redactSecrets('sign call ' + digest + ' canonical {"branch":"/proj/sekret.key"}',
      ['./sekret.key', '/proj/sekret.key'], [digest]);
    expect(kept).toContain(digest);
    expect(kept).not.toContain('/proj');
    expect(kept).not.toContain('sekret.key');
    expect(kept).toContain('<keyfile>');
    // A known secret wins over the keep-list, even when both are the same 64 hex chars.
    expect(redactSecrets('want ' + digest, [digest], [digest])).toBe('want <keyfile>');
    expect(redactSecrets('want ' + digest.toUpperCase(), [], [digest])).toContain(digest.toUpperCase());
  });

  it('redacts base64, base64url, uppercase hex, and SPKI forms of a 64-hex key', () => {
    const hex = '80fe5ea71d0ded8c77e6746ea2e50713fbef300810a72031fe99c437e0367fca';
    const raw = Buffer.from(hex, 'hex');
    const b64 = raw.toString('base64');
    const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_');
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]).toString('base64');
    const pem = '-----BEGIN PUBLIC KEY-----\n' + der + '\n-----END PUBLIC KEY-----';
    const forms = [
      hex, hex.toUpperCase(),
      b64, b64.replace(/=+$/, ''),
      b64url, b64url.replace(/=+$/, ''),
      der, der.replace(/=+$/, ''),
      pem, pem.replace(/\n/g, '\r\n'),
    ];
    expect(b64).toContain('+');
    expect(b64).toContain('/');
    const digest = 'cd'.repeat(32);
    const out = redactSecrets(forms.join(' | ') + ' | ' + digest, [hex], [digest]);
    for (const form of forms) expect(out, form).not.toContain(form);
    expect(out).toContain(digest);
    expect(out).toContain('<keyfile>');
    // A path that is not 64 hex is not expanded into key encodings.
    expect(redactSecrets('keep ab', ['/not/hex'])).toBe('keep ab');
  });

  it('classifies a can() refusal without treating a lookalike name as the stage', () => {
    expect(classifyCanRefusal('Guard failed: stage == Approved (stage is Idle)', 'stage')).toBe('stage');
    expect(classifyCanRefusal('Guard failed: stage == 0', 'stage')).toBe('stage');
    expect(classifyCanRefusal('Guard failed: testsPassed == true (stage is Idle)', 'stage')).toBe('precondition');
    expect(classifyCanRefusal('Guard failed: stage == 0', '')).toBe('precondition');
    expect(classifyCanRefusal('Precondition failed: path !== "" (stage is Idle)', 'stage')).toBe('precondition');
    expect(classifyCanRefusal('missing argument(s): path', 'stage')).toBe('precondition');
    expect(classifyCanRefusal('Postcondition failed: path !== path', 'stage')).toBe('internal');
    expect(classifyCanRefusal('unknown action: nope', 'stage')).toBe('internal');
  });

  it('names a stage from the label table and leaves a raw value otherwise', () => {
    expect(stageNameOf(0, { Idle: 0, Approved: 3 })).toBe('Idle');
    expect(stageNameOf(9, { Idle: 0 })).toBe('9');
    expect(stageNameOf(1, { toString: 1 })).toBe('toString');
    expect(stageNameOf(null, { Idle: 0 })).toBe('');
    expect(stageNameOf(4, null)).toBe('4');
    expect(stageNameOf(4, ['Idle'])).toBe('4');
    expect(stageNameOf(undefined, 1)).toBe('');
  });

  it('writes a stage next step and a precondition next step', () => {
    expect(stageNext('Idle')).toContain('stage Idle');
    expect(stageNext('Idle')).toContain('Do not edit the state file');
    expect(stageNext('')).toContain('the current stage');
    expect(preconditionNext()).toContain('do not retry the same input');
  });

  it('names the sign-off, the outcomes and the exact command', () => {
    const command = applyCommand('/a/signal.mjs', '/a/state.json', 'apply');
    const near = signoffNext('near', 'review', ['approve', 'reject'], [{ name: 'reviewer', typeName: 'String' }], command, 'abc123');
    expect(near).toContain('Act tools stay refused');
    expect(near).toContain('Sign-off "review"');
    expect(near).toContain('outcomes: approve, reject');
    expect(near).toContain('claims: reviewer: String');
    expect(near).toContain(command);
    expect(near).toContain('"run":"abc123"');
    expect(near).toContain('"outcome":"<approve or reject>"');
    expect(near).not.toContain('--key');
    const hitl = signoffNext('in', 'review', ['approve'], [], command, '');
    expect(hitl).toContain('No tool call runs');
    expect(hitl).toContain('<run id printed by signal.mjs init>');
    expect(hitl).not.toContain('claims:');
    const bare = signoffNext('near', 'gate', [], null, command, 'r');
    expect(bare).toContain('see the spec');
    expect(bare).toContain('"<outcome>"');
    expect(() => signoffNext('near', 'review', 'approve', [], command, 'r')).toThrow(/outcomes/);
    expect(() => signoffNext('near', 'review', ['approve'], ['carol'], command, 'r')).toThrow(/claim/);
  });

  it('gives the clear-pending command and caps a huge call id', () => {
    const command = applyCommand('/a/signal.mjs', '/a/state.json', 'clear-pending');
    const text = pendingNext('c1', '10m', command, 'run1', signerNote(undefined));
    expect(text).toContain('clear-pending');
    expect(text).toContain(command);
    expect(text).toContain('"call_id":"c1"');
    expect(text).toContain('"run":"run1"');
    expect(text).not.toContain('--key');
    const huge = pendingNext('z'.repeat(500), '1s', command, '');
    expect(huge).toContain('z'.repeat(200));
    expect(huge).not.toContain('z'.repeat(201));
    expect(huge).toContain('<run id printed by signal.mjs init>');
  });

  it('has a next step for every internal code', () => {
    for (const code of ['spec-hash', 'integrity', 'unknown-tool', 'stdin', 'usage', 'lock', 'missing-state', 'post-mismatch', 'post-expired', 'other']) {
      const text = internalNext(code);
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(/\/etc\/|BEGIN |[0-9a-f]{64}/);
    }
    expect(internalNext('spec-hash')).toContain('signal.mjs init');
    expect(internalNext('other')).toContain('failed closed');
  });

  it('renders each class and refuses a broken class or a sentence that lost its label', () => {
    const secrets = ['/etc/speckl/state.key'];
    const stage = renderDenyReason('stage', 'can() refused: Guard failed: stage == Approved', stageNext('Idle'), secrets);
    expect(stage.startsWith('Speckl denied (not allowed in this stage):')).toBe(true);
    expect(stage).toContain('Next:');
    expect(renderDenyReason('signoff', 'HNTL: waiting', 'a human runs it', null)).toContain('waiting on a sign-off');
    expect(renderDenyReason('precondition', 'Precondition failed: x', preconditionNext(), [])).toContain('precondition failed');
    expect(renderDenyReason('internal', 'state integrity: state key not found: /etc/speckl/state.key', internalNext('integrity'), secrets)).not.toContain('/etc/speckl/state.key');
    expect(() => renderDenyReason('nope', 'x', 'y', [])).toThrow(/unknown deny kind/);
    expect(() => renderDenyReason('stage', '', 'y', [])).toThrow(/detail/);
    expect(() => renderDenyReason('stage', 1 as unknown as string, 'y', [])).toThrow(/detail/);
    expect(() => renderDenyReason('stage', 'x', '', [])).toThrow(/next/);
    expect(() => renderDenyReason('stage', 'x', 2 as unknown as string, [])).toThrow(/next/);
    expect(() => renderDenyReason('stage', 'Speckl denied (gone', 'next', ['Speckl denied ('])).toThrow(/lost its class/);
  });

  it('drops the exception text when the builder throws and still returns a denial', () => {
    const secret = 'SUPER-SECRET-KEY-MATERIAL';
    expect(safeDenyText(() => { throw new Error(secret); })).toBe(fallbackDenyText());
    expect(safeDenyText(() => { throw new Error(secret); })).not.toContain(secret);
    expect(safeDenyText(() => '')).toBe(fallbackDenyText());
    expect(safeDenyText(() => 0 as unknown as string)).toBe(fallbackDenyText());
    expect(safeDenyText(() => 'kept')).toBe('kept');
    expect(fallbackDenyText()).toContain('fail closed');
    expect(fallbackDenyText()).toContain('stays denied');
  });

  it('adds a fail-closed next step for each adapter denial and redacts the key path', () => {
    const key = '/etc/speckl/k.key';
    const cases: [string, string][] = [
      ['unmapped harness tool "WebFetch" (fail closed)', 'not in the spec map'],
      ['command contains shell control characters', 'one plain command'],
      ['Read touches a Speckl-protected path (/etc/speckl/k.key)', 'off limits'],
      ['cannot resolve the protected path /tmp', 'off limits'],
      ['tool_input is a string that is not JSON', 'could not be read'],
      ['hook payload is not a JSON object', 'could not be read'],
      ['bash sets cwd "/tmp"', 'project root'],
      ['exec sets workdir "/tmp"', 'project root'],
      ['unknown event "nope"', 'Do not retry it unchanged'],
    ];
    for (const [reason, want] of cases) {
      const text = explainAdapterDeny(reason, [key]);
      expect(text.startsWith('Speckl: ' + reason.replace(key, '<keyfile>')) || text.startsWith('Speckl: ')).toBe(true);
      expect(text).toContain(want);
      expect(text).toContain('fail closed');
      expect(text).not.toContain(key);
    }
    expect(explainAdapterDeny('unmapped harness tool "X"', undefined)).toContain('map line');
  });

  it('emits plain functions with no imports', () => {
    for (const fn of [...DENY_REASON_FUNCTIONS, explainAdapterDeny]) {
      const src = fn.toString();
      expect(src.startsWith('function ' + fn.name + '('), src.slice(0, 80)).toBe(true);
      expect(src).not.toMatch(/__vite|import\(|require\(/);
    }
  });
});
