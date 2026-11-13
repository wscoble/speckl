// `stored` is the AST the line walker returns. `message` is what
// parseSpeckContent reports. Every rejection class is off, so a missing
// `}` still parses. Later classes reuse this harness.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lexProblem, lexStart, setParseFile, type SpeckNode } from '../speck-part0.js';
import { maskLine, nextCodeIsNamedBlock, parseSpeck } from '../speck-part1.js';
import { parseSpeckContent } from '../parser.js';

function message(src: string, file = 'bad.speckdl'): string {
  try {
    parseSpeckContent(src, file);
    return 'accept';
  } catch (err) {
    return (err as Error).message;
  }
}

/** The line walker as it was before this check: a broken speck still returned an AST. */
function lineWalkerBefore(content: string, filePath: string): { specks: SpeckNode[] } {
  setParseFile(filePath);
  try {
    const specks: SpeckNode[] = [];
    const lines = content.split('\n');
    let scan = lexStart();
    for (let n = 0; n < lines.length; n++) scan = maskLine(lines[n], scan, n + 1).state;
    if (scan.block) throw lexProblem(scan.openLine, 'unterminated block comment');
    let i = 0;
    let lex = lexStart();
    while (i < lines.length) {
      const masked = maskLine(lines[i], lex, i + 1);
      lex = masked.state;
      const line = lines[i].trim();
      const code = masked.text.trim();
      if (line.startsWith('*/') && /^(speck|action|invariant|state|init)\b/.test(code)) {
        throw lexProblem(i + 1, 'header is not at the start of the line');
      }
      if (!line || !code || line.startsWith('//') || line.startsWith('/*')) {
        i++;
        continue;
      }
      if (line.startsWith('import ')) {
        i++;
        continue;
      }
      if (code === 'speck' && nextCodeIsNamedBlock(lines, i + 1, lex)) {
        throw lexProblem(i + 1, 'speck name must be on the same line as "speck"');
      }
      if (line.startsWith('speck ') && code.startsWith('speck ')) {
        const speck = parseSpeck(lines, i);
        if (speck) specks.push(speck);
        i++;
        continue;
      }
      i++;
    }
    return { specks };
  } finally {
    setParseFile('');
  }
}

function stored(src: string, file = 'bad.speckdl'): string {
  const ast = lineWalkerBefore(src, file);
  return JSON.stringify(ast.specks.map(s => ({
    name: s.name,
    endLine: s.endLine,
    members: s.members.map(m => {
      if (m.type === 'state') return { type: 'state', vars: m.variables.map(v => [v.name, v.typeExpr]) };
      if (m.type === 'init') return { type: 'init', asg: m.assignments };
      if (m.type === 'invariant') return { type: 'invariant', name: m.name, expr: m.expr };
      const named = m as { type: string; name?: string };
      return { type: named.type, name: named.name };
    }),
  })));
}

describe('strict structure check', () => {
  it('still parses a missing close', () => {
    const src = 'speck A {\n';
    expect(stored(src)).toBe(JSON.stringify([{ name: 'A', endLine: 1, members: [] }]));
    expect(message(src)).toBe('accept');
  });

  it('still accepts an extra close', () => {
    const src = 'speck A {\n}\n}\n';
    expect(stored(src)).toBe('[{"name":"A","endLine":2,"members":[]}]');
    expect(message(src)).toBe('accept');
  });

  it('still accepts text after a close', () => {
    const src = 'speck A {\n} junk\n';
    expect(stored(src)).toBe('[{"name":"A","endLine":2,"members":[]}]');
    expect(message(src)).toBe('accept');
  });

  it('still accepts an unrecognized member', () => {
    const src = 'speck A {\n    garbage line here\n}\n';
    expect(stored(src)).toBe('[{"name":"A","endLine":3,"members":[]}]');
    expect(message(src)).toBe('accept');
  });

  it('still accepts a section sign', () => {
    const src = 'speck A {\n §\n}\n';
    expect(stored(src)).toBe('[{"name":"A","endLine":3,"members":[]}]');
    expect(message(src)).toBe('accept');
  });

  it('keeps every rejection class off', () => {
    const text = readFileSync(new URL('../walker-strict.ts', import.meta.url), 'utf8');
    const start = text.indexOf('const ON');
    const block = text.slice(start, text.indexOf('};', start) + 2);
    const flags = [...block.matchAll(/(\w+):\s*(true|false)/g)].map(m => [m[1], m[2]] as const);
    expect(flags.map(([name]) => name)).toEqual([
      'missing', 'extra', 'text', 'second', 'member', 'top', 'memberTail',
      'braceLine', 'state', 'init', 'comment', 'cr', 'section', 'digit',
      'ascii', 'numeric', 'unclosed',
    ]);
    expect(flags.every(([, value]) => value === 'false')).toBe(true);
  });

  it('does not treat a brace inside a string as an extra close', () => {
    const parsed = parseSpeckContent(
      'speck A {\n    state {\n        x: Nat\n    }\n    action Go {\n        note := "}"\n    }\n}\n',
      'ok.speckdl',
    );
    expect(parsed.specks.map(s => s.name)).toEqual(['A']);
  });

  it('keeps the same error when the speck name is on the next line', () => {
    const src = 'speck\nName {\n}\n';
    const old = (() => {
      try {
        lineWalkerBefore(src, 'bad.speckdl');
        return 'accept';
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(old).toBe('Parse error at bad.speckdl:1: speck name must be on the same line as "speck"');
    expect(message(src)).toBe(old);
  });

  it('still parses every example', () => {
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'examples');
    const files = readdirSync(root).filter(name => name.endsWith('.speckdl'));
    expect(files.length).toBeGreaterThanOrEqual(16);
    for (const name of files) {
      const text = readFileSync(join(root, name), 'utf8');
      expect(parseSpeckContent(text, name).specks.length, name).toBeGreaterThan(0);
    }
  });
});
