import { readFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAX_SOURCE_BYTES,
  MAX_SOURCE_LINES,
  sourceLineCount,
  MIN_ACCEPTED_BYTES,
  RequestGate,
  applyHash,
  compileSource,
  compilerLoadFailureMessage,
  cursorLineCol,
  decodeBase64Url,
  decodeSpecHash,
  crc32,
  encodeBase64Url,
  encodeSpecHash,
  filesForTarget,
  formatBytes,
  hashForSource,
  historyMode,
  lineRange,
  looksBinary,
  normalizeTarget,
  orderOutputPaths,
  preferredOutput,
  presentDiagnostic,
  proofNote,
  uncheckedObligationCount,
  z3InfoDiagnostic,
  shareAllowed,
  shouldConfirmDiscard,
  sortDiagnostics,
  cleanErrorMessage,
  fromIR,
  hashRejectNotice,
  locateDiagnostic,
  timeoutMessage,
  workerCrashMessage,
} from '../browser/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.resolve(here, '..', '..', '..', 'examples');
const deploy = readFileSync(join(examples, 'DeployGate.speckdl'), 'utf8');
const agent = readFileSync(join(examples, 'AgentPolicy.speckdl'), 'utf8');
const toggle = readFileSync(join(examples, 'ToggleSwitch.speckdl'), 'utf8');

function xorshift(seed: number): () => number {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

describe('share links', () => {
  it('round-trips unicode, emoji, RTL, tabs, and CRLF', () => {
    const samples = ['', 'a', 'ab', 'abc', 'abcd', 'DeployGate', 'مرحبا 😀', 'a\tb\r\nc', 'line\n'.repeat(20)];
    for (const sample of samples) {
      const back = decodeSpecHash('#' + encodeSpecHash(sample));
      expect(back).toEqual({ ok: true, source: sample });
    }
  });

  it('round-trips every byte length mod 3', () => {
    for (let n = 0; n < 12; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 17 + 3) & 255);
      const decoded = decodeBase64Url(encodeBase64Url(bytes));
      expect(decoded).toEqual(bytes);
    }
  });

  it('accepts standard base64 padding and rejects damaged text', () => {
    expect(decodeSpecHash('#s1.YQ==')).toEqual({ ok: true, source: 'a' });
    const damaged = decodeSpecHash('#s1.!!!!');
    expect(damaged.ok).toBe(false);
    if (!damaged.ok) expect(damaged.message).toMatch(/damaged|edited/i);
    const foreign = decodeSpecHash('#<script>alert(1)</script>');
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.message).toMatch(/not a Speckl playground link/);
    const garbage = decodeSpecHash('#garbage');
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) {
      expect(garbage.message).toMatch(/not a Speckl playground link/);
      expect(garbage.message).not.toMatch(/example was loaded/);
      expect(hashRejectNotice(garbage.message, true)).toMatch(/left unchanged/);
      expect(hashRejectNotice(garbage.message, true)).not.toMatch(/example was loaded/);
      expect(hashRejectNotice(garbage.message, false)).toMatch(/An example was loaded instead/);
    }
    const unknown = decodeSpecHash('#s3.abcd');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toMatch(/version s3/);
    const short = decodeSpecHash('#s2.abcd');
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.message).toMatch(/cut off/);
    expect(decodeSpecHash('').ok).toBe(false);
    expect(decodeSpecHash('s1.' + 'a'.repeat(4_000_001)).ok).toBe(false);
    const badUtf = decodeSpecHash('s1.' + encodeBase64Url(new Uint8Array([0xff, 0xfe, 0xfd])));
    expect(badUtf.ok).toBe(false);
    if (!badUtf.ok) expect(badUtf.message).toMatch(/readable text/);
  });

  it('refuses a decoded spec over the byte cap', () => {
    const huge = 's1.' + encodeBase64Url(new Uint8Array(MAX_SOURCE_BYTES + 1));
    const decoded = decodeSpecHash(huge);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.message).toMatch(/limit/);
  });

  it('decides what a hash does to the editor', () => {
    expect(applyHash('', 'x')).toEqual({ action: 'ignore' });
    expect(applyHash('#', 'x')).toEqual({ action: 'ignore' });
    expect(applyHash('#s1.', '')).toEqual({ action: 'ignore' });
    expect(applyHash('#s1.', 'kept')).toEqual({ action: 'load', source: '' });
    const same = '#' + encodeSpecHash('kept');
    expect(applyHash(same, 'kept')).toEqual({ action: 'ignore' });
    const other = applyHash(same, 'other');
    expect(other).toEqual({ action: 'load', source: 'kept' });
    const bad = applyHash('#nope', '');
    expect(bad.action).toBe('reject');
  });

  it('keeps large specs out of the URL', () => {
    expect(shareAllowed('ok')).toBe(true);
    expect(shareAllowed('x'.repeat(60_001))).toBe(false);
    const big = hashForSource('x'.repeat(60_001));
    expect(big.hash).toBe('');
    expect(big.reason).toMatch(/too large/);
    const small = hashForSource('speck S {}');
    expect(small.hash.startsWith('#s2.')).toBe(true);
  });

  it('rejects a cut-off or edited s2 link and still reads s1', () => {
    const hash = encodeSpecHash('speck S { state { x: Nat } }');
    expect(hash.startsWith('s2.')).toBe(true);
    const cut = decodeSpecHash('#' + hash.slice(0, -4));
    expect(cut.ok).toBe(false);
    if (!cut.ok) expect(cut.message).toMatch(/cut off/);
    const extra = decodeSpecHash('#' + hash + 'zzz');
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.message).toMatch(/cut off|edited/);
    const payload = hash.slice(3);
    const at = 4;
    const flipped = payload.slice(0, at) + (payload[at] === 'A' ? 'B' : 'A') + payload.slice(at + 1);
    const edited = decodeSpecHash('s2.' + flipped);
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.message).toMatch(/cut off|edited/);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('session rules', () => {
  it('drops stale compile ids', () => {
    const gate = new RequestGate();
    const first = gate.issue();
    const second = gate.issue();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it('pushes history for examples and settled edits, and replaces navigation', () => {
    expect(historyMode({ lastPushAt: 0, now: 10, hashChanged: false, reason: 'edit' })).toBe('skip');
    expect(historyMode({ lastPushAt: 0, now: 10, hashChanged: true, reason: 'boot' })).toBe('replace');
    expect(historyMode({ lastPushAt: 0, now: 10, hashChanged: true, reason: 'navigation' })).toBe('replace');
    expect(historyMode({ lastPushAt: 0, now: 10, hashChanged: true, reason: 'example' })).toBe('push');
    expect(historyMode({ lastPushAt: 0, now: 10, hashChanged: true, reason: 'edit' })).toBe('replace');
    expect(historyMode({ lastPushAt: 0, now: 2_000, hashChanged: true, reason: 'edit' })).toBe('push');
  });

  it('asks before discarding dirty edits', () => {
    expect(shouldConfirmDiscard('speck Edited {}', 'speck Loaded {}')).toBe(true);
    expect(shouldConfirmDiscard('speck Loaded {}', 'speck Loaded {}')).toBe(false);
    expect(shouldConfirmDiscard('', 'speck Loaded {}')).toBe(false);
    expect(shouldConfirmDiscard('   \n', 'speck Loaded {}')).toBe(false);
  });

  it('maps a caret and a line number back to the text', () => {
    const src = 'ab\r\ncd';
    expect(cursorLineCol(src, 0)).toEqual({ line: 1, column: 1 });
    expect(cursorLineCol(src, 4)).toEqual({ line: 2, column: 1 });
    expect(cursorLineCol(src, 99)).toEqual({ line: 2, column: 3 });
    expect(cursorLineCol(src, Number.NaN)).toEqual({ line: 1, column: 1 });
    expect(lineRange(src, 1)).toEqual({ start: 0, end: 3 });
    expect(lineRange(src, 2)).toEqual({ start: 4, end: 6 });
    expect(lineRange(src, 0)).toBeNull();
    expect(lineRange(src, 3)).toBeNull();
    expect(lineRange(src, 1.5)).toBeNull();
  });

  it('puts AGENTS.md and the hook ahead of other files', () => {
    const ordered = orderOutputPaths([
      'camel/A.java',
      'Toggle.ir.smt2',
      'Toggle.smt2',
      'Toggle.ts',
      'agent/hook.mjs',
      'agent/tools.json',
      'agent/AGENTS.md',
      'agent/Agent.ts',
    ]);
    expect(ordered[0]).toBe('agent/AGENTS.md');
    expect(ordered[1]).toBe('agent/hook.mjs');
    expect(ordered.indexOf('Toggle.smt2')).toBeLessThan(ordered.indexOf('Toggle.ir.smt2'));
    expect(ordered.indexOf('Toggle.ts')).toBeLessThan(ordered.indexOf('agent/Agent.ts'));
    expect(preferredOutput(ordered)).toBe('agent/AGENTS.md');
    expect(preferredOutput([])).toBeNull();
    expect(orderOutputPaths(['notes/AGENTS.md', 'other/hook.mjs'])[0]).toBe('notes/AGENTS.md');
  });

  it('lists the files for the selected target', () => {
    const paths = [
      'ClaudeCodePolicy.ts',
      'openapi/claudecodepolicy.openapi.json',
      'k8s/policies.speckl.dev.yaml',
      'claudecodepolicy.proto',
      'claudecodepolicy-elm/src/Types.elm',
      'camel/src/main/java/Go.java',
      'toggleswitch/toggle.go',
      'Toggle.ir.smt2',
      'agent/AGENTS.md',
    ];
    expect(filesForTarget(paths, 'openapi')[0]).toMatch(/openapi/);
    expect(filesForTarget(paths, 'openapi').some((p) => p.endsWith('.ts'))).toBe(false);
    expect(filesForTarget(paths, 'protobuf').every((p) => p.endsWith('.proto'))).toBe(true);
    expect(filesForTarget(paths, 'k8s').every((p) => p.includes('k8s/'))).toBe(true);
    expect(filesForTarget(paths, 'elm').every((p) => p.endsWith('.elm'))).toBe(true);
    expect(filesForTarget(paths, 'go').every((p) => p.endsWith('.go'))).toBe(true);
    expect(filesForTarget(paths, 'camel').every((p) => p.endsWith('.java'))).toBe(true);
    expect(filesForTarget(paths, 'z3').every((p) => p.endsWith('.smt2'))).toBe(true);
    expect(filesForTarget(paths, 'agent')[0]).toBe('agent/AGENTS.md');
    expect(filesForTarget(paths, 'typescript')).toEqual(['ClaudeCodePolicy.ts']);
    expect(filesForTarget(paths, 'all')).toHaveLength(paths.length);
    expect(filesForTarget(paths, 'all-ir')).toHaveLength(paths.length);
    expect(filesForTarget(['only.ts'], 'rust')).toEqual(['only.ts']);
    expect(filesForTarget(paths, 'nope')).toHaveLength(paths.length);
  });
});

describe('diagnostic text', () => {
  it('formats bytes, timeouts, and crashes in plain language', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(-1)).toBe('0 bytes');
    expect(formatBytes(Number.NaN)).toBe('0 bytes');
    expect(formatBytes(12)).toBe('12 bytes');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(timeoutMessage(8000)).toMatch(/8 seconds/);
    expect(timeoutMessage(10)).toMatch(/1 second/);
    expect(workerCrashMessage()).toMatch(/still in the editor/);
    expect(MAX_SOURCE_BYTES).toBeGreaterThan(MIN_ACCEPTED_BYTES);
    expect(MAX_SOURCE_BYTES).toBeLessThan(2 * 1024 * 1024);
    expect(sourceLineCount('')).toBe(0);
    expect(sourceLineCount('a')).toBe(1);
    expect(sourceLineCount('a\nb\n')).toBe(2);
    expect(MAX_SOURCE_LINES).toBe(12_000);
  });

  it('points a parse error at a line and strips stack frames', () => {
    const err = new Error('Parse error at line 4: bad\n    at parse (parser.ts:1:1)');
    expect(cleanErrorMessage(err)).toBe('Parse error at line 4: bad');
    expect(cleanErrorMessage('plain')).toBe('plain');
    expect(cleanErrorMessage(3)).toBe('The compiler failed.');
    expect(cleanErrorMessage(new Error('   '))).toBe('The compiler failed.');
    const located = locateDiagnostic('a\nb\nverify nope', 'Parse error at line 2: verify nope');
    expect(located.line).toBe(2);
    const withColumn = locateDiagnostic('}\n', 'Parse error at line 1, column 1: unexpected `}`');
    expect(withColumn).toMatchObject({ line: 1, column: 1 });
    const inferred = locateDiagnostic('  }\n', 'Parse error at line 1: unexpected `}`');
    expect(inferred.column).toBe(3);
    const quoted = locateDiagnostic('keep\nthis exact snippet here', 'Failed: "this exact snippet"');
    expect(quoted.line).toBe(2);
    expect(locateDiagnostic('abc', 'no location')).toEqual({ level: 'error', message: 'no location' });
    expect(locateDiagnostic('abc', '   ')).toEqual({ level: 'error', message: 'The compiler failed.' });
  });

  it('prefixes a line and a speck name when the message does not', () => {
    expect(presentDiagnostic({ level: 'error', message: 'duplicate tool', line: 9, speck: 'Bad' }))
      .toBe('Line 9: Bad: duplicate tool');
    expect(presentDiagnostic({ level: 'error', message: 'duplicate tool', line: 9, column: 4, speck: 'Bad' }))
      .toBe('Line 9, column 4: Bad: duplicate tool');
    expect(presentDiagnostic({ level: 'error', message: 'Parse error at line 3, column 2: nope', line: 3, column: 2 }))
      .toBe('Line 3, column 2: nope');
    expect(presentDiagnostic({ level: 'info', message: 'hello' })).toBe('hello');
    const ir = fromIR('x\n  bogus := 1\n', { level: 'error', message: 'undeclared variable "bogus"', line: 2, speck: 'T' });
    expect(ir.column).toBe(3);
    expect(presentDiagnostic(ir)).toBe('Line 2, column 3: T: undeclared variable "bogus"');
    const sorted = sortDiagnostics([
      { level: 'info', message: 'i', line: 1 },
      { level: 'error', message: 'e', line: 8 },
      { level: 'warning', message: 'w' },
      { level: 'error', message: 'earlier', line: 2 },
    ]);
    expect(sorted.map((d) => d.message)).toEqual(['earlier', 'e', 'w', 'i']);
  });

  it('treats NUL and control-heavy text as binary, and tabs as text', () => {
    expect(looksBinary('')).toBe(false);
    expect(looksBinary('hello\tworld\r\n')).toBe(false);
    expect(looksBinary('ok\0no')).toBe(true);
    expect(looksBinary('\u0001'.repeat(20) + 'a'.repeat(20))).toBe(true);
    expect(looksBinary('a'.repeat(100) + '\u0001')).toBe(false);
  });
});

describe('compileSource', () => {
  it('compiles DeployGate to AGENTS.md and a hook', () => {
    const result = compileSource(deploy, { target: 'all' });
    expect(result.ok, result.diagnostics.map((d) => d.message).join('\n')).toBe(true);
    const agents = result.files.find((f) => f.path === 'agent/AGENTS.md');
    const hook = result.files.find((f) => f.path === 'agent/hook.mjs');
    expect(agents?.text).toContain('Call-bound');
    expect(hook?.text).toContain('pre');
    expect(result.files.some((f) => f.path.endsWith('.smt2'))).toBe(true);
    expect(result.files.some((f) => f.path.endsWith('.ts'))).toBe(true);
    expect(result.diagnostics.some((d) => d.level === 'info' && d.message.includes('Proofs are not run in the browser'))).toBe(true);
    expect(result.diagnostics.some((d) => d.level === 'warning' && /\.ir\.smt2|output line/.test(d.message))).toBe(false);
    expect(z3InfoDiagnostic().message).toMatch(/Proofs are not run/);
    expect(proofNote(2).message).toMatch(/2 checks/);
    expect(uncheckedObligationCount([{ path: 'A.smt2', text: '; speckl-unchecked: goal\n; ok\n' }])).toBe(1);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('compiles the agent policy example and a spec with no agent block', () => {
    const policy = compileSource(agent, { target: 'agent' });
    expect(policy.ok, policy.diagnostics.map((d) => d.message).join('\n')).toBe(true);
    expect(policy.files.some((f) => f.path === 'agent/AGENTS.md')).toBe(true);
    expect(policy.files.some((f) => f.path.includes('openapi'))).toBe(false);

    const machine = compileSource(toggle, { target: 'typescript' });
    expect(machine.files.some((f) => f.path.endsWith('.ts'))).toBe(true);
    expect(machine.files.some((f) => f.path.endsWith('AGENTS.md'))).toBe(false);
    const all = compileSource(toggle, { target: 'all' });
    expect(all.diagnostics.some((d) => /no agent block/.test(d.message))).toBe(false);
    const rails = compileSource(toggle, { target: 'agent' });
    expect(rails.diagnostics.some((d) => /no agent block/.test(d.message))).toBe(true);
    expect(rails.diagnostics.some((d) => /does not drive an agent/.test(d.message))).toBe(true);
    expect(compilerLoadFailureMessage()).toMatch(/Couldn't load the compiler/);
  });

  it('reports an empty editor, garbage, and a parse error on a line', () => {
    expect(compileSource('   \n').diagnostics[0].message).toMatch(/Nothing to compile/);
    const garbage = compileSource('this is not a spec\n@@@@');
    expect(garbage.ok).toBe(false);
    expect(garbage.diagnostics.some((d) => d.line === 1 && d.message.includes('speck Name'))).toBe(true);
    const bad = compileSource('speck S {\n verify nope\n state { x: Nat }\n}\n');
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.some((d) => d.line === 2 && /unsupported verify/.test(d.message))).toBe(true);
  });

  it('keeps a line number for an agent mistake and still emits other targets', () => {
    const src = `speck Bad {
  state { stage: Nat }
  init { stage := 0 }
  action Go { stage := 1 }
  agent {
    stages stage { Idle = 0 }
    tool go -> Go effect act
    tool go -> Go effect act
  }
}
`;
    const result = compileSource(src, { target: 'all' });
    expect(result.ok).toBe(false);
    const dup = result.diagnostics.find((d) => d.message.includes('duplicate tool'));
    expect(dup?.line).toBeGreaterThan(0);
    expect(result.diagnostics.some((d) => d.message.startsWith('agent block is invalid'))).toBe(false);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.some((f) => f.path.endsWith('AGENTS.md'))).toBe(false);
  });

  it('names an unknown next: action and an unknown compile target falls back to all', () => {
    expect(normalizeTarget('nope')).toBe('all');
    expect(normalizeTarget('agent')).toBe('agent');
    expect(normalizeTarget(undefined)).toBe('all');
    const result = compileSource('speck Bad {\n state { x: Nat }\n action Go { x := 1 }\n next: Missing\n}\n', { target: 'nope' });
    const diag = result.diagnostics.find((d) => d.message.includes('Missing'));
    expect(diag?.level).toBe('error');
    expect(diag?.line).toBeGreaterThan(0);
    expect(result.files.length).toBeGreaterThan(0);
    const nexts = result.diagnostics.filter((d) => /next: references unknown action/.test(d.message));
    expect(nexts.length).toBeGreaterThan(0);
    expect(nexts.every((d) => d.line !== undefined)).toBe(true);
  });

  it('accepts CRLF, tabs, emoji, and RTL text', () => {
    const src = 'speck S {\r\n\tstate {\r\n\t\tx: Nat\r\n\t}\r\n\t// مرحبا 😀\r\n}\r\n';
    const result = compileSource(src, { target: 'typescript' });
    expect(result.ok, result.diagnostics.map((d) => d.message).join('\n')).toBe(true);
    expect(result.files.some((f) => f.text.includes('class') || f.path.endsWith('.ts'))).toBe(true);
  });

  it('refuses binary input and specs over the cap', () => {
    const binary = compileSource('speck S {\0}\n');
    expect(binary.ok).toBe(false);
    expect(binary.files).toEqual([]);
    expect(binary.diagnostics[0].message).toMatch(/binary/);
    const huge = compileSource('x'.repeat(200), { maxBytes: 20 });
    expect(huge.diagnostics[0].message).toMatch(/playground limit/);
    expect(compileSource('hi', { maxBytes: Number.NaN }).diagnostics[0].message).toMatch(/limit/);
  });

  it('warns on a very long line and shortens huge outputs', () => {
    const src = 'speck S {\n // ' + 'x'.repeat(20_001) + '\n state { x: Nat }\n}\n';
    const result = compileSource(src, { target: 'typescript' });
    expect(result.diagnostics.some((d) => d.line === 2 && d.message.includes('characters on one line'))).toBe(true);
    const short = compileSource(deploy, { target: 'agent', maxFileChars: 40, maxTotalChars: 80 });
    expect(short.files.some((f) => f.truncated)).toBe(true);
    expect(short.files.every((f) => !f.path.includes('..'))).toBe(true);
  });

  it('compiles ten thousand comment lines and a megabyte of comment text', () => {
    const lines = 'speck Big {\n' + '// line\n'.repeat(10_000) + ' state { x: Nat }\n}\n';
    const many = compileSource(lines, { target: 'typescript' });
    expect(many.ok, many.diagnostics.map((d) => d.message).join('\n')).toBe(true);

    const fat = 'speck Big {\n // ' + 'x'.repeat(1_100_000) + '\n state { x: Nat }\n}\n';
    expect(fat.length).toBeGreaterThan(MIN_ACCEPTED_BYTES);
    const wide = compileSource(fat, { target: 'typescript' });
    expect(wide.files.some((f) => f.path.endsWith('.ts'))).toBe(true);
    expect(wide.diagnostics.some((d) => d.level === 'error' && d.message.includes('limit'))).toBe(false);
  }, 30_000);

  it('returns on nested parentheses instead of hanging', () => {
    const src = 'speck S {\n constraint C: ' + '('.repeat(4_000) + 'true' + ')'.repeat(4_000) + '\n state { x: Nat }\n}\n';
    const started = Date.now();
    const result = compileSource(src, { target: 'typescript' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(Array.isArray(result.diagnostics)).toBe(true);
    expect(result.files.every((f) => typeof f.text === 'string')).toBe(true);
  });

  it('does not spin on the worker test marker', () => {
    const src = 'speck S {\n /*__SPECKL_SPIN__*/\n state { x: Nat }\n}\n';
    const started = Date.now();
    const result = compileSource(src, { target: 'typescript' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.files.some((f) => f.path.endsWith('.ts'))).toBe(true);
  });

  it('never throws on fuzzed input and always returns text diagnostics', () => {
    const rand = xorshift(0x51ec41);
    const alphabet = 'speck \n{}:<>"\'/\\@\t\r😀א\u0001<script>';
    const cases = [
      '',
      '\0\0',
      '{'.repeat(2_000),
      'speck {',
      'a'.repeat(50_000),
      'speck S {\n' + '{\n'.repeat(1_000),
    ];
    for (let i = 0; i < 24; i++) {
      const len = Math.floor(rand() * 400);
      let s = '';
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
      cases.push(s);
    }
    for (const source of cases) {
      const result = compileSource(source, { target: 'typescript' });
      expect(typeof result.ok).toBe('boolean');
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      for (const d of result.diagnostics) {
        expect(d.message.length).toBeGreaterThan(0);
        expect(['error', 'warning', 'info']).toContain(d.level);
      }
      for (const file of result.files) {
        expect(file.path.includes('..')).toBe(false);
        expect(typeof file.text).toBe('string');
      }
    }
  }, 30_000);
});
