// Size score for the Effect target, for the later "compiles + tests pass,
// then shrink" hill climb: for every fixture the Effect compile test covers,
// measure the generated code (bytes, lines, token estimate) and print a
// per-fixture table plus a total in the test output. The machine-readable
// line at the end makes the score easy to pull out of the output later.
// See helpers/code-size.ts for what the token estimate counts.
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exampleNames, FIXTURES_DIR, generate } from './helpers/toolchains.js';
import { measureGeneratedCode } from './helpers/code-size.js';

// Same fixtures as compiles-effect.test.ts.
const FIXTURES = [...exampleNames(), join(FIXTURES_DIR, 'EffectTranslation.speckdl')];

interface SizeRow {
  fixture: string;
  bytes: number;
  lines: number;
  tokens: number;
  files: number;
}

const rows: SizeRow[] = [];

describe('Effect size score', () => {
  it.each(FIXTURES)('%s', (fixture) => {
    const size = measureGeneratedCode(generate(fixture, 'effect'));
    expect(size.files.length).toBeGreaterThan(0);
    rows.push({
      fixture: basename(fixture).replace(/\.speckdl$/, ''),
      bytes: size.bytes,
      lines: size.lines,
      tokens: size.tokens,
      files: size.files.length,
    });
  });

  it('prints the per-fixture table and the total', () => {
    expect(rows.length).toBeGreaterThan(0);
    const ordered = [...rows].sort((a, b) => (a.fixture < b.fixture ? -1 : a.fixture > b.fixture ? 1 : 0));
    const total = {
      fixture: 'TOTAL',
      bytes: ordered.reduce((n, r) => n + r.bytes, 0),
      lines: ordered.reduce((n, r) => n + r.lines, 0),
      tokens: ordered.reduce((n, r) => n + r.tokens, 0),
      files: ordered.reduce((n, r) => n + r.files, 0),
    };
    const width = Math.max(...ordered.map((r) => r.fixture.length), total.fixture.length);
    const num = (n: number) => n.toLocaleString('en-US');
    const line = (fixture: string, bytes: number, lines: number, tokens: number, files: number) =>
      `${fixture.padEnd(width)}  ${num(bytes).padStart(10)}  ${num(lines).padStart(7)}  ${num(tokens).padStart(8)}  ${String(files).padStart(3)}`;
    const header = `${'fixture'.padEnd(width)}  ${'bytes'.padStart(10)}  ${'lines'.padStart(7)}  ${'tokens'.padStart(8)}  ${'files'.padStart(3)}`;
    console.log(`\nGenerated Effect code size (token column is an estimate, see helpers/code-size.ts):\n`);
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const r of ordered) console.log(line(r.fixture, r.bytes, r.lines, r.tokens, r.files));
    console.log('-'.repeat(header.length));
    console.log(line(total.fixture, total.bytes, total.lines, total.tokens, total.files));
    console.log(`\nEFFECT-SIZE-JSON ${JSON.stringify({ rows: ordered, total })}`);
  });
});
