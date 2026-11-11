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

const OUTLINE_SHA256 = '52680b9231245195f1320de8d2fcc0066b32ab89f7ba24228d531ecf087f9909';
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
});
