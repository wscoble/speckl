// SpeckDL parser. `lexSpeck` produces one token stream for the file.
//
// Brace matching uses that stream, so a `{` or `}` inside a comment or a
// string is not structure. A block that opens and closes on its header
// line takes its phrase body from that brace span. A multi-line block ends
// at the matching token brace; the phrase parser then reads the source
// lines in between. The member phrases themselves (action statements,
// field lists, constraints) are still parsed from that source text.
//
// After the walk, token depth must be 0 at each speck's close and at EOF.
// A line that starts with `/*` and still has tokens is an error: that code
// would otherwise be skipped with every later member.

import {
  AST, SpeckNode, MemberNode, ImportNode,
  lexStart, maskLine, lexProblem,
  parseImportStatement, parseMember, parseMemberBlock, stripInvariantExpr,
  parseMultiLineConstraintVerify, expressionSpanEnd, unsupportedVerify, parseNextRelation,
} from './parser.js';
import { SpeckToken, lexSpeck, parseErrorAt } from './speck-lex.js';

const BLOCK_STARTERS = [
  'state:', 'init:', 'action ', 'event ', 'provenance ', 'bom ', 'interface ',
  'state {', 'init {', 'verify ', 'constraint ', 'input:', 'output:', 'service ', 'oneof ', 'transition ',
  'state as ', 'type ', 'component ', 'invariant ', 'agent {', 'agent ',
];

export function parseSpeckDocument(content: string, filePath?: string): AST {
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  rejectBareCr(content, filePath);
  const lexed = lexSpeck(content, filePath);
  const lines = content.split('\n');
  const byLine = bucketByLine(lexed.tokens);
  assertNoCodeAfterBlockComment(lines, byLine, filePath);
  // A header glued to a comment closer is reported before brace depth, which
  // would otherwise see the header's `{` as an unclosed brace.
  if (lexed.headerAfterComment.length > 0) {
    throw lexProblem(lexed.headerAfterComment[0], 'header is not at the start of the line');
  }
  assertBraceStructure(lexed.tokens, filePath);
  assertImportNotInBlock(lexed.tokens, filePath);
  const specks: SpeckNode[] = [];
  const fileImports: ImportNode[] = [];
  const headerLines = new Set(lexed.headerAfterComment);
  let coveredUntil = 0;
  let i = 0;
  let lex = lexStart();

  while (i < lines.length) {
    const masked = maskLine(lines[i], lex, i + 1);
    lex = masked.state;
    const line = lines[i].trim();
    const code = masked.text.trim();

    if (headerLines.has(i + 1)) {
      throw lexProblem(i + 1, 'header is not at the start of the line');
    }

    if (!line || !code || line.startsWith('//') || (line.startsWith('/*') && !code.startsWith('import '))) {
      i++;
      continue;
    }

    if (firstTokenIs(byLine, i + 1, 'import')) {
      if (i < coveredUntil) {
        i++;
        continue;
      }
      if (!/^import\b/.test(line)) {
        throw lexProblem(i + 1, `Failed to parse import statement: ${line}`);
      }
      try {
        fileImports.push(parseImportStatement(line));
      } catch (e) {
        throw lexProblem(i + 1, (e as Error).message);
      }
      i++;
      continue;
    }

    if (code === 'speck' && nextCodeIsNamedBlock(lines, i + 1, lex)) {
      throw lexProblem(i + 1, 'speck name must be on the same line as "speck"');
    }

    if (/^speck\s+\S/.test(line) && /^speck\s+\S/.test(code)) {
      const speck = parseSpeck(content, lines, lexed.tokens, byLine, i, filePath);
      if (!speck) {
        throw parseErrorAt(filePath, i + 1, columnOf(lines[i]), `unrecognized top-level "${line}"`);
      }
      specks.push(speck);
      coveredUntil = Math.max(coveredUntil, speck.endLine ?? i + 1);
      // endLine is 1-based, so it is the index of the line after the speck.
      // Walk the lex state through the speck, including a comment opened on its close.
      const endIdx = (speck.endLine ?? (i + 1)) - 1;
      lex = lexThrough(lines, i + 1, endIdx, lex);
      i = endIdx + 1;
      continue;
    }

    throw parseErrorAt(filePath, i + 1, columnOf(lines[i]), `unrecognized top-level "${line}"`);
  }

  assertParsedSpeckHeaders(lexed.tokens, specks, filePath);
  const ast: AST = { specks };
  if (fileImports.length > 0) ast.imports = fileImports;
  return ast;
}

/**
 * Parse the speck whose header is `lines[start]`. Member boundaries come
 * from the token stream. Returns null when the header is not `speck Name {`.
 */
function parseSpeck(content: string, lines: string[], tokens: SpeckToken[], byLine: SpeckToken[][], start: number, filePath?: string): SpeckNode | null {
  const headerMatch = lines[start].match(/^speck\s+([\w-]+)\s*{/);
  if (!headerMatch) return null;

  const name = headerMatch[1];
  const members: MemberNode[] = [];
  const metadata: {
    protoPackage?: string;
    goPackage?: string;
    eventSuffix?: string;
    version?: string;
    author?: string;
    license?: string;
    k8sGroup?: string;
    k8sVersion?: string;
  } = {};

  let i = start + 1;
  let braceCount = 1;
  let speckEndLine = Math.min(lines.length, start + 1);
  let lex = maskLine(lines[start], lexStart(), start + 1).state;

  while (i < lines.length && braceCount > 0) {
    const rawLine = lines[i];
    const masked = maskLine(rawLine, lex, i + 1);
    lex = masked.state;
    const line = rawLine.trim();
    const counts = bracesOnLine(byLine, i + 1);
    const openCount = counts.open;
    const closeCount = counts.close;

    if (!line || !masked.text.trim() || line.startsWith('//') || line.startsWith('/*')) {
      i++;
      continue;
    }

    if (firstTokenIs(byLine, i + 1, 'import')) {
      if (!/^import\b/.test(line)) throw lexProblem(i + 1, `Failed to parse import statement: ${line}`);
      let node: ImportNode;
      try {
        node = parseImportStatement(line);
      } catch (e) {
        throw lexProblem(i + 1, (e as Error).message);
      }
      members.push(Object.assign(node, { startLine: i + 1, endLine: i + 1 }));
      i++;
      continue;
    }

    if (line.startsWith('next:')) {
      const startLine = i + 1;
      const { node, endIndex } = parseNextRelation(lines, i);
      members.push(Object.assign(node, { startLine, endLine: endIndex + 1 }));
      speckEndLine = endIndex + 1;
      lex = lexThrough(lines, i + 1, endIndex, lex);
      i = endIndex + 1;
      continue;
    }

    const speckMetaMatch = line.match(/^(version|author|license|k8s_group|k8s_version)\s*:\s*([^{<]+)$/);
    if (speckMetaMatch) {
      const value = speckMetaMatch[2].trim().replace(/^['"]|['"]$/g, '');
      const key = speckMetaMatch[1];
      if (key === 'version') metadata.version = value;
      else if (key === 'author') metadata.author = value;
      else if (key === 'license') metadata.license = value;
      else if (key === 'k8s_group') metadata.k8sGroup = value;
      else if (key === 'k8s_version') metadata.k8sVersion = value;
      i++;
      continue;
    }

    const metaMatch = line.match(/^(proto_package|go_package|event_suffix)\s*:\s*(.+)$/);
    if (metaMatch) {
      const value = metaMatch[2].trim().replace(/^['"]|['"]$/g, '');
      if (metaMatch[1] === 'proto_package') metadata.protoPackage = value;
      else if (metaMatch[1] === 'go_package') metadata.goPackage = value;
      else if (metaMatch[1] === 'event_suffix') metadata.eventSuffix = value;
      i++;
      continue;
    }

    const isBlockStarter = BLOCK_STARTERS.some(s => line.startsWith(s));

    const lifecycleLine = line.match(/^(conditions|finalizers|ownerReferences|status)\s*:/);
    if (lifecycleLine) {
      const key = lifecycleLine[1];
      const valueMatch = line.match(/^(conditions|finalizers|ownerReferences|status)\s*:\s*(.+)$/);
      if (valueMatch) {
        const value = valueMatch[2].trim();
        let parsedValue: string | boolean | string[] = value;
        if (value.startsWith('[') && value.endsWith(']')) {
          parsedValue = value.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        } else if (value === 'true') {
          parsedValue = true;
        } else if (value === 'false') {
          parsedValue = false;
        }
        members.push({ type: 'lifecycle_metadata', key, value: parsedValue });
        i++;
        continue;
      }
    }

    if (isBlockStarter && openCount > 0) {
      const blockStartLine = i + 1;
      const open = (byLine[i + 1] ?? []).find(t => t.kind === '{');
      const close = open ? matchingClose(tokens, open) : undefined;
      if (close) {
        const after = (byLine[close.line] ?? []).filter(t => t.start >= close.end);
        if (after.length > 0) {
          throw parseErrorAt(filePath, after[0].line, after[0].column, 'text after a member\'s "}"');
        }
      }
      const member = parseMemberAt(lines, i);
      if (member && member.type === 'invariant' && open && close) {
        const expr = stripInvariantExpr(content.slice(open.end, close.start));
        if (!expr) throw parseErrorAt(filePath, open.line, open.column, 'invariant expression is empty');
        member.expr = expr;
      }
      if (!member && line.startsWith('verify')) throw unsupportedVerify(line, i);
      if (!member) rejectUnparsed(filePath, rawLine, i + 1, line);
      if (closeCount < openCount) {
        const endIdx = blockEndLine(byLine, i + 1, braceCount + openCount, lines.length);
        if (member) {
          members.push(Object.assign(member, { startLine: blockStartLine, endLine: endIdx + 1 }));
        }
        speckEndLine = endIdx + 1;
        lex = lexThrough(lines, i + 1, endIdx, lex);
        i = endIdx + 1;
      } else {
        if (member) {
          members.push(Object.assign(member, { startLine: blockStartLine, endLine: blockStartLine }));
        }
        speckEndLine = i + 1;
        i++;
      }
      continue;
    }

    if (line.startsWith('constraint ') || line.startsWith('verify ') || line.startsWith('verify:') || line.startsWith('constraint:')) {
      const member = parseMultiLineConstraintVerify(lines, i);
      if (!member && line.startsWith('verify')) throw unsupportedVerify(line, i);
      if (!member) {
        if (openingBraceOnNextLine(lines, i)) rejectBraceOnNextLine(filePath, rawLine, i + 1);
        rejectUnparsed(filePath, rawLine, i + 1, line);
      }
      // The expression parser already took its continuation lines. Anything
      // after that span is the next member, or an error. Do not skip ahead
      // to the next keyword: that dropped valid actions and misspellings.
      const endIdx = expressionSpanEnd(lines, i);
      members.push(Object.assign(member!, { startLine: i + 1, endLine: endIdx + 1 }));
      speckEndLine = endIdx + 1;
      lex = lexThrough(lines, i + 1, endIdx, lex);
      i = endIdx + 1;
      continue;
    }

    braceCount += openCount - closeCount;
    if (braceCount <= 0) {
      speckEndLine = i + 1;
      i++;
      break;
    }

    // `type Name = ...` is not stored on the AST (the printer says so).
    // Every other non-blank, non-comment line here is a member or an error.
    if (/^type\s+\S/.test(line) && !line.includes('{')) {
      if (openingBraceOnNextLine(lines, i)) rejectBraceOnNextLine(filePath, rawLine, i + 1);
      const rhs = line.replace(/^type\s+\S+\s*=\s*/, '');
      if (!/^[A-Za-z_]\w*(\s*(?:<[^<>]*>|\([^()]*\)))?(\s*\|\s*[A-Za-z_]\w*(\s*(?:<[^<>]*>|\([^()]*\)))?)*$/.test(rhs.replace(/\/\/.*$/, '').trim())) {
        rejectUnparsed(filePath, rawLine, i + 1, line);
      }
      i++;
      continue;
    }
    if (openingBraceOnNextLine(lines, i) && !line.includes('{')) {
      rejectBraceOnNextLine(filePath, rawLine, i + 1);
    }
    const member = parseMember(line);
    if (!member) rejectUnparsed(filePath, rawLine, i + 1, line);
    members.push(Object.assign(member, { startLine: i + 1, endLine: i + 1 }));
    speckEndLine = i + 1;
    i++;
  }

  return {
    type: 'speck', name, members,
    startLine: start + 1,
    endLine: speckEndLine,
    protoPackage: metadata.protoPackage,
    goPackage: metadata.goPackage,
    eventSuffix: metadata.eventSuffix,
    version: metadata.version,
    author: metadata.author,
    license: metadata.license,
    k8sGroup: metadata.k8sGroup,
    k8sVersion: metadata.k8sVersion,
  };
}

/**
 * A block member. `parseMemberBlock` reads the phrase. The caller found the
 * block's end from tokens, so a later member is not part of this span.
 */
function parseMemberAt(lines: string[], start: number): MemberNode | null {
  return parseMemberBlock(lines, start);
}

function columnOf(raw: string): number {
  const lead = /^\s*/.exec(raw);
  return (lead ? lead[0].length : 0) + 1;
}

/** Next line that is not blank and not a comment. `-1` at EOF. */
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

function openingBraceOnNextLine(lines: string[], index: number): boolean {
  const n = nextCodeLine(lines, index + 1);
  return n >= 0 && lines[n].trim().startsWith('{');
}

function rejectUnparsed(file: string | undefined, raw: string, lineNo: number, trimmed: string): never {
  throw parseErrorAt(file, lineNo, columnOf(raw), `unrecognized member "${trimmed}"`);
}

function rejectBraceOnNextLine(file: string | undefined, raw: string, lineNo: number): never {
  throw parseErrorAt(file, lineNo, columnOf(raw), 'opening "{" must be on the same line as the member header');
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
  for (let i = at + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === '{') depth++;
    else if (t.kind === '}') {
      depth--;
      if (depth === 0) return t;
    }
  }
  return undefined;
}

function bracesOnLine(byLine: SpeckToken[][], line: number): { open: number; close: number } {
  let open = 0;
  let close = 0;
  for (const t of byLine[line] ?? []) {
    if (t.kind === '{') open++;
    else if (t.kind === '}') close++;
  }
  return { open, close };
}

/**
 * Line index of the `}` that brings the running brace count below
 * `startCount`. `startIndex` is the 0-based header line; the scan starts
 * on the next line, at that line's bucket, so it does not rescan earlier tokens.
 */
function blockEndLine(byLine: SpeckToken[][], startIndex: number, startCount: number, lineCount: number): number {
  let count = startCount;
  for (let line = startIndex + 1; line <= lineCount; line++) {
    for (const t of byLine[line] ?? []) {
      if (t.kind === '{') count++;
      else if (t.kind === '}') {
        count--;
        if (count < startCount) return t.line - 1;
      }
    }
  }
  return lineCount;
}

/** A `\r` that is not part of `\r\n` is a CR-only line ending. Members on those "lines" would be one line and dropped. */
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

/**
 * A line whose first code is a block-comment opener is skipped as a comment.
 * Tokens on that line are code after the closer, which the skip would drop
 * along with every later member.
 */
function firstTokenIs(byLine: SpeckToken[][], line: number, text: string): boolean {
  const t = byLine[line]?.[0];
  return t?.kind === 'ident' && t.text === text;
}

function assertNoCodeAfterBlockComment(lines: string[], byLine: SpeckToken[][], file?: string): void {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('/*')) continue;
    const tokens = byLine[i + 1] ?? [];
    if (tokens.length === 0) continue;
    // An import glued to a comment closer is reported as a bad import.
    if (tokens[0].kind === 'ident' && tokens[0].text === 'import') continue;
    throw parseErrorAt(file, i + 1, tokens[0].column, 'code after */ on a line that starts with /*');
  }
}

/** An `import` token is legal at file level (depth 0) and as a speck member (depth 1). */
function assertImportNotInBlock(tokens: SpeckToken[], file?: string): void {
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === '{') { depth++; continue; }
    if (t.kind === '}') { depth = Math.max(0, depth - 1); continue; }
    if (t.kind === 'ident' && t.text === 'import' && depth > 1) {
      const next = tokens[tokens.indexOf(t) + 1];
      // `import: Nat` is a field. An import statement is `import` followed by a string.
      if (next?.kind === 'string') {
        throw parseErrorAt(file, t.line, t.column, 'import is inside a block');
      }
    }
  }
}

/**
 * Brace depth is the token stream. It must return to 0 at the end of each
 * speck and at EOF. A `}` past that, text on the close line, or a second
 * `speck` on that line is an error.
 */
/**
 * A `speck` token at brace depth 0 that did not become a speck was skipped
 * (a non-ASCII space in `speck A {`, or a header the line walk did not see).
 */
function assertParsedSpeckHeaders(tokens: SpeckToken[], specks: SpeckNode[], file?: string): void {
  const starts = new Set(specks.map(s => s.startLine));
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === '{') depth++;
    else if (t.kind === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && t.kind === 'ident' && t.text === 'speck' && !starts.has(t.line)) {
      throw parseErrorAt(file, t.line, t.column, 'speck header was not parsed');
    }
  }
}

function assertBraceStructure(tokens: SpeckToken[], file?: string): void {
  let depth = 0;
  const open: SpeckToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === '{') {
      depth++;
      open.push(t);
      continue;
    }
    if (t.kind !== '}') continue;
    if (depth === 0) throw parseErrorAt(file, t.line, t.column, 'extra "}"');
    depth--;
    open.pop();
    if (depth !== 0) continue;
    const rest: SpeckToken[] = [];
    for (let j = i + 1; j < tokens.length && tokens[j].line === t.line; j++) rest.push(tokens[j]);
    if (rest.length === 0) continue;
    const next = rest[0];
    if (next.kind === 'ident' && next.text === 'speck') {
      throw parseErrorAt(file, next.line, next.column, 'a second speck on one line');
    }
    if (next.kind === '}') throw parseErrorAt(file, next.line, next.column, 'extra "}"');
    throw parseErrorAt(file, next.line, next.column, 'text after a speck\'s "}"');
  }
  if (depth > 0) {
    const unclosed = open[open.length - 1];
    throw parseErrorAt(file, unclosed.line, unclosed.column, 'missing final "}"');
  }
}

function lexThrough(lines: string[], from: number, to: number, lex: ReturnType<typeof lexStart>): ReturnType<typeof lexStart> {
  let state = lex;
  for (let k = from; k <= to && k < lines.length; k++) state = maskLine(lines[k], state, k + 1).state;
  return state;
}

function nextCodeIsNamedBlock(lines: string[], from: number, lex: ReturnType<typeof lexStart>): boolean {
  let state = lex;
  for (let j = from; j < lines.length; j++) {
    const masked = maskLine(lines[j], state, j + 1);
    state = masked.state;
    const raw = lines[j].trim();
    const code = masked.text.trim();
    if (!raw || !code || raw.startsWith('//') || raw.startsWith('/*')) continue;
    return /^[\w-]+\s*\{/.test(code);
  }
  return false;
}
