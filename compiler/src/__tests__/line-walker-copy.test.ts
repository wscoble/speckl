// compiler/src/line-walker is a copy of the line walker. parseSpeck does
// not call it. This test is the check that the copy and the live parser
// return the same AST for every speck in the repo.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent as copy } from '../line-walker/parser.js';
import { parseSpeckContent as live } from '../parser.js';

function speckdlFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) speckdlFiles(path, out);
    else if (name.endsWith('.speckdl')) out.push(path);
  }
}

describe('line walker copy', () => {
  it('parses every speck in the repo the same way as the live parser', () => {
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
    const files: string[] = [];
    speckdlFiles(root, files);
    expect(files.filter(path => path.includes('/examples/')).length).toBeGreaterThanOrEqual(16);
    expect(files.length).toBeGreaterThanOrEqual(22);
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      expect(JSON.stringify(copy(text, path)), path).toBe(JSON.stringify(live(text, path)));
    }
  });
});
