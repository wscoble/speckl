// Diagnostics that used to succeed: trailing text, a misspelled statement,
// an unknown type, an undeclared name, and a repeated action.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpeckContent } from '../parser.js';
import { maskSource } from '../source-scan.js';
import { parseActionStatements } from '../expr/stmt-parser.js';
import { lower } from '../ir/lower.js';
import { compileSource } from '../browser/compile-source.js';
import { presentDiagnostic } from '../browser/diagnostics.js';

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
    expect(() => parseSpeckContent(speck + 'this is trailing garbage !!!\n')).toThrow(
      /Parse error at line 4, column \d+: unexpected text after end of speck/,
    );
  });

  it('reports a stray brace as an imbalance, not as trailing text', () => {
    expect(() => parseSpeckContent(speck + '}\n')).toThrow(/Parse error at line 4(?:, column \d+)?: unexpected `}`/);
    expect(() => parseSpeckContent(speck + '}\n')).not.toThrow(/closed early/);
    const many = speck + Array.from({ length: 80 }, () => 'a{').join('\n') + '\n';
    expect(() => parseSpeckContent(many)).toThrow(/missing `}`: block opened at line 4 is never closed/);
    expect(() => parseSpeckContent(many)).not.toThrow(/by line/);
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
    expect(diag?.column).toBeGreaterThan(0);
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

describe('unclosed blocks and structural duplicates', () => {
  it('rejects a speck that is never closed', () => {
    const src = 'speck S {\n  state { x: Nat }\n  action Go {\n    x := 1\n';
    expect(() => parseSpeckContent(src)).toThrow(/missing `}`: block opened at line 3 is never closed/);
    const result = compileSource(src, { target: 'typescript' });
    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.diagnostics.some((d) => d.line === 3 && /never closed/.test(d.message))).toBe(true);
  });

  it('rejects an action whose closing brace was deleted', () => {
    const src = `speck S {
  state { x: Nat }
  action Go {
    x := 1
  action Stop { x := 0 }
}
`;
    expect(() => parseSpeckContent(src)).toThrow(/Parse error at line 3(?:, column \d+)?: missing `}`: block opened at line 3 is never closed \(expected a `}` before line 5\)/);
  });

  it('rejects a doubled action brace on that line', () => {
    const src = `speck S {
  state { x: Nat }
  action RunChecks {{
    x := 1
  }
}
`;
    expect(() => parseSpeckContent(src)).toThrow(/Parse error at line 3, column \d+: unexpected `\{`/);
  });

  it('rejects a nameless action at that line', () => {
    const src = `speck S {
  action {
    checksPassed := true
  }
}
`;
    expect(() => parseSpeckContent(src)).toThrow(/Parse error at line 2, column \d+: action is missing a name/);
    const result = compileSource(src, { target: 'typescript' });
    expect(result.diagnostics.some((d) => /undeclared variable/.test(d.message))).toBe(false);
  });

  it('rejects two specks with the same name', () => {
    const src = 'speck S {\n  state { x: Nat }\n}\nspeck S {\n  state { y: Nat }\n}\n';
    expect(() => parseSpeckContent(src)).toThrow(/Parse error at line 4, column \d+: duplicate speck "S"/);
  });

  it('rejects a repeated state variable on its line', () => {
    const src = 'speck S {\n  state {\n    stage: Nat\n    stage: Bool\n  }\n}\n';
    expect(() => parseSpeckContent(src)).toThrow(/Parse error at line 4, column \d+: duplicate state variable "stage"/);
    expect(() => parseSpeckContent('speck S {\n  state { x: Nat, x: Bool }\n}\n')).toThrow(/duplicate state variable "x"/);
  });

  it('rejects a repeated stage number on its line', () => {
    const src = `speck S {
  state { stage: Nat }
  action Go { stage := 1 }
  agent {
    stages stage {
      Idle = 1
      ChecksGreen = 1
    }
    tool go -> Go effect act
  }
}
`;
    expect(() => parseSpeckContent(src)).toThrow(/Parse error at line 7, column \d+: duplicate stage number 1 \("Idle" and "ChecksGreen"\)/);
  });

  it('says when a speck name is missing or invalid', () => {
    expect(() => parseSpeckContent('speck\n')).toThrow(/Parse error at line 1, column \d+: speck name is missing/);
    expect(() => parseSpeckContent('speck ../../etc/passwd {\n  state { x: Nat }\n}\n')).toThrow(/Parse error at line 1, column \d+: speck name "\.\.\/\.\.\/etc\/passwd" is invalid/);
    expect(() => parseSpeckContent('speck Dëplöy日本 {\n  state { x: Nat }\n}\n')).toThrow(/Parse error at line 1, column \d+: speck name "Dëplöy日本" is invalid/);
    expect(() => parseSpeckContent('speck 2fast {\n  state { x: Nat }\n}\n')).toThrow(/speck name "2fast" is invalid \(names must start with a letter\)/);
    expect(() => parseSpeckContent('speck My Spec {\n  state { x: Nat }\n}\n')).toThrow(/spec names can't contain spaces/);
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

describe('comments, strings, and same-line braces', () => {
  it('does not count braces inside comments or strings', () => {
    const commentedBraces = '// {\nstage := 0 // set { to zero\n// }\n/*\n{\n*/\n"{"\n';
    const masked = maskSource(commentedBraces);
    expect(masked).not.toMatch(/[{}]/);
    expect(masked.length).toBe(commentedBraces.length);
    expect(masked.split('\n')[1].startsWith('stage := 0')).toBe(true);
    const hooks = maskSource('// hooks/*.json\n  state { x: Nat }\n');
    expect(hooks.split('\n')[1]).toBe('  state { x: Nat }');
    expect(hooks.split('\n')[0]).not.toContain('/');
    expect(() => maskSource('/* comment')).toThrow(/unclosed comment opened at line 1/);
    expect(() => maskSource('ok\n/* comment')).toThrow(/unclosed comment opened at line 2/);

    const commented = `speck S {
  state { x: Nat }
  // {
  init {
    x := 0 // set { to zero
  }
  // }
  action Go { x := 1 }
}
/*
{
*/
`;
    const ast = parseSpeckContent(commented);
    expect(ast.specks.map((s) => s.name)).toEqual(['S']);
    expect(() => parseSpeckContent('speck S {\n  state { x: Nat }\n}\n/*\n{\n*/\n')).not.toThrow();
    expect(() => parseSpeckContent('speck S {\n  /* comment\n  state { x: Nat }\n}\n')).toThrow(/unclosed comment opened at line 2/);

    const policy = readFileSync(join(import.meta.dirname, '..', '..', '..', 'examples', 'AgentPolicy.speckdl'), 'utf8');
    const withBraces = policy
      .replace('stage := 0', 'stage := 0 // set { to zero')
      .replace(/\n}\s*$/, '\n  // {\n  // }\n}\n');
    const compiled = compileSource(withBraces, { target: 'typescript' });
    expect(compiled.ok, compiled.diagnostics.map((d) => d.message).join('\n')).toBe(true);
    expect(compiled.diagnostics.some((d) => /unexpected `\}`|missing `\}`|unexpected text/.test(d.message))).toBe(false);
  });

  it('keeps a field or statement written on the brace line', () => {
    const src = 'speck T {\n state { ready: Bool\n n: Nat }\n action Go { ready := true }\n}\n';
    const ast = parseSpeckContent(src);
    const state = ast.specks[0].members.find((m) => m.type === 'state') as { variables: { name: string }[] };
    expect(state.variables.map((v) => v.name)).toEqual(['ready', 'n']);
    const ir = lowerSrc(src);
    expect(ir.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    const result = compileSource(src, { target: 'typescript' });
    expect(result.ok, result.diagnostics.map((d) => d.message).join('\n')).toBe(true);
    expect(result.diagnostics.some((d) => /undeclared variable "ready"/.test(d.message))).toBe(false);

    const action = `speck T {
  state { ready: Bool }
  action Go { require ready == false
    ready := true }
}
`;
    const lowered = lowerSrc(action);
    expect(lowered.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    const go = lowered.specks[0].facets.behavior.actions.find((a) => a.name === 'Go');
    expect(go?.statements.map((s) => s.kind)).toEqual(['require', 'assign']);
    expect(JSON.stringify(go?.statements)).not.toContain('true }');
    const oneLine = parseSpeckContent('speck T {\n  state { ready: Bool, n: Nat }\n  action Go { ready := true }\n}\n');
    const oneState = oneLine.specks[0].members.find((m) => m.type === 'state') as { variables: { name: string }[] };
    expect(oneState.variables.map((v) => v.name)).toEqual(['ready', 'n']);
  });

  it('points a stray closing brace at the earlier close', () => {
    const deploy = readFileSync(join(import.meta.dirname, '..', '..', '..', 'examples', 'DeployGate.speckdl'), 'utf8');
    const lines = deploy.split('\n');
    lines.splice(20, 0, '}');
    expect(() => parseSpeckContent(lines.join('\n'))).toThrow(
      /Parse error at line 21, column \d+: a block opened at line 1 may have closed early at line 21\. The extra `}` ended up at line 88/,
    );
  });

  it('rejects Boolean, a missing colon, and a keyword used as an action name', () => {
    const bool = 'speck S {\n  state { ready: Boolean }\n  action Go { ready := true }\n}\n';
    const result = compileSource(bool, { target: 'typescript' });
    expect(result.ok).toBe(false);
    const type = result.diagnostics.find((d) => /unknown type "Boolean"/.test(d.message));
    expect(type?.message).toMatch(/Did you mean `Bool`/);
    expect(type?.line).toBe(2);
    expect(type?.column).toBeGreaterThan(0);
    expect(presentDiagnostic(type!)).toMatch(/^Line 2, column \d+:/);
    expect(() => parseSpeckContent('speck S {\n  state { ready Bool }\n}\n')).toThrow(
      /Parse error at line 2(?:, column \d+)?: state variable "ready" is missing a colon/,
    );
    expect(() => parseSpeckContent('speck S {\n  action action {}\n}\n')).toThrow(
      /Parse error at line 2, column \d+: action name "action" is a keyword/,
    );
    expect(() => parseSpeckContent('speck S {\n  action {\n    x := 1\n  }\n}\n')).toThrow(/action is missing a name/);
  });

  it('describes a deep unclosed brace without blaming line 1 as the deadline', () => {
    expect(() => parseSpeckContent('{'.repeat(500))).toThrow(/the file ends on line 1 while this block is still open, 500 blocks are still open/);
    expect(() => parseSpeckContent('{'.repeat(500))).not.toThrow(/by line/);
  });
});

describe('expression names and literal types', () => {
  it('rejects an undeclared name in a require, with line and column', () => {
    const src = 'speck S {\n  state { ready: Bool }\n  action Go { require foo == 1\n    ready := true }\n}\n';
    const result = compileSource(src, { target: 'typescript' });
    expect(result.ok).toBe(false);
    const diag = result.diagnostics.find((d) => /undeclared variable "foo"/.test(d.message));
    expect(diag?.line).toBe(3);
    expect(diag?.column).toBeGreaterThan(1);
    expect(presentDiagnostic(diag!)).toMatch(/^Line 3, column \d+:/);
    const ir = lowerSrc(src);
    expect(ir.diagnostics.some((d) => d.level === 'error' && /undeclared variable "foo"/.test(d.message) && d.column)).toBe(true);
  });

  it('rejects obvious literal mismatches on assignment and comparison', () => {
    const assign = 'speck S {\n  state { ready: Bool }\n  action Go { ready := 5 }\n}\n';
    const assigned = compileSource(assign, { target: 'typescript' });
    const mismatch = assigned.diagnostics.find((d) => /type mismatch: cannot assign a number to Bool variable "ready"/.test(d.message));
    expect(mismatch?.line).toBe(3);
    expect(mismatch?.column).toBeGreaterThan(0);
    expect(presentDiagnostic(mismatch!)).toMatch(/^Line 3, column \d+:/);

    const compared = lowerSrc('speck S {\n  state { ready: Bool\n n: Nat\n s: String\n i: Int\n r: Real }\n  action Go {\n    require ready == 1\n    require n == -1\n    require s == true\n    n := -2\n    n := 1.5\n    i := -2\n    r := 1.5\n    ready := true\n    s := "ok"\n  }\n}\n');
    const errors = compared.diagnostics.filter((d) => d.level === 'error').map((d) => d.message);
    expect(errors.some((m) => /cannot compare Bool variable "ready" with a number/.test(m))).toBe(true);
    expect(errors.some((m) => /cannot compare Nat variable "n" with a negative number/.test(m))).toBe(true);
    expect(errors.some((m) => /cannot compare String variable "s" with a boolean/.test(m))).toBe(true);
    expect(errors.some((m) => /cannot assign a negative number to Nat variable "n"/.test(m))).toBe(true);
    expect(errors.some((m) => /cannot assign a non-integer number to Nat variable "n"/.test(m))).toBe(true);
    expect(errors.some((m) => /cannot assign a negative number to Int/.test(m))).toBe(false);
    expect(errors.some((m) => /Real/.test(m))).toBe(false);
    expect(errors.some((m) => /cannot assign a boolean to Bool/.test(m))).toBe(false);
    expect(errors.some((m) => /cannot assign a string to String/.test(m))).toBe(false);
  });

  it('accepts stage labels, enum constants, lets, and known calls', () => {
    const src = `speck S {
  type Color = Red | Blue
  state {
    stage: Nat
    ready: Bool
  }
  action Go(n: Nat) {
    require stage == 0
    require ready == false
    let k := n
    stage := k
    require length(k) == 1
    require stage == Red
    ready := true
  }
  agent {
    stages stage { Idle = 0 }
    tool go -> Go effect act
  }
}
`;
    const ir = lowerSrc(src);
    expect(ir.diagnostics.filter((d) => d.level === 'error').map((d) => d.message)).toEqual([]);
  });

  it('does not flag names in the shipped examples', () => {
    const dir = join(import.meta.dirname, '..', '..', '..', 'examples');
    const problems: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.speckdl'))) {
      const src = readFileSync(join(dir, file), 'utf8');
      const ir = lowerSrc(src);
      for (const d of ir.diagnostics) {
        if (d.level === 'error' && /undeclared variable|type mismatch/.test(d.message)) {
          problems.push(`${file}:${d.line ?? '?'}: ${d.message}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('type-checks an initializer written on the state field', () => {
    const bad = lowerSrc('speck S {\n  state { n: Nat := -1 }\n}\n');
    expect(bad.diagnostics.some((d) => /cannot assign a negative number to Nat variable "n"/.test(d.message))).toBe(true);
    const good = lowerSrc('speck S {\n  state { ready: Bool := true }\n  init { ready := false }\n}\n');
    expect(good.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  });

  it('rejects a call that names nothing in scope', () => {
    const ir = lowerSrc('speck S {\n  state { n: Nat }\n  action Go { n := mystery(1) }\n}\n');
    expect(ir.diagnostics.some((d) => /undeclared variable "mystery"/.test(d.message))).toBe(true);
  });

  it('does not treat a nested block comment as nested', () => {
    expect(() => maskSource('/* a /* b */ c */')).toThrow(/unexpected `c \*\/` \(block comments do not nest\)/);
    expect(() => parseSpeckContent('speck S {\n  /* a /* b */ c */\n  state { x: Nat }\n}\n')).toThrow(/block comments do not nest/);
    expect(() => maskSource('/* a /* b */')).not.toThrow();
    expect(() => maskSource('// */\n')).not.toThrow();
    expect(() => maskSource('"*/"\n')).not.toThrow();
    expect(() => maskSource('  /* comment')).toThrow(/Parse error at line 1, column 3: unclosed comment opened at line 1/);
  });
});
