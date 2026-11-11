import { LexState, lexStart } from './speck-part0.js';
import { maskCode, isExpressionComplete } from './speck-part1.js';
import { exprIncomplete } from './speck-part4.js';

export function expressionClosed(expr: string): boolean {
  const t = expr.trim();
  if (!t) return false;
  if (!isExpressionComplete(t)) return false;
  if (t.endsWith(':')) return false;
  return !exprIncomplete(t);
}

/**
 * Lines that belong to an expression starting at `startIndex`.
 * Only an unfinished expression takes the next line. A later member,
 * including one that is misspelled, is left for the caller.
 */
export function takeExpressionLines(lines: string[], startIndex: number, initial: string, style: 'space' | 'newline'): { text: string; endIndex: number } {
  const parts: string[] = [];
  const head = initial.trim();
  if (head) parts.push(head);
  let end = startIndex;
  const closed = () => expressionClosed(parts.join(' '));
  if (parts.length > 0 && closed()) {
    return { text: head, endIndex: end };
  }
  for (let j = startIndex + 1; j < lines.length; j++) {
    const nl = lines[j].trim();
    if (nl === '}') break;
    if (!nl || nl.startsWith('//') || nl.startsWith('/*')) {
      end = j;
      continue;
    }
    if (parts.length > 0 && closed()) break;
    parts.push(nl);
    end = j;
    if (closed()) break;
  }
  const text = style === 'newline'
    ? parts.join('\n').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim()
    : parts.join(' ').replace(/\s+/g, ' ').trim();
  return { text, endIndex: end };
}

/** Last line consumed by a brace-free constraint or verify. The line itself when the expression finishes there. */
export function expressionSpanEnd(lines: string[], startIndex: number): number {
  const line = lines[startIndex].trim();
  let initial = '';
  let style: 'space' | 'newline' = 'newline';
  if (line.startsWith('constraint:') || line.startsWith('verify:')) {
    initial = line.slice(line.indexOf(':') + 1);
  } else {
    const named = line.match(/^constraint\s+\w+:(.*)$/) || line.match(/^constraint\s+"[^"]+"\s*:(.*)$/);
    if (!named) return startIndex;
    initial = named[1];
    style = 'space';
  }
  return takeExpressionLines(lines, startIndex, initial, style).endIndex;
}

export function splitTopLevel(inner: string): string[] {
  const masked = maskCode(inner).text;
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && (ch === ',' || ch === ';' || ch === '\n')) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map(s => s.trim()).filter(Boolean);
}

export function isAliasTypeText(src: string): boolean {
  const s = maskCode(src).kept.trim();
  if (!s) return false;
  let i = 0;
  const ok = parseUnion();
  skip();
  return ok && i === s.length;

  function skip(): void {
    while (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r') i++;
  }
  function parseUnion(): boolean {
    if (!parseRange()) return false;
    skip();
    while (s[i] === '|') {
      i++;
      if (!parseRange()) return false;
      skip();
    }
    return true;
  }
  function parseRange(): boolean {
    if (!parsePostfix()) return false;
    skip();
    if (s.startsWith('..', i)) {
      i += 2;
      if (!parsePostfix()) return false;
    }
    return true;
  }
  function parsePostfix(): boolean {
    if (!parseAtom()) return false;
    skip();
    while (s.startsWith('[]', i)) { i += 2; skip(); }
    return true;
  }
  function parseAtom(): boolean {
    skip();
    if (i >= s.length) return false;
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) i += 2;
        else i++;
      }
      if (s[i] !== '"') return false;
      i++;
      return true;
    }
    if (s[i] === '(' || s[i] === '[') {
      const close = s[i] === '(' ? ')' : ']';
      i++;
      skip();
      if (s[i] === close) { i++; return true; }
      if (!parseUnion()) return false;
      skip();
      while (s[i] === ',') {
        i++;
        if (!parseUnion()) return false;
        skip();
      }
      if (s[i] !== close) return false;
      i++;
      return true;
    }
    if (s[i] === '{') {
      i++;
      skip();
      if (s[i] === '}') { i++; return true; }
      for (;;) {
        skip();
        if (!/[A-Za-z_]/.test(s[i] ?? '')) return false;
        while (/[A-Za-z0-9_]/.test(s[i] ?? '')) i++;
        skip();
        if (s[i] !== ':') return false;
        i++;
        if (!parseUnion()) return false;
        skip();
        if (s[i] === ',') { i++; continue; }
        break;
      }
      skip();
      if (s[i] !== '}') return false;
      i++;
      return true;
    }
    if (/[0-9]/.test(s[i])) {
      while (/[0-9]/.test(s[i] ?? '')) i++;
      if (s[i] === '.' && /[0-9]/.test(s[i + 1] ?? '')) {
        i++;
        while (/[0-9]/.test(s[i] ?? '')) i++;
      }
      return true;
    }
    if (!/[A-Za-z_]/.test(s[i])) return false;
    while (/[A-Za-z0-9_]/.test(s[i] ?? '')) i++;
    skip();
    if (s[i] === '<' || s[i] === '(') {
      const close = s[i] === '<' ? '>' : ')';
      i++;
      skip();
      if (s[i] !== close) {
        if (!parseUnion()) return false;
        skip();
        while (s[i] === ',') {
          i++;
          if (!parseUnion()) return false;
          skip();
        }
      }
      if (s[i] !== close) return false;
      i++;
    }
    return true;
  }
}

export function codeWithoutComments(line: string, state: LexState): { text: string; state: LexState } {
  const scanned = maskCode(line, state);
  return { text: scanned.kept, state: scanned.state };
}

/** Type text with comments removed. A `//` or `/*` inside `"..."` is part of the type. */
export function stripTypeComment(typeStr: string): string {
  return maskCode(typeStr).kept.replace(/,\s*$/, '').trim();
}

/** True when an expression text has unbalanced brackets (type declarations). */
export function angleUnbalanced(text: string): boolean {
  let depth = 0;
  for (const c of maskCode(text).text) {
    if (c === '<') depth++;
    else if (c === '>') depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

/** True when an expression text has unbalanced brackets or a dangling operator. */
export function initStatementClosed(stmt: string): boolean {
  return expressionClosed(stmt);
}

/** `name :=`, `name ==`, `let name :=`, `forall` / `exists`. Not `y = 0`. */
export function isInitStarter(raw: string): boolean {
  return /^(?:let\s+)?\w+(?:\[[^\]]*\])?\s*(?::=|==)/.test(raw) || /^(?:forall|exists)\b/.test(raw);
}

export function braceInner(lines: string[], startIndex: number): string {
  let depth = 0;
  let started = false;
  let out = '';
  // Comment and string state carries across lines. A `}` inside a block
  // comment that opened on the header line is not the close.
  let lex = lexStart();
  for (let li = startIndex; li < lines.length; li++) {
    const line = lines[li];
    const masked = maskCode(line, lex, li + 1);
    lex = masked.state;
    let takeFrom = 0;
    for (let i = 0; i < masked.text.length; i++) {
      const ch = masked.text[i];
      if (ch === '{') {
        depth++;
        if (!started) {
          started = true;
          takeFrom = i + 1;
        }
      } else if (ch === '}' && started) {
        depth--;
        if (depth === 0) return out + line.slice(takeFrom, i);
      }
    }
    if (started) out += line.slice(takeFrom) + '\n';
  }
  return out;
}

/** Invariant text with line and block comments removed. */
export function stripInvariantExpr(src: string): string {
  let out = '';
  let quote = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\' && next !== undefined) { out += next; i++; continue; }
      if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') { quote = true; out += ch; continue; }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return collapseSpaceOutsideStrings(out);
}

/** Collapse whitespace outside `"..."` so `s != "a  b"` keeps both spaces. */
export function collapseSpaceOutsideStrings(src: string): string {
  let out = '';
  let quote = false;
  let pending = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\' && next !== undefined) { out += next; i++; continue; }
      if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') {
      if (pending) { out += ' '; pending = false; }
      quote = true;
      out += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (out.length > 0) pending = true;
      continue;
    }
    if (pending) { out += ' '; pending = false; }
    out += ch;
  }
  return out.trim();
}

/** Keep a line break after a `//` comment so the next statement is not commented out. */
