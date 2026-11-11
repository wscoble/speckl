import { InitNode, InvariantMemberNode, StateNode } from './speck-part0.js';
import { findBlockEnd, maskCode } from './speck-part1.js';
import { parseStateBlock } from './speck-part2.js';
import { parseInitBlock } from './speck-part3.js';

export function parseStateBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): StateNode {
  // Cycle 59: support `state as <MessageName> { ... }` to override the
  // generated .proto message name. Default (no `as`) keeps the existing
  // `message <SpeckName>State { ... }` convention.
  const headerLine = lines[startIndex].trim();
  const asMatch = headerLine.match(/^state\s+as\s+(\w+)\s*{/);
  const messageName = asMatch ? asMatch[1] : undefined;

  const endIndex = findBlockEnd(lines, startIndex + 1, startBraceCount);
  const innerLines = lines.slice(startIndex + 1, endIndex).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));
  // State blocks separate fields with commas or newlines/semicolons.
  // Strip trailing commas (they are field separators, not continuations)
  // then join with semicolons between complete variable declarations.
  const cleanedLines = innerLines.map(l => l.replace(/,+\s*$/, ''));
  const inner = cleanedLines.reduce((acc, line, i) => {
    if (i === 0) return line;
    const prevLine = cleanedLines[i - 1];
    // Check if this line starts a new variable declaration (name: type)
    const isNewVar = /^\w+\s*:/.test(line);
    // Check if prev line ends with a continuation character (brace or paren, NOT comma)
    const prevIsContinuation = /[{(]\s*$/.test(prevLine);
    // While the accumulated text is unbalanced (a multi-line type expression,
    // e.g. `authorizationCodes: Map(AuthorizationCode, {` opening a multi-
    // line inline record), join every line until brackets balance — record
    // field lines match the new-var pattern but sit inside the brackets.
    // Join with a comma so the inline record keeps its field separators
    // (trailing commas were stripped per-line as declaration separators).
    // Bracket depth only (not the dangling-operator regex): type
    // declarations never contain bare operators, and `Map<Nat, Real>` ends
    // with `>` which the operator heuristic would misread as incomplete.
    if (!bracketsUnbalanced(acc)) {
      if (isNewVar && !prevIsContinuation) {
        return acc + '; ' + line;
      }
      return acc + ' ' + line;
    }
    return acc.endsWith('{') ? acc + ' ' + line : acc + ', ' + line;
  }, '');
  const result = parseStateBlock(inner);
  if (messageName !== undefined) result.messageName = messageName;
  return result;
}

/** True when an expression text has unbalanced brackets (type declarations). */
export function bracketsUnbalanced(text: string): boolean {
  let depth = 0;
  for (const c of maskCode(text).text) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return depth > 0;
}

/** True when an expression text has unbalanced brackets or a dangling operator. */
export function exprIncomplete(text: string): boolean {
  const code = maskCode(text).text;
  let depth = 0;
  for (const c of code) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return depth > 0 || /(==|!=|>=|<=|[<>+\-*/]|\b(?:and|or|implies)\b)\s*$/.test(code.trim());
}

export function parseInitBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): InitNode {
  const endIndex = findBlockEnd(lines, startIndex + 1, startBraceCount);
  const innerLines = lines.slice(startIndex + 1, endIndex).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));
  // Group lines into statements: a `name := ...` line starts a new
  // assignment; anything else (record/map literal field lines) continues
  // the current one. Only declaration lines have their trailing comma
  // stripped - field commas inside a multi-line literal are separators and
  // must survive.
  const stmts: string[] = [];
  let cur: string | null = null;
  for (const raw of innerLines) {
    if (/^\w+\s*:=/.test(raw) || cur === null) {
      if (cur !== null) stmts.push(cur.replace(/,\s*$/, '').trim());
      cur = raw;
    } else {
      cur += ' ' + raw;
    }
  }
  if (cur !== null) stmts.push(cur.replace(/,\s*$/, '').trim());
  return parseInitBlock(stmts.join('\n'));
}

/**
 * Parse an `invariant Name { expr }` block into a first-class member.
 */
export function parseInvariantBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): InvariantMemberNode {
  const firstLine = lines[startIndex].trim();
  const headerMatch = firstLine.match(/^invariant\s+([\w\s]+?)\s*\{/);
  const name = headerMatch ? headerMatch[1].trim() : `invariant_${startIndex + 1}`;
  const endIndex = findBlockEnd(lines, startIndex + 1, startBraceCount);
  const body = lines
    .slice(startIndex + 1, endIndex)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('/*'))
    .join(' ');
  return { type: 'invariant', name, expr: body.trim() };
}

/** Keep a line break after a `//` comment so the next statement is not commented out. */
export function joinBlockLines(lines: string[]): string {
  let out = '';
  for (const line of lines) {
    if (!out) { out = line; continue; }
    out += (lastLineHasLineComment(out) ? '\n' : ' ') + line;
  }
  return out;
}

export function lastLineHasLineComment(text: string): boolean {
  const line = text.slice(text.lastIndexOf('\n') + 1);
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"') {
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '/') return true;
    if (ch === '/' && next === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    i++;
  }
  return false;
}

/**
 * Body of an action that opens and closes on this line.
 * A brace in a comment, a string, or a parenthesized parameter is not the
 * body's brace. A trailing `// }` stays outside the body. Null when the
 * body does not close on this line.
 */
export function inlineActionBody(line: string): string | null {
  const masked = maskCode(line).text;
  let paren = 0;
  let depth = 0;
  let started = -1;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (paren === 0 && ch === '{') {
      if (depth === 0) started = i;
      depth++;
    } else if (paren === 0 && ch === '}') {
      depth--;
      if (depth === 0 && started >= 0) return line.slice(started + 1, i);
    }
  }
  return null;
}

