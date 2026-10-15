// Runtime API of the generated TypeScript machine: can(), serialize(), restore().
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parseSpeckContent } from '../parser.js';
import { generateTypeScriptStateMachine } from '../generators/typescript-state-machine.js';

const SPEC = `speck Gate {
    state {
        stage: Nat
        opens: Nat
        seen: Set(String)
    }

    init {
        stage := 0
        opens := 0
    }

    action Request(who: String) {
        require stage == 0
        stage := 1
    }

    action Grant {
        require stage == 1
        stage := 2
        opens := opens + 1
    }

    next: Request | Grant
}
`;

let source = '';
let Gate: any;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-tsrt-'));
  generateTypeScriptStateMachine(parseSpeckContent(SPEC), dir);
  source = readFileSync(join(dir, 'Gate.ts'), 'utf-8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const file = join(dir, 'Gate.mjs');
  writeFileSync(file, js);
  Gate = (await import(pathToFileURL(file).href)).GateMachine;
});

describe('generated TS machine runtime API', () => {
  it('typechecks under --strict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-tsrt-tc-'));
    const file = join(dir, 'Gate.ts');
    writeFileSync(file, source);
    const program = ts.createProgram([file], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, skipLibCheck: true });
    const diags = ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(diags).toEqual([]);
  });

  it('exposes the action table with ordered parameter names', () => {
    expect(Gate.ACTIONS).toEqual({ Request: ['who'], Grant: [] });
  });

  it('can() answers without mutating the machine', () => {
    const m = new Gate();
    const before = JSON.stringify(m.serialize());
    expect(m.can('Request', { who: 'scott' })).toBe(true);
    expect(m.can('Grant')).toMatch(/^Guard failed/);
    expect(JSON.stringify(m.serialize())).toBe(before);
    expect(m.stage).toBe(0);
  });

  it('can() refuses unknown actions and missing arguments', () => {
    const m = new Gate();
    expect(m.can('Explode')).toBe('unknown action: Explode');
    expect(m.can('Request', {})).toBe('missing argument(s): who');
  });

  it('serialize/restore round-trips state, Sets, and the decision log', () => {
    const m = new Gate();
    m.seen = new Set(['a', 'b']);
    m.Request('scott');
    const snap = JSON.parse(JSON.stringify(m.serialize()));
    expect(snap.speck).toBe('Gate');
    const r = Gate.restore(snap);
    expect(r).toBeInstanceOf(Gate);
    expect(r.stage).toBe(1);
    expect(r.seen).toEqual(new Set(['a', 'b']));
    expect(r.can('Grant')).toBe(true);
    r.Grant();
    expect(r.opens).toBe(1);
    expect(m.opens).toBe(0);
  });

  it('restore rejects snapshots from another speck or with missing state', () => {
    expect(() => Gate.restore({ speck: 'Other', version: 1, state: {}, decisionLog: [] })).toThrow(/not a Gate v1 snapshot/);
    expect(() => Gate.restore({ speck: 'Gate', version: 1, state: { stage: 0 }, decisionLog: [] })).toThrow(/missing state variable opens/);
  });
});
