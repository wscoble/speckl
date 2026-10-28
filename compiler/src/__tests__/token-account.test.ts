import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseSpeckContent } from '../parser.js';
import { generateGo } from '../generators/go.js';
import { lexTokens } from '../account.js';

const speck = (body: string) => `speck A {\n    state { n: Nat m: Nat }\n    init { n := 0 m := 0 }\n${body}\n}\n`;

function goOf(src: string): string {
  const ast = parseSpeckContent(src, 'p.speckdl');
  const out = mkdtempSync(join(tmpdir(), 'speckl-acc-'));
  generateGo(ast, out);
  return readFileSync(join(out, 'a', 'a.go'), 'utf8');
}

describe('token conservation', () => {
  it('keeps a header that follows a comment on the same line', () => {
    const specs = [
      ['/* c */ speck C {\n    state { n: Nat }\n    init { n := 0 }\n}\n', 'C'],
      [speck('    /* a */ action Evil { m := 99 }'), 'Evil'],
      ['speck A {\n    state { n: Nat }\n    init { n := 0 }\n} /*\nb */ speck C {\n    state { n: Nat }\n    init { n := 0 }\n}\n', 'C'],
    ];
    for (const [src, name] of specs) {
      const ast = parseSpeckContent(src, 'a.speckdl');
      expect(ast.specks.map(s => s.name), src).toContain(name === 'Evil' ? 'A' : name);
      if (name === 'Evil') {
        const action = ast.specks[0].members.find(m => m.type === 'action') as { name: string } | undefined;
        expect(action?.name).toBe('Evil');
      }
    }
    const inv = parseSpeckContent(speck('    /*\n    b */ invariant Q { false }'), 'a17.speckdl');
    const q = inv.specks[0].members.find(m => m.type === 'invariant') as { name: string; expr: string };
    expect(q.name).toBe('Q');
    expect(q.expr).toContain('false');
  });

  it('parses state and init when { is on the next line or tight against the word', () => {
    for (const src of [
      speck('    state\n    {\n        n: Nat\n    }'),
      speck('    state\t{\n        n: Nat\n    }'),
      speck('    state/* c */{\n        n: Nat\n    }'),
    ]) {
      const ast = parseSpeckContent(src, 'n01.speckdl');
      const fields = ast.specks.flatMap(s => s.members.filter(m => m.type === 'state').flatMap(m => (m as { variables: { name: string }[] }).variables.map(v => v.name)));
      expect(fields, src).toContain('n');
    }
    const init = parseSpeckContent(speck('    init\n    {\n        n := 4\n    }'), 'n02.speckdl');
    const assigns = init.specks.flatMap(s => s.members.filter(m => m.type === 'init').flatMap(m => (m as { assignments: { name: string; expr: string }[] }).assignments.map(a => `${a.name}=${a.expr}`)));
    expect(assigns).toContain('n=4');
  });

  it('does not run an else or for body that opens on the next line', () => {
    const iff = () => parseSpeckContent(speck('    action Go {\n        iff n > 3\n        {\n            n := 0\n        }\n    }'), 'n24.speckdl');
    expect(iff).toThrow(/unknown block/);
    const els = goOf(speck('    action Go {\n        if n > 3 {\n            n := 0\n        }\n        else\n        {\n            n := 1\n        }\n    }'));
    expect(els).toMatch(/if[\s\S]*m\.N = 0[\s\S]*else[\s\S]*m\.N = 1/);
    expect(els).not.toMatch(/}\s*\n\s*m\.N = 1/);
    const fr = goOf(speck('    action Go {\n        for i in {1, 2}\n        {\n            m := i\n        }\n    }'));
    const outside = fr.split('func ')[1] ?? fr;
    expect(outside).not.toMatch(/}\s*\n\tm\.M = i/);
    expect(fr).toMatch(/m\.M = i|for i in/);
  });

  it('rejects a block brace that is not an allowlisted header', () => {
    const cases = [
      speck('    foo.bar\n    {\n        action Bad { n := 1 }\n    }'),
      speck('    x = {\n        action Bad { n := 1 }\n    }'),
      speck('    meta: {\n        action Bad { n := 1 }\n    }'),
      speck('    action Pay(a: Nat)) {\n        require n < 5\n        n := 1\n    }'),
    ];
    for (const src of cases) {
      expect(() => parseSpeckContent(src, 'bad.speckdl'), src).toThrow(/unknown block|unparsed text at /);
    }
  });
});

describe('mutated specs do not move a canary', () => {
  const examples = readdirSync(resolve(__dirname, '..', '..', '..', 'examples'))
    .filter(f => f.endsWith('.speckdl'))
    .sort();
  const seed = 20261028;
  const cases = 2000;

  it(`checks ${cases} single-token edits with a fixed seed`, () => {
    let rng = seed;
    const next = () => {
      rng = (rng * 1664525 + 1013904223) >>> 0;
      return rng / 0x100000000;
    };
    const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)];
    let checked = 0;
    for (let n = 0; n < cases; n++) {
      const file = pick(examples);
      const src = readFileSync(resolve(__dirname, '..', '..', '..', 'examples', file), 'utf8')
        + '\nspeck CanaryHost {\n    invariant Canary { false }\n}\n';
      const toks = lexTokens(src).filter(t => t.kind !== 'nl');
      if (toks.length < 2) continue;
      const at = Math.floor(next() * toks.length);
      const kind = Math.floor(next() * 6);
      const insert = pick(['{', '}', '/*', '*/', ';', '\n']);
      let edited = src;
      const tok = toks[at];
      const lines = src.split('\n');
      const lineIdx = tok.line - 1;
      const line = lines[lineIdx] ?? '';
      if (kind === 0) {
        lines[lineIdx] = line.slice(0, tok.col - 1) + line.slice(tok.end - 1);
        edited = lines.join('\n');
      } else if (kind === 1) {
        lines[lineIdx] = line.slice(0, tok.end - 1) + tok.text + line.slice(tok.end - 1);
        edited = lines.join('\n');
      } else {
        const col = Math.min(tok.col - 1, line.length);
        lines[lineIdx] = line.slice(0, col) + insert + line.slice(col);
        edited = lines.join('\n');
      }
      let ast;
      try { ast = parseSpeckContent(edited, file); }
      catch { checked++; continue; }
      const homes = ast.specks.filter(s => s.members.some(m => m.type === 'invariant' && (m as { name: string }).name === 'Canary'));
      expect(homes.length, file).toBeLessThanOrEqual(1);
      if (homes.length === 1) expect(homes[0].name.startsWith('CanaryHost'), file).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
