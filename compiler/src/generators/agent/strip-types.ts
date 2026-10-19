// Type-erasure for the TypeScript the state-machine generator emits, so the
// agent target can ship a plain-JavaScript machine without depending on the
// `typescript` package at runtime.
//
// This is not a general TypeScript compiler. It handles exactly the
// TS-only constructs the generator produces (checked by tests against
// ts.transpileModule for every example):
//   interface / type alias declarations, `as T` casts, `x!` non-null and
//   `name!:` definite assignment, `: T` annotations on parameters, return
//   types, variable and class-property declarations, optional `?` markers,
//   and readonly/private/public/protected modifiers.
// Anything it does not recognize is left as-is; the agent generator then
// syntax-checks the result, so a gap fails at compile time, not in the hook.

type Kind = 'ws' | 'comment' | 'ident' | 'num' | 'str' | 'tmpl' | 'regex' | 'punct';
interface Tok { k: Kind; t: string; }

const PUNCTS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '**', '<<'];
const KEYWORDS_NOT_EXPR_END = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of',
  'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const prevSig = (): Tok | undefined => {
    for (let j = out.length - 1; j >= 0; j--) if (out[j].k !== 'ws' && out[j].k !== 'comment') return out[j];
    return undefined;
  };
  while (i < src.length) {
    const c = src[i];
    const start = i;
    if (/\s/.test(c)) {
      while (i < src.length && /\s/.test(src[i])) i++;
      out.push({ k: 'ws', t: src.slice(start, i) });
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out.push({ k: 'comment', t: src.slice(start, i) });
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      out.push({ k: 'comment', t: src.slice(start, i) });
    } else if (/[A-Za-z_$]/.test(c)) {
      while (i < src.length && /[\w$]/.test(src[i])) i++;
      out.push({ k: 'ident', t: src.slice(start, i) });
    } else if (/[0-9]/.test(c)) {
      while (i < src.length && /[\w.]/.test(src[i])) i++;
      out.push({ k: 'num', t: src.slice(start, i) });
    } else if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; }
      i++;
      out.push({ k: 'str', t: src.slice(start, i) });
    } else if (c === '`') {
      i = scanTemplate(src, i);
      out.push({ k: 'tmpl', t: src.slice(start, i) });
    } else if (c === '/' && !isExprEnd(prevSig())) {
      i++;
      let inClass = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        i++;
      }
      i++;
      while (i < src.length && /[a-z]/.test(src[i])) i++;
      out.push({ k: 'regex', t: src.slice(start, i) });
    } else {
      const p = PUNCTS.find(x => src.startsWith(x, i)) ?? c;
      i += p.length;
      out.push({ k: 'punct', t: p });
    }
  }
  return out;
}

function scanTemplate(src: string, i: number): number {
  i++; // opening backtick
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '$' && src[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '`') { i = scanTemplate(src, i); continue; }
        if (ch === '"' || ch === "'") {
          i++;
          while (i < src.length && src[i] !== ch) { if (src[i] === '\\') i++; i++; }
        } else if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i + 1;
}

/** Strip types inside each `${...}` of a template literal token. */
function stripTemplate(t: string): string {
  if (!t.includes('${')) return t;
  let out = '`';
  let i = 1;
  while (i < t.length - 1) {
    if (t[i] === '\\') { out += t.slice(i, i + 2); i += 2; continue; }
    if (t[i] === '$' && t[i + 1] === '{') {
      // find the matching close brace using the same rules as scanTemplate
      let j = i + 2;
      let depth = 1;
      while (j < t.length && depth > 0) {
        const ch = t[j];
        if (ch === '`') { j = scanTemplate(t, j); continue; }
        if (ch === '"' || ch === "'") {
          j++;
          while (j < t.length && t[j] !== ch) { if (t[j] === '\\') j++; j++; }
        } else if (ch === '{') depth++;
        else if (ch === '}') depth--;
        j++;
      }
      out += '${' + stripTypes(t.slice(i + 2, j - 1)) + '}';
      i = j;
      continue;
    }
    out += t[i];
    i++;
  }
  return out + '`';
}

function isExprEnd(t: Tok | undefined): boolean {
  if (!t) return false;
  if (t.k === 'ident') return !KEYWORDS_NOT_EXPR_END.has(t.t);
  if (t.k === 'num' || t.k === 'str' || t.k === 'tmpl' || t.k === 'regex') return true;
  return t.t === ')' || t.t === ']' || t.t === '}';
}

class Stripper {
  private keep: boolean[];
  /** Brace token indices that open a class body. */
  private classBraces = new Set<number>();

  constructor(private toks: Tok[]) {
    this.keep = toks.map(() => true);
  }

  private sig(i: number): number {
    while (i < this.toks.length && (this.toks[i].k === 'ws' || this.toks[i].k === 'comment')) i++;
    return i;
  }

  private prevSig(i: number): number {
    i--;
    while (i >= 0 && (this.toks[i].k === 'ws' || this.toks[i].k === 'comment')) i--;
    return i;
  }

  private is(i: number, t: string): boolean {
    return i < this.toks.length && this.toks[i].t === t && this.toks[i].k !== 'str';
  }

  private drop(from: number, to: number): void {
    for (let j = from; j < to; j++) this.keep[j] = false;
  }

  /** Index just past the bracket matching the opener at i. */
  private matchClose(i: number): number {
    const open = this.toks[i].t;
    const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : '>';
    let depth = 0;
    for (let j = i; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.k !== 'punct') continue;
      if (t.t === open) depth++;
      else if (t.t === close) { depth--; if (depth === 0) return j + 1; }
    }
    throw new Error(`strip-types: unbalanced ${open}`);
  }

  // --- type grammar (enough for generator output) ---
  private skipType(i: number): number {
    i = this.sig(i);
    if (this.is(i, '|') || this.is(i, '&')) i = this.sig(i + 1);
    i = this.skipPostfix(i);
    for (;;) {
      const j = this.sig(i);
      if (this.is(j, '|') || this.is(j, '&')) { i = this.skipPostfix(this.sig(j + 1)); continue; }
      return i;
    }
  }

  private skipPostfix(i: number): number {
    i = this.skipPrimary(i);
    for (;;) {
      const j = this.sig(i);
      if (this.is(j, '[') && !/\s/.test(this.toks[i]?.t ?? '')) { i = this.matchClose(j); continue; }
      return i;
    }
  }

  private skipPrimary(i: number): number {
    i = this.sig(i);
    const t = this.toks[i];
    if (!t) throw new Error('strip-types: type expected at end of input');
    if (t.k === 'ident' && (t.t === 'typeof' || t.t === 'keyof' || t.t === 'readonly' || t.t === 'unique')) {
      return this.skipPostfix(i + 1);
    }
    if (t.k === 'ident') {
      i++;
      while (this.is(this.sig(i), '.') && this.toks[this.sig(this.sig(i) + 1)]?.k === 'ident') i = this.sig(this.sig(i) + 1) + 1;
      const j = this.sig(i);
      if (this.is(j, '<')) return this.matchClose(j);
      return i;
    }
    if (t.k === 'str' || t.k === 'num' || t.k === 'tmpl') return i + 1;
    if (t.t === '-' ) return this.skipPrimary(i + 1);
    if (t.t === '{' || t.t === '[') return this.matchClose(i);
    if (t.t === '(') {
      const end = this.matchClose(i);
      const j = this.sig(end);
      if (this.is(j, '=>')) return this.skipType(j + 1);
      return end;
    }
    throw new Error(`strip-types: unexpected ${JSON.stringify(t.t)} in type`);
  }

  /** Strip `: T` starting at colon index c; returns index after the type. */
  private stripAnnotation(c: number): number {
    const end = this.skipType(c + 1);
    this.drop(c, end);
    return end;
  }

  /** Param list: opener at i. Strips param annotations and `?`. Returns index past `)`. */
  private stripParams(i: number): number {
    const end = this.matchClose(i);
    let depth = 0;
    let j = i + 1;
    while (j < end - 1) {
      const t = this.toks[j];
      if (t.k === 'punct' && (t.t === '(' || t.t === '[' || t.t === '{')) {
        // destructuring patterns / default values: walk through
        if (depth === 0 && t.t === '(') { j = this.matchClose(j); continue; }
        depth++;
      } else if (t.k === 'punct' && (t.t === ')' || t.t === ']' || t.t === '}')) {
        depth--;
      } else if (depth === 0 && t.k === 'ident' && /^(readonly|private|public|protected)$/.test(t.t)) {
        this.drop(j, this.sig(j + 1));
      } else if (depth === 0 && (t.t === '?' || t.t === ':') && t.k === 'punct') {
        let c = j;
        if (t.t === '?') {
          const n = this.sig(j + 1);
          if (!this.is(n, ':')) { j++; continue; }
          this.drop(j, j + 1);
          c = n;
        }
        j = this.stripAnnotation(c);
        continue;
      } else if (depth === 0 && t.t === '=' && t.k === 'punct') {
        // default value: skip expression to next top-level comma
        let d = 0;
        j++;
        while (j < end - 1) {
          const u = this.toks[j];
          if (u.k === 'punct' && '([{'.includes(u.t)) d++;
          else if (u.k === 'punct' && ')]}'.includes(u.t)) d--;
          else if (d === 0 && u.t === ',') break;
          j++;
        }
        continue;
      }
      j++;
    }
    return end;
  }

  /** After a param list ending at `end`, strip a return type if present. */
  private stripReturnType(end: number): number {
    const c = this.sig(end);
    if (this.is(c, ':')) return this.stripAnnotation(c);
    return end;
  }

  run(): string {
    const toks = this.toks;
    const classStack: number[] = [];
    let braceDepth = 0;
    let pendingClass = false;
    let i = 0;
    while (i < toks.length) {
      const t = toks[i];
      if (!this.keep[i] || t.k === 'ws' || t.k === 'comment') { i++; continue; }

      if (t.k === 'ident') {
        const prev = this.prevSig(i);
        const prevTok = prev >= 0 ? toks[prev] : undefined;
        const atStmtStart = !prevTok || prevTok.t === ';' || prevTok.t === '{' || prevTok.t === '}' || prevTok.t === 'export';
        // interface X { ... }  /  type X = ...;
        if ((t.t === 'interface' || t.t === 'type') && atStmtStart && toks[this.sig(i + 1)]?.k === 'ident') {
          const from = prevTok && prevTok.t === 'export' ? prev : i;
          let end: number;
          if (t.t === 'interface') {
            let j = this.sig(i + 1);
            while (!this.is(j, '{')) j = this.sig(j + 1);
            end = this.matchClose(j);
          } else {
            let j = i + 1;
            let d = 0;
            while (j < toks.length) {
              const u = toks[j];
              if (u.k === 'punct' && '([{'.includes(u.t)) d++;
              else if (u.k === 'punct' && ')]}'.includes(u.t)) d--;
              else if (d === 0 && u.t === ';' && u.k === 'punct') { j++; break; }
              j++;
            }
            end = j;
          }
          this.drop(from, end);
          i = end;
          continue;
        }
        if (t.t === 'as' && isExprEnd(prevTok) && prevTok?.t !== 'as') {
          const end = this.skipType(i + 1);
          // keep one space if we would glue tokens together
          this.drop(prev + 1, end);
          i = end;
          continue;
        }
        if (t.t === 'class') { pendingClass = true; i++; continue; }
        if (t.t === 'function') {
          let j = this.sig(i + 1);
          if (toks[j]?.k === 'ident') j = this.sig(j + 1);
          if (this.is(j, '(')) {
            const end = this.stripParams(j);
            i = this.stripReturnType(end);
            continue;
          }
        }
        if ((t.t === 'const' || t.t === 'let' || t.t === 'var')) {
          let j = this.sig(i + 1);
          if (toks[j]?.k === 'ident') {
            const n = this.sig(j + 1);
            if (this.is(n, ':')) { i = this.stripAnnotation(n); continue; }
          }
          i++;
          continue;
        }
        // class member start
        const inClassBody = classStack.length > 0 && classStack[classStack.length - 1] === braceDepth;
        if (inClassBody && atStmtStart) {
          let j = i;
          // modifiers
          for (;;) {
            const u = toks[j];
            if (u?.k === 'ident' && /^(readonly|private|public|protected|declare|override)$/.test(u.t)
                && toks[this.sig(j + 1)]?.k === 'ident') {
              this.drop(j, this.sig(j + 1));
              j = this.sig(j + 1);
              continue;
            }
            if (u?.k === 'ident' && /^(static|async|get|set)$/.test(u.t) && toks[this.sig(j + 1)]?.k === 'ident') {
              j = this.sig(j + 1);
              continue;
            }
            break;
          }
          if (toks[j]?.k === 'ident') {
            let n = this.sig(j + 1);
            if (this.is(n, '!') || this.is(n, '?')) {
              const after = this.sig(n + 1);
              if (this.is(after, ':')) { this.drop(n, n + 1); n = after; }
            }
            if (this.is(n, ':')) { i = this.stripAnnotation(n); continue; }
            if (this.is(n, '(')) {
              const end = this.stripParams(n);
              i = this.stripReturnType(end);
              continue;
            }
          }
          i = j + 1;
          continue;
        }
        i++;
        continue;
      }

      if (t.k === 'punct') {
        if (t.t === '{') {
          braceDepth++;
          if (pendingClass) { classStack.push(braceDepth); pendingClass = false; }
        } else if (t.t === '}') {
          if (classStack.length && classStack[classStack.length - 1] === braceDepth) classStack.pop();
          braceDepth--;
        } else if (t.t === '!') {
          // non-null assertion: directly after an expression, not a prefix `!`
          const prev = i - 1;
          if (prev >= 0 && isExprEnd(toks[prev]) && toks[prev].k !== 'ws') {
            this.keep[i] = false;
          }
        } else if (t.t === '(') {
          // arrow function with annotated params: (a: T, b) => / (a): T =>
          const end = this.matchClose(i);
          const n = this.sig(end);
          if (this.is(n, '=>') || (this.is(n, ':') && this.looksLikeArrowReturn(n))) {
            const prev = this.prevSig(i);
            if (!(prev >= 0 && isExprEnd(toks[prev]))) {
              this.stripParams(i);
              this.stripReturnType(end);
            }
          }
        }
      }
      i++;
    }
    return toks.filter((_, j) => this.keep[j]).map(x => (x.k === 'tmpl' ? stripTemplate(x.t) : x.t)).join('');
  }

  private looksLikeArrowReturn(c: number): boolean {
    try {
      const end = this.skipType(c + 1);
      return this.is(this.sig(end), '=>');
    } catch {
      return false;
    }
  }
}

/** Erase TypeScript-only syntax from generator output, yielding ES module JS. */
export function stripTypes(src: string): string {
  return new Stripper(tokenize(src)).run();
}
