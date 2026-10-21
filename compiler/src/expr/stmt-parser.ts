// SpeckDL Statement Parser
// Parses an action body (list of lines) into typed ActionStatement nodes
// with full expression subtrees from the ExpressionParser.

import { TokenType, Tokenizer, tokenize, Token as TokenT } from './tokenizer.js';
import { ExpressionParser } from './parser.js';
import { Expr } from "./ast";
import { ActionStatement } from './stmt-ast.js';

/**
 * Parse a single action's body lines into typed statement nodes.
 * Handles: precondition, postcondition, require, let, assign, emit, return, ifblock.
 */
export function parseActionStatements(lines: string[]): ActionStatement[] {
  const stmts: ActionStatement[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;

    // Clean up double-backslash from old parser (SpeckDL set diff is single \)
    // The old parser stores \\ as two chars; the expression parser expects single \\n    // Actually, keep double backslash as-is since the tokenizer handles both

    // --- for / forall loop: the IR has no loop node, so keep the whole loop
    // (header and body) as one raw statement. Backends report it as not
    // lowered; splitting it would run the body once, outside any loop, with
    // the loop variable unbound.
    if (/^for(all)?\s/.test(trimmed)) {
      const end = loopBlockEnd(lines, i);
      const blockText = lines.slice(i, end + 1).map(l => stripLineComment(l.trim())).filter(Boolean).join(' ');
      stmts.push({ type: 'ifblock', raw: blockText });
      i = end;
      continue;
    }

    // --- precondition: expr ---
    if (trimmed.startsWith('precondition:')) {
      const exprs = collectExpression(lines, i, 13, 'or ');
      i = exprs.endIdx;
      stmts.push({ type: 'precondition', expr: parseExprSingle(exprs.text) });
      continue;
    }

    // --- postcondition: expr ---
    if (trimmed.startsWith('postcondition:')) {
      const exprs = collectExpression(lines, i, 14, 'or ');
      i = exprs.endIdx;
      stmts.push({ type: 'postcondition', expr: parseExprSingle(exprs.text) });
      continue;
    }

    // --- require expr ---
    if (trimmed.startsWith('require ')) {
      const exprs = collectRequireExpression(lines, i);
      i = exprs.endIdx;
      stmts.push({ type: 'require', expr: parseExprSingle(exprs.text) });
      continue;
    }

    // --- return expr ---
    if (trimmed.startsWith('return ')) {
      stmts.push({ type: 'return', expr: parseExprSingle(trimmed.substring(7).trim()) });
      continue;
    }

    // --- emit Event { fields } (may span several lines) ---
    let emitText = trimmed;
    if (/^emit\s+\w+\s*\{/.test(emitText)) {
      emitText = stripLineComment(emitText);
      while (exprLooksIncomplete(emitText) && i + 1 < lines.length) {
        const nt = stripLineComment(lines[i + 1]?.trim() ?? '');
        i++;
        if (nt) emitText += ' ' + nt;
      }
    }
    const emitMatch = emitText.match(/^emit\s+(\w+)\s*\{\s*(.*)\s*\}$/);
    if (emitMatch) {
      const eventName = emitMatch[1];
      const fieldsStr = emitMatch[2];
      const fields: { name: string; value: Expr }[] = [];
      if (fieldsStr.trim()) {
        for (const fp of splitTopLevel(fieldsStr)) {
          const colonIdx = fp.indexOf(':');
          if (colonIdx > 0) {
            fields.push({
              name: fp.substring(0, colonIdx).trim(),
              value: parseExprSingle(fp.substring(colonIdx + 1).trim()),
            });
          }
        }
      }
      stmts.push({ type: 'emit', event: eventName, fields });
      continue;
    }

    // --- if condition { ... } else ... ---
    if (trimmed.startsWith('if ')) {
      // Collect the full if/else block as raw text
      let braceDepth = 0;
      let j = i;
      const blockLines: string[] = [];
      while (j < lines.length) {
        const bl = lines[j];
        if (!bl) { j++; continue; }
        const bt = bl.trim();
        if (bt.startsWith('//')) { j++; continue; }
        blockLines.push(bt);
        for (const ch of bt) {
          if (ch === '{') braceDepth++;
          else if (ch === '}') braceDepth--;
        }
        j++;
        if (braceDepth === 0) break;
      }
      stmts.push({ type: 'ifblock', raw: blockLines.join(' ') });
      i = j - 1;
      continue;
    }

    // --- let name := expr ---
    // `let name := expr`, or the typed form `let name: Type = expr`.
    const letMatch = trimmed.match(/^let\s+([A-Za-z_]\w*)\s*:=\s*(.+)$/)
      ?? trimmed.match(/^let\s+([A-Za-z_]\w*)\s*:\s*[\w.<>\[\], ]+?\s*=(?!=)\s*(.+)$/);
    if (letMatch) {
      let rhs = letMatch[2].trim();
      if (/^if\b/.test(rhs) && !/\belse\b/.test(rhs)) {
        stmts.push({ type: 'ifblock', raw: trimmed });
        continue;
      }
      // Multi-line expressions: join continuation lines while the right-hand
      // side is syntactically incomplete (e.g. a multi-line record literal
      // opened with `Customer {`).
      rhs = stripLineComment(rhs);
      while (i + 1 < lines.length) {
        const nt = stripLineComment(lines[i + 1]?.trim() ?? '');
        if (!continues(rhs, nt) || /\w+\s*:=/.test(nt)) break;
        rhs += ' ' + nt;
        i++;
      }
      stmts.push({ type: 'let', name: letMatch[1], expr: parseExprSingle(rhs) });
      continue;
    }

    // --- assignment: target := expr ---
    const assignMatch = trimmed.match(/^(\w+(?:\[.*?\])?)\s*:=\s*(.*)$/);
    if (assignMatch) {
      let exprText = stripLineComment(assignMatch[2].trim());
      // Join continuation lines only while the right-hand side is still
      // incomplete (dangling operator, open bracket) or the next line starts
      // with a binary operator. Joining unconditionally swallowed the next
      // statement whenever it was not caught by a keyword check, e.g.
      // `balances[id] := 0` or a bare call.
      while (i + 1 < lines.length) {
        const nt = stripLineComment(lines[i + 1]?.trim() ?? '');
        if (!continues(exprText, nt)) break;
        exprText += ' ' + nt;
        i++;
      }
      const target = assignMatch[1];
      const expr = parseExprSingle(exprText);

      // Determine target kind: plain or map_index
      const bracketMatch = target.match(/^(\w+)\[(.+)\]$/);
      if (bracketMatch && bracketMatch[2].trim()) {
        stmts.push({
          type: 'assign',
          target: { kind: 'map_index', mapName: bracketMatch[1], index: parseExprSingle(bracketMatch[2]) },
          expr,
        });
      } else {
        stmts.push({ type: 'assign', target: { kind: 'plain', name: target }, expr });
      }
      continue;
    }

    // Anything else (a bare call, an assignment to a dotted path, ...) is
    // kept as raw text so it is reported as not lowered instead of vanishing.
    stmts.push({ type: 'ifblock', raw: trimmed });
  }

  return stmts;
}

// --- Helpers ---

/**
 * Index of the last line of the loop starting at `start`: a colon-form loop
 * (`for i from 0 to n - 1:`) runs over the following lines indented deeper
 * than its header; a brace-form loop runs until its braces balance; a
 * one-line `forall x in S: expr` is just its own line.
 */
function loopBlockEnd(lines: string[], start: number): number {
  const header = stripLineComment(lines[start].trim());
  const indentOf = (l: string) => l.length - l.trimStart().length;
  if (header.endsWith(':')) {
    const base = indentOf(lines[start]);
    let end = start;
    for (let j = start + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l || !l.trim()) continue;
      if (indentOf(l) <= base) break;
      end = j;
    }
    return end;
  }
  if (header.includes('{')) {
    let depth = 0;
    for (let j = start; j < lines.length; j++) {
      const t = stripLineComment(lines[j]?.trim() ?? '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
      for (const ch of t) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth <= 0) return j;
    }
    return lines.length - 1;
  }
  return start;
}

/** Parse a single expression string to an Expr AST. */
function parseExprSingle(src: string): Expr {
  // The whole text must parse. A prefix parse used to drop the rest silently
  // (`x := a union {b}` followed by a swallowed next line, `Rec { ... }` read
  // as `Rec`); report it as unparsed instead.
  try {
    const tokens = new Tokenizer(src).tokenize();
    return new ExpressionParser(tokens).parseComplete();
  } catch (e) {
    return { kind: 'unparsed', source: src, error: (e as Error).message };
  }
}

interface CollectResult {
  text: string;
  endIdx: number;
}

/** Collect an expression that may continue on 'or ' lines. */
/** True when an expression text is syntactically incomplete (dangling operator or unbalanced brackets). */
function exprLooksIncomplete(text: string): boolean {
  let depth = 0;
  let inStr = false;
  for (const c of text) {
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  if (depth > 0) return true;
  // Ends with a binary operator → the expression continues on the next line.
  const t = text.trim();
  // Nothing yet (`x :=` with the value on the next line), or a quantifier
  // header ending in `:` whose body follows.
  if (!t || t.endsWith(':')) return true;
  return /(==|!=|>=|<=|<|>|\+|-|\*|\/|\band\b|\bor\b|implies|->|=\u003e|distinct|union|mod)\s*$/i.test(t);
}

/** A line that starts with a binary operator continues the previous expression. */
const LEADING_OP_RE = /^(\|\||&&|==|!=|>=|<=|\+|\*|\/|or\b|and\b|implies\b|union\b|diff\b|mod\b)/;

/**
 * Whether `next` continues the expression `text`: either `text` is still
 * incomplete or `next` opens with a binary operator. Blank lines, comments
 * and new statements never continue it.
 */
function continues(text: string, next: string): boolean {
  if (!next || next.startsWith('//') || STMT_START_RE.test(next)) return false;
  return exprLooksIncomplete(text) || LEADING_OP_RE.test(next);
}

/** Drop a trailing `// comment` (outside string literals) before lines are joined. */
function stripLineComment(text: string): string {
  let inStr = false;
  for (let k = 0; k < text.length - 1; k++) {
    const c = text[k];
    if (c === '"') inStr = !inStr;
    if (!inStr && c === '/' && text[k + 1] === '/') return text.slice(0, k).trim();
  }
  return text;
}

/** Split on commas that are not nested inside brackets or strings. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, k));
      start = k + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

const STMT_START_RE = /^(require\s|return\s|emit\s|let\s|precondition:|postcondition:|[\w.]+(\[.*?\])?\s*:=)/;

function collectExpression(lines: string[], startIdx: number, prefixLen: number, continuationPfx: string): CollectResult {
  let text = lines[startIdx].trim().substring(prefixLen).trim();
  let i = startIdx;
  while (i + 1 < lines.length) {
    const next = lines[i + 1];
    if (!next) break;
    const nt = next.trim();
    if (!nt || nt.startsWith('//')) break;
    // Legacy explicit continuation: each line starts with the prefix ("or ").
    if (nt.startsWith(continuationPfx)) {
      text += ' or ' + nt.substring(continuationPfx.length).trim();
      i++;
      continue;
    }
    // Dangling-operator continuation: the expression is incomplete and the
    // next line is not the start of a new statement (e.g. a multi-line
    // `postcondition: a[x] ==\n    old(a[x]) + t.amount`).
    if (exprLooksIncomplete(text) && !STMT_START_RE.test(nt)) {
      text += ' ' + nt;
      i++;
      continue;
    }
    break;
  }
  return { text, endIdx: i };
}

/** Collect a require expression that may span multiple lines (forall, or, etc). */
function collectRequireExpression(lines: string[], startIdx: number): CollectResult {
  let text = stripLineComment(lines[startIdx].trim().substring(8).trim());
  let i = startIdx;
  while (i + 1 < lines.length) {
    const nt = stripLineComment(lines[i + 1]?.trim() ?? '');
    if (/\w+\s*:=/.test(nt) || !continues(text, nt)) break;
    i++;
    text += ' ' + nt;
  }
  return { text, endIdx: i };
}

// Re-export Expr type
export type { Expr } from './ast.js';
