// compiler/src/line-walker is a copy of the line walker from before the
// token parser swap. Later edits store different spans on the AST. The
// lowered IR of every speck in the repo still matches.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lower } from '../ir/lower.js';
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
  it('lowers every speck in the repo to the same IR as the live parser', () => {
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
    const files: string[] = [];
    speckdlFiles(root, files);
    expect(files.filter(path => path.includes('/examples/')).length).toBeGreaterThanOrEqual(16);
    expect(files.length).toBeGreaterThanOrEqual(22);
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      const oldIr = lower(copy(text, path), { filePath: path, resolveImports: false });
      const liveIr = lower(live(text, path), { filePath: path, resolveImports: false });
      expect(JSON.stringify(oldIr), path).toBe(JSON.stringify(liveIr));
    }
  }, 120_000);
});
