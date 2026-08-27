// src/__tests__/round-trip.test.ts
//
// Round-trip property: for every example spec,
//   parse(file) → print → parse(printed) must yield a structurally
//   identical AST, and printing must reach a fixed point:
//   print(parse(print(parse(x)))) === print(parse(x)).
//
// This is cheap insurance for the parser as the language evolves: any new
// syntax the printer doesn't handle shows up immediately as a diff.

import { describe, it, expect } from 'vitest';
import { parseSpeckFile, parseSpeckContent, AST } from '../parser.js';
import { printAST } from '../printer.js';
import { readdirSync } from 'fs';
import { join, resolve } from 'path';

const EXAMPLES_DIR = resolve(__dirname, '..', '..', '..', 'examples');

const exampleFiles = readdirSync(EXAMPLES_DIR)
  .filter(f => f.endsWith('.speckdl'))
  .sort();

describe('printer round-trip', () => {
  for (const file of exampleFiles) {
    it(`${file}: parse → print → parse yields an identical AST`, () => {
      const filePath = join(EXAMPLES_DIR, file);
      const ast1: AST = parseSpeckFile(filePath);
      const printed1 = printAST(ast1);
      const ast2: AST = parseSpeckContent(printed1);
      // Structural identity between the original and reparsed AST.
      expect(stableStringify(ast2)).toEqual(stableStringify(ast1));

      // Fixed point: printing the reparsed AST is stable.
      const printed2 = printAST(ast2);
      expect(printed2).toEqual(printed1);
    });
  }
});

function parseSpeckContent2(content: string): AST {
  return parseSpeckContent(content);
}

/**
 * JSON.stringify with sorted object keys so AST comparison is insensitive to
 * key insertion order.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}