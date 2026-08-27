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
    if (line.startsWith('//') || line.startsWith('/*')) continue;

    const trimmed = line.trim();
    if (!trimmed) continue;

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

    // --- emit Event { fields } ---
    const emitMatch = trimmed.match(/^emit\s+(\w+)\s*\{\s*(.*)\s*\}$/);
    if (emitMatch) {
      const eventName = emitMatch[1];
      const fieldsStr = emitMatch[2];
      const fields: { name: string; value: Expr }[] = [];
      if (fieldsStr.trim()) {
        for (const fp of fieldsStr.split(',').map(s => s.trim()).filter(Boolean)) {
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
    const letMatch = trimmed.match(/^let\s+([A-Za-z_]\w*)\s*:=\s*(.+)$/);
    if (letMatch) {
      let rhs = letMatch[2].trim();
      if (/^if\b/.test(rhs) && !/\belse\b/.test(rhs)) {
        stmts.push({ type: 'ifblock', raw: trimmed });
        continue;
      }
      // Multi-line expressions: join continuation lines while the right-hand
      // side is syntactically incomplete (e.g. a multi-line record literal
      // opened with `Customer {`).
      while (exprLooksIncomplete(rhs) && i + 1 < lines.length) {
        const next = lines[i + 1];
        const nt = next?.trim() ?? '';
        if (!nt || nt.startsWith('//') || STMT_START_RE.test(nt) || /\w+\s*:=/.test(nt)) break;
        rhs += ' ' + nt;
        i++;
      }
      stmts.push({ type: 'let', name: letMatch[1], expr: parseExprSingle(rhs) });
      continue;
    }

    // --- assignment: target := expr ---
    const assignMatch = trimmed.match(/^(\w+(?:\[.*?\])?)\s*:=\s*(.+)$/);
    if (assignMatch) {
      let exprText = assignMatch[2].trim();
      // Handle multiline expressions
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (!next || next.trim().startsWith('//') || next.trim().startsWith('require ') ||
            next.trim().startsWith('return ') || next.trim().startsWith('emit ') ||
            next.trim().startsWith('let ') || /\w+\s*:=/.test(next.trim())) {
          break;
        }
        // Join continuation lines
        if (next.trim()) {
          exprText += ' ' + next.trim();
          i++;
        } else {
          break;
        }
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
  }

  return stmts;
}

// --- Helpers ---

/** Parse a single expression string to an Expr AST. */
function parseExprSingle(src: string): Expr {
  const tokens = new Tokenizer(src).tokenize();
  return new ExpressionParser(tokens).parse();
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
  return /(==|!=|>=|<=|<|>|\+|-|\*|\/|\band\b|\bor\b|implies|->|=\u003e|distinct|union|mod)\s*$/i.test(text.trim());
}

const STMT_START_RE = /^(require\s|return\s|emit\s|let\s|precondition:|postcondition:|\w+\s*:=)/;

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
  let text = lines[startIdx].trim().substring(8).trim();
  let i = startIdx;
  while (i + 1 < lines.length) {
    const next = lines[i + 1];
    if (!next) break;
    const nt = next.trim();
    if (nt.startsWith('//') || nt.startsWith('precondition:') || nt.startsWith('postcondition:') ||
        nt.startsWith('require ') || nt.startsWith('return ') || nt.startsWith('emit ') ||
        nt.startsWith('let ') || /\w+\s*:=/.test(nt)) {
      break;
    }
    // Dangling-operator continuation (see collectExpression).
    if (!exprLooksIncomplete(text)) break;
    i++;
    text += ' ' + nt;
  }
  return { text, endIdx: i };
}

// Re-export Expr type
export type { Expr } from './ast.js';
