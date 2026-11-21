import { ActionNode, ActionStatement, EventNode, TypeExpr } from './speck-part0.js';
import { exprIncomplete, inlineActionBody, joinBlockLines } from './speck-part4.js';
import { findBlockEnd, isExpressionComplete, maskCode } from './speck-part1.js';
import { parseActionHeader, parseEvent, parseTypeExpr } from './speck-part3.js';
import { splitFields } from './speck-part7.js';

/** Text before the first `{`/`}` that is not inside a string or a comment. */
function textBeforeCodeClose(line: string): string {
  const masked = maskCode(line).text;
  const at = masked.indexOf('}');
  if (at < 0) return '';
  return line.slice(0, at).trim();
}

/** A `cost <n>` statement, not an assignment whose name starts with "cost". */
function isCostLine(stmt: string): boolean {
  const cut = stmt.indexOf('//');
  const text = (cut >= 0 ? stmt.slice(0, cut) : stmt).trim();
  return /^cost\s+\S/.test(text) && !/^cost\s*:=/.test(text);
}

/** A `priority <Name>` statement, not an assignment `priority := ...`. */
function isPriorityLine(stmt: string): boolean {
  const cut = stmt.indexOf('//');
  const text = (cut >= 0 ? stmt.slice(0, cut) : stmt).trim();
  return /^priority\b/.test(text) && !/^priority\s*:=/.test(text);
}

/**
 * A one-line event. A `}` inside a `"` string or a `//` comment is not the
 * closer, so `event E kpi "a}b" { }` and `event E kpi "x" { } // {` stay
 * on this line.
 */
function inlineEvent(firstLine: string): { fields: string } | null {
  const masked = maskCode(firstLine).text;
  const open = masked.indexOf('{');
  if (open < 0) return null;
  const close = masked.indexOf('}', open + 1);
  if (close < 0) return null;
  if (masked.slice(close + 1).trim() !== '') return null;
  return { fields: firstLine.slice(open + 1, close) };
}

export function parseActionBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): ActionNode | null {
  const firstLine = lines[startIndex].trim();
  const header = parseActionHeader(firstLine);
  if (!header) return null;

  // The header's own `}` is not on a later line. Scanning forward from the
  // next line used to take the following action's statements, and a `}`
  // inside `//` was not what stopped that scan.
  const inline = inlineActionBody(firstLine);
  const endIndex = inline !== null ? startIndex : findBlockEnd(lines, startIndex + 1, startBraceCount);
  // A statement on the opening line or on the closing line is still a
  // statement. `action Go { cost 1` / `cost 2 }` must not disappear.
  const headerTail = inline === null ? firstLine.slice(firstLine.indexOf('{') + 1).trim() : '';
  const closeTail = inline === null && endIndex < lines.length ? textBeforeCodeClose(lines[endIndex]) : '';
  const bodySource = inline !== null
    ? (inline.trim() ? [inline] : [])
    : [
        ...(headerTail ? [headerTail] : []),
        ...lines.slice(startIndex + 1, endIndex),
        ...(closeTail ? [closeTail] : []),
      ];
  // Keep blank lines as null to separate statements, filter only comments.
  // Preserve indentation: it bounds colon-form if/else regions.
  type BodyEntry = { text: string; indent: number } | null;
  const bodyEntries: BodyEntry[] = bodySource.map(l => {
    const trimmed = l.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) return null;
    return { text: trimmed, indent: l.length - l.trimStart().length };
  });

  // Pre-pass: lower colon-form if/else regions (`if cond:` / `else:`) into
  // brace form so the brace scanner below captures the whole region as one
  // ifblock. The then-branch is the run of deeper-indented lines after
  // `if cond:`; an `else:` at the if's indent switches branches; a line at
  // or below the if's indent ends the region.
  const prePass: (string | null)[] = [];
  {
    let i = 0;
    while (i < bodyEntries.length) {
      const cur = bodyEntries[i];
      if (cur && /^for\b[^{]*:\s*$/.test(cur.text)) {
        // colon-form for loop: `for v in coll:` - brace it; go.ts lowers the
        // range and body
        const forIndent = cur.indent;
        prePass.push(cur.text.replace(/:\s*$/, ' {'));
        i++;
        while (i < bodyEntries.length) {
          const l2 = bodyEntries[i];
          if (l2 === null) { prePass.push(null); i++; continue; }
          if (l2.indent <= forIndent) break;
          prePass.push(l2.text);
          i++;
        }
        prePass.push('}');
        continue;
      }
      if (!cur || !/^if\b[^{]*:\s*$/.test(cur.text) || cur.text.includes('{')) {
        prePass.push(cur ? cur.text : null);
        i++;
        continue;
      }
      const ifIndent = cur.indent;
      prePass.push(cur.text.replace(/:\s*$/, ' {'));
      i++;
      while (i < bodyEntries.length) {
        const l2 = bodyEntries[i];
        if (l2 === null) { prePass.push(null); i++; continue; }
        if (l2.indent <= ifIndent) {
          if (/^else\s*:\s*$/.test(l2.text)) { prePass.push('} else {'); i++; continue; }
          break;
        }
        prePass.push(l2.text);
        i++;
      }
      prePass.push('}');
    }
  }
  // Collapse consecutive nulls and strip trailing nulls
  const collapsed: (string | null)[] = [];
  for (const line of prePass) {
    if (line !== null || (collapsed.length > 0 && collapsed[collapsed.length - 1] !== null)) {
      collapsed.push(line);
    }
  }
  // Remove trailing nulls
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === null) {
    collapsed.pop();
  }
  const bodyLines = collapsed;

  const statements: ActionStatement[] = [];
  for (let i = 0; i < bodyLines.length; i++) {
    const stmtOrNull = bodyLines[i];
    // Skip blank line separators
    if (stmtOrNull === null) continue;
    const stmt = stmtOrNull;
    // precondition: expr
    if (stmt.startsWith('precondition:')) {
      let expr = stmt.substring(13).trim();
      // support 'or' continuation lines
      while (i + 1 < bodyLines.length) {
        const nextLine = bodyLines[i + 1];
        if (nextLine === null || !nextLine.startsWith('or ')) break;
        i++;
        expr += ' || ' + nextLine.substring(3).trim();
      }
      statements.push({ type: 'precondition', expr });
      continue;
    }
    // postcondition: expr
    if (stmt.startsWith('postcondition:')) {
      let expr = stmt.substring(14).trim();
      // support 'or' continuation lines
      while (i + 1 < bodyLines.length) {
        const nextLine = bodyLines[i + 1];
        if (nextLine === null || !nextLine.startsWith('or ')) break;
        i++;
        expr += ' || ' + nextLine.substring(3).trim();
      }
      statements.push({ type: 'postcondition', expr });
      continue;
    }
    // require expr
    if (stmt.startsWith('require ')) {
      let expr = stmt.substring(8).trim();
      // support multi-line continuation (forall, or, etc.)
      while (i + 1 < bodyLines.length) {
        const nextLine = bodyLines[i + 1];
        if (nextLine === null) break;
        // Stop if next line starts a new statement keyword
        if (nextLine.startsWith('precondition:') || nextLine.startsWith('postcondition:') ||
            nextLine.startsWith('require ') || nextLine.startsWith('return ') ||
            nextLine.startsWith('emit ') || nextLine.startsWith('let ') ||
            nextLine.startsWith('if ') || isCostLine(nextLine) || isPriorityLine(nextLine) ||
            nextLine.includes(':=')) {
          break;
        }
        i++;
        expr += ' ' + nextLine;
      }
      statements.push({ type: 'require', expr });
      continue;
    }
    // return expr
    if (stmt.startsWith('return ')) {
      statements.push({ type: 'return', expr: stmt.substring(7).trim() });
      continue;
    }
    // emit Event { fields }
    const emitMatch = stmt.match(/^emit\s+(\w+)\s*\{\s*(.*)\s*\}$/);
    if (emitMatch) {
      const eventName = emitMatch[1];
      const fieldsStr = emitMatch[2];
      const fields: { name: string; value: string }[] = [];
      if (fieldsStr) {
        const fieldPairs = splitFields(fieldsStr);
        for (const fp of fieldPairs) {
          const colonIdx = fp.indexOf(':');
          if (colonIdx > 0) {
            fields.push({
              name: fp.substring(0, colonIdx).trim(),
              value: fp.substring(colonIdx + 1).trim(),
            });
          }
        }
      }
      statements.push({ type: 'emit', event: eventName, fields });
      continue;
    }
    if (isCostLine(stmt)) {
      const text = stmt.slice(0, stmt.includes('//') ? stmt.indexOf('//') : stmt.length).trim();
      const costMatch = text.match(/^cost\s+(\d+)\s*$/);
      const amount = costMatch ? Number(costMatch[1]) : NaN;
      if (!costMatch || !Number.isSafeInteger(amount)) {
        throw new Error(`Parse error at line ${startIndex + 1}: action ${header.name} cost must be a non-negative integer`);
      }
      if (statements.some(s => s.type === 'cost')) {
        throw new Error(`Parse error at line ${startIndex + 1}: action ${header.name} declares cost more than once`);
      }
      statements.push({ type: 'cost', amount });
      continue;
    }
    if (isPriorityLine(stmt)) {
      const text = stmt.slice(0, stmt.includes('//') ? stmt.indexOf('//') : stmt.length).trim();
      const pri = text.match(/^priority\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/);
      if (!pri) {
        throw new Error(`Parse error at line ${startIndex + 1}: action ${header.name} priority must be an identifier`);
      }
      if (statements.some(s => s.type === 'priority')) {
        throw new Error(`Parse error at line ${startIndex + 1}: action ${header.name} declares priority more than once`);
      }
      statements.push({ type: 'priority', name: pri[1] });
      continue;
    }
    // for v in coll { ... } - range loop captured as a forblock statement
    if (stmt.startsWith('for ')) {
      let braceDepth = 0;
      let j = i;
      const blockLines2: string[] = [];
      while (j < bodyLines.length) {
        const line = bodyLines[j];
        if (line === null) { j++; continue; }
        blockLines2.push(line);
        for (const ch of maskCode(line).text) {
          if (ch === '{') braceDepth++;
          else if (ch === '}') braceDepth--;
        }
        j++;
        if (braceDepth === 0) break;
      }
      statements.push({ type: 'forblock', raw: joinBlockLines(blockLines2) } as any);
      i = j - 1;
      continue;
    }
    // if condition { ... } else if condition { ... } else { ... }
    // SpeckDL conditional blocks - parse as a special statement type
    if (stmt.startsWith('if ')) {
      // Find matching } for this if block (may span multiple bodyLines entries)
      let braceDepth = 0;
      let j = i;
      const blockLines: string[] = [];
      while (j < bodyLines.length) {
        const line = bodyLines[j];
        if (line === null) { j++; continue; }
        blockLines.push(line);
        for (const ch of maskCode(line).text) {
          if (ch === '{') braceDepth++;
          else if (ch === '}') braceDepth--;
        }
        j++;
        if (braceDepth === 0) break;
      }
      // For now, treat as a raw 'ifblock' statement that the generator can handle
      statements.push({ type: 'ifblock', raw: joinBlockLines(blockLines) });
      i = j - 1; // skip to end of if block
      continue;
    }
    // let name := expr (may span multiple lines, e.g. a record constructor)
    const letMatch = stmt.match(/^let\s+(\w+)\s*:=\s*(.+)$/);
    if (letMatch) {
      let rhs = letMatch[2].trim();
      // Multi-line expressions: join continuation lines while the right-hand
      // side is syntactically incomplete (e.g. `Customer { ... }` spanning
      // several lines). Statement starters terminate the join.
      while (i + 1 < bodyLines.length) {
        const nextLine = bodyLines[i + 1];
        if (!nextLine) break;
        const nt = nextLine.trim();
        if (!nt || nt.startsWith('//')) break;
        if (nt.startsWith('require ') || nt.startsWith('return ') ||
            nt.startsWith('emit ') || nt.startsWith('let ') ||
            /\w+\s*:=/.test(nt)) {
          break;
        }
        if (!exprIncomplete(rhs)) break;
        rhs += ' ' + nt;
        i++;
      }
      statements.push({ type: 'let', name: letMatch[1], expr: rhs });
      continue;
    }
    // assignment: target := expr (may span multiple lines)
    const assignMatch = stmt.match(/^([\w\[\]]+(?:\.\w+)?)\s*:=\s*(.+)$/);
    if (assignMatch) {
      let target = assignMatch[1];
      let expr = assignMatch[2].trim();
      // Handle multiline expressions: join subsequent lines until braces/parens are balanced
      while (i + 1 < bodyLines.length && !isExpressionComplete(expr)) {
        i++;
        expr += ' ' + bodyLines[i];
      }
      statements.push({ type: 'assign', target, expr });
    }
  }

  return { ...header, statements };
}

export function parseEventBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): EventNode {
  const firstLine = lines[startIndex].trim();
  const header = parseEvent(firstLine);

  // Handle single-line events: event Foo { a: Type, b: Type }
  // extract fields from the first line itself
  const inlineMatch = inlineEvent(firstLine);
  const inlineFields: { name: string; type: TypeExpr }[] = [];
  if (inlineMatch && inlineMatch.fields.trim()) {
    const fieldStr = inlineMatch.fields.trim();
    for (const f of fieldStr.split(',')) {
      const fm = f.trim().match(/^(\w+)\s*:\s*(.+)$/);
      if (fm) {
        inlineFields.push({ name: fm[1], type: { type: 'ident', name: fm[2].trim() } as TypeExpr });
      }
    }
  }

  // Single-line form: the braces balance on the header line itself, so the
  // block walk below must not run - it would overrun into later members
  // (their `state:` / `actions:` lines would leak in as event fields).
  if (inlineMatch) {
    return { ...header, fields: inlineFields };
  }
  const endIndex = findBlockEnd(lines, startIndex + 1, startBraceCount);
  const innerLines = lines.slice(startIndex + 1, endIndex).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));

  const fields: { name: string; type: TypeExpr }[] = [];
  for (const line of innerLines) {
    // Cycle 62: strip inline `//` line-comments from the type expression
    // before parsing. Without this, an event field like
    //   mesh_ip: Bytes   // 4 bytes (IPv4 overlay)
    // produces a TypeExpr whose name includes the comment text, which
    // the .proto generator emits verbatim:
    //   bytes  // 4 bytes (IPv4 overlay) mesh_ip = 2;
    // (broken syntax — comment is in the type position).
    const noComment = line.replace(/\/\/.*$/, '').trim();
    // Cycle 65: strip default-value suffix `= <expr>` from the type
    // expression. The federated-meetup speckdl has fields like
    //   initial_mesh_peers: List<InitialMeshPeer> = []
    // where the default is meaningful in Speckl semantics (a state-
    // machine init) but the .proto wire format doesn't carry a
    // default — it's a generator concern. Without this, the type
    // expression was emitted as `List<InitialMeshPeer> = []` and
    // protoc rejects the resulting syntax.
    const noDefault = noComment.replace(/\s*=\s*[^,]+$/, '').trim();
    const match = noDefault.match(/^(\w+)\s*:\s*(.+?),?$/);
    if (match) {
      fields.push({ name: match[1], type: parseTypeExpr(match[2].replace(/,$/, '').trim()) });
    }
  }

  return { ...header, fields: fields.length > 0 ? fields : inlineFields };
}

