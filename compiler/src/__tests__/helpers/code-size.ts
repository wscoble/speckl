// Code-size measures for generated output, so a "compiles + tests pass,
// then shrink" loop has a numeric score to climb (see the parent issue's
// Theo/T3 Code notes: a program that gives a score makes that score go up).
// The token count is a heuristic, not a tokenizer-grade count; use it to
// compare fixtures against each other over time.
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

export interface GeneratedFileSize {
  /** Path relative to the generated root. */
  path: string;
  bytes: number;
  lines: number;
  tokens: number;
}

export interface GeneratedTreeSize {
  files: GeneratedFileSize[];
  bytes: number;
  lines: number;
  tokens: number;
}

/**
 * Rough token estimate in the spirit of a BPE tokenizer: chunk the source
 * into identifiers/keywords, numbers, string and template literals,
 * punctuation runs, and whitespace, then count each chunk of up to 8
 * characters as one token and longer chunks as about one token per 4
 * characters. Dependency-free, deterministic, and good enough to rank
 * fixtures; it is not a count from a real tokenizer.
 */
export function estimateTokens(src: string): number {
  const chunks = src.match(
    /[A-Za-z_$][A-Za-z0-9_$]*|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\s+|[^\sA-Za-z0-9_$"'`]+/g,
  );
  if (!chunks) return 0;
  let tokens = 0;
  for (const chunk of chunks) {
    if (/^\s+$/.test(chunk)) continue;
    tokens += chunk.length <= 8 ? 1 : Math.ceil(chunk.length / 4);
  }
  return tokens;
}

/** Line count in the usual editor sense: what wc -l counts when the file ends in a newline. */
export function countLines(src: string): number {
  return src.length === 0 ? 0 : (src.match(/\n/g) ?? []).length + (src.endsWith('\n') ? 0 : 1);
}

/** Every `.ts` file under `root`, depth first, sorted by path. */
function tsFilesUnder(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...tsFilesUnder(join(root, e.name), rel));
    else if (extname(e.name) === '.ts') out.push(rel);
  }
  return out;
}

/** Measure every generated `.ts` file under `root`, with tree totals. */
export function measureGeneratedCode(root: string): GeneratedTreeSize {
  const files = tsFilesUnder(root).map((rel) => {
    const src = readFileSync(join(root, rel), 'utf-8');
    return { path: rel, bytes: Buffer.byteLength(src, 'utf-8'), lines: countLines(src), tokens: estimateTokens(src) };
  });
  return {
    files,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    lines: files.reduce((n, f) => n + f.lines, 0),
    tokens: files.reduce((n, f) => n + f.tokens, 0),
  };
}
