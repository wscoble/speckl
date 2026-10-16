// `!` reject marker and `pending timeout` syntax: parser, printer, IR and
// diagnostics (in process).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpeckContent, AgentMemberNode } from '../parser.js';
import { printAST } from '../printer.js';
import { lower } from '../ir/lower.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(compilerDir, '..', 'examples', 'AgentPolicy.speckdl'), 'utf-8');

const agentOf = (src: string) =>
  parseSpeckContent(src).specks[0].members.find((m): m is AgentMemberNode => m.type === 'agent')!;
function lowerSrc(src: string) {
  const file = join(mkdtempSync(join(tmpdir(), 'speckl-mark-')), 'x.speckdl');
  writeFileSync(file, src);
  return lower(parseSpeckContent(src, file), { filePath: file, resolveImports: false });
}
const errs = (src: string) => lowerSrc(src).diagnostics.filter(d => d.level === 'error').map(d => d.message);
const warns = (src: string) => lowerSrc(src).diagnostics.filter(d => d.level === 'warning').map(d => d.message);
const setOutcomes = (src: string, list: string) => src.replace('require outcome in { approve, reject! }', `require outcome in { ${list} }`);

describe('reject marker: parser', () => {
  it('records marked outcomes separately from names', () => {
    const a = agentOf(SRC).awaits[0];
    expect(a.outcomes).toEqual(['approve', 'reject']);
    expect(a.rejects).toEqual(['reject']);
  });

  it('accepts several markers, any names, and whitespace before !', () => {
    const a = agentOf(setOutcomes(SRC, 'approve, request_changes !, reject!')).awaits[0];
    expect(a.outcomes).toEqual(['approve', 'request_changes', 'reject']);
    expect(a.rejects).toEqual(['request_changes', 'reject']);
  });

  it('no marker means no reject outcomes (names are never guessed)', () => {
    expect(agentOf(setOutcomes(SRC, 'approve, reject').replace('timeout 24h -> reject\n', '')).awaits[0].rejects).toEqual([]);
  });

  it.each([
    ['double bang', 'approve, reject!!', /not an identifier/],
    ['leading bang', 'approve, !reject', /not an identifier/],
    ['duplicate outcome', 'approve, reject!, reject', /duplicate outcome reject/],
  ])('rejects %s', (_n, list, re) => {
    expect(() => parseSpeckContent(setOutcomes(SRC, list))).toThrow(re);
  });

  it('printer round-trips the marker', () => {
    const src = setOutcomes(SRC, 'approve, veto!, reject!');
    const once = printAST(parseSpeckContent(src));
    expect(once).toContain('require outcome in { approve, veto!, reject! }');
    expect(printAST(parseSpeckContent(once))).toBe(once);
  });

  it('printer tolerates ASTs built without rejects (older callers)', () => {
    const ast = parseSpeckContent(SRC);
    delete (agentOf(SRC) as any).rejects;
    const agent = ast.specks[0].members.find((m): m is AgentMemberNode => m.type === 'agent')!;
    delete (agent.awaits[0] as any).rejects;
    expect(printAST(ast)).toContain('require outcome in { approve, reject }');
  });
});

describe('reject marker: IR and diagnostics', () => {
  it('IR carries rejects', () => {
    const ir = lowerSrc(SRC);
    expect((ir.specks[0].facets as any).behavior.agent.awaits[0].rejects).toEqual(['reject']);
    expect(warns(SRC).filter(w => /looks like a rejection/.test(w))).toEqual([]);
  });

  it('a timeout to an unmarked outcome named "reject" is an error', () => {
    const e = errs(setOutcomes(SRC, 'approve, reject'));
    expect(e.some(m => /timeout may only resolve to a reject outcome marked with ! \(got "reject"/.test(m)), e.join('\n')).toBe(true);
  });

  it('unmarked rejection-looking names warn', () => {
    const src = setOutcomes(SRC, 'approve, reject, deny').replace('timeout 24h -> reject\n', '');
    const w = warns(src);
    expect(w.some(m => /"reject" looks like a rejection/.test(m))).toBe(true);
    expect(w.some(m => /"deny" looks like a rejection/.test(m))).toBe(true);
  });

  it('a custom marked outcome is a valid timeout target', () => {
    const src = setOutcomes(SRC, 'approve, veto!').replace('on reject  -> Rejected', 'on veto -> Rejected').replace('timeout 24h -> reject', 'timeout 24h -> veto');
    expect(errs(src)).toEqual([]);
  });

  it('a marked outcome reaching an accepting stage is an error even without a timeout', () => {
    const src = SRC.replace('on reject  -> Rejected', 'on reject  -> Approved').replace('timeout 24h -> reject\n', '');
    expect(errs(src).some(m => /reject outcome "reject" leads to Approved, which a non-reject outcome also reaches/.test(m))).toBe(true);
  });

  it('two marked outcomes may share a stage', () => {
    const src = setOutcomes(SRC, 'approve, reject!, veto!').replace('on reject  -> Rejected', 'on reject  -> Rejected\n            on veto -> Rejected');
    expect(errs(src)).toEqual([]);
  });

  it('all-reject awaits warn that nothing can approve', () => {
    const src = setOutcomes(SRC, 'approve!, reject!').replace('on approve -> Approved', 'on approve -> Rejected');
    expect(warns(src).some(m => /every outcome is marked reject/.test(m))).toBe(true);
  });
});

describe('pending timeout syntax', () => {
  const withPending = (d: string) => SRC.replace('        await AwaitingReview {', `        pending timeout ${d}\n\n        await AwaitingReview {`);

  it('parses, lowers and round-trips', () => {
    const src = withPending('90s');
    expect(agentOf(src).pendingTimeout).toEqual({ durationMs: 90_000, durationText: '90s' });
    expect((lowerSrc(src).specks[0].facets as any).behavior.agent.pendingTimeout).toEqual({ durationMs: 90_000, durationText: '90s' });
    const once = printAST(parseSpeckContent(src));
    expect(once).toContain('    pending timeout 90s');
    expect(printAST(parseSpeckContent(once))).toBe(once);
  });

  it('is absent unless declared', () => {
    expect(agentOf(SRC).pendingTimeout).toBeUndefined();
    expect('pendingTimeout' in (lowerSrc(SRC).specks[0].facets as any).behavior.agent).toBe(false);
    expect(printAST(parseSpeckContent(SRC))).not.toContain('pending timeout');
  });

  it('rejects duplicates, bad durations and zero', () => {
    expect(() => parseSpeckContent(withPending('1m').replace('pending timeout 1m', 'pending timeout 1m\n        pending timeout 2m'))).toThrow(/duplicate pending timeout/);
    expect(() => parseSpeckContent(withPending('soon'))).toThrow(/duration/);
    expect(errs(withPending('0s')).some(m => /pending timeout must be greater than zero/.test(m))).toBe(true);
  });
});

describe('generateAgent edge shapes (in process)', () => {
  it('an agent block with no stages, awaits or pending timeout still emits working rails', async () => {
    const { generateAgent } = await import('../generators/agent/index.js');
    const src = `speck Bare {
    state {
        n: Nat
    }
    init {
        n := 0
    }
    action Bump {
        n := n + 1
    }
    agent {
        tool bump -> Bump effect act
    }
    next: Bump
}
`;
    const out = mkdtempSync(join(tmpdir(), 'speckl-bare-'));
    generateAgent(parseSpeckContent(src), { outputDir: out });
    const dir = join(out, 'agent');
    const cfg = JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf-8'));
    expect(cfg).toMatchObject({ stageVariable: 'stage', stages: {}, awaits: [], pendingTimeout: { durationText: '10m' } });
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toContain('_No await blocks._');
    const readme = readFileSync(join(dir, 'README.md'), 'utf-8');
    expect(readme).toContain('--outcome approve --as alice\n');
    expect(readme).toContain('"signal":"review"');
    const mod = await import(join(dir, 'Bare.mjs'));
    const m = new mod.BareMachine();
    m.Bump();
    expect(m.n).toBe(1);
  });

  it('pending timeout and custom reject markers flow into config and AGENTS.md', async () => {
    const { generateAgent } = await import('../generators/agent/index.js');
    const src = SRC
      .replace('require outcome in { approve, reject! }', 'require outcome in { approve, reject!, veto! }')
      .replace('on reject  -> Rejected', 'on reject  -> Rejected\n            on veto -> Rejected')
      .replace('        await AwaitingReview {', '        pending timeout 45s\n\n        await AwaitingReview {');
    const out = mkdtempSync(join(tmpdir(), 'speckl-pt-gen-'));
    generateAgent(parseSpeckContent(src), { outputDir: out, sourcePath: join(out, 'missing.speckdl') });
    const cfg = JSON.parse(readFileSync(join(out, 'agent', 'agent-config.json'), 'utf-8'));
    expect(cfg.pendingTimeout).toEqual({ durationMs: 45_000, durationText: '45s' });
    expect(cfg.awaits[0].rejects).toEqual(['reject', 'veto']);
    const md = readFileSync(join(out, 'agent', 'AGENTS.md'), 'utf-8');
    expect(md).toContain('`approve`, `reject` (reject), `veto` (reject)');
    expect(md).toContain('pending call older than `45s`');
  });
});
