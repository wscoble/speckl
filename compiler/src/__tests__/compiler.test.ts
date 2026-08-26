import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { parseSpeckFile } from '../parser.js';
import { lower } from '../ir/lower.js';
import { generateProvenanceFromIR } from '../generators/provenance-from-ir.js';
import { generateCycloneDX } from '../generators/cyclonedx.js';
import { generateSPDX } from '../generators/spdx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Compiler E2E', () => {
  let ast: any;
  let ir: any;
  const testOutputDir = './test-output';

  beforeAll(() => {
    // Create test output directory
    if (!fs.existsSync(testOutputDir)) {
      fs.mkdirSync(testOutputDir);
    }
  });

  it('should parse RetryHandler.speck', () => {
    const specPath = path.join(__dirname, '..', '..', '..', 'examples', 'RetryHandler.speck');
    ast = parseSpeckFile(specPath);

    expect(ast).toBeDefined();
    expect(ast.specks).toBeDefined();
    expect(ast.specks.length).toBeGreaterThan(0);

    const speck = ast.specks[0];
    expect(speck.name).toBe('RetryHandler');
    expect(speck.type).toBe('speck');
    expect(speck.members.length).toBeGreaterThan(0);

    // Lower to IR — the IR is the source of truth for the provenance generator
    ir = lower(ast, { filePath: specPath, resolveImports: false });
    expect(ir.specks[0].facets.provenance).toBeDefined();
  });

  it('should generate provenance graph from IR', () => {
    generateProvenanceFromIR(ir, testOutputDir);

    const provFile = path.join(testOutputDir, 'RetryHandler.prov.jsonld');
    expect(fs.existsSync(provFile)).toBe(true);

    const content = fs.readFileSync(provFile, 'utf-8');
    const provGraph = JSON.parse(content);

    expect(provGraph['@context']).toBeDefined();
    expect(provGraph['@graph']).toBeDefined();
    // The IR-driven graph includes the synthesized flag, review policy,
    // authors as agents, and clauses as separate entities.
    const root = provGraph['@graph'].find((e: any) => e['@id'] === 'speck:RetryHandler');
    expect(root).toBeDefined();
    expect(root).toHaveProperty('speckl:synthesized');
    expect(root).toHaveProperty('speckl:review');
  });

  it('should generate CycloneDX BOM', () => {
    generateCycloneDX(ast, testOutputDir);
    
    const cdxFile = path.join(testOutputDir, 'RetryHandler.specbom.cdx.json');
    expect(fs.existsSync(cdxFile)).toBe(true);
    
    const content = fs.readFileSync(cdxFile, 'utf-8');
    const cdx = JSON.parse(content);
    
    expect(cdx.bomFormat).toBe('CycloneDX');
    expect(cdx.specVersion).toBe('1.6');
    expect(cdx.components).toBeDefined();
  });

  it('should generate SPDX BOM', () => {
    generateSPDX(ast, testOutputDir);
    
    const spdxFile = path.join(testOutputDir, 'RetryHandler.specbom.spdx.json');
    expect(fs.existsSync(spdxFile)).toBe(true);
    
    const content = fs.readFileSync(spdxFile, 'utf-8');
    const spdx = JSON.parse(content);
    
    expect(spdx['@context']).toBeDefined();
    expect(spdx.spdx).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Regression tests for Z3 / TypeScript / Rust expression translation fixes.
//
// These tests compile the FederatedMeetupProduct spec against each backend
// (z3, typescript, rust) and assert that the generated output contains the
// expected translated patterns. They guard against regressions in:
//   - implies() argument preservation (Z3 + TS + Rust)
//   - multi-level field access flattening (Z3)
//   - len()/length() normalization (Z3)
//   - nil → speckl_nil translation (Z3)
//   - != → (distinct X Y) wrapping (Z3)
//   - constraint checks emitting real every() / iter().all() (TS + Rust)
//   - 'in' operator → .has() in verify expressions (TS)
//   - multiple verify blocks all emitted (memberKey dedup fix) (TS + Rust)
// ---------------------------------------------------------------------------

const SPEC_PATH = '__dirname/../../examples/specs/FederatedMeetupProduct.speckdl';
const OUT_DIR = './out';  // CLI writes to ./out relative to compiler cwd
const COMPILER_DIR = '__dirname/../../compiler';

describe('Z3 / TS / Rust expression translation regressions', () => {
  let z3Output: string;
  let tsOutput: string;
  let rustOutput: string;

  beforeAll(() => {
    // Clean out directory to avoid stale output
    execSync(`rm -rf ${OUT_DIR}`, { cwd: COMPILER_DIR });
    execSync(`mkdir -p ${OUT_DIR}`, { cwd: COMPILER_DIR });

    // Compile to all three targets
    execSync(
      `npx tsx src/index.ts ${SPEC_PATH} --target z3 --output ${OUT_DIR}`,
      { cwd: COMPILER_DIR, stdio: 'pipe' },
    );
    z3Output = fs.readFileSync(
      path.join(COMPILER_DIR, OUT_DIR, 'FederatedMeetupProduct.smt2'),
      'utf-8',
    );

    execSync(
      `npx tsx src/index.ts ${SPEC_PATH} --target typescript --output ${OUT_DIR}`,
      { cwd: COMPILER_DIR, stdio: 'pipe' },
    );
    tsOutput = fs.readFileSync(
      path.join(COMPILER_DIR, OUT_DIR, 'FederatedMeetupProduct.ts'),
      'utf-8',
    );

    execSync(
      `npx tsx src/index.ts ${SPEC_PATH} --target rust --output ${OUT_DIR}`,
      { cwd: COMPILER_DIR, stdio: 'pipe' },
    );
    rustOutput = fs.readFileSync(
      path.join(COMPILER_DIR, OUT_DIR, 'FederatedMeetupProduct', 'src', 'lib.rs'),
      'utf-8',
    );
  }, 120_000);

  // 1. Z3: implies() preserves both arguments → (=> P Q) not (=> true true)
  it('Z3: implies() emits (=> P Q) preserving both arguments', () => {
    expect(z3Output).toContain('(=>');
    expect(z3Output).toContain('(=> (= o_status Refunded) (distinct o_refunded_at speckl_nil))');
    // Ensure we did NOT regress to (=> true true)
    expect(z3Output).not.toContain('(=> true true)');
    expect(z3Output).not.toContain('(=> true');
  });

  // 2. Z3: multi-level field access m.price.amount → m_price_amount
  it('Z3: multi-level field access m.price.amount flattens to m_price_amount', () => {
    expect(z3Output).toContain('m_price_amount');
    // Ensure we did NOT regress to single-level m_price or bare m.price.amount
    expect(z3Output).not.toContain('m.price.amount');
    // The constraint m_price_amount >= 0 should be present
    expect(z3Output).toContain('(>= m_price_amount 0)');
  });

  // 3. Z3: len() handled same as length() → speckl_len_Int
  it('Z3: len() is translated to speckl_len_Int (same as length())', () => {
    // The spec uses len(m.price.currency) — should become speckl_len_Int
    expect(z3Output).toContain('(speckl_len_Int m_price_currency)');
    // Ensure we did NOT regress to bare len() or length()
    expect(z3Output).not.toMatch(/\blen\s*\(/);
    expect(z3Output).not.toMatch(/\blength\s*\(/);
  });

  // 4. Z3: nil translated to speckl_nil
  it('Z3: nil is translated to speckl_nil sentinel', () => {
    expect(z3Output).toContain('(declare-const speckl_nil Int)');
    expect(z3Output).toContain('speckl_nil');
    // Ensure we did NOT regress to bare nil / null
    expect(z3Output).not.toMatch(/\bnil\b/);
  });

  // 5. Z3: != produces (distinct X Y) not bare 'distinct'
  it('Z3: != produces wrapped (distinct X Y) not bare distinct', () => {
    // The constraint g.hosting_tier != Free should emit (distinct g_hosting_tier Free)
    expect(z3Output).toContain('(distinct g_hosting_tier Free)');
    // Ensure we did NOT regress to bare 'distinct g_hosting_tier Free' without parens
    // (the fix wraps the operator in parens)
    // A bare distinct would look like "g_hosting_tier distinct Free" without surrounding parens
    expect(z3Output).not.toMatch(/[^(]\w+\s+distinct\s+\w+/);
  });

  // 6. TS: implies(p,q) → (!p || q) not (p || q)
  it('TS: implies(p, q) translates to (!p || q), not (p || q)', () => {
    // constraint 6: implies(o.status == Refunded, o.refunded_at != nil)
    // Should become (!(o.status === ...) || (o.refunded_at !== ...))
    expect(tsOutput).toContain('(!(');
    expect(tsOutput).toContain('||');
    // The specific pattern: (!(o.status === ... || (o.refunded_at !== nil))
    expect(tsOutput).toMatch(/!\(o\.status === .* \|\| \(o\.refunded_at !== /);
    // Ensure the CODE (not comments) has negation on p.
    // A regression would have `return this.orders.every((o: any) => (o.status ===` 
    // (without the `!(` negation before `o.status`).
    // Strip comments to avoid matching the original spec text in comments.
    const tsNoComments = tsOutput.replace(/^\s*\/\/.*$/gm, '');
    // Positive: the every() body starts with (!(o.status — the (! is the negation
    expect(tsNoComments).toMatch(/every\(\(o:\s*any\)\s*=>\s*\(!\(o\.status/);
    // Negative: a regression would have every((o: any) => (o.status without the ! negation
    expect(tsNoComments).not.toMatch(/every\(\(o:\s*any\)\s*=>\s*\(o\.status/);
  });

  // 7. TS: constraint checks emit real every() not return true
  it('TS: constraint checks emit real .every() calls, not return true', () => {
    expect(tsOutput).toContain('.every(');
    // Multiple constraints use every() — at least 8 constraints
    const everyCount = (tsOutput.match(/\.every\(/g) || []).length;
    expect(everyCount).toBeGreaterThanOrEqual(8);
    // Ensure we did NOT regress to `return true` stubs
    // A stub would have checkConstraintN() { return true; }
    expect(tsOutput).not.toMatch(/checkConstraint\d+\(\):\s*boolean\s*\{\s*return\s*true\s*;\s*\}/);
  });

  // 8. TS: 'in' operator in verify expressions → .has() not raw 'in'
  it('TS: "in" operator in verify expressions translates to .has(), not raw in', () => {
    // V1: always(implies(event == PurchaseTicket, ticket_id in tickets))
    // Should become tickets.has(ticket_id)
    expect(tsOutput).toContain('.has(');
    expect(tsOutput).toContain('tickets.has(ticket_id)');
    // Ensure we did NOT regress to raw 'in' operator (JS `in` checks property keys, not membership).
    // A regression would look like `ticket_id in tickets` in CODE (not comments).
    // Strip comments to avoid matching the original spec text in comments.
    const tsNoComments = tsOutput.replace(/^\s*\/\/.*$/gm, '');
    expect(tsNoComments).not.toMatch(/\bticket_id\s+in\s+tickets\b/);
  });

  // 9. TS/Rust: multiple verify blocks all emitted (memberKey dedup fix)
  it('TS: all 6 verify blocks are emitted (memberKey dedup fix)', () => {
    // The spec has 6 verify blocks; previously dedup killed all but the first
    expect(tsOutput).toContain('verify1');
    expect(tsOutput).toContain('verify2');
    expect(tsOutput).toContain('verify3');
    expect(tsOutput).toContain('verify4');
    expect(tsOutput).toContain('verify5');
    expect(tsOutput).toContain('verify6');
    expect(tsOutput).not.toContain('verify7'); // only 6 verify blocks in spec
  });

  it('Rust: all 6 verify blocks are emitted (memberKey dedup fix)', () => {
    expect(rustOutput).toContain('verify_1');
    expect(rustOutput).toContain('verify_2');
    expect(rustOutput).toContain('verify_3');
    expect(rustOutput).toContain('verify_4');
    expect(rustOutput).toContain('verify_5');
    expect(rustOutput).toContain('verify_6');
    expect(rustOutput).not.toContain('verify_7');
  });

  // 10. Rust: constraint checks emit iter().all() not return true
  it('Rust: constraint checks emit iter().all(), not return true stubs', () => {
    expect(rustOutput).toContain('.iter().all(');
    // Multiple constraints use iter().all() — at least 8 constraints
    const iterAllCount = (rustOutput.match(/\.iter\(\)\.all\(/g) || []).length;
    expect(iterAllCount).toBeGreaterThanOrEqual(8);
    // Ensure we did NOT regress to `return true` stubs
    expect(rustOutput).not.toMatch(/check_invariant_\d+\(&self\)\s*->\s*bool\s*\{\s*true\s*\}/);
  });

  // 11. Rust: implies() → (!p || q) in Rust
  it('Rust: implies(p, q) translates to (!p || q) in Rust', () => {
    // constraint 6: implies(o.status == Refunded, o.refunded_at != nil)
    // Should become (!(o.status == ... || (o.refunded_at != ...))
    expect(rustOutput).toContain('(!(');
    expect(rustOutput).toMatch(/!\(o\.status == .* \|\| \(o\.refunded_at != /);
    // Ensure the CODE (not comments) has negation on p.
    // A regression would have `self.orders.iter().all(|o| (o.status ==` 
    // (without the `!(` negation before `o.status`).
    // Strip comments to avoid matching the original spec text in comments.
    const rustNoComments = rustOutput.replace(/^\s*\/\/.*$/gm, '');
    // Positive: the iter().all() body starts with (!(o.status — the (! is the negation
    expect(rustNoComments).toMatch(/iter\(\)\.all\(\|o\|\s*\(!\(o\.status/);
    // Negative: a regression would have iter().all(|o| (o.status without the ! negation
    expect(rustNoComments).not.toMatch(/iter\(\)\.all\(\|o\|\s*\(o\.status/);
  });
});