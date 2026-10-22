// Parser / printer / IR diagnostics for agent { } blocks.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpeckContent, parseDurationToMs } from '../parser.js';
import { printAST } from '../printer.js';
import { lower } from '../ir/lower.js';
import { injectSignalActions } from '../generators/agent/inject-signals.js';

const MINIMAL = `speck Mini {
    state {
        stage: Nat
    }
    init {
        stage := 0
    }
    action Go {
        require stage == 0
        stage := 1
    }
    action Peek {
        return true
    }
    agent {
        stages stage {
            Idle = 0
            AwaitingReview = 1
            Approved = 2
            Rejected = 3
        }
        tool go -> Go effect act
        tool peek -> Peek effect observe
        await AwaitingReview {
            signal review
            mode near
            require outcome in { approve, reject! }
            require claims { reviewer: String }
            on approve -> Approved
            on reject -> Rejected
            timeout 24h -> reject
        }
    }
    next: Go | Peek
}
`;

describe('parseDurationToMs', () => {
  it('parses h/m/s/ms/d', () => {
    expect(parseDurationToMs('24h')).toBe(86_400_000);
    expect(parseDurationToMs('30m')).toBe(1_800_000);
    expect(parseDurationToMs('90s')).toBe(90_000);
    expect(parseDurationToMs('500ms')).toBe(500);
    expect(parseDurationToMs('1d')).toBe(86_400_000);
  });
  it('rejects junk', () => {
    expect(() => parseDurationToMs('24')).toThrow(/duration/);
  });
});

describe('agent { } parser', () => {
  it('parses tools, stages, await, timeout', () => {
    const ast = parseSpeckContent(MINIMAL);
    const agent = ast.specks[0].members.find(m => m.type === 'agent');
    expect(agent?.type).toBe('agent');
    if (agent?.type !== 'agent') return;
    expect(agent.stages?.variable).toBe('stage');
    expect(agent.tools).toHaveLength(2);
    expect(agent.tools[0]).toEqual({ name: 'go', action: 'Go', effect: 'act' });
    expect(agent.awaits[0].mode).toBe('near');
    expect(agent.awaits[0].timeout?.durationText).toBe('24h');
    expect(agent.awaits[0].claims[0].name).toBe('reviewer');
    expect(agent.awaits[0].bindCall).toEqual([]);
  });

  it('round-trips through the printer', () => {
    const ast = parseSpeckContent(MINIMAL);
    const printed = printAST(ast);
    const again = parseSpeckContent(printed);
    const a = ast.specks[0].members.find(m => m.type === 'agent');
    const b = again.specks[0].members.find(m => m.type === 'agent');
    expect(b).toEqual(expect.objectContaining({
      type: 'agent',
      tools: (a as any).tools,
      awaits: expect.arrayContaining([
        expect.objectContaining({ state: 'AwaitingReview', signal: 'review', mode: 'near' }),
      ]),
    }));
  });

  it('rejects unknown tool action at lower time', () => {
    const src = MINIMAL.replace('tool go -> Go effect act', 'tool go -> NoSuch effect act');
    const dir = mkdtempSync(join(tmpdir(), 'speckl-agent-diag-'));
    const file = join(dir, 'x.speckdl');
    writeFileSync(file, src);
    try {
      const ir = lower(parseSpeckContent(src, file), { filePath: file, resolveImports: false });
      expect(ir.diagnostics.some(d => d.level === 'error' && /unknown action/.test(d.message))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects timeout to a non-reject outcome', () => {
    const src = MINIMAL.replace('timeout 24h -> reject', 'timeout 24h -> approve');
    const dir = mkdtempSync(join(tmpdir(), 'speckl-agent-to-'));
    const file = join(dir, 'x.speckdl');
    writeFileSync(file, src);
    try {
      const ir = lower(parseSpeckContent(src, file), { filePath: file, resolveImports: false });
      expect(ir.diagnostics.some(d => /timeout may only resolve to a reject/.test(d.message))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects bad tool syntax at parse time', () => {
    expect(() => parseSpeckContent(MINIMAL.replace('effect act', 'effect side'))).toThrow(/unexpected line|effect/);
  });

  it('injectSignalActions appends synthetics to next:', () => {
    const inj = injectSignalActions(parseSpeckContent(MINIMAL));
    const actions = inj.specks[0].members.filter(m => m.type === 'action').map((m: any) => m.name);
    expect(actions).toContain('__signal_review_approve');
    expect(actions).toContain('__signal_review_reject');
    const next = inj.specks[0].members.find(m => m.type === 'next') as any;
    expect(next.actions).toContain('__signal_review_approve');
  });
});
