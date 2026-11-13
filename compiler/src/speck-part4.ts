import { InitNode, InvariantMemberNode, StateNode, lexStart, lexProblem } from './speck-part0.js';
import { findBlockEnd, maskCode } from './speck-part1.js';
import { parseStateBlock } from './speck-part2.js';
import { parseInitBlock } from './speck-part3.js';
import { codeWithoutComments, angleUnbalanced, initStatementClosed, isInitStarter, stripInvariantExpr, braceInner } from './speck-span.js';

export function parseStateBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): StateNode {
  // Cycle 59: support `state as <MessageName> { ... }` to override the
  // generated .proto message name. Default (no `as`) keeps the existing
  // `message <SpeckName>State { ... }` convention.
  const headerLine = lines[startIndex].trim();
  const asMatch = headerLine.match(/^state\s+as\s+(\w+)\s*{/);
  const messageName = asMatch ? asMatch[1] : undefined;

  // A one-line `state { x: Nat }` closes on the header. The line walker
  // started on the next line and stored no variables.
  const inline = inlineActionBody(headerLine);
  if (inline !== null) {
    const result = parseStateBlock(inline.trim());
    if (messageName !== undefined) result.messageName = messageName;
    return result;
  }

  const endIndex = findBlockEnd(lines, startIndex + 1, startBraceCount);
  // Drop comments before joining. A `//` tail left in the text comments out
  // every later line that gets concatenated onto it, so the rest of the
  // block disappears into one field.
  let commentState = lexStart();
  const pieces: { text: string; hadComma: boolean }[] = [];
  for (let li = startIndex + 1; li < endIndex; li++) {
    const stripped = codeWithoutComments(lines[li], commentState);
    commentState = stripped.state;
    const trimmed = stripped.text.trim();
    if (!trimmed) continue;
    pieces.push({
      text: trimmed.replace(/,+\s*$/, ''),
      hadComma: /,\s*$/.test(trimmed),
    });
  }
  const inner = pieces.reduce((acc, piece, i) => {
    const line = piece.text;
    if (i === 0) return line;
    const prevLine = pieces[i - 1].text;
    // Check if this line starts a new variable declaration (name: type)
    const isNewVar = /^\w+\s*:/.test(line);
    // Check if prev line ends with a continuation character (brace or paren, NOT comma)
    const prevIsContinuation = /[{(]\s*$/.test(prevLine);
    // A type continues onto this line when `<` `(` `[` `{` is still open,
    // the code (not a comment) ended with `|`, or this line starts a union alternative.
    // `x: Nat // a |` must not swallow the next field.
    const continues = angleUnbalanced(acc) || maskCode(acc).text.trimEnd().endsWith('|') || line.startsWith('|');
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
      if (continues) {
        return pieces[i - 1].hadComma && !line.startsWith('|') ? acc + ', ' + line : acc + ' ' + line;
      }
      if (isNewVar && !prevIsContinuation) {
        return acc + '; ' + line;
      }
      if (!prevIsContinuation) {
        throw lexProblem(startIndex + 1, `unrecognized state field "${line}"`);
      }
      return acc + ' ' + line;
    }
    return acc.endsWith('{') ? acc + ' ' + line : acc + ', ' + line;
  }, '');
  const result = parseStateBlock(inner);
  if (messageName !== undefined) result.messageName = messageName;
  return result;
}

/**
 * One line of state text with comments removed, via `maskCode`.
 * A block comment carries `state` onto the next line. `"/*"` and `"a//b"` stay.
 */
export function bracketsUnbalanced(text: string): boolean {
  let depth = 0;
  for (const c of maskCode(text).text) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return depth > 0;
}

/** A `<...>` generic that has not closed yet. `>` inside a string is not a closer. */
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
  // A one-line `init { x := 0 }` closes on the header. The line walker
  // started on the next line and stored no assignments.
  const inline = inlineActionBody(lines[startIndex].trim());
  if (inline !== null) return parseInitBlock(inline.trim());

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
    const closed = cur !== null && initStatementClosed(cur);
    if (cur !== null && !closed) {
      cur += ' ' + raw;
      continue;
    }
    // `name :=`, `name ==`, `let`, and `forall` start a statement.
    // `y = 0` and a stray line do not.
    if (isInitStarter(raw) || cur === null) {
      if (cur !== null) stmts.push(cur.replace(/,\s*$/, '').trim());
      if (cur === null && !isInitStarter(raw)) {
        throw lexProblem(startIndex + 1, `unrecognized init line "${raw}"`);
      }
      cur = raw;
      continue;
    }
    throw lexProblem(startIndex + 1, `unrecognized init line "${raw}"`);
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
  // A trailing `//` is a comment. The line walker left it in the expression.
  const expr = stripInvariantExpr(braceInner(lines, startIndex));
  if (!expr) throw lexProblem(startIndex + 1, 'invariant expression is empty');
  return { type: 'invariant', name, expr };
}

/**
 * Source between a block's opening `{` and its matching `}`.
 * Comments and strings are not braces. Includes text on the header
 * after `{` and text on the closing line before `}`.
 */
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

