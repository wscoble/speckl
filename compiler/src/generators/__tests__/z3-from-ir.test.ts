// src/generators/__tests__/z3-from-ir.test.ts
//
// Tests for the IR-driven Z3 generator. The IR-based Z3 must:
//   - Walk the IR's typed expression trees (no string re-parsing)
//   - Emit valid SMT-LIB2 syntax
//   - Translate boolean/int/float/string literals
//   - Translate binary operators (==, !=, <, <=, >, >=, &&, ||, +, -, *, /)
//   - Translate unary operators (!, -)
//   - Translate identifier references
//   - Handle nullable types (lift to underlying type)
//   - Emit check-sat and get-model at the end

import { describe, it, expect } from 'vitest';
import path, { join } from 'path';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { writeFileSync } from 'fs';
import { parseSpeckFile } from '../../parser.js';
import { lower } from '../../ir/lower.js';
import { generateZ3FromIR } from '../z3-from-ir.js';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));


function lowerFromContent(src: string) {
  const filePath = '/tmp/speckl-z3-test.speckdl';
  writeFileSync(filePath, src);
  const ast = parseSpeckFile(filePath);
  return lower(ast, { filePath, resolveImports: false });
}

function runZ3(ir: any, depth = 10): string {
  const tmp = mkdtempSync(join(tmpdir(), 'speckl-z3-'));
  try {
    generateZ3FromIR(ir, { outputDir: tmp, verifyDepth: depth });
    const speckName = ir.specks[0].name;
    return readFileSync(join(tmp, `${speckName}.ir.smt2`), 'utf-8');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('IR-driven Z3 generator', () => {
  it('emits SMT-LIB2 with state var declarations and check-sat', () => {
    const src = `
speck Counter {
  state: {
    count: Nat
  }
  init: {
    count := 0
  }
  constraint "count is non-negative" {
    count >= 0
  }
}
`;
    const ir = lowerFromContent(src);
    const smt = runZ3(ir);

    // Must contain state var declaration
    expect(smt).toContain('(declare-const count Int)');
    // Must contain init assertion
    expect(smt).toContain('(assert (= count 0))');
    // Must contain the constraint
    expect(smt).toContain('(assert (>= count 0))');
    expect(smt).toContain('count is non-negative');
    // Must end with check-sat
    expect(smt).toContain('(check-sat)');
    expect(smt).toContain('(get-model)');
  });

  it('translates boolean literals', () => {
    const src = `
speck BoolTest {
  state: {
    flag: Bool
  }
  constraint "flag is true" {
    flag == true
  }
}
`;
    const ir = lowerFromContent(src);
    const smt = runZ3(ir);
    expect(smt).toContain('(assert (= flag true))');
  });

  it('translates binary operators', () => {
    const src = `
speck BinopTest {
  state: {
    a: Int,
    b: Int
  }
  constraint "a plus b" {
    a + b == 10
  }
  constraint "a is less" {
    a < b
  }
  constraint "a is in range" {
    a >= 0 && a <= 100
  }
}
`;
    const ir = lowerFromContent(src);
    const smt = runZ3(ir);
    expect(smt).toContain('(assert (= (+ a b) 10))');
    expect(smt).toContain('(assert (< a b))');
    expect(smt).toContain('(assert (and (>= a 0) (<= a 100)))');
  });

  it('translates unary operators', () => {
    const src = `
speck UnopTest {
  state: {
    flag: Bool,
    count: Int
  }
  constraint "flag is false" {
    !flag
  }
  constraint "count is negative" {
    -count > 0
  }
}
`;
    const ir = lowerFromContent(src);
    const smt = runZ3(ir);
    expect(smt).toContain('(assert (not flag))');
    expect(smt).toContain('(assert (> (- count) 0))');
  });

  it('handles list and map types', () => {
    const src = `
speck CollectionTest {
  state: {
    items: List<String>,
    byKey: Map<String, Int>
  }
  constraint "first item is hello" {
    items[0] == "hello"
  }
}
`;
    const ir = lowerFromContent(src);
    const smt = runZ3(ir);
    // The state vars should have their proper sort
    expect(smt).toContain('(declare-const items (Seq String))');
    expect(smt).toContain('(declare-const byKey (Array String Int))');
  });

  it('handles nullable types by lifting to underlying', () => {
    const src = `
speck NullableZ3 {
  state: {
    maybe: Int | null
  }
}
`;
    const ir = lowerFromContent(src);
    const smt = runZ3(ir);
    // Nullable is lifted to underlying sort
    expect(smt).toContain('(declare-const maybe Int)');
  });

  it('emits BMC for verifies with depth=2', () => {
    const src = `
speck BMCTest {
  state: {
    count: Int
  }
  verify "count is bounded" depth 2 {
    count < 100
  }
}
`;
    const ir = lowerFromContent(src);
    const smt = runZ3(ir, 2);  // depth 2
    expect(smt).toMatch(/count_0/);
    expect(smt).toMatch(/count_2/);
    expect(smt).toContain('count is bounded');
  });

  it('produces valid SMT for TEF (real spec)', () => {
    // TEF's constraints use quantifier sugar (`forall p in products.values():`)
    // that the IR expression parser cannot yet lower. The generator must
    // degrade gracefully: emit a checkable file with those constraints
    // explicitly skipped (as comments) instead of emitting invalid SMT that
    // Z3 rejects.
    const ast = parseSpeckFile(join(path.resolve(__dirname, '..', '..', '..', '..'), 'examples', 'tef.speckdl'));
    const ir = lower(ast, { filePath: join(path.resolve(__dirname, '..', '..', '..', '..'), 'examples', 'tef.speckdl'), resolveImports: false });
    const smt = runZ3(ir);

    // Should have the standard SMT-LIB2 footer
    expect(smt).toContain('(check-sat)');

    // Quantifier-sugar constraints must be visibly skipped, never emitted as
    // malformed SMT (regression guard: the old compiler emitted
    // `(assert forall)` atoms for each of them).
    expect(smt).not.toMatch(/^\(assert forall\b/gm);

    // Every skipped constraint is documented in the output.
    expect(smt).toContain('; skipped');
  });
});
