// The Z3 IR generator fails closed when member type info is missing or unknown.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';
import { lower } from '../ir/lower.js';
import { generateZ3FromIR } from '../generators/z3-from-ir.js';

describe('Z3 IR fails closed', () => {
  it('rejects a missing list and an unknown type, and accepts an ordinary speck', () => {
    const out = mkdtempSync(join(tmpdir(), 'speckl-guard-z3ir-'));
    const file = join(out, 'S.speckdl');
    const src = 'speck S {\n    state { n: Nat }\n    init { n := 0 }\n    action Go { n := n + 1 }\n}\n';
    writeFileSync(file, src);
    const ir = lower(parseSpeckContent(src, file), { filePath: file, resolveImports: false });
    const bare = { ...ir, specks: [{ ...ir.specks[0], sourceMemberTypes: undefined }] };
    const unnamed = { ...ir, specks: [{ ...ir.specks[0], sourceMemberTypes: ['not-a-member'] }] };
    const empty = { ...ir, specks: [{ ...ir.specks[0], sourceMemberTypes: [] }] };
    expect(() => generateZ3FromIR(bare, { outputDir: out })).toThrow(/sourceMemberTypes is missing on speck "S"/);
    expect(() => generateZ3FromIR(unnamed, { outputDir: out })).toThrow(/no handler for AST node type "not-a-member"/);
    expect(() => generateZ3FromIR(empty, { outputDir: out })).not.toThrow();
    expect(() => generateZ3FromIR({ ...ir, specks: [{ ...ir.specks[0], sourceMemberTypes: ['oneof'] }] }, { outputDir: out })).toThrow(/z3-ir backend rejects AST node type "oneof"/);
    expect(() => generateZ3FromIR(ir, { outputDir: out })).not.toThrow();
  });
});