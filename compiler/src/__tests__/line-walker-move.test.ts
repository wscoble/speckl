// The line walker moved out of parser.ts. This pin is the member outline of
// every example. A change to what the walker stores fails the hash.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';

const examplesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'examples');

function outline(): string {
  const rows: string[] = [];
  for (const file of readdirSync(examplesDir).filter(f => f.endsWith('.speckdl')).sort()) {
    const ast = parseSpeckContent(readFileSync(join(examplesDir, file), 'utf8'), file);
    for (const speck of ast.specks) {
      rows.push(`${file} ${speck.name}`);
      for (const member of speck.members) {
        const name = 'name' in member && typeof member.name === 'string' ? member.name : '';
        rows.push(`  ${member.type}:${name}`);
      }
    }
  }
  return rows.join('\n');
}

const OUTLINE_SHA256 = '485dbb7239566f2687b2cb3afb4bafdd62a45cba2ca50c08c06e2b202e68e736';
const goldenPath = fileURLToPath(new URL('./fixtures/line-walker-outline.txt', import.meta.url));

describe('line walker move', () => {
  it('matches the member outline the walker produced before the move', () => {
    const text = outline();
    const golden = readFileSync(goldenPath, 'utf8').replace(/\n$/, '');
    expect(text).toBe(golden);
    expect(createHash('sha256').update(text).digest('hex')).toBe(OUTLINE_SHA256);
    expect(createHash('sha256').update(golden).digest('hex')).toBe(OUTLINE_SHA256);
  });

  it('a changed outline does not keep that hash', () => {
    const text = outline();
    const changed = `${text}\n  state:extra`;
    expect(createHash('sha256').update(changed).digest('hex')).not.toBe(OUTLINE_SHA256);
  });

  it('names every example file in the golden outline', () => {
    const files = readdirSync(examplesDir).filter(f => f.endsWith('.speckdl')).sort();
    const golden = readFileSync(goldenPath, 'utf8');
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(golden, file).toContain(`${file} `);
      expect(outline(), file).toContain(`${file} `);
    }
  });

  it('throws on a bad string, a bad comment, a bad next, and a bad import', () => {
    expect(() => parseSpeckContent('speck A {\n    s := "hi\n}\n', 'bad.speckdl')).toThrow(/unterminated string/);
    expect(() => parseSpeckContent('speck A {\n    /* never\n}\n', 'bad.speckdl')).toThrow(/unterminated block comment/);
    expect(() => parseSpeckContent('speck A {\n    next: 1 +\n}\n', 'bad.speckdl')).toThrow(/not an action name/);
    expect(() => parseSpeckContent('import not-a-path\nspeck A {\n}\n', 'bad.speckdl')).toThrow(/Failed to parse import/);
  });
});
