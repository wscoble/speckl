import { LexState, MemberNode, SpeckNode, lexProblem, lexStart } from './speck-part0.js';
import { parseMemberBlock, parseMember } from './speck-part2.js';
import { parseMultiLineConstraintVerify } from './speck-part6.js';
import { parseNextRelation } from './speck-part8.js';

export function maskCode(input: string, state: LexState = lexStart(), lineNo = 1): { text: string; state: LexState } {
  let block = state.block;
  let quote = state.quote;
  let openLine = state.openLine;
  let text = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (quote) {
      if (ch === '\\' && next !== undefined) {
        text += '  ';
        i++;
        continue;
      }
      text += ch === quote ? ch : ' ';
      if (ch === quote) { quote = null; openLine = 0; }
      continue;
    }
    if (block) {
      text += ' ';
      if (ch === '*' && next === '/') {
        text += ' ';
        i++;
        block = false;
        openLine = 0;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      text += ' '.repeat(input.length - i);
      break;
    }
    if (ch === '/' && next === '*') {
      text += '  ';
      i++;
      block = true;
      openLine = lineNo;
      continue;
    }
    if (ch === '"') {
      text += ch;
      quote = ch;
      openLine = lineNo;
      continue;
    }
    text += ch;
  }
  return { text, state: { block, quote, openLine } };
}

/** A `"` that is still open at the end of the line is an error on that line. */
export function maskLine(input: string, state: LexState, lineNo: number): { text: string; state: LexState } {
  const masked = maskCode(input, state, lineNo);
  if (masked.state.quote) throw lexProblem(masked.state.openLine, 'unterminated string');
  return masked;
}

export function braceCounts(text: string, state?: LexState): { open: number; close: number; state: LexState } {
  const masked = maskCode(text, state ?? lexStart());
  let open = 0;
  let close = 0;
  for (const ch of masked.text) {
    if (ch === '{') open++;
    else if (ch === '}') close++;
  }
  return { open, close, state: masked.state };
}

/** Lex state after consuming lines[from..endInclusive]. */
export function lexAfter(lines: string[], endInclusive: number, from = 0): LexState {
  let lex = lexStart();
  for (let k = from; k <= endInclusive && k < lines.length; k++) lex = maskLine(lines[k], lex, k + 1).state;
  return lex;
}

/** True when the next line that has code is `Name {`. Comments and blanks are skipped. */
export function nextCodeIsNamedBlock(lines: string[], from: number, lex: LexState): boolean {
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

export function parseSpeck(lines: string[], startIndex: number): SpeckNode | null {
  const headerMatch = lines[startIndex].match(/^speck\s+([\w-]+)\s*{/);
  if (!headerMatch) return null;

  const name = headerMatch[1];
  const members: MemberNode[] = [];

  // Cycle 73: refactored from static-field hack to local-object pattern.
  // Previously, proto_package / go_package / event_suffix were stored
  // on (parseSpeck as any)._protoPackage etc — static function fields
  // that leaked between parse calls. Now collected in a local metadata
  // object and spread into the return value. No reset needed because
  // the object is local to this invocation.
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

  // Resolve the orientation of tool aliases against actions in this speck,
  // including actions declared after the agent block.
  const speckEnd = findBlockEnd(lines, startIndex + 1, 1);
  const actionNames = new Set(lines.slice(startIndex + 1, speckEnd)
    .flatMap(line => { const m = line.match(/^\s*action\s+(\w+)\b/); return m ? [m[1]] : []; }));
  let i = startIndex + 1;
  let braceCount = 1;
  let speckEndLine = Math.min(lines.length, startIndex + 1);
  let lex = lexAfter(lines, startIndex, startIndex);

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
      const startLine = i + 1;
      const { node, endIndex } = parseNextRelation(lines, i);
      members.push(Object.assign(node, { startLine, endLine: endIndex + 1 }));
      speckEndLine = endIndex + 1;
      lex = lexAfter(lines, endIndex, startIndex);
      i = endIndex + 1;
      continue;
    }

    // ── Top-of-file protobuf metadata directives ────────────────
    // These attach to the SpeckNode and are NOT emitted as members.
    // Format: `key: value` (string values may be quoted or bare).
    // `author:`, `version:`, `license:` continue to be parsed as members
    // (AuthorNode, etc.) for backward compatibility with the existing
    // PROV-O / CycloneDX generators.
    // ── Top-of-file speck metadata directives ─────────────────────
  // `version:`, `author:`, `license:` attach to the SpeckNode directly.
  // (proto_package/go_package/event_suffix also go here, handled below.)
  // Format: `key: value` (string values may be quoted or bare).
  // We parse these as SpeckNode fields, not as members. The lower pass
  // also reads them via the `bom` block's compiler/license as fallback.
  // Speck-level metadata directives. These attach to the SpeckNode and
  // are NOT emitted as members. Format: `key: value` (string values may
  // be quoted or bare).
  //
  // Two regexes:
  //   1. simple form: `version: "0.1.2"`, `k8s_group: "x.y.z"`, etc.
  //      The value must not contain `<` (signature form) or `{` (block
  //      form), so the existing author/block parsers handle those.
  //   2. protobuf metadata: `proto_package`, `go_package`, `event_suffix`
  //      — also simple form, but historically tracked separately.
  //
  // The simple form is parsed first; the protobuf form below is a
  // subset of the same family but uses different field names.
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
      // Strip surrounding quotes if present
      const value = metaMatch[2].trim().replace(/^['"]|['"]$/g, '');
      if (metaMatch[1] === 'proto_package') {
        metadata.protoPackage = value;
      } else if (metaMatch[1] === 'go_package') {
        metadata.goPackage = value;
      } else if (metaMatch[1] === 'event_suffix') {
        metadata.eventSuffix = value;
      }
      i++;
      continue;
    }

    // Check for block-opening members (those that open braces on the same line)
    const blockStarters = ['state:', 'init:', 'action ', 'event ', 'provenance ', 'bom ', 'interface ',
      'state {', 'init {', 'verify ', 'constraint ', 'input:', 'output:', 'service ', 'oneof ', 'transition ',
      'state as ', 'type ', 'component ', 'invariant ', 'agent {', 'agent '];
    const isBlockStarter = blockStarters.some(s => line.startsWith(s));

    // Handle single-line metadata members that aren't block-starters:
    //   `conditions: ["Ready", "ItemsLoaded"]`
    //   `finalizers: []`
    //   `ownerReferences: true`
    //   `status: { ... }` (K8s-style status subresource)
    // These are part of the resource_lifecycle facet.
    const lifecycleLine = line.match(/^(conditions|finalizers|ownerReferences|status)\s*:/);
    if (lifecycleLine) {
      const key = lifecycleLine[1];
      const valueMatch = line.match(/^(conditions|finalizers|ownerReferences|status)\s*:\s*(.+)$/);
      if (valueMatch) {
        const value = valueMatch[2].trim();
        let parsed: any = value;
        if (value.startsWith('[') && value.endsWith(']')) {
          // String list: ["a", "b"]
          parsed = value.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        } else if (value === 'true') {
          parsed = true;
        } else if (value === 'false') {
          parsed = false;
        }
        members.push({ type: 'lifecycle_metadata', key, value: parsed } as any);
        i++;
        continue;
      }
    }

    if (isBlockStarter && openCount > 0) {
      // Multi-line block: parse it and skip to its end
      const blockStartLine = i + 1;
      const member = parseMemberBlock(lines, i, actionNames);
      if (!member && line.startsWith('verify')) throw unsupportedVerify(line, i);
      if (closeCount < openCount) {
        const endIdx = findBlockEnd(lines, i + 1, braceCount + openCount, lex);
        if (member) {
          members.push(Object.assign(member, { startLine: blockStartLine, endLine: endIdx + 1 }));
        }
        speckEndLine = endIdx + 1;
        // Skip past this block if it spans multiple lines. The lexer has to
        // follow, or a block comment inside the block stays open.
        lex = lexAfter(lines, endIdx, startIndex);
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

    // Handle constraint/verify blocks that may span multiple lines without braces
    // (e.g. constraint Name: forall r in [0..4]:, verify: always(implies(\n  ...\n)))
    if (line.startsWith('constraint ') || line.startsWith('verify ') || line.startsWith('verify:') || line.startsWith('constraint:')) {
      const member = parseMultiLineConstraintVerify(lines, i);
      if (!member && line.startsWith('verify')) throw unsupportedVerify(line, i);
      if (member) {
        const constraintStartLine = i + 1;
        // Skip past the consumed continuation lines
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
        }
        members.push(Object.assign(member, { startLine: constraintStartLine, endLine: i + 1 }));
        speckEndLine = i + 1;
      }
      i++;
      continue;
    }

    // Single-line: update brace count, then parse if still inside
    braceCount += openCount - closeCount;
    if (braceCount <= 0) {
      speckEndLine = i + 1;
      i++;
      break;
    }

    const member = parseMember(line);
    if (member) {
      members.push(Object.assign(member, { startLine: i + 1, endLine: i + 1 }));
      speckEndLine = i + 1;
    }
    i++;
  }

  return { type: 'speck', name, members,
           startLine: startIndex + 1,
           endLine: speckEndLine,
           protoPackage: metadata.protoPackage,
           goPackage: metadata.goPackage,
           eventSuffix: metadata.eventSuffix,
           version: metadata.version,
           author: metadata.author,
           license: metadata.license,
           k8sGroup: metadata.k8sGroup,
           k8sVersion: metadata.k8sVersion };
}

/**
 * A `verify` line no form recognises is an error. It used to be dropped
 * without a word, so the property was never checked and verification still
 * passed.
 */
export function unsupportedVerify(line: string, index: number): Error {
  return new Error(`Parse error at line ${index + 1}: unsupported verify form "${line}" `
    + '(use verify Always(InvariantName) { depth N }, verify "name" { expr } or verify: expr)');
}

export function findBlockEnd(lines: string[], startIndex: number, startBraceCount: number, lex: LexState = lexStart()): number {
  let braceCount = startBraceCount;
  let i = startIndex;
  while (i < lines.length) {
    // Comments and strings are not structure, on every line. That includes
    // agent advisory strings (`instruction`, `prompt tool`, `tool …
    // description`), whose text may contain `{` or `}`.
    const masked = maskLine(lines[i], lex, i + 1);
    lex = masked.state;
    for (const ch of masked.text) {
      if (ch === '{') braceCount++;
      if (ch === '}') {
        braceCount--;
        if (braceCount < startBraceCount) {
          return i;
        }
      }
    }
    i++;
  }
  if (lex.block) throw lexProblem(lex.openLine, 'unterminated block comment');
  return i;
}

// Check if an expression has balanced braces, parens, and brackets
export function isExpressionComplete(expr: string): boolean {
  let braces = 0, parens = 0, brackets = 0;
  for (const char of maskCode(expr).text) {
    if (char === '{') braces++;
    else if (char === '}') braces--;
    else if (char === '(') parens++;
    else if (char === ')') parens--;
    else if (char === '[') brackets++;
    else if (char === ']') brackets--;
  }
  return braces === 0 && parens === 0 && brackets === 0;
}

