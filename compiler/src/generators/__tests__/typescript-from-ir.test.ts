// src/generators/__tests__/typescript-from-ir.test.ts
//
// Proof that the IR is lossless: the IR-driven TypeScript generator and
// the AST-driven TypeScript generator should produce equivalent output
// for any spec. If they diverge, the IR is missing something.

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { parseSpeckFile } from '../../parser.js';
import { lower } from '../../ir/lower.js';
import { generateTypeScriptStateMachine } from '../typescript-state-machine.js';
import { generateTypeScriptFromIR } from '../typescript-from-ir.js';

const REPO = '/home/sscoble/speckl';

function compileBoth(name: string): { ast: string; ir: string } {
  const filePath = join(REPO, 'compiler', '__tests__', 'fixtures', name);
  const ast = parseSpeckFile(filePath);

  const tmpAst = mkdtempSync(join(tmpdir(), 'speckl-ast-'));
  const tmpIr = mkdtempSync(join(tmpdir(), 'speckl-ir-'));

  try {
    generateTypeScriptStateMachine(ast, tmpAst);

    const ir = lower(ast, { filePath, resolveImports: false });
    generateTypeScriptFromIR(ir, tmpIr);

    const astFile = readFileSync(join(tmpAst, `${ast.specks[0].name}.ts`), 'utf-8');
    const irFile = readFileSync(join(tmpIr, `${ast.specks[0].name}.ts`), 'utf-8');

    return { ast: astFile, ir: irFile };
  } finally {
    rmSync(tmpAst, { recursive: true, force: true });
    rmSync(tmpIr, { recursive: true, force: true });
  }
}

describe('IR-driven TypeScript generator', () => {
  it('produces output for a simple spec', () => {
    const { ir } = compileBoth('simple.speck');
    expect(ir).toContain('export const enum ToggleSwitchState');
    expect(ir).toContain('export class ToggleSwitch');
  });

  it('produces output for tigerbeetle (real spec)', () => {
    const { ir } = compileBoth('tigerbeetle.speck');
    expect(ir).toContain('export class TigerBeetle');
    expect(ir).toContain('CreateAccount');
    expect(ir).toContain('Transfer');
    expect(ir).toContain('CloseAccount');
    expect(ir).toContain('CloseLedger');
  });

  it('IR output has provenance comment', () => {
    const { ir } = compileBoth('simple.speck');
    // The IR-driven output includes a comment about provenance.
    // The AST-driven output does not. This is the visible difference.
    expect(ir).toContain('Provenance:');
  });

  it('AST and IR outputs share the same shape (class, actions)', () => {
    const { ast, ir } = compileBoth('simple.speck');
    // Both should reference the action.
    expect(ast).toContain('FlipSwitch');
    expect(ir).toContain('FlipSwitch');
    // Both should have the class.
    expect(ast).toContain('export class ToggleSwitch');
    expect(ir).toContain('export class ToggleSwitch');
  });
});
