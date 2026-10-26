// Diagnostics that used to succeed: trailing text, a misspelled statement,
// an unknown type, an undeclared name, and a repeated action.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpeckContent } from '../parser.js';
import { parseActionStatements } from '../expr/stmt-parser.js';
import { lower } from '../ir/lower.js';
import { compileSource } from '../browser/compile-source.js';

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

function lowerSrc(src: string) {
  const filePath = join(mkdtempSync(join(tmpdir(), 'speckl-diag-')), 'T.speckdl');
  writeFileSync(filePath, src);
  return lower(parseSpeckContent(src, filePath), { filePath, resolveImports: false });
}

describe('trailing text after a speck', () => {
  const speck = 'speck S {\n  state { x: Nat }\n}\n';

  it('is an error on that line', () => {
    expect(() => parseSpeckContent(speck + 'this is trailing garbage }}} ((( !!!\n')).toThrow(
      /Parse error at line 4: unexpected text after end of speck/,
    );
    const many = speck + Array.from({ length: 80 }, () => 'a{').join('\n') + '\n';
    expect(() => parseSpeckContent(many)).toThrow(/Parse error at line 4: unexpected text after end of speck/);
  });

  it('still allows a comment, a blank line, an import, and another speck', () => {
    const src = `${speck}// note\n\nimport "other.speckdl"\n/* block\n   still a comment\n*/\nspeck T {\n  state { y: Bool }\n}\n`;
    expect(parseSpeckContent(src).specks.map((s) => s.name)).toEqual(['S', 'T']);
  });

  it('fails the playground compile instead of reporting success', () => {
    const result = compileSource(speck + 'this is trailing garbage\n', { target: 'typescript' });
    expect(result.ok).toBe(false);
    const diag = result.diagnostics.find((d) => /unexpected text after end of speck/.test(d.message));
    expect(diag?.line).toBe(4);
    expect(result.diagnostics.some((d) => /Compiled/.test(d.message))).toBe(false);
  });
});

describe('unrecognized statements', () => {
  it('suggests require for requires and keeps the source line', () => {
    const src = `speck S {
  state { stage: Nat }
  action Go {
    requires stage == 1
    stage := 1
  }
}
`;
    const ir = lowerSrc(src);
    const diag = ir.diagnostics.find((d) => d.level === 'error' && /unrecognized statement/.test(d.message));
    expect(diag?.message).toMatch(/requires stage == 1/);
    expect(diag?.message).toMatch(/Did you mean `require`/);
    expect(diag?.line).toBe(4);
    const result = compileSource(src, { target: 'agent' });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.line === 4 && /require/.test(d.message))).toBe(true);
    expect(result.diagnostics.some((d) => /preserved as raw text/.test(d.message) && /requires/.test(d.message))).toBe(false);
  });

  it('keeps bare calls, dotted assigns, and for headers as raw text', () => {
    const stmts = parseActionStatements([
      'transitionProductPhase(productName, Rejected, reason)',
      'p.status.phase := newPhase',
      'for x in xs:',
    ]);
    expect(stmts.map((s) => s.type)).toEqual(['ifblock', 'ifblock', 'ifblock']);
  });

  it('errors on a bare comparison with no keyword hint', () => {
    const [stmt] = parseActionStatements(['stage == 1'], [9]);
    expect(stmt).toMatchObject({ type: 'unrecognized', raw: 'stage == 1', line: 9 });
    expect(stmt).not.toHaveProperty('suggestion');
  });
});

describe('unknown types and undeclared names', () => {
  it('names the type and the variable with their lines', () => {
    const src = `speck S {
  state {
    checksPassed: Booll
  }
  action Go {
    bogus := 1
  }
}
`;
    const result = compileSource(src, { target: 'typescript' });
    expect(result.ok).toBe(false);
    const type = result.diagnostics.find((d) => /unknown type "Booll"/.test(d.message));
    const name = result.diagnostics.find((d) => /undeclared variable "bogus"/.test(d.message));
    expect(type?.message).toMatch(/Did you mean `Bool`/);
    expect(type?.line).toBe(3);
    expect(name?.line).toBe(6);
  });

  it('accepts a declared alias and Option(T)', () => {
    const src = `speck S {
  type NodeId = Nat
  state {
    votedFor: Option(NodeId)
  }
  action Go(id: NodeId) {
    votedFor := id
  }
}
`;
    const ir = lowerSrc(src);
    expect(ir.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  });

  it('allows a let to introduce a name used later in the action', () => {
    const src = `speck S {
  state {
    x: Nat
  }
  action Go {
    let n := 1
    x := n
  }
}
`;
    const ir = lowerSrc(src);
    expect(ir.diagnostics.filter((d) => /undeclared/.test(d.message))).toEqual([]);
  });
});

describe('duplicate actions', () => {
  it('says duplicate action and points at the second one', () => {
    const src = `speck S {
  state { x: Nat }
  action Go { x := 1 }
  action Go { x := 2 }
}
`;
    const result = compileSource(src, { target: 'typescript' });
    expect(result.ok).toBe(false);
    const diag = result.diagnostics.find((d) => /duplicate action "Go"/.test(d.message));
    expect(diag?.line).toBe(4);
  });
});
