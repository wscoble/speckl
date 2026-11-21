// The Camel generator fails closed when member type info is missing or unknown.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';
import { lower } from '../ir/lower.js';
import { generateCamel } from '../generators/camel.js';

describe('Camel fails closed', () => {
  it('rejects a missing list and an unknown type, and accepts an ordinary speck', () => {
    const out = mkdtempSync(join(tmpdir(), 'speckl-guard-camel-'));
    const file = join(out, 'S.speckdl');
    const src = 'speck S {\n    state { n: Nat }\n    init { n := 0 }\n    action Go { n := n + 1 }\n}\n';
    writeFileSync(file, src);
    const ir = lower(parseSpeckContent(src, file), { filePath: file, resolveImports: false });
    const bare = { ...ir, specks: [{ ...ir.specks[0], sourceMemberTypes: undefined }] };
    const unnamed = { ...ir, specks: [{ ...ir.specks[0], sourceMemberTypes: ['not-a-member'] }] };
    expect(() => generateCamel(bare, { outputDir: out })).toThrow(/sourceMemberTypes is missing on speck "S"/);
    expect(() => generateCamel(unnamed, { outputDir: out })).toThrow(/no handler for AST node type "not-a-member"/);
    expect(() => generateCamel({ ...ir, specks: [{ ...ir.specks[0], sourceMemberTypes: ['oneof'] }] }, { outputDir: out })).toThrow(/camel backend rejects AST node type "oneof"/);
    expect(() => generateCamel(ir, { outputDir: out })).not.toThrow();
  });
});