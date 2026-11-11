// The line walker copied under ./line-walker is the parser from the
// output-hash branch (parser.ts and speck-part0.ts through speck-part9.ts).
// parseSpeck on this branch calls the token parser. This file lowers both
// ASTs with the same lower() and compares the IR.
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lower } from '../ir/lower.js';
import type { IR } from '../ir/types.js';
import { parseSpeckContent as parseRd } from '../parser.js';
import { parseSpeckContent as parseWalker } from './line-walker/parser.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const roots = [
  join(here, '..', '..', '..', 'examples'),
  join(here, 'fixtures'),
  join(here, '..', '..', '__tests__', 'fixtures'),
];

function speckdlFiles(): string[] {
  const out: string[] = [];
  for (const root of roots) {
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (name.endsWith('.speckdl') && statSync(path).isFile()) out.push(path);
    }
  }
  return out.sort();
}

function message(parse: (src: string, file?: string) => unknown, src: string, file: string): string {
  try {
    parse(src, file);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

function irOf(parse: (src: string, file?: string) => unknown, src: string, file: string): IR {
  return lower(parse(src, file) as never, { filePath: file, resolveImports: false });
}

describe('line walker and token parser', () => {
  it('lowers every example and fixture to the same IR', () => {
    const files = speckdlFiles();
    expect(files.some(path => path.endsWith('KafkaKRaft.speckdl'))).toBe(true);
    expect(files.some(path => path.endsWith('OAuth2AuthorizationCode.speckdl'))).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(22);
    const diffs: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      const walker = irOf(parseWalker, text, path);
      const rd = irOf(parseRd, text, path);
      if (JSON.stringify(walker) !== JSON.stringify(rd)) diffs.push(path);
    }
    expect(diffs).toEqual([]);
  }, 120_000);

  it('compares malformed error text and position with the line walker', () => {
    const file = 'bad.speckdl';
    const rows: { src: string; walker: string; rd: string }[] = [
      {
        src: 'speck A {\n',
        walker: '',
        rd: 'Parse error at bad.speckdl:1: missing final "}" (column 9)',
      },
      {
        src: 'speck A {\n}\n}\n',
        walker: '',
        rd: 'Parse error at bad.speckdl:3: extra "}" (column 1)',
      },
      {
        src: 'speck A {\n} junk\n',
        walker: '',
        rd: 'Parse error at bad.speckdl:2: text after a speck\'s "}" (column 3)',
      },
      {
        src: 'speck A {\n    garbage line here\n}\n',
        walker: '',
        rd: 'Parse error at bad.speckdl:2: unrecognized member "garbage line here" (column 5)',
      },
      {
        src: 'speck A {\n    x: "ab\n}\n',
        walker: 'Parse error at bad.speckdl:2: unterminated string',
        rd: 'Parse error at bad.speckdl:2: unterminated string (column 8)',
      },
      {
        src: 'speck A {\n §\n}\n',
        walker: '',
        rd: 'Parse error at bad.speckdl:2: unexpected character "§" (column 2)',
      },
      {
        src: 'speck\nName {\n}\n',
        walker: 'Parse error at bad.speckdl:1: speck name must be on the same line as "speck"',
        rd: 'Parse error at bad.speckdl:1: speck name must be on the same line as "speck"',
      },
    ];
    for (const row of rows) {
      expect(message(parseWalker, row.src, file), row.src).toBe(row.walker);
      expect(message(parseRd, row.src, file), row.src).toBe(row.rd);
    }

    const dir = mkdtempSync(join(tmpdir(), 'speckl-walker-'));
    const empty = join(dir, 'empty.speckdl');
    const comment = join(dir, 'comment.speckdl');
    writeFileSync(empty, '');
    writeFileSync(comment, '// only\n');
    for (const path of [empty, comment]) {
      const text = readFileSync(path, 'utf8');
      expect(JSON.stringify(irOf(parseWalker, text, path))).toBe(JSON.stringify(irOf(parseRd, text, path)));
    }
  });
});
