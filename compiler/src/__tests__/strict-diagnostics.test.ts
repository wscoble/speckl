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
import { explainTargetError, presentDiagnostic } from '../browser/diagnostics.js';

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
      const playground = new Set(['DeployGate.speckdl', 'AgentPolicy.speckdl', 'ClaudeCodePolicy.speckdl', 'ToggleSwitch.speckdl']);
      for (const d of ir.diagnostics) {
        if (d.level === 'error') problems.push(`${file}:${d.line ?? '?'}: ${d.message}`);
        else if (d.level === 'warning' && (playground.has(file) || /unexpected character|type mismatch|unknown type/.test(d.message))) {
          problems.push(`${file}:${d.line ?? '?'}: warning: ${d.message}`);
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

describe('round 5: types, stages, and statement shape', () => {
  it('rejects an undeclared type and suggests a near miss', () => {
    const src = 'speck S {\n  state { x: Foo }\n  action Go(k: Banana) { x := 1 }\n}\n';
    const ir = lowerSrc(src);
    const foo = ir.diagnostics.find((d) => /unknown type "Foo"/.test(d.message));
    const banana = ir.diagnostics.find((d) => /unknown type "Banana"/.test(d.message));
    expect(foo?.line).toBe(2);
    expect(foo?.column).toBeGreaterThan(1);
    expect(presentDiagnostic({ level: 'error', message: foo!.message, line: foo!.line, column: foo!.column })).toMatch(/^Line 2, column \d+: unknown type "Foo"/);
    expect(banana?.line).toBe(3);
    expect(banana?.message).not.toMatch(/Did you mean/);
    const declared = lowerSrc('speck S {\n  type Account\n  state { a: Account }\n}\n');
    expect(declared.diagnostics.filter((d) => /unknown type/.test(d.message))).toEqual([]);
    const near = lowerSrc('speck S {\n  state { x: Booll }\n}\n');
    expect(near.diagnostics.some((d) => /unknown type "Booll"/.test(d.message) && /Did you mean `Bool`/.test(d.message))).toBe(true);
  });

  it('compares a stage by its declared label', () => {
    const src = `speck DeployGate {
  state { stage: Nat }
  init { stage := 0 }
  action RequestDeploy {
    require stage == Approved
    stage := Approved
  }
  next: RequestDeploy
  agent {
    stages stage {
      Idle = 0
      Approved = 3
    }
    tool request_deploy -> RequestDeploy effect act
    await Approved {
      signal approval
      mode near
      require outcome in { approve, reject! }
      on approve -> Approved
      on reject -> Idle
    }
  }
}
`;
    const ir = lowerSrc(src);
    expect(ir.diagnostics.filter((d) => d.level === 'error').map((d) => d.message)).toEqual([]);
    const action = ir.specks[0]?.facets.behavior.actions.find((a) => a.name === 'RequestDeploy');
    const guard = action?.statements.find((s) => s.kind === 'require');
    expect(guard && guard.kind === 'require' ? guard.value : undefined).toMatchObject({
      kind: 'binop',
      right: { kind: 'int_lit', value: 3 },
    });
    const result = compileSource(src, { target: 'agent' });
    expect(result.diagnostics.filter((d) => /untranslated|Did not compile/.test(d.message)).map((d) => d.message)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('checks declared variable types against each other', () => {
    const src = `speck S {
  state {
    b: Bool
    n: Nat
    i: Int
    s: String
    r: Real
  }
  action Go {
    b := n
    n := b + 1
    n := i
    i := n
    s := s + "b"
    r := n
    require n
    require s
    require n and b
    require not b
    n := n + 1
    return n
  }
}
`;
    const errors = lowerSrc(src).diagnostics.filter((d) => d.level === 'error').map((d) => d.message);
    expect(errors.some((m) => /cannot assign Nat variable "n" to Bool variable "b"/.test(m))).toBe(true);
    expect(errors.some((m) => /arithmetic only applies to numbers/.test(m))).toBe(true);
    expect(errors.some((m) => /cannot assign Int variable "i" to Nat variable "n"/.test(m))).toBe(true);
    expect(errors.some((m) => /require expects a Bool, got Nat variable "n"/.test(m))).toBe(true);
    expect(errors.some((m) => /require expects a Bool, got String variable "s"/.test(m))).toBe(true);
    expect(errors.some((m) => /and expects a Bool, got Nat variable "n"/.test(m))).toBe(true);
    expect(errors.some((m) => /cannot assign Int variable "n" to Int/.test(m))).toBe(false);
    expect(errors.some((m) => /cannot assign a string to String/.test(m))).toBe(false);
    expect(errors.some((m) => /Real/.test(m))).toBe(false);
    expect(errors.some((m) => /not expects a Bool/.test(m))).toBe(false);
  });

  it('rejects a top-level ensure and keeps postcondition', () => {
    expect(() => parseSpeckContent('speck S {\n  ensure Go: n > 0\n  state { n: Nat }\n}\n')).toThrow(/Parse error at line 2, column \d+: "ensure" is not a Speckl statement/);
    expect(() => parseSpeckContent('ensure Go: n > 0\nspeck S {\n  state { n: Nat }\n}\n')).toThrow(/"ensure" is not a Speckl statement/);
    const inside = lowerSrc('speck S {\n  state { n: Nat }\n  action Go {\n    ensure n > 0\n    postcondition: n > 0\n  }\n}\n');
    const diag = inside.diagnostics.find((d) => /unrecognized statement "ensure n > 0"/.test(d.message));
    expect(diag?.line).toBe(4);
    expect(diag?.column).toBeGreaterThan(0);
    expect(diag?.message).toMatch(/postcondition/);
    expect(inside.diagnostics.some((d) => /postcondition: n > 0/.test(d.message) && d.level === 'error')).toBe(false);
  });

  it('rejects junk in an action with a line and column', () => {
    const ir = lowerSrc('speck S {\n  state { n: Nat }\n  action Go {\n    bogus stuff\n    n := 1\n  }\n}\n');
    const diag = ir.diagnostics.find((d) => /unrecognized statement "bogus stuff"/.test(d.message));
    expect(diag?.level).toBe('error');
    expect(diag?.line).toBe(4);
    expect(diag?.column).toBeGreaterThan(0);
    expect(presentDiagnostic({ level: 'error', message: diag!.message, line: diag!.line, column: diag!.column })).toMatch(/^Line 4, column \d+:/);
    const kept = lowerSrc('speck S {\n  state { n: Nat }\n  action Go {\n    for x in n { n := 1 }\n    helper()\n    a.b := 1\n  }\n}\n');
    expect(kept.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  });

  it('rejects a stage number, a digit name, and a keyword name', () => {
    const stage = lowerSrc(`speck S {
  state { stage: Nat }
  action Go {
    stage := 99
  }
  agent {
    stages stage {
      Idle = 0
      Approved = 3
    }
  }
}
`);
    const bad = stage.diagnostics.find((d) => /stage value 99 is not a declared stage/.test(d.message));
    expect(bad?.line).toBe(4);
    expect(bad?.message).toMatch(/Idle = 0/);
    const ok = lowerSrc('speck S {\n  state { stage: Nat }\n  action Go { stage := 0 }\n  agent { stages stage { Idle = 0 } }\n}\n');
    expect(ok.diagnostics.filter((d) => /stage value/.test(d.message))).toEqual([]);
    expect(() => parseSpeckContent('speck S {\n  state { 2x: Bool }\n}\n')).toThrow(/Parse error at line 2, column \d+: state variable "2x" is invalid/);
    expect(() => parseSpeckContent('speck S {\n  state { state: Bool }\n}\n')).toThrow(/state variable "state" is a keyword/);
    expect(() => parseSpeckContent('speck S {\n  state { require: Bool }\n}\n')).toThrow(/state variable "require" is a keyword/);
    expect(() => parseSpeckContent('speck action {\n  state { x: Bool }\n}\n')).toThrow(/speck name "action" is a keyword/);
  });

  it('reports an emoji as a code point on its real line', () => {
    const src = 'speck S {\n  state { n: Nat }\n  action Go {\n    n := 1😀\n  }\n}\n';
    const ir = lowerSrc(src);
    const diag = ir.diagnostics.find((d) => /unexpected character U\+1F600/.test(d.message));
    expect(diag?.level).toBe('error');
    expect(diag?.line).toBe(4);
    expect(diag?.column).toBeGreaterThan(1);
    expect(diag?.message).not.toMatch(/\\ud83d|1:6/);
    expect(presentDiagnostic({ level: 'error', message: diag!.message, line: diag!.line, column: diag!.column })).toMatch(/^Line 4, column \d+: unexpected character U\+1F600/);
  });

  it('points an agent target error at the bad stage, not the block header', () => {
    const src = `speck S {
  state { stage: Nat }
  action Go { stage := 1 }
  agent {
    stages stage { Idle = 0, Approved = 1 }
    await Approved {
      signal approval
      mode near
      require outcome in { approve }
      on approve -> Aprovd
    }
  }
}
`;
    const ir = lowerSrc(src);
    const diag = ir.diagnostics.find((d) => /unknown target stage/.test(d.message));
    const lineNo = src.split('\n').findIndex((l) => l.includes('Aprovd')) + 1;
    const line = src.split('\n')[lineNo - 1];
    expect(diag?.line).toBe(lineNo);
    expect(diag?.column).toBe(line.indexOf('Aprovd') + 1);
    expect(diag?.line).not.toBe(src.split('\n').findIndex((l) => l.includes('agent {')) + 1);
    const shown = presentDiagnostic({ level: 'error', message: diag!.message, line: diag!.line, column: diag!.column });
    expect(shown).toMatch(new RegExp(`^Line ${lineNo}, column \\d+:`));
  });

  it('explains an untranslated-identifier failure in plain English', () => {
    const source = 'speck S {\n  state { owner: String }\n  action Go { owner := nil }\n}\n';
    const explained = explainTargetError(source, '-t agent: the generated machine has untranslated identifiers in Go (nil); its guards would not match the spec, so no rails were emitted');
    expect(explained.message).toMatch(/left Go \(nil\) untranslated/);
    expect(explained.message).not.toMatch(/FIXME/);
    expect(explained.line).toBe(3);
    expect(explained.column).toBeGreaterThan(1);
    const bare = explainTargetError('speck S {}', '-t agent: emitted JavaScript machine failed a syntax check');
    expect(bare.message).toMatch(/could not finish this target/);
  });
});
