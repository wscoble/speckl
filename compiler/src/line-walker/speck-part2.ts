import { BOMNode, MemberNode, ProvenanceClause, StateNode, StateVar } from './speck-part0.js';
import { braceCounts, findBlockEnd, maskCode } from './speck-part1.js';
import { componentRemoved, parseConstraintBlockMultiline, parseVerifyBlockMultiline } from './speck-part7.js';
import { parseActionBlockMultiline, parseEventBlockMultiline } from './speck-part5.js';
import { parseActionHeader, parseAuthor, parseDerives, parseEvent, parseInitBlock, parseInterface, parseOneof, parseSatisfies, parseSource, parseTransition, parseTypeExpr } from './speck-part3.js';
import { parseAgentBlockMultiline } from './speck-part8.js';
import { parseInitBlockMultiline, parseInvariantBlockMultiline, parseStateBlockMultiline } from './speck-part4.js';
import { parseInterfaceBlockMultiline, parseOneofBlockMultiline, parseServiceBlockMultiline, parseTransitionBlockMultiline } from './speck-part6.js';

export function parseMemberBlock(lines: string[], startIndex: number, actionNames: Set<string>): MemberNode | null {
  const firstLine = lines[startIndex].trim();
  const startBraceCount = braceCounts(firstLine).open;
  
  if (firstLine.startsWith('state:')) {
    return parseStateBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('state {') || firstLine === 'state') {
    return parseStateBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('state as ')) {
    // Cycle 63: `state as <MessageName> { ... }` form must dispatch
    // through the same state-block parser so the `as` override on the
    // first line is captured.
    return parseStateBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('init:')) {
    return parseInitBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('init {') || firstLine === 'init') {
    return parseInitBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('action ')) {
    return parseActionBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('invariant ')) {
    return parseInvariantBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('component ')) throw componentRemoved(firstLine, startIndex);
  if (firstLine.startsWith('event ')) {
    return parseEventBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('interface ')) {
    return parseInterfaceBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('type ')) {
    // `type X = { ... }` is a record type alias. We synthesize a header
    // of the form `interface X { ... }` so the existing interface parser
    // handles it. The '=' sign and surrounding whitespace are stripped.
    // This is a pre-existing gap: the existing parser only recognizes
    // `interface X { ... }`, not `type X = { ... }`, but the OAuth example
    // and other specs use the latter. We bridge the gap here.
    const eqMatch = firstLine.match(/^type\s+(\w+)\s*=\s*(.*)$/);
    if (eqMatch) {
      const aliasName = eqMatch[1];
      const rest = eqMatch[2].trim();
      // Replace the line with the interface form so parseInterfaceBlockMultiline
      // can do its job. The `rest` may be empty (block starts on next line) or
      // contain the opening brace.
      const syntheticLine = rest
        ? `interface ${aliasName} ${rest}`
        : `interface ${aliasName} {`;
      const synthetic = [...lines];
      synthetic[startIndex] = syntheticLine;
      return parseInterfaceBlockMultiline(synthetic, startIndex, startBraceCount);
    }
  }
  if (firstLine.startsWith('oneof ')) {
    return parseOneofBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('transition ')) {
    return parseTransitionBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('service ')) {
    return parseServiceBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('agent ') || firstLine === 'agent' || firstLine.startsWith('agent {')) {
    return parseAgentBlockMultiline(lines, startIndex, startBraceCount, actionNames);
  }
  if (firstLine.startsWith('provenance ')) {
    // Parse the provenance block body. Each clause is one of:
    //   `regulation "name" :: "note"`
    //   `design_decision "name" :: "note"`
    //   `parent_spec "name"`
    //   `external_doc "name" :: "url"`
    // The block may also be empty (clauses: []).
    const endIdx = findBlockEnd(lines, startIndex + 1, startBraceCount);
    const innerLines = lines.slice(startIndex + 1, endIdx)
      .map((l: string) => l.trim())
      .filter((l: string) => l && !l.startsWith('//') && l !== '}');
    const clauses: ProvenanceClause[] = [];
    for (const line of innerLines) {
      const m = line.match(/^(regulation|design_decision|parent_spec|external_doc)\s+"([^"]+)"\s*(?:::)?\s*(?:"([^"]*)")?/);
      if (m) {
        const clause: ProvenanceClause = {
          type: m[1] as 'regulation' | 'design_decision' | 'parent_spec' | 'external_doc',
          value: m[2],
        };
        if (m[3]) clause.location = m[3];
        clauses.push(clause);
      }
    }
    return { type: 'provenance', clauses };
  }
  if (firstLine.startsWith('bom ')) {
    // Parse the bom block body. The body has a mix of:
    //   `compiler { name: "x", version: "y" }`  (braced form)
    //   `compiler: "x" version "y"`              (colon-quote form, used by RetryHandler.speckdl)
    //   `solver { name: "x", version: "y" }`
    //   `runtime { name: "x", version: "y" }`
    //   `license: "MIT"`
    const endIdx = findBlockEnd(lines, startIndex + 1, startBraceCount);
    const innerText = lines.slice(startIndex + 1, endIdx)
      .map((l: string) => l.trim())
      .filter((l: string) => l && !l.startsWith('//') && l !== '}')
      .join(' ');
    const bom: BOMNode = { type: 'bom' };
    // Try braced form first: compiler { name: "x", version: "y" }
    const compMatch = innerText.match(/compiler\s*\{\s*name:\s*"([^"]+)"(?:\s*,\s*version:\s*"([^"]*)")?\s*\}/);
    if (compMatch) bom.compiler = { name: compMatch[1], version: compMatch[2] };
    else {
      // Try colon-quote form: compiler: "x" version "y"
      const compMatch2 = innerText.match(/compiler:\s*"([^"]+)"(?:\s+version\s+"([^"]*)")?/);
      if (compMatch2) bom.compiler = { name: compMatch2[1], version: compMatch2[2] };
    }
    // Try braced form for solver
    const solvMatch = innerText.match(/solver\s*\{\s*name:\s*"([^"]+)"(?:\s*,\s*version:\s*"([^"]*)")?\s*\}/);
    if (solvMatch) bom.solver = { name: solvMatch[1], version: solvMatch[2] };
    else {
      // Try colon-quote form: solver: "x" version "y"
      const solvMatch2 = innerText.match(/solver:\s*"([^"]+)"(?:\s+version\s+"([^"]*)")?/);
      if (solvMatch2) bom.solver = { name: solvMatch2[1], version: solvMatch2[2] };
    }
    // Try braced form for runtime
    const runMatch = innerText.match(/runtime\s*\{\s*name:\s*"([^"]+)"(?:\s*,\s*version:\s*"([^"]*)")?\s*\}/);
    if (runMatch) bom.runtime = { name: runMatch[1], version: runMatch[2] };
    else {
      // Try colon-quote form: runtime: "x" version "y"
      const runMatch2 = innerText.match(/runtime:\s*"([^"]+)"(?:\s+version\s+"([^"]*)")?/);
      if (runMatch2) bom.runtime = { name: runMatch2[1], version: runMatch2[2] };
    }
    const licMatch = innerText.match(/license:\s*"([^"]+)"/);
    if (licMatch) bom.license = licMatch[1];
    const hashMatch = innerText.match(/hash:\s*"([^"]+)"/);
    if (hashMatch) bom.hash = hashMatch[1];
    return bom;
  }
  if (firstLine.startsWith('verify ')) {
    return parseVerifyBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('constraint ')) {
    return parseConstraintBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('input:') || firstLine.startsWith('output:')) {
    return parseInputOutputBlock(lines, startIndex, startBraceCount);
  }

  return null;
}

/**
 * Parse a multi-line `input: { ... }` or `output: { ... }` block.
 *
 * The first line opens with `input: {` or `output: {` and the matching `}`
 * may be many lines later (with field declarations on intermediate lines).
 * We collect all lines up to the matching `}` (brace-counted) and join the
 * inner content into a single record string that `parseTypeExpr` already
 * knows how to handle.
 */
export function parseInputOutputBlock(
  lines: string[],
  startIndex: number,
  startBraceCount: number,
): MemberNode | null {
  const header = lines[startIndex].trim();
  const isInput = header.startsWith('input:');
  const kind: 'input' | 'output' = isInput ? 'input' : 'output';

  // Collect inner content lines, brace-counting across the block.
  // startBraceCount is the brace count on the header line (1 for `input: {`).
  // We need to find the line where braceCount returns to 0 (i.e. the closing `}`).
  const innerLines: string[] = [];
  let braceCount = 0;
  let i = startIndex;
  // First pass: extract inner content from header line (everything after the first `{`).
  const headerLine = lines[startIndex].trim();
  const headerNoComment = headerLine.replace(/\/\/.*$/, '').trim();
  const openIdx = headerNoComment.indexOf('{');
  if (openIdx >= 0) {
    const after = headerNoComment.substring(openIdx + 1).trim();
    if (after) innerLines.push(after);
  }
  braceCount = 1; // we're inside one `{` from the header
  i = startIndex + 1;
  while (i < lines.length && braceCount > 0) {
    const raw = lines[i];
    const stripped = raw.trim();
    // Strip line comments (//...) — they cannot be inside a type expression.
    const noComment = stripped.replace(/\/\/.*$/, '').trim();
    for (const ch of maskCode(noComment).text) {
      if (ch === '{') braceCount++;
      else if (ch === '}') braceCount--;
    }
    if (braceCount > 0 && noComment) {
      // Inside the block — keep content (skip the closing `}` line itself).
      innerLines.push(noComment);
    }
    i++;
  }

  // Join inner content with newlines; `parseTypeExpr`'s record branch
  // splits on commas and matches `name: type` pairs.
  const recordExpr = '{ ' + innerLines.join(' ') + ' }';
  const typeExpr = parseTypeExpr(recordExpr);
  return { type: kind, typeExpr };
}

export function parseMember(line: string): MemberNode | null {
  // input:
  if (line.startsWith('input:')) {
    const typeExpr = parseTypeExpr(line.substring(6).trim());
    return { type: 'input', typeExpr };
  }
  
  // output:
  if (line.startsWith('output:')) {
    const typeExpr = parseTypeExpr(line.substring(7).trim());
    return { type: 'output', typeExpr };
  }
  
  // constraint/verify lines never reach here: parseSpeck handles them
  // (parseMultiLineConstraintVerify / parseMemberBlock) before calling us.

  // interface:
  if (line.startsWith('interface ')) {
    return parseInterface(line);
  }
  
  // event:
  if (line.startsWith('event ')) {
    return parseEvent(line);
  }

  // oneof:
  if (line.startsWith('oneof ')) {
    return parseOneof(line);
  }

  // transition:
  if (line.startsWith('transition ')) {
    return parseTransition(line);
  }
  
  // provenance {
  if (line.startsWith('provenance ')) {
    return { type: 'provenance', clauses: [] };
  }
  
  // review:
  if (line.startsWith('review:')) {
    const kind = line.substring(7).trim() as 'manual' | 'auto' | 'hybrid';
    return { type: 'review', kind };
  }
  
  // derives from:
  if (line.startsWith('derives from ')) {
    return parseDerives(line);
  }
  
  // satisfies:
  if (line.startsWith('satisfies ')) {
    return parseSatisfies(line);
  }
  
  // author:
  if (line.startsWith('author:')) {
    return parseAuthor(line);
  }
  
  // source:
  if (line.startsWith('source:')) {
    return parseSource(line);
  }
  
  // state: or state {
  if (line.startsWith('state:')) {
    const varsStr = line.substring(6).trim();
    // state: { ... } - single-line form
    if (varsStr.startsWith('{') && varsStr.endsWith('}')) {
      const inner = varsStr.slice(1, -1).trim();
      return parseStateBlock(inner);
    }
    // state: { - multi-line opening (handled by parseStateMultiline)
    return { type: 'state', variables: [] };
  }
  if (line.startsWith('state {') || line === 'state') {
    // state { ... } inline or state { on its own line (handled by parseMemberBlock)
    if (line.startsWith('state {')) {
      const inner = line.substring(6).trim();
      const content = inner.startsWith('{') ? inner.slice(1).trim() : inner;
      if (content.endsWith('}')) {
        return parseStateBlock(content.slice(0, -1).trim());
      }
    }
    return { type: 'state', variables: [] };
  }

  // init: or init {
  if (line.startsWith('init:')) {
    const initStr = line.substring(5).trim();
    if (initStr.startsWith('{') && initStr.endsWith('}')) {
      const inner = initStr.slice(1, -1).trim();
      return parseInitBlock(inner);
    }
    return { type: 'init', assignments: [] };
  }
  if (line.startsWith('init {') || line === 'init') {
    // init { ... } inline
    if (line.startsWith('init {')) {
      const inner = line.substring(5).trim();
      const content = inner.startsWith('{') ? inner.slice(1).trim() : inner;
      if (content.endsWith('}')) {
        return parseInitBlock(content.slice(0, -1).trim());
      }
    }
    return { type: 'init', assignments: [] };
  }

  // action keyword
  if (line.startsWith('action ')) {
    return parseActionHeader(line);
  }

  if (line.startsWith('component ')) throw componentRemoved(line);

  // bom {
  if (line.startsWith('bom ')) {
    // Simplified - full BOM block parsing would need multi-line context
    return {
      type: 'bom',
    };
  }
  
  return null;
}

export function parseStateBlock(inner: string): StateNode {
  const variables: StateVar[] = [];
  if (!inner.trim()) return { type: 'state', variables };

  const varStrs = inner.split(/;|\n/).map(s => s.trim()).filter(Boolean);

  for (const vStr of varStrs) {
    const withDefault = vStr.match(/^(\w+)\s*:\s*(.+?)\s*:=\s*(.+)$/);
    if (withDefault) {
      // Strip trailing comments from type expression
      let typeStr = withDefault[2].trim();
      const commentIdx = typeStr.indexOf('//');
      if (commentIdx >= 0) typeStr = typeStr.substring(0, commentIdx).trim();
      // A declaration comma can survive comment stripping when a comment
      // followed it (`signals: List<Foo>, // note`); strip it so the type
      // parses as a generic, not an ident.
      typeStr = typeStr.replace(/,\s*$/, '').trim();
      variables.push({
        name: withDefault[1],
        typeExpr: parseTypeExpr(typeStr),
        defaultInit: withDefault[3].trim(),
      });
      continue;
    }
    const withoutDefault = vStr.match(/^(\w+)\s*:\s*(.+)$/);
    if (withoutDefault) {
      // Strip trailing comments from type expression
      let typeStr = withoutDefault[2].trim();
      const commentIdx = typeStr.indexOf('//');
      if (commentIdx >= 0) typeStr = typeStr.substring(0, commentIdx).trim();
      typeStr = typeStr.replace(/,\s*$/, '').trim();
      variables.push({
        name: withoutDefault[1],
        typeExpr: parseTypeExpr(typeStr),
      });
    }
  }

  return { type: 'state', variables };
}

