// The line walker copied under ../line-walker is the parser from the
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
import { parseSpeckContent as parseWalker } from '../line-walker/parser.js';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

function speckdlFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.speckdl')) out.push(path);
    }
  };
  walk(repoRoot);
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
  it('lowers every speck in the repo to the same IR', () => {
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

  it('matches the line walker on malformed input, including the AST when both accept', () => {
    const file = 'bad.speckdl';
    const sources = [
      'speck A {\n',
      'speck A {\n}\n}\n',
      'speck A {\n} junk\n',
      'speck A {\n    garbage line here\n}\n',
      'speck A {\n    state { x: Nat }\n    garbage line here\n}\n',
      'speck A {\n    x: "ab\n}\n',
      'speck A {\n §\n}\n',
      'speck A {\n    x → y\n}\n',
      'speck\nName {\n}\n',
      'speck A { } speck B { }\n',
      'speck A {\n    /* c */ action go {\n        x := 1\n    }\n}\n',
      '/* note */ speck A {\n}\n',
      'speck A {\n    invariant P { x >= 0 } junk\n}\n',
      'speck A {\n    actoin go {\n        x := 1\n    }\n}\n',
      'speck A {\n    state { x: Nat }\n}\nspek B {\n}\n',
      'speck 9A {\n}\n',
    ];
    for (const src of sources) {
      const walkerMessage = message(parseWalker, src, file);
      const rdMessage = message(parseRd, src, file);
      expect(rdMessage, src).toBe(walkerMessage);
      if (walkerMessage === '') {
        expect(JSON.stringify(parseRd(src, file)), src).toBe(JSON.stringify(parseWalker(src, file)));
      }
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
