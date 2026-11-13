import { ConstraintNode, VerifyNode } from './speck-part0.js';
import { braceCounts, findBlockEnd, isExpressionComplete, maskCode } from './speck-part1.js';
import { inlineActionBody } from './speck-part4.js';
import { takeExpressionLines, stripInvariantExpr, braceInner } from './speck-span.js';

export function parseConstraintColonBlock(lines: string[], startIndex: number): ConstraintNode | null {
  const firstLine = lines[startIndex].trim();
  // Strip the `constraint:` prefix.
  const head = firstLine.substring(firstLine.indexOf(':') + 1).trim();
  if (!head) return null;
  const taken = takeExpressionLines(lines, startIndex, head, 'newline');
  return { type: 'constraint', expr: taken.text };
}

export function parseConstraintAnyForm(lines: string[], startIndex: number): ConstraintNode | null {
  const line = lines[startIndex].trim();

  // Form 1: `constraint Name: <expr>` — bare-word name with colon.
  const namedMatch = line.match(/^constraint\s+(\w+):(.*)$/);
  // Form 2: `constraint "name with spaces" { <expr> }` — quoted name with brace.
  // Form 3: `constraint "name" : <expr>` — quoted name with colon.
  const quotedMatch = line.match(/^constraint\s+"([^"]+)"\s*(\{|:)(.*)$/);

  let name: string;
  let expr: string;
  let exprFollows: 'colon' | 'brace';

  if (namedMatch) {
    name = namedMatch[1];
    expr = namedMatch[2].trim();
    exprFollows = 'colon';
  } else if (quotedMatch) {
    name = quotedMatch[1];
    exprFollows = quotedMatch[2] === '{' ? 'brace' : 'colon';
    expr = (exprFollows === 'colon' ? quotedMatch[3] : quotedMatch[3].trim());
  } else {
    return null;
  }
  
  // If opens a brace, treat as block
  if (exprFollows === 'brace' || expr.startsWith('{')) {
    const inline = inlineActionBody(line);
    if (inline !== null) {
      expr = inline.trim();
    } else {
      // Strip the leading '{' from expr if it was passed in via the colon form
      if (expr.startsWith('{')) expr = expr.substring(1).trim();
      const openCount = braceCounts(line).open;
      const endIdx = findBlockEnd(lines, startIndex + 1, openCount);
      const innerLines = lines.slice(startIndex + 1, endIdx).map(l => l.trim()).filter(l => l && !l.startsWith('//') && l !== '}');
      const inner = innerLines.join(' ');
      expr = (expr + ' ' + inner).trim();
    }
  } else {
    // No braces. A finished expression stays on this line. An unfinished
    // one (empty, trailing `:`, open bracket, dangling operator) takes
    // the following lines and then stops.
    expr = takeExpressionLines(lines, startIndex, expr, 'space').text;
  }
  
  return { type: 'constraint', name, expr: expr.trim() };
}

export function parseVerifyAnyForm(lines: string[], startIndex: number): VerifyNode | null {
  const line = lines[startIndex].trim();
  
  // Single-line: verify Always(Name) { depth N }
  const fullMatch = line.match(/^verify\s+((?:Always|always|Eventually|eventually)\s*\(\s*(\w+)\s*\))\s*\{\s*depth\s+(\d+)\s*\}/);
  if (fullMatch) {
    return {
      type: 'verify',
      name: fullMatch[2],
      temporalExpr: fullMatch[1].trim(),
      depth: parseInt(fullMatch[3], 10),
    };
  }
  
  // Multi-line: verify Always(Name) { ... }
  if (line.includes('{')) {
    const headerMatch = line.match(/^verify\s+((?:Always|always|Eventually|eventually)\s*\(\s*(\w+)\s*\))\s*\{/);
    if (headerMatch) {
      const temporalExpr = headerMatch[1].trim();
      const name = headerMatch[2];
      
      const openCount = braceCounts(line).open;
      const endIdx = findBlockEnd(lines, startIndex + 1, openCount);
      const innerLines = lines.slice(startIndex + 1, endIdx).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));
      const inner = innerLines.join(' ');
      
      const afterBrace = line.substring(line.indexOf('{') + 1).trim();
      const combined = (afterBrace + ' ' + inner).trim();
      const depthMatch = combined.match(/\bdepth\s+(\d+)\b/);
      const depth = depthMatch ? parseInt(depthMatch[1], 10) : undefined;
      
      return { type: 'verify', name, temporalExpr, depth };
    }
  }
  
  // Simple: verify Always(Name)
  const simpleMatch = line.match(/^verify\s+((?:Always|always|Eventually|eventually)\s*\(\s*(\w+)\s*\))\s*$/);
  if (simpleMatch) {
    return {
      type: 'verify',
      name: simpleMatch[2],
      temporalExpr: simpleMatch[1].trim(),
    };
  }
  
  return null;
}

// --- Verify/Constraint block parsing ---

/**
 * Parse a verify block opened with `verify Always(Name) { ... }` or similar.
 * The first line already contains the header; we need to parse the body inside { }.
 */
export function parseVerifyBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): VerifyNode | null {
  const firstLine = lines[startIndex].trim();
  
  // Form 1: verify "quoted name" [depth N] { body }
  // The quoted name can contain spaces. depth is optional. Body is inside { }.
  const quotedHeaderMatch = firstLine.match(/^verify\s+"([^"]+)"\s*(?:depth\s+(\d+)\s*)?\{/);
  if (quotedHeaderMatch) {
    const name = quotedHeaderMatch[1];
    const depth = quotedHeaderMatch[2] ? parseInt(quotedHeaderMatch[2], 10) : undefined;
    
    // Check if the brace closes on the same line (single-line form)
    const counted = braceCounts(firstLine);
    const openBraceCount = counted.open;
    const closeBraceCount = counted.close;
    
    if (closeBraceCount >= openBraceCount) {
      // Single-line: body is between first { and last }
      const openIdx = firstLine.indexOf('{');
      const closeIdx = firstLine.lastIndexOf('}');
      let body = firstLine.substring(openIdx + 1, closeIdx).trim();
      // Body may contain "depth N" at the start if depth was not before the brace
      // But in our regex we already captured depth before the brace, so body is just the expression.
      // However, if depth was inside braces like: verify "name" { depth 2, expr }
      // check for that pattern:
      const depthInBody = body.match(/^\s*depth\s+(\d+)\s*,?\s*/);
      let actualDepth = depth;
      if (!actualDepth && depthInBody) {
        actualDepth = parseInt(depthInBody[1], 10);
        body = body.substring(depthInBody[0].length);
      }
      return { type: 'verify', name, temporalExpr: body, depth: actualDepth };
    }
    
    // Multi-line: collect body from subsequent lines
    const endIdx = findBlockEnd(lines, startIndex + 1, startBraceCount);
    const afterBrace = firstLine.substring(firstLine.indexOf('{') + 1).trim();
    const innerLines = lines.slice(startIndex + 1, endIdx).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));
    let body = (afterBrace + ' ' + innerLines.join(' ')).trim();
    
    // Check for "depth N" inside body
    const depthInBody = body.match(/^\s*depth\s+(\d+)\s*,?\s*/);
    let actualDepth = depth;
    if (!actualDepth && depthInBody) {
      actualDepth = parseInt(depthInBody[1], 10);
      body = body.substring(depthInBody[0].length);
    }
    
    return { type: 'verify', name, temporalExpr: body, depth: actualDepth };
  }
  
  // Form 2: verify Always(Name) { depth N } or verify Always(Name) {
  const headerMatch = firstLine.match(/^verify\s+((?:Always|always|Eventually|eventually)\s*\(\s*(\w+)\s*\))\s*\{/);
  if (!headerMatch) return null;
  
  const temporalExpr = headerMatch[1].trim();
  const name = headerMatch[2];
  
  // Check if the brace closes on the same line (single-line form)
  const counted = braceCounts(firstLine);
  const openBraceCount = counted.open;
  const closeBraceCount = counted.close;
  
  if (closeBraceCount >= openBraceCount) {
    // Single-line: parse depth from same line
    const afterBrace = firstLine.substring(firstLine.indexOf('{') + 1);
    const beforeClose = afterBrace.substring(0, afterBrace.lastIndexOf('}')).trim();
    const depthMatch = beforeClose.match(/\bdepth\s+(\d+)\b/);
    const depth = depthMatch ? parseInt(depthMatch[1], 10) : undefined;
    return { type: 'verify', name, temporalExpr, depth };
  }
  
  // Multi-line block
  let depth: number | undefined;
  const endIdx = findBlockEnd(lines, startIndex + 1, startBraceCount);
  
  const innerLines = lines.slice(startIndex + 1, endIdx).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));
  const inner = innerLines.join(' ');
  
  const afterBrace = firstLine.substring(firstLine.indexOf('{') + 1).trim();
  
  const depthMatch = (afterBrace + ' ' + inner).match(/\bdepth\s+(\d+)\b/);
  if (depthMatch) {
    depth = parseInt(depthMatch[1], 10);
  }
  
  return { type: 'verify', name, temporalExpr, depth };
}

/**
 * Parse a constraint block opened with `constraint Name: ...` which may
 * be multi-line (e.g. forall spanning multiple lines).
 */
export function parseConstraintBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): ConstraintNode | null {
  const firstLine = lines[startIndex].trim();

  // Match: constraint Name: expr (possibly opening a {} block, or just a forall on next line)
  // For the SQLiteWAL style: constraint Name: expr  (single line, no braces needed)
  // Also accept `constraint "name with spaces" { ... }` and `constraint "name" : expr`
  const namedMatch = firstLine.match(/^constraint\s+(\w+):(.*)$/);
  const quotedMatch = firstLine.match(/^constraint\s+"([^"]+)"\s*(\{|:)(.*)$/);
  if (namedMatch) {
    const name = namedMatch[1];
    let expr = namedMatch[2].trim();
    
    // If the expression opens a brace, the body is the whole {…} span,
    // including text on the line that closes it.
    if (expr.startsWith('{')) {
      expr = stripInvariantExpr(braceInner(lines, startIndex));
    } else {
      // No braces, but might still be multiline (forall spanning multiple lines)
      // Check if next line(s) continue the expression
      const endIdx = findBlockEnd(lines, startIndex + 1, startBraceCount);
      const innerLines = lines.slice(startIndex + 1, endIdx).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));
      if (innerLines.length > 0) {
        expr = expr + ' ' + innerLines.join(' ');
      }
    }

    return { type: 'constraint', name, expr: expr.trim() };
  }

  // Quoted-name form: `constraint "name" { ... }` or `constraint "name" : expr`
  if (quotedMatch) {
    const name = quotedMatch[1];
    const followsBrace = quotedMatch[2] === '{';
    let expr = quotedMatch[3].trim();
    if (followsBrace) {
      if (expr.startsWith('{')) expr = expr.substring(1).trim();
      // Single-line form: the braces balance on the header line itself
      // (`constraint "name" { true }`) - the block walk below would overrun
      // into later members (their content leaks in as constraint expr).
      if (firstLine.endsWith('}')) {
        return { type: 'constraint', name, expr: expr.replace(/}\s*$/, '').trim() };
      }
      const endIdx = findBlockEnd(lines, startIndex + 1, startBraceCount);
      const innerLines = lines.slice(startIndex + 1, endIdx).map(l => l.trim()).filter(l => l && !l.startsWith('//') && l !== '}');
      const inner = innerLines.join(' ');
      expr = (expr + ' ' + inner).trim();
    }
    return { type: 'constraint', name, expr: expr.trim() };
  }

  // `constraint Name { expr }` — same brace span as a named invariant.
  const bareBrace = firstLine.match(/^constraint\s+(\w+)\s*\{/);
  if (bareBrace) {
    return { type: 'constraint', name: bareBrace[1], expr: stripInvariantExpr(braceInner(lines, startIndex)) };
  }

  return null;
}

/** Split on commas while respecting parenthesized groups and quoted strings */
export function splitFields(s: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let inDouble = false;
  let inSingle = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (inDouble || inSingle) continue;
    if (ch === '(' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === '}') { depth--; continue; }
    if (ch === ',' && depth === 0) {
      result.push(s.substring(start, i).trim());
      start = i + 1;
    }
  }
  const last = s.substring(start).trim();
  if (last) result.push(last);
  return result;
}

/**
 * `component` partitions only drove the Elm composite-app backend, which was
 * removed. Reject the block instead of silently ignoring it.
 */
export function componentRemoved(line: string, index?: number): Error {
  const at = index === undefined ? '' : ` at line ${index + 1}`;
  return new Error(`Parse error${at}: component blocks are no longer supported ("${line}")`);
}

/** Strip a trailing `//` line comment (next: lines hold only identifiers). */
