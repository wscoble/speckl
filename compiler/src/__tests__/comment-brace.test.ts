// A `}` inside a trailing comment must not close the surrounding block,
// and a `//` inside a string literal must not start a comment.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpeckContent, type ActionNode, type StateNode } from '../parser.js';
import {
  braceCounts,
  blockSpan,
  indexOfCode,
  lastIndexOfCode,
  scanLine,
  stripTrailingLineComment,
} from '../lex-scan.js';

const compilerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function dedent(src: string): string {
  const lines = src.replace(/^\n/, '').replace(/\s*$/, '').split('\n');
  const pad = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^ */)?.[0].length ?? 0));
  return lines.map(l => l.slice(pad)).join('\n');
}

function speck(src: string) {
  return parseSpeckContent(dedent(src)).specks[0];
}

function action(src: string, name: string): ActionNode {
  const node = speck(src).members.find(m => m.type === 'action' && m.name === name);
  if (!node || node.type !== 'action') throw new Error(`missing action ${name}`);
  return node;
}

describe('braces inside comments do not close blocks', () => {
  it('parses the require-comment repro and keeps the following statements and next', () => {
    const ast = speck(`
      speck Counter {
        state {
          n: Nat
        }
        init {
          n := 0
        }
        action Inc {
          require n < 3 // a } b
          n := n + 1
        }
        next: Inc
      }
    `);
    const inc = ast.members.find(m => m.type === 'action' && m.name === 'Inc');
    expect(inc && inc.type === 'action' && inc.statements).toEqual([
      { type: 'require', expr: 'n < 3', source: 'n < 3 // a } b' },
      { type: 'assign', target: 'n', expr: 'n + 1' },
    ]);
    const next = ast.members.find(m => m.type === 'next');
    expect(next && next.type === 'next' && next.actions).toEqual(['Inc']);
  });

  it('keeps a } in a comment on a single-line block and on a multi-line block', () => {
    // The real closer is before the comment. A later `}` inside `//` must
    // not be treated as another closer (it used to end the speck).
    const closed = speck(`
      speck S {
        state { n: Nat } // a } b
        action Inc { require n < 3 } // a } b
        next: Inc
      }
    `);
    const single = closed.members.find(m => m.type === 'action') as ActionNode;
    expect(single.statements).toEqual([
      { type: 'require', expr: 'n < 3' },
    ]);
    const state = closed.members.find(m => m.type === 'state') as StateNode;
    expect(state.variables.map(v => v.name)).toEqual(['n']);
    const closedNext = closed.members.find(m => m.type === 'next');
    expect(closedNext && closedNext.type === 'next' && closedNext.actions).toEqual(['Inc']);

    // A `}` that exists only inside the comment does not finish the block.
    const multi = speck(`
      speck S {
        state {
          n: Nat // a } b
          m: Nat
        }
        action Inc { require n < 3 // a } b
          n := n + 1
        }
        next: Inc
      }
    `);
    const inc = multi.members.find(m => m.type === 'action') as ActionNode;
    expect(inc.statements.map(s => s.type === 'require' || s.type === 'assign' ? s.expr : s.type)).toEqual([
      'n < 3',
      'n + 1',
    ]);
    const st = multi.members.find(m => m.type === 'state') as StateNode;
    expect(st.variables.map(v => v.name)).toEqual(['n', 'm']);
    const next = multi.members.find(m => m.type === 'next');
    expect(next && next.type === 'next' && next.actions).toEqual(['Inc']);
  });

  it('ignores } inside a block comment, including one that spans lines', () => {
    const ast = speck(`
      speck S {
        state { n: Nat }
        action Inc {
          require n < 3 /* a } b */
          n := n + 1 /* }
          }
          */
        }
        next: Inc
      }
    `);
    const inc = ast.members.find(m => m.type === 'action') as ActionNode;
    expect(inc.statements.map(s => s.type)).toEqual(['require', 'assign']);
    expect(inc.statements[0]).toMatchObject({ expr: 'n < 3 /* a } b */' });
    expect(inc.statements[1]).toMatchObject({ expr: 'n + 1 /* }' });
    const next = ast.members.find(m => m.type === 'next');
    expect(next && next.type === 'next' && next.actions).toEqual(['Inc']);
  });

  it('does not treat // inside a string literal as a comment', () => {
    const inc = action(`
      speck S {
        state { n: Nat }
        action Set {
          require s == "http://example.com/a"
          require t == 'http://example.com/a }'
          n := "x // } y"
          p := "a\\\\" // }
        }
        next: Set
      }
    `, 'Set');
    expect(inc.statements).toEqual([
      { type: 'require', expr: 's == "http://example.com/a"' },
      { type: 'require', expr: "t == 'http://example.com/a }'" },
      { type: 'assign', target: 'n', expr: '"x // } y"' },
      { type: 'assign', target: 'p', expr: '"a\\\\"', source: '"a\\\\" // }' },
    ]);
    const next = speck(`
      speck S {
        state { n: Nat }
        action Set {
          require s == "http://example.com/a"
          n := "x // } y"
        }
        next: Set
      }
    `).members.find(m => m.type === 'next');
    expect(next && next.type === 'next' && next.actions).toEqual(['Set']);
  });

  it('compiles the repro instead of dropping the rest of the action', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-brace-'));
    const src = `speck Counter {
  state {
    n: Nat
  }
  init {
    n := 0
  }
  action Inc {
    require n < 3 // a } b
    n := n + 1
  }
  next: Inc
}
`;
    try {
      const file = join(dir, 'Counter.speckdl');
      writeFileSync(file, src);
      const r = spawnSync(process.execPath, [
        join(compilerDir, 'node_modules', 'vite-node', 'vite-node.mjs'),
        join(compilerDir, 'src', 'index.ts'),
        file, '-t', 'typescript', '-o', join(dir, 'out'),
      ], { cwd: compilerDir, encoding: 'utf-8' });
      expect(r.status).toBe(0);
      const ts = readFileSync(join(dir, 'out', 'Counter.ts'), 'utf-8');
      expect(ts).toContain('n < 3');
      expect(ts).toMatch(/n \+ 1|n\+1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lex scan', () => {
  it('counts only code braces and strips only real comments', () => {
    expect(stripTrailingLineComment('n < 3')).toBe('n < 3');
    expect(stripTrailingLineComment('n < 3 // a } b')).toBe('n < 3');
    expect(stripTrailingLineComment('"http://x // }"')).toBe('"http://x // }"');
    expect(stripTrailingLineComment("'http://x' // }")).toBe("'http://x'");
    expect(braceCounts('/* } */ {')).toEqual({ open: 1, close: 0, inBlock: false });
    expect(braceCounts('/* }')).toEqual({ open: 0, close: 0, inBlock: true });
    expect(braceCounts('}', true)).toEqual({ open: 0, close: 0, inBlock: true });
    expect(braceCounts('*/ }', true)).toEqual({ open: 0, close: 1, inBlock: false });
    expect(braceCounts('"a\\\\" // } {')).toEqual({ open: 0, close: 0, inBlock: false });
    expect(blockSpan('action A { require true }').balanced).toBe(true);
    expect(blockSpan('action A {').balanced).toBe(false);
    expect(indexOfCode('// }', '}')).toBe(-1);
    expect(indexOfCode('{', '{')).toBe(0);
    const sample = 'a { b { c } }';
    expect(lastIndexOfCode(sample, '}')).toBeGreaterThan(indexOfCode(sample, '}'));
    let saw = '';
    expect(scanLine('a / b', (ch) => { saw += ch; })).toBe(false);
    expect(saw).toBe('a / b');
  });
});
