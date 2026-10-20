// `verify Always(Inv)` names an invariant. The TypeScript machine used to
// emit the bare name (`if (!(PrNeedsApproval))`), which neither type-checks
// nor runs. The invariant's expression is now inlined; one the backend
// cannot translate makes verifyN() throw SPECKL-UNTRANSLATED (fail closed)
// instead of emitting TypeScript that does not parse.
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
        approved: Bool
        tested: Bool
        history: List(Nat)
    }

    init {
        stage = 0
        approved = false
        tested = false
    }

    invariant OpenNeedsApproval {
        stage != 2 or approved
    }

    invariant OpenNeedsTests {
        stage != 2 or tested
    }

    invariant Both {
        OpenNeedsApproval and OpenNeedsTests
    }

    invariant Monotone {
        stage' >= stage
    }

    invariant AllSmall {
        forall s in history: s < 10
    }

    action Open {
        require stage == 1
        stage := 2
    }

    verify Always(OpenNeedsApproval) {
        depth 4
    }

    verify Always(OpenNeedsTests) {
        depth 4
    }

    verify Always(Both) {
        depth 4
    }

    verify Always(Monotone) {
        depth 4
    }

    verify Always(AllSmall) {
        depth 4
    }
}
`;

let source = '';
let Gate: any;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-tsinv-'));
  generateTypeScriptStateMachine(parseSpeckContent(SPEC), dir);
  source = readFileSync(join(dir, 'Gate.ts'), 'utf-8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const file = join(dir, 'Gate.mjs');
  writeFileSync(file, js);
  Gate = (await import(pathToFileURL(file).href)).GateMachine;
});

describe('verify checks that name an invariant', () => {
  it('inline every invariant, not just the first (no bare invariant names left)', () => {
    expect(source).toContain('(this.stage !== 2 || this.approved)');
    expect(source).toContain('(this.stage !== 2 || this.tested)');
    expect(source).not.toMatch(/if \(!\((OpenNeedsApproval|OpenNeedsTests|Both)\)\)/);
  });

  it('evaluate the inlined invariant against the live state', async () => {
    const m = new Gate();
    m.stage = 2; m.approved = true; m.tested = false;
    expect(await m.verify1()).toBe(true);
    expect(await m.verify2()).toBe(false);
    m.tested = true;
    expect(await m.verify2()).toBe(true);
  });

  it('inline invariants that name other invariants', async () => {
    const m = new Gate();
    m.stage = 2; m.approved = true; m.tested = false;
    expect(await m.verify3()).toBe(false);
    m.tested = true;
    expect(await m.verify3()).toBe(true);
  });

  it('fail closed on an invariant the backend cannot translate (primes, quantifiers)', async () => {
    const m = new Gate();
    await expect(m.verify4()).rejects.toThrow(/SPECKL-UNTRANSLATED: verify Always\(Monotone\) uses invariant Monotone/);
    await expect(m.verify5()).rejects.toThrow(/SPECKL-UNTRANSLATED: verify Always\(AllSmall\) uses invariant AllSmall/);
  });

  it('the generated module type-checks under --strict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-tsinv-tc-'));
    const file = join(dir, 'Gate.ts');
    writeFileSync(file, source);
    const program = ts.createProgram([file], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts'], types: [], skipLibCheck: true });
    const diags = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(diags).toEqual([]);
  });
});
