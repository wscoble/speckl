/**
 * Token conservation for one file.
 *
 * Whitespace and comments are not tokens. Every other token is consumed by
 * exactly one construct, or the parse is `unparsed text at <file>:<line>:<col>`.
 * A `{` opens a block only when that statement's first word is an allowlisted
 * header. Any other block `{` is `unknown block`. A newline is not a token,
 * so a header and its `{` are the same statement across a line break, a tab,
 * or a comment.
 */
import { lexProblem, lexStart, lexWhere, scanLine } from './lex.js';

export interface SrcTok {
  kind: 'ident' | 'num' | 'str' | 'punct' | 'nl';
  text: string;
  /** 1-based. */
  line: number;
  /** 1-based column of the first character. */
  col: number;
  /** Column just past the token. */
  end: number;
}

/** Headers that may own a `{` directly inside a speck. */
const MEMBER_BLOCK = new Set([
  'state', 'init', 'action', 'event', 'provenance', 'bom', 'interface', 'verify',
  'constraint', 'service', 'oneof', 'transition', 'invariant', 'agent', 'type',
  'input', 'output', 'next', 'status', 'conditions', 'component',
]);

/** Headers that may own a `{` inside an action, if, or for. */
const INNER_BLOCK = new Set(['if', 'else', 'for', 'emit']);

const VALUE_PREV = new Set([
  '=', '==', '!=', ':=', ':', ',', '(', '[', 'in', '->', '+', '-', '*', '/',
  '<', '>', '<=', '>=', '&&', '||', '|', '\\', 'not', 'and', 'or',
]);

export function lexTokens(src: string): SrcTok[] {
  const lines = src.split('\n');
  const out: SrcTok[] = [];
  let state = lexStart();
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n].replace(/\r$/, '');
    const scanned = scanLine(raw, state, n + 1);
    state = scanned.state;
    if (state.kind === 'string') throw lexProblem(state.openLine, 'unterminated string');
    tokenizeCode(scanned.code, n + 1, out);
    out.push({ kind: 'nl', text: '\n', line: n + 1, col: raw.length + 1, end: raw.length + 1 });
  }
  if (state.kind === 'block') throw lexProblem(state.openLine, 'unterminated block comment');
  return out;
}

function tokenizeCode(code: string, line: number, out: SrcTok[]): void {
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (/\s/u.test(ch)) { i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === '"') { j++; break; }
        j++;
      }
      out.push({ kind: 'str', text: code.slice(i, j), line, col: i + 1, end: j + 1 });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < code.length && /[\w-]/.test(code[j])) j++;
      out.push({ kind: 'ident', text: code.slice(i, j), line, col: i + 1, end: j + 1 });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < code.length && /[0-9.]/.test(code[j])) j++;
      out.push({ kind: 'num', text: code.slice(i, j), line, col: i + 1, end: j + 1 });
      i = j;
      continue;
    }
    const three = code.slice(i, i + 3);
    if (three === '...') {
      out.push({ kind: 'punct', text: '...', line, col: i + 1, end: i + 4 });
      i += 3;
      continue;
    }
    const two = code.slice(i, i + 2);
    if ([':=', '==', '!=', '<=', '>=', '->', '||', '&&', '..'].includes(two)) {
      out.push({ kind: 'punct', text: two, line, col: i + 1, end: i + 3 });
      i += 2;
      continue;
    }
    out.push({ kind: 'punct', text: ch, line, col: i + 1, end: i + 2 });
    i++;
  }
}

function unparsed(tok: SrcTok): Error {
  return new Error(`unparsed text at ${lexWhere(tok.line)}:${tok.col}`);
}

function unknownBlock(tok: SrcTok): Error {
  return lexProblem(tok.line, 'unknown block');
}

class Account {
  private i = 0;
  private readonly mark: boolean[];
  private readonly lines: string[];

  constructor(private readonly toks: SrcTok[], src: string) {
    this.mark = new Array<boolean>(toks.length).fill(false);
    this.lines = src.split('\n');
  }

  private headerAfterCloser(tok: SrcTok | undefined): void {
    if (!tok) return;
    const raw = (this.lines[tok.line - 1] ?? '').replace(/\r$/, '').trim();
    if (!raw.startsWith('*/')) return;
    if (tok.text === 'speck' || MEMBER_BLOCK.has(tok.text) || INNER_BLOCK.has(tok.text)) {
      throw lexProblem(tok.line, 'header is not at the start of the line');
    }
  }

  run(): void {
    while (this.i < this.toks.length) {
      this.skipNl();
      if (this.i >= this.toks.length) break;
      const t = this.toks[this.i];
      if (t.kind === 'ident' && (t.text === 'speck' || t.text === 'domain')) {
        this.parseSpeckOrDomain(t.text);
        continue;
      }
      if (t.kind === 'ident' && t.text === 'import') {
        this.untilBreak();
        continue;
      }
      throw unparsed(t);
    }
    for (let k = 0; k < this.toks.length; k++) {
      if (this.toks[k].kind !== 'nl' && !this.mark[k]) throw unparsed(this.toks[k]);
    }
  }

  private skipNl(): void {
    while (this.i < this.toks.length && this.toks[this.i].kind === 'nl') this.take();
  }

  private take(): SrcTok {
    const t = this.toks[this.i];
    this.mark[this.i] = true;
    this.i++;
    return t;
  }

  private prev(): SrcTok | undefined {
    for (let k = this.i - 1; k >= 0; k--) if (this.toks[k].kind !== 'nl') return this.toks[k];
    return undefined;
  }

  private nextNonNl(from = this.i): SrcTok | undefined {
    for (let k = from; k < this.toks.length; k++) if (this.toks[k].kind !== 'nl') return this.toks[k];
    return undefined;
  }

  private parseSpeckOrDomain(kind: string): void {
    this.take();
    this.skipNl();
    if (this.toks[this.i]?.kind === 'ident') this.take();
    else if (kind === 'speck') throw unparsed(this.toks[this.i] ?? this.toks[this.i - 1]);
    this.skipNl();
    if (this.toks[this.i]?.text !== '{') throw unparsed(this.toks[this.i] ?? this.toks[this.i - 1]);
    this.take();
    if (kind === 'domain') {
      this.consumeBrace(false);
      return;
    }
    for (;;) {
      this.skipNl();
      const t = this.toks[this.i];
      if (!t) return;
      if (t.text === '}') { this.take(); return; }
      this.headerAfterCloser(t);
      this.parseMember();
    }
  }

  /** `action Name(params) {` — a punctuated name is unparsed, not a parameter error. */
  private parseActionMember(): void {
    this.take();
    this.skipNl();
    if (this.toks[this.i]?.kind === 'ident') this.take();
    this.skipNl();
    if (this.toks[this.i]?.text === '(') {
      let depth = 0;
      while (this.i < this.toks.length) {
        const t = this.toks[this.i];
        if (t.kind === 'nl') { this.take(); continue; }
        if (t.text === '(') depth++;
        else if (t.text === ')') {
          if (depth === 0) throw unparsed(t);
          depth--;
          this.take();
          if (depth === 0) break;
          continue;
        }
        this.take();
      }
    }
    this.skipNl();
    const brace = this.toks[this.i];
    if (!brace || brace.text !== '{') throw unparsed(brace ?? this.toks[this.i - 1]);
    this.consumeBrace(true);
  }

  /** A direct child of a speck. A block `{` here needs an allowlisted header. */
  private parseMember(): void {
    const start = this.i;
    const first = this.toks[this.i]?.kind === 'ident' ? this.toks[this.i].text : undefined;
    if (first === 'action') {
      this.parseActionMember();
      return;
    }
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    while (this.i < this.toks.length) {
      const t = this.toks[this.i];
      if (t.kind === 'nl' && paren === 0 && bracket === 0 && brace === 0) {
        const ahead = this.nextNonNl(this.i + 1);
        if (first && MEMBER_BLOCK.has(first) && ahead?.text === '{') { this.take(); continue; }
        this.take();
        return;
      }
      if (t.text === '(') paren++;
      else if (t.text === ')') {
        if (paren === 0) throw unparsed(t);
        paren--;
      } else if (t.text === '[') bracket++;
      else if (t.text === ']') {
        if (bracket === 0) throw unparsed(t);
        bracket--;
      } else if (t.text === '{') {
        if (paren === 0 && bracket === 0 && brace === 0) {
          this.headerAfterCloser(this.toks[start]);
          if (!first || !MEMBER_BLOCK.has(first)) throw unknownBlock(t);
          const inner = first === 'action';
          this.consumeBrace(inner);
          return;
        }
        brace++;
      } else if (t.text === '}') {
        if (brace === 0) return;
        brace--;
      }
      if (this.i === start && t.kind === 'nl') { this.take(); continue; }
      this.take();
    }
  }

  /** Consume the `{` at `this.i` and its match. `inner` parses action/if/for statements. */
  private consumeBrace(inner: boolean): void {
    this.take();
    if (!inner) {
      let depth = 1;
      while (this.i < this.toks.length && depth > 0) {
        const t = this.take();
        if (t.kind === 'nl') continue;
        if (t.text === '{') depth++;
        else if (t.text === '}') depth--;
      }
      return;
    }
    for (;;) {
      this.skipNl();
      const t = this.toks[this.i];
      if (!t) return;
      if (t.text === '}') { this.take(); return; }
      this.parseInner();
    }
  }

  /** One statement inside an action, if, or for. */
  private parseInner(): void {
    const first = this.toks[this.i]?.kind === 'ident' ? this.toks[this.i].text : undefined;
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    let opened = false;
    while (this.i < this.toks.length) {
      const t = this.toks[this.i];
      if (t.text === '}' && paren === 0 && bracket === 0 && brace === 0) return;
      if (t.kind === 'nl' && paren === 0 && bracket === 0 && brace === 0) {
        const ahead = this.nextNonNl(this.i + 1);
        if (first && INNER_BLOCK.has(first) && !opened && ahead?.text === '{') { this.take(); continue; }
        this.take();
        return;
      }
      if (t.text === '(') paren++;
      else if (t.text === ')') {
        if (paren === 0) throw unparsed(t);
        paren--;
      } else if (t.text === '[') bracket++;
      else if (t.text === ']') {
        if (bracket === 0) throw unparsed(t);
        bracket--;
      } else if (t.text === '{') {
        if (paren === 0 && bracket === 0 && brace === 0 && this.isInnerBlockBrace(first)) {
          if (!first || !INNER_BLOCK.has(first)) throw unknownBlock(t);
          const nest = first === 'if' || first === 'for' || first === 'else';
          this.consumeBrace(nest);
          opened = true;
          if (first === 'if') this.attachElse();
          return;
        }
        brace++;
      } else if (t.text === '}') {
        if (brace === 0) return;
        brace--;
      }
      this.take();
    }
  }

  /** `{` opens if/else/for/emit. `Customer {` and `{1, 2}` do not. */
  private isInnerBlockBrace(first: string | undefined): boolean {
    const p = this.prev();
    if (p && VALUE_PREV.has(p.text)) return false;
    if (p?.kind === 'ident' && !(first && INNER_BLOCK.has(first))) return false;
    if (!first || !INNER_BLOCK.has(first)) return true;
    return true;
  }

  private attachElse(): void {
    for (;;) {
      this.skipNl();
      if (!(this.toks[this.i]?.kind === 'ident' && this.toks[this.i].text === 'else')) return;
      this.take();
      this.skipNl();
      if (this.toks[this.i]?.kind === 'ident' && this.toks[this.i].text === 'if') {
        this.parseInner();
        continue;
      }
      if (this.toks[this.i]?.text === '{') this.consumeBrace(true);
    }
  }

  /** Tokens of a loose member until a newline at depth 0, or a block `{`. */
  private untilBreak(): void {
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    while (this.i < this.toks.length) {
      const t = this.toks[this.i];
      if (t.kind === 'nl' && paren === 0 && bracket === 0 && brace === 0) { this.take(); return; }
      if (t.text === '(') paren++;
      else if (t.text === ')') { if (paren === 0) throw unparsed(t); paren--; }
      else if (t.text === '[') bracket++;
      else if (t.text === ']') { if (bracket === 0) throw unparsed(t); bracket--; }
      else if (t.text === '{') brace++;
      else if (t.text === '}') { if (brace === 0) return; brace--; }
      this.take();
    }
  }
}

/** Throw unless every token is consumed and every block `{` is allowlisted. */
export function accountSource(src: string): void {
  new Account(lexTokens(src), src).run();
}

/**
 * Put a header and its `{` on one line, and drop a comment that sits in
 * front of a header. Comments are not tokens, so the accounted stream does
 * not change.
 */
export function normalizeSource(src: string): string {
  const lines = src.split('\n');
  const toks = lexTokens(src);
  const edits: { line: number; col: number; len: number; text: string }[] = [];
  const sigBefore = (k: number): SrcTok | undefined => {
    for (let j = k - 1; j >= 0; j--) if (toks[j].kind !== 'nl') return toks[j];
    return undefined;
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.kind !== 'ident') continue;
    const header = MEMBER_BLOCK.has(t.text) || INNER_BLOCK.has(t.text)
      || t.text === 'speck' || t.text === 'domain';
    if (!header) continue;
    if (t.col > 1) {
      const raw = lines[t.line - 1].replace(/\r$/, '');
      const prefix = raw.slice(0, t.col - 1);
      const trimmed = raw.trim();
      const commentThenHeader = prefix.includes('/*') && prefix.includes('*/') && prefix.indexOf('/*') < prefix.indexOf('*/');
      // A closer that finishes a comment from an earlier line stays on this
      // line. The header moves to the next line so it is still parsed.
      if (!trimmed.startsWith('*/') && (prefix.includes('*/') || prefix.includes('//')) && !commentThenHeader) {
        edits.push({ line: t.line, col: t.col, len: 0, text: '\n' });
      } else if (commentThenHeader) {
        const indent = prefix.match(/^\s*/)?.[0] ?? '';
        edits.push({ line: t.line, col: 1, len: t.col - 1, text: indent });
      }
    }
    // Only a name and a balanced parameter list may sit between the header
    // word and its block `{`. An expression (`if a > b and` / next line) is
    // left untouched.
    let j = k + 1;
    let paren = 0;
    let names = 0;
    let brace: SrcTok | undefined;
    let headerEnd = t;
    let simple = true;
    while (j < toks.length) {
      const n = toks[j];
      if (n.kind === 'nl') { j++; continue; }
      if (n.text === '(') paren++;
      else if (n.text === ')') {
        paren = Math.max(0, paren - 1);
        if (paren === 0) headerEnd = n;
      } else if (paren > 0) { j++; continue; }
      else if (n.kind === 'ident' && names === 0) { names++; headerEnd = n; }
      else if (n.text === '{' ) {
        const p = sigBefore(j);
        if (p && VALUE_PREV.has(p.text)) { simple = false; break; }
        brace = n;
        break;
      } else { simple = false; break; }
      j++;
    }
    if (!brace || !simple) continue;
    if (brace.line === headerEnd.line) {
      const raw = lines[headerEnd.line - 1].replace(/\r$/, '');
      const between = raw.slice(headerEnd.end - 1, brace.col - 1);
      if (between !== ' ' && (between.includes('/*') || between.includes('*/') || between.includes('\t') || between.trim() === '')) {
        edits.push({ line: headerEnd.line, col: headerEnd.end, len: brace.col - headerEnd.end, text: ' ' });
      }
      continue;
    }
    edits.push({ line: brace.line, col: brace.col, len: 1, text: ' ' });
    edits.push({ line: headerEnd.line, col: headerEnd.end, len: 0, text: ' {' });
  }
  if (edits.length === 0) return src;
  const byLine = new Map<number, typeof edits>();
  for (const e of edits) {
    const list = byLine.get(e.line) ?? [];
    list.push(e);
    byLine.set(e.line, list);
  }
  return lines.map((line, idx) => {
    const list = byLine.get(idx + 1);
    if (!list) return line;
    const cr = line.endsWith('\r');
    let body = cr ? line.slice(0, -1) : line;
    for (const e of [...list].sort((a, b) => b.col - a.col)) {
      body = body.slice(0, e.col - 1) + e.text + body.slice(e.col - 1 + e.len);
    }
    return cr ? body + '\r' : body;
  }).join('\n');
}
