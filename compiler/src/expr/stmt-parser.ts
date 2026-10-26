// SpeckDL Statement Parser
// Parses an action body (list of lines) into typed ActionStatement nodes
// with full expression subtrees from the ExpressionParser.

import { TokenType, Tokenizer, tokenize, Token as TokenT } from './tokenizer.js';
import { maskSource } from '../source-scan.js';
import { ExpressionParser } from './parser.js';
import { Expr } from "./ast";
import { ActionStatement } from './stmt-ast.js';

/**
 * Parse a single action's body lines into typed statement nodes.
 * Handles: precondition, postcondition, require, let, assign, emit, return, ifblock.
 */
export function parseActionStatements(lines: string[], lineNumbers?: number[]): ActionStatement[] {
  const stmts: ActionStatement[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;

    // Clean up double-backslash from old parser (SpeckDL set diff is single \)
    // The old parser stores \\ as two chars; the expression parser expects single \\n    // Actually, keep double backslash as-is since the tokenizer handles both

    // --- forall block: keep as raw ifblock ---
    if (trimmed.startsWith('forall ')) {
      // Collect entire forall block
      let blockText = trimmed;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (!next || !next.trim()) break;
        const nt = next.trim();
        if (nt.startsWith('require ') || nt.startsWith('let ') || nt.startsWith('return ') ||
            nt.startsWith('emit ') || /^\w+\s*:=/.test(nt)) break;
        blockText += ' ' + nt;
        j++;
      }
      stmts.push({ type: 'ifblock', raw: blockText });
      i = j - 1;
      continue;
    }

    // --- precondition: expr ---
    if (trimmed.startsWith('precondition:')) {
      const sourceLine = lineNumbers?.[i];
      const exprs = collectExpression(lines, i, 13, 'or ');
      i = exprs.endIdx;
      stmts.push({ type: 'precondition', expr: parseExprSingle(exprs.text), ...(sourceLine ? { line: sourceLine } : {}) });
      continue;
    }

    // --- postcondition: expr ---
    if (trimmed.startsWith('postcondition:')) {
      const sourceLine = lineNumbers?.[i];
      const exprs = collectExpression(lines, i, 14, 'or ');
      i = exprs.endIdx;
      stmts.push({ type: 'postcondition', expr: parseExprSingle(exprs.text), ...(sourceLine ? { line: sourceLine } : {}) });
      continue;
    }

    // --- require expr ---
    if (trimmed.startsWith('require ')) {
      const sourceLine = lineNumbers?.[i];
      const exprs = collectRequireExpression(lines, i);
      i = exprs.endIdx;
      stmts.push({ type: 'require', expr: parseExprSingle(exprs.text), ...(sourceLine ? { line: sourceLine } : {}) });
      continue;
    }

    // --- return expr ---
    if (trimmed.startsWith('return ')) {
      const sourceLine = lineNumbers?.[i];
      stmts.push({ type: 'return', expr: parseExprSingle(trimmed.substring(7).trim()), ...(sourceLine ? { line: sourceLine } : {}) });
      continue;
    }

    // --- emit Event { fields } (may span several lines) ---
    const emitLine = lineNumbers?.[i];
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
      stmts.push({ type: 'emit', event: eventName, fields, ...(emitLine ? { line: emitLine } : {}) });
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
        const code = maskSource(bt, { unclosed: 'blank', blankStringBraces: false }).trim();
        if (code) blockLines.push(code);
        for (const ch of code) {
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
      const sourceLine = lineNumbers?.[i];
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
      stmts.push({ type: 'let', name: letMatch[1], expr: parseExprSingle(rhs), ...(sourceLine ? { line: sourceLine } : {}) });
      continue;
    }

    // --- assignment: target := expr ---
    const assignMatch = trimmed.match(/^(\w+(?:\[.*?\])?)\s*:=\s*(.*)$/);
    if (assignMatch) {
      const sourceLine = lineNumbers?.[i];
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
      const lineField = sourceLine ? { line: sourceLine } : {};

      // Determine target kind: plain or map_index
      const bracketMatch = target.match(/^(\w+)\[(.+)\]$/);
      if (bracketMatch && bracketMatch[2].trim()) {
        stmts.push({
          type: 'assign',
          target: { kind: 'map_index', mapName: bracketMatch[1], index: parseExprSingle(bracketMatch[2]) },
          expr,
          ...lineField,
        });
      } else {
        stmts.push({ type: 'assign', target: { kind: 'plain', name: target }, expr, ...lineField });
      }
      continue;
    }

    // A bare call, a `for` header, or an assignment to a dotted path has no
    // IR form yet. Keep it as raw text so it is reported, not deleted.
    const dottedAssign = /^(.+?)\s*:=/.exec(trimmed);
    if (/^for\b/.test(trimmed) || /^[\w.]+\s*\(/.test(trimmed) || (dottedAssign && dottedAssign[1].includes('.'))) {
      stmts.push({ type: 'ifblock', raw: trimmed });
      continue;
    }

    // A misspelled keyword (`requires`), a bare guard (`stage == 1`, `not
    // isOn`), or any other text that is not a statement is an error.
    // Fragments of an if/else the block parser did not collect
    // (`else ...`, `}`) stay raw text. `for`, bare calls, and dotted
    // assignments were kept above.
    const sourceLine = lineNumbers?.[i];
    const postWord = trimmed.match(/^(ensure|ensures|post)\b/);
    const word = trimmed.match(/^[A-Za-z_]\w*/)?.[0];
    const suggestion = postWord ? 'postcondition' : word ? suggestKeyword(word) : undefined;
    // A `{` still belongs to a conditional the block parser did not collect
    // (Raft writes `path[i].term == ... {`). That stays raw text. `bogus stuff`
    // has no brace and is an error.
    const fragment = /^(else\b|[{}])/.test(trimmed) || trimmed.includes('{');
    if (fragment) {
      stmts.push({ type: 'ifblock', raw: trimmed });
      continue;
    }
    stmts.push({
      type: 'unrecognized',
      raw: trimmed,
      ...(sourceLine ? { line: sourceLine } : {}),
      ...(suggestion ? { suggestion } : {}),
    });
  }

  return stmts;
}

// --- Helpers ---

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

const STATEMENT_KEYWORDS = [
  'require', 'return', 'emit', 'let', 'if', 'forall', 'for', 'precondition', 'postcondition',
];

/** Edit distance 1, or 2 when either word is at least 6 characters. */
function suggestKeyword(word: string): string | undefined {
  const lower = word.toLowerCase();
  let best: { kw: string; d: number } | undefined;
  for (const kw of STATEMENT_KEYWORDS) {
    const d = editDistance(lower, kw);
    if (d === 0) continue;
    const limit = Math.max(lower.length, kw.length) >= 6 ? 2 : 1;
    if (d <= limit && (!best || d < best.d)) best = { kw, d };
  }
  return best?.kw;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = new Array<number>(b.length + 1);
  const next = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    next[0] = i;
    let rowMin = next[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + cost);
      if (next[j] < rowMin) rowMin = next[j];
    }
    if (rowMin > 2) return 3;
    for (let j = 0; j <= b.length; j++) prev[j] = next[j];
  }
  return prev[b.length];
}

// Re-export Expr type
export type { Expr } from './ast.js';
