// The line walker used to keep an AST when the spec was broken: a missing
// `}`, an extra `}`, text after `}`, an unrecognized member, and `§` were
// not part of the program, and the file still parsed. An unrecognized
// state field and an unrecognized init line were folded into the previous
// text. This check rejects those shapes before the walk. The messages are
// the ones the token parser reports, including the column, except an
// unrecognized state field and an unrecognized init line, which name the
// line only.

import { lexProblem, lexStart, type LexState } from './speck-part0.js';
import {
  findBlockEnd, isExpressionComplete, maskCode, maskLine, nextCodeIsNamedBlock,
} from './speck-part1.js';
import { parseMember } from './speck-part2.js';
import { exprIncomplete } from './speck-part4.js';
import { parseNextRelation } from './speck-part8.js';
import { lexSpeck, parseErrorAt, type SpeckToken } from './speck-lex.js';


// Each name is one rejection class. A later change turns one name on.
// The messages and positions are the ones below; a class that is off
// leaves that input to the line walker.
const ON: { [name: string]: boolean } = {
  missing: true,
  extra: true,
  text: true,
  second: true,
  member: true,
  top: true,
  memberTail: true,
  braceLine: true,
  state: true,
  init: true,
  comment: true,
  cr: false,
  section: false,
  digit: false,
  ascii: false,
  numeric: false,
  unclosed: false,
};

function on(name: string): boolean {
  return ON[name] === true;
}

function rethrowLexer(err: unknown): boolean {
  const msg = (err as Error).message;
  const kind = msg.includes('unexpected character') ? 'section'
    : msg.includes('identifier must not start with a digit') ? 'digit'
    : msg.includes('identifier must be ASCII') ? 'ascii'
    : msg.includes('unsupported numeric literal') ? 'numeric'
    : msg.includes('unterminated string') || msg.includes('unterminated block comment') ? 'unclosed'
    : undefined;
  if (kind === undefined || on(kind)) throw err;
  return false;
}

const BLOCK_STARTERS = [
  'state:', 'init:', 'action ', 'event ', 'provenance ', 'bom ', 'interface ',
  'state {', 'init {', 'verify ', 'constraint ', 'input:', 'output:', 'service ', 'oneof ', 'transition ',
  'state as ', 'type ', 'component ', 'invariant ', 'agent {', 'agent ',
];

export function assertClosedSpec(content: string, file?: string): void {
  if (on('cr')) rejectBareCr(content, file);
  let lexed;
  try {
    lexed = lexSpeck(content, file);
  } catch (err) {
    rethrowLexer(err);
    return;
  }
  const lines = content.split('\n');
  const byLine = bucketByLine(lexed.tokens);
  if (on('comment')) assertNoCodeAfterBlockComment(lines, byLine, file);
  if (lexed.headerAfterComment.length > 0) {
    throw lexProblem(lexed.headerAfterComment[0], 'header is not at the start of the line');
  }
  assertBraceStructure(lexed.tokens, file);
  scanFile(lines, byLine, lexed.tokens, file);
}

function scanFile(lines: string[], byLine: SpeckToken[][], tokens: SpeckToken[], file?: string): void {
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
      const stepped = scanSpeck(lines, byLine, tokens, i, lex, file);
      i = stepped.i;
      lex = stepped.lex;
      continue;
    }
    if (on('top')) throw parseErrorAt(file, i + 1, columnOf(lines[i]), `unrecognized top-level "${line}"`);
    i++;
    continue;
  }
}

function scanSpeck(
  lines: string[],
  byLine: SpeckToken[][],
  tokens: SpeckToken[],
  start: number,
  lexIn: LexState,
  file?: string,
): { i: number; lex: LexState } {
  let i = start + 1;
  let braceCount = 1;
  let lex = lexIn;
  while (i < lines.length && braceCount > 0) {
    const rawLine = lines[i];
    const masked = maskLine(rawLine, lex, i + 1);
    lex = masked.state;
    const line = rawLine.trim();
    const openCount = (masked.text.match(/{/g) || []).length;
    const closeCount = (masked.text.match(/}/g) || []).length;
    if (!line || !masked.text.trim() || line.startsWith('//') || line.startsWith('/*')) {
      i++;
      continue;
    }
    if (line.startsWith('next:')) {
      i = parseNextRelation(lines, i).endIndex + 1;
      lex = lexAfterLines(lines, i - 1, start);
      continue;
    }
    if (/^(version|author|license|k8s_group|k8s_version)\s*:\s*([^{<]+)$/.test(line)) {
      i++;
      continue;
    }
    if (/^(proto_package|go_package|event_suffix)\s*:\s*(.+)$/.test(line)) {
      i++;
      continue;
    }
    const isBlockStarter = BLOCK_STARTERS.some(s => line.startsWith(s));
    if (/^(conditions|finalizers|ownerReferences|status)\s*:/.test(line)) {
      i++;
      continue;
    }
    if (isBlockStarter && openCount > 0) {
      const open = (byLine[i + 1] ?? []).find(t => t.kind === '{');
      const close = open ? matchingClose(tokens, open) : undefined;
      if (close) {
        const after = (byLine[close.line] ?? []).filter(t => t.start >= close.end);
        if (after.length > 0 && on('memberTail')) {
          throw parseErrorAt(file, after[0].line, after[0].column, 'text after a member\'s "}"');
        }
      }
      if (closeCount < openCount) {
        if (line.startsWith('state')) assertStateFields(lines, i, findBlockEnd(lines, i + 1, braceCount + openCount, lex));
        if (line.startsWith('init')) assertInitLines(lines, i, findBlockEnd(lines, i + 1, braceCount + openCount, lex));
        const endIdx = findBlockEnd(lines, i + 1, braceCount + openCount, lex);
        lex = lexAfterLines(lines, endIdx, start);
        i = endIdx + 1;
      } else {
        i++;
      }
      continue;
    }
    if (line.startsWith('constraint ') || line.startsWith('verify ') || line.startsWith('verify:') || line.startsWith('constraint:')) {
      i = skipClosedConstraint(lines, i);
      continue;
    }
    braceCount += openCount - closeCount;
    if (braceCount <= 0) {
      i++;
      break;
    }
    if (/^type\s+\S/.test(line) && !line.includes('{')) {
      if (openingBraceOnNextLine(lines, i)) rejectBraceOnNextLine(file, rawLine, i + 1);
      const rhs = stripComment(line.replace(/^type\s+\S+\s*=\s*/, ''));
      if (!isAliasTypeText(rhs)) rejectUnparsed(file, rawLine, i + 1, line);
      i++;
      continue;
    }
    if (openingBraceOnNextLine(lines, i) && !line.includes('{')) {
      rejectBraceOnNextLine(file, rawLine, i + 1);
    }
    if (!parseMember(line)) rejectUnparsed(file, rawLine, i + 1, line);
    i++;
  }
  return { i, lex };
}

function skipClosedConstraint(lines: string[], index: number): number {
  let acc = lines[index].trim();
  let i = index;
  if (expressionClosed(acc)) return i + 1;
  while (i + 1 < lines.length) {
    const nextLine = lines[i + 1].trim();
    if (!nextLine || nextLine.startsWith('//') || nextLine.startsWith('/*') ||
        nextLine.startsWith('constraint ') || nextLine.startsWith('verify ') ||
        nextLine.startsWith('constraint:') || nextLine.startsWith('verify:') ||
        nextLine.startsWith('state') || nextLine.startsWith('init') ||
        nextLine.startsWith('action ') || nextLine.startsWith('event ') ||
        nextLine.startsWith('interface ') || nextLine.startsWith('provenance ') ||
        nextLine.startsWith('service ') || nextLine.startsWith('bom ') ||
        nextLine.startsWith('}') ||
        nextLine.startsWith('next:') || nextLine.startsWith('invariant ') || nextLine.startsWith('agent ')) {
      break;
    }
    i++;
    acc += ' ' + nextLine;
    if (expressionClosed(acc)) break;
  }
  return i + 1;
}

function assertStateFields(lines: string[], startIndex: number, endIndex: number): void {
  const inner = lines.slice(startIndex + 1, endIndex).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));
  const cleaned = inner.map(l => l.replace(/,+\s*$/, ''));
  let acc = '';
  for (let n = 0; n < cleaned.length; n++) {
    const line = cleaned[n];
    if (n === 0) { acc = line; continue; }
    const prevLine = cleaned[n - 1];
    const isNewVar = /^\w+\s*:/.test(line);
    const prevIsContinuation = /[{(]\s*$/.test(prevLine);
    const continues = angleUnbalanced(acc) || maskCode(acc).text.trimEnd().endsWith('|') || line.startsWith('|');
    if (!bracketsUnbalanced(acc)) {
      if (continues) acc = acc + ' ' + line;
      else if (isNewVar && !prevIsContinuation) acc = acc + '; ' + line;
      else if (!prevIsContinuation) {
        if (on('state')) throw lexProblem(startIndex + 1, `unrecognized state field "${line}"`);
        acc = acc + ' ' + line;
      }
      else acc = acc + ' ' + line;
    } else {
      acc = acc.endsWith('{') ? acc + ' ' + line : acc + ', ' + line;
    }
  }
}

function assertInitLines(lines: string[], startIndex: number, endIndex: number): void {
  const inner = lines.slice(startIndex + 1, endIndex).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));
  let cur: string | null = null;
  for (const raw of inner) {
    const closed = cur !== null && expressionClosed(cur);
    if (cur !== null && !closed) {
      cur += ' ' + raw;
      continue;
    }
    if (isInitStarter(raw) || cur === null) {
      if (cur === null && !isInitStarter(raw)) {
        if (on('init')) throw lexProblem(startIndex + 1, `unrecognized init line "${raw}"`);
        cur = raw;
        continue;
      }
      cur = raw;
      continue;
    }
    if (on('init')) throw lexProblem(startIndex + 1, `unrecognized init line "${raw}"`);
    cur = raw;
  }
}

function expressionClosed(expr: string): boolean {
  const t = expr.trim();
  if (!t) return false;
  if (!isExpressionComplete(t)) return false;
  if (t.endsWith(':')) return false;
  return !exprIncomplete(t);
}

function isInitStarter(raw: string): boolean {
  return /^(?:let\s+)?\w+(?:\[[^\]]*\])?\s*(?::=|==)/.test(raw) || /^(?:forall|exists)\b/.test(raw);
}

function bracketsUnbalanced(text: string): boolean {
  let depth = 0;
  for (const c of maskCode(text).text) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return depth > 0;
}

function angleUnbalanced(text: string): boolean {
  let depth = 0;
  for (const c of maskCode(text).text) {
    if (c === '<') depth++;
    else if (c === '>') depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

function columnOf(raw: string): number {
  const lead = /^\s*/.exec(raw);
  return (lead ? lead[0].length : 0) + 1;
}

function rejectUnparsed(file: string | undefined, raw: string, lineNo: number, trimmed: string): void {
  if (on('member')) throw parseErrorAt(file, lineNo, columnOf(raw), `unrecognized member "${trimmed}"`);
}

function rejectBraceOnNextLine(file: string | undefined, raw: string, lineNo: number): void {
  if (on('braceLine')) throw parseErrorAt(file, lineNo, columnOf(raw), 'opening "{" must be on the same line as the member header');
}

function openingBraceOnNextLine(lines: string[], index: number): boolean {
  const n = nextCodeLine(lines, index + 1);
  return n >= 0 && lines[n].trim().startsWith('{');
}

function nextCodeLine(lines: string[], from: number): number {
  let block = false;
  for (let j = from; j < lines.length; j++) {
    const t = lines[j].trim();
    if (block) {
      if (t.includes('*/')) block = false;
      continue;
    }
    if (!t || t.startsWith('//')) continue;
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) block = true;
      continue;
    }
    return j;
  }
  return -1;
}

function lexAfterLines(lines: string[], endInclusive: number, from: number): LexState {
  let lex = lexStart();
  for (let k = from; k <= endInclusive && k < lines.length; k++) lex = maskLine(lines[k], lex, k + 1).state;
  return lex;
}

function bucketByLine(tokens: SpeckToken[]): SpeckToken[][] {
  const byLine: SpeckToken[][] = [];
  for (const t of tokens) (byLine[t.line] ??= []).push(t);
  return byLine;
}

function matchingClose(tokens: SpeckToken[], open: SpeckToken): SpeckToken | undefined {
  let lo = 0;
  let hi = tokens.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start === open.start) { at = mid; break; }
    if (tokens[mid].start < open.start) lo = mid + 1;
    else hi = mid - 1;
  }
  if (at < 0) return undefined;
  let depth = 1;
  for (let n = at + 1; n < tokens.length; n++) {
    const t = tokens[n];
    if (t.kind === '{') depth++;
    else if (t.kind === '}') {
      depth--;
      if (depth === 0) return t;
    }
  }
  return undefined;
}

function assertNoCodeAfterBlockComment(lines: string[], byLine: SpeckToken[][], file?: string): void {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('/*')) continue;
    const lineTokens = byLine[i + 1] ?? [];
    if (lineTokens.length === 0) continue;
    throw parseErrorAt(file, i + 1, lineTokens[0].column, 'code after */ on a line that starts with /*');
  }
}

function assertBraceStructure(tokens: SpeckToken[], file?: string): void {
  let depth = 0;
  const open: SpeckToken[] = [];
  for (let n = 0; n < tokens.length; n++) {
    const t = tokens[n];
    if (t.kind === '{') {
      depth++;
      open.push(t);
      continue;
    }
    if (t.kind !== '}') continue;
    if (depth === 0) {
      if (on('extra')) throw parseErrorAt(file, t.line, t.column, 'extra "}"');
      continue;
    }
    depth--;
    open.pop();
    if (depth !== 0) continue;
    const rest: SpeckToken[] = [];
    for (let j = n + 1; j < tokens.length && tokens[j].line === t.line; j++) rest.push(tokens[j]);
    if (rest.length === 0) continue;
    const next = rest[0];
    if (next.kind === 'ident' && next.text === 'speck') {
      if (on('second')) throw parseErrorAt(file, next.line, next.column, 'a second speck on one line');
      continue;
    }
    if (next.kind === '}') {
      if (on('extra')) throw parseErrorAt(file, next.line, next.column, 'extra "}"');
      continue;
    }
    if (on('text')) throw parseErrorAt(file, next.line, next.column, 'text after a speck\'s "}"');
  }
  if (depth > 0 && on('missing')) {
    const unclosed = open[open.length - 1];
    throw parseErrorAt(file, unclosed.line, unclosed.column, 'missing final "}"');
  }
}

function rejectBareCr(src: string, file?: string): void {
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '\r' || src[i + 1] === '\n') continue;
    let line = 1;
    let column = 1;
    for (let j = 0; j < i; j++) {
      if (src[j] === '\n') { line++; column = 1; }
      else column++;
    }
    throw parseErrorAt(file, line, column, 'CR-only line endings are not supported');
  }
}

function stripComment(line: string): string {
  return maskCode(line).text.replace(/ /g, '').length === 0
    ? ''
    : line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

/** A type alias right-hand side. `!!` and other non-type text is not one. */
function isAliasTypeText(src: string): boolean {
  const s = src.trim();
  if (!s) return false;
  let i = 0;
  const ok = parseUnion();
  skip();
  return ok && i === s.length;
  function skip(): void {
    while (s[i] === ' ' || s[i] === '\t') i++;
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
