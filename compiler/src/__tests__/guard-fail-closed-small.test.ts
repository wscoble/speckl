// OpenAPI, CycloneDX, SPDX, and the TypeScript IR generator fail closed
// when the member-type list is missing or names a type the table does not.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent, type AST, type MemberNode } from '../parser.js';
import { lower } from '../ir/lower.js';
import { generateTypeScriptFromIR } from '../generators/typescript-from-ir.js';
import { OpenAPITarget } from '../generators/openapi.js';
import { generateCycloneDX } from '../generators/cyclonedx.js';
import { generateSPDX } from '../generators/spdx.js';

const missing = /cannot check member types/;
const unknown = /no handler for AST node type "not-a-member"/;

function out(): string {
  return mkdtempSync(join(tmpdir(), 'speckl-guard-fc-'));
}

function machine(dir: string): { ast: AST; file: string } {
  const file = join(dir, 'S.speckdl');
  const src = 'speck S {\n    state { n: Nat }\n    init { n := 0 }\n    action Go { n := n + 1 }\n}\n';
  writeFileSync(file, src);
  return { ast: parseSpeckContent(src, file), file };
}

describe('OpenAPI, CycloneDX, SPDX, and TypeScript IR fail closed', () => {
  it('rejects a missing member list and an unknown type, and accepts an ordinary speck', () => {
    const dir = out();
    const { ast, file } = machine(dir);
    const ir = lower(ast, { filePath: file, resolveImports: false });
    expect(ir.specks[0].sourceMemberTypes).toEqual(['state', 'init', 'action']);

    const bare = { ...ir, specks: [{ ...ir.specks[0], sourceMemberTypes: undefined }] };
    expect(() => new OpenAPITarget().generate(bare, { outputDir: dir })).toThrow(missing);
    expect(() => generateTypeScriptFromIR(bare, dir)).toThrow(missing);

    const unnamed = { ...ir, specks: [{ ...ir.specks[0], sourceMemberTypes: ['not-a-member'] }] };
    expect(() => new OpenAPITarget().generate(unnamed, { outputDir: dir })).toThrow(unknown);
    expect(() => generateTypeScriptFromIR(unnamed, dir)).toThrow(unknown);

    const noMembers = { specks: [{ type: 'speck', name: 'S' }] } as unknown as AST;
    expect(() => generateCycloneDX(noMembers, dir)).toThrow(/members are missing on speck "S"/);
    expect(() => generateSPDX(noMembers, dir)).toThrow(/members are missing on speck "S"/);

    const blankMember = { specks: [{ type: 'speck', name: 'S', members: [{}] }] } as unknown as AST;
    expect(() => generateCycloneDX(blankMember, dir)).toThrow(/a member type is missing on speck "S"/);
    expect(() => generateSPDX(blankMember, dir)).toThrow(/a member type is missing on speck "S"/);

    const odd = { specks: [{ type: 'speck', name: 'S', members: [{ type: 'not-a-member' } as unknown as MemberNode] }] } as unknown as AST;
    expect(() => generateCycloneDX(odd, dir)).toThrow(unknown);
    expect(() => generateSPDX(odd, dir)).toThrow(unknown);

    expect(() => new OpenAPITarget().generate(ir, { outputDir: dir })).not.toThrow();
    expect(() => generateTypeScriptFromIR(ir, dir)).not.toThrow();
    expect(() => generateCycloneDX(ast, dir)).not.toThrow();
    expect(() => generateSPDX(ast, dir)).not.toThrow();
  });
});
