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

describe('line walker move', () => {
  it('keeps the example member outline', () => {
    const text = outline();
    const hash = createHash('sha256').update(text).digest('hex');
    expect(hash).toBe(OUTLINE_SHA256);
  });
});
