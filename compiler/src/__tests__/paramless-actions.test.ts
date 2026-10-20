// Parameterless actions (`action Approve {`) keep their bodies in the IR.
//
// The IR located action bodies by scanning the raw source for
// `action Name(`, so an action written without parentheses lowered with no
// statements: every IR backend (Camel processors, IR Z3, TS-from-IR) saw an
// action with no guard and no effect. Bodies now come from the parser's own
// line range for each action node.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseSpeckContent } from '../parser.js';
import { lower } from '../ir/lower.js';
import type { IR, IRStmt } from '../ir/types.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { vi.restoreAllMocks(); });

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples');

function lowerFile(filePath: string): IR {
  return lower(parseSpeckContent(readFileSync(filePath, 'utf-8'), filePath), { filePath, resolveImports: false });
}

function lowerSrc(src: string): IR {
  const filePath = join(mkdtempSync(join(tmpdir(), 'speckl-paramless-')), 'T.speckdl');
  writeFileSync(filePath, src);
  return lowerFile(filePath);
}

/** `kind:target` / `kind` summary of an action's IR statements. */
function shape(ir: IR, action: string, speck = 0): string[] {
  const a = ir.specks[speck].facets.behavior.actions.find(x => x.name === action);
  if (!a) throw new Error(`no action ${action}`);
  return a.statements.map((s: IRStmt) => (s.target ? `${s.kind}:${s.target}` : s.kind));
}

describe('parameterless actions in the examples keep their statements in the IR', () => {
  it('ToggleSwitch', () => {
    const ir = lowerFile(join(examples, 'ToggleSwitch.speckdl'));
    expect(shape(ir, 'TurnOn')).toEqual(['require', 'assign:isOn', 'return']);
    expect(shape(ir, 'TurnOff')).toEqual(['require', 'assign:isOn', 'return']);
  });

  it('TwoPhaseCommit', () => {
    const ir = lowerFile(join(examples, 'TwoPhaseCommit.speckdl'));
    expect(shape(ir, 'TMCommit').slice(0, 3)).toEqual(['require', 'require', 'assign:tmState']);
    expect(shape(ir, 'TMAbort').slice(0, 3)).toEqual(['require', 'assign:tmState', 'assign:msgs']);
  });

  it('ReviewGate', () => {
    const ir = lowerFile(join(examples, 'ReviewGate.speckdl'));
    expect(shape(ir, 'RunTests')).toEqual(['require', 'assign:testsPassed', 'assign:stage']);
    expect(shape(ir, 'RequestReview')).toEqual(['require', 'assign:stage']);
    expect(shape(ir, 'Approve')).toEqual(['require', 'assign:approved', 'assign:stage']);
    expect(shape(ir, 'Merge')).toEqual(['require', 'assign:stage']);
  });

  it('AgentPolicy', () => {
    const ir = lowerFile(join(examples, 'AgentPolicy.speckdl'));
    expect(shape(ir, 'RunTests')).toEqual(['require', 'assign:testsPassed', 'assign:stage']);
    expect(shape(ir, 'RequestReview')).toEqual(['require', 'assign:stage']);
    expect(shape(ir, 'OpenPR')).toEqual(['require', 'assign:prFromApproved', 'assign:stage']);
  });

  it('ClaudeCodePolicy', () => {
    const ir = lowerFile(join(examples, 'ClaudeCodePolicy.speckdl'));
    expect(shape(ir, 'RunTests')).toEqual(['require', 'assign:testsPassed', 'assign:stage']);
    expect(shape(ir, 'RequestReview')).toEqual(['require', 'assign:stage']);
    expect(shape(ir, 'OpenPR')).toEqual(['require', 'assign:prFromApproved', 'assign:stage']);
    expect(shape(ir, 'Inspect')).toEqual(['return']);
  });

  it('the guard expression itself survives (ReviewGate Approve: stage == 2)', () => {
    const ir = lowerFile(join(examples, 'ReviewGate.speckdl'));
    const approve = ir.specks[0].facets.behavior.actions.find(a => a.name === 'Approve')!;
    expect(approve.statements[0].value).toMatchObject({ kind: 'binop', op: '==', left: { kind: 'ident', name: 'stage' }, right: { kind: 'int_lit', value: 2 } });
  });
});

describe('action body extraction', () => {
  const wrap = (actions: string) => `speck T {
    state {
        x: Nat
    }
${actions}
}
`;

  it('treats parenthesized and bare actions alike', () => {
    const ir = lowerSrc(wrap(`    action A {
        require x == 0
        x := 1
    }
    action B() {
        require x == 0
        x := 1
    }`));
    expect(shape(ir, 'A')).toEqual(shape(ir, 'B'));
    expect(shape(ir, 'A')).toEqual(['require', 'assign:x']);
  });

  it('a body with nested braces ends at the action\u2019s own closing brace', () => {
    const ir = lowerSrc(wrap(`    action A {
        if x == 0 {
            x := 1
        }
        x := 2
    }
    action B {
        x := 3
    }`));
    expect(shape(ir, 'A')).toEqual(['if', 'assign:x']);
    expect(shape(ir, 'B')).toEqual(['assign:x']);
  });

  it('two specks in one file each get their own same-named action (the old whole-file scan gave both the last body)', () => {
    const src = `speck P {
    state {
        x: Nat
    }
    action Step() {
        x := 1
    }
}

speck Q {
    state {
        y: Nat
    }
    action Step() {
        require y == 0
        y := 2
    }
}
`;
    const ir = lowerSrc(src);
    expect(shape(ir, 'Step', 0)).toEqual(['assign:x']);
    expect(shape(ir, 'Step', 1)).toEqual(['require', 'assign:y']);
  });
});
