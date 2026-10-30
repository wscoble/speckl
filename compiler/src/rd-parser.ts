// Recursive-descent parser for SpeckDL.
//
// `lexSpeck` produces the token stream. This parser consumes it: a file is
// a sequence of specks, a speck is a sequence of members, and each member
// is a function that reads the tokens of that phrase. Brace matching uses
// the token stream, so a `{` or `}` inside a comment or a string is not
// structure. Phrase bodies (action statements, field lists, agent blocks)
// are the source span of those tokens; the span is not found by scanning
// the rest of the file.

import {
  AST, SpeckNode, MemberNode,
  lexStart, maskLine, lexProblem,
  parseImportStatement, parseMember, parseMemberBlock,
  parseMultiLineConstraintVerify, unsupportedVerify, parseNextRelation,
} from './parser.js';
import { SpeckToken, lexSpeck } from './speck-lex.js';

const BLOCK_STARTERS = [
  'state:', 'init:', 'action ', 'event ', 'provenance ', 'bom ', 'interface ',
  'state {', 'init {', 'verify ', 'constraint ', 'input:', 'output:', 'service ', 'oneof ', 'transition ',
  'state as ', 'type ', 'component ', 'invariant ', 'agent {', 'agent ',
];

export function parseSpeckDocument(content: string, filePath?: string): AST {
  const lexed = lexSpeck(content, filePath);
  const lines = content.split('\n');
  const specks: SpeckNode[] = [];
  const headerLines = new Set(lexed.headerAfterComment);
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

    if (!line || !code || line.startsWith('//') || line.startsWith('/*')) {
      i++;
      continue;
    }

    if (line.startsWith('import ')) {
      // File-level imports are recognized and checked. Attaching them to a
      // speck is the import resolver's job.
      parseImportStatement(line);
      i++;
      continue;
    }

    if (code === 'speck' && nextCodeIsNamedBlock(lines, i + 1, lex)) {
      throw lexProblem(i + 1, 'speck name must be on the same line as "speck"');
    }

    if (line.startsWith('speck ') && code.startsWith('speck ')) {
      const speck = parseSpeck(lines, lexed.tokens, i);
      if (speck) specks.push(speck);
      i++;
      continue;
    }

    i++;
  }

  return { specks };
}

/**
 * Parse the speck whose header is `lines[start]`. Member boundaries come
 * from the token stream. Returns null when the header is not `speck Name {`.
 */
function parseSpeck(lines: string[], tokens: SpeckToken[], start: number): SpeckNode | null {
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
    const counts = bracesOnLine(tokens, i + 1);
    const openCount = counts.open;
    const closeCount = counts.close;

    if (!line || !masked.text.trim() || line.startsWith('//') || line.startsWith('/*')) {
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
      const member = parseMemberAt(lines, i);
      if (!member && line.startsWith('verify')) throw unsupportedVerify(line, i);
      if (closeCount < openCount) {
        const endIdx = blockEndLine(tokens, i + 1, braceCount + openCount, lines.length);
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
      if (member) {
        const constraintStartLine = i + 1;
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

function bracesOnLine(tokens: SpeckToken[], line: number): { open: number; close: number } {
  let open = 0;
  let close = 0;
  for (const t of tokens) {
    if (t.line !== line) continue;
    if (t.kind === '{') open++;
    else if (t.kind === '}') close++;
  }
  return { open, close };
}

/**
 * Line index of the `}` that brings the running brace count below
 * `startCount`, scanning tokens from the 0-based line `startIndex`.
 * Mirrors the old block walk, but the braces are tokens.
 */
function blockEndLine(tokens: SpeckToken[], startIndex: number, startCount: number, lineCount: number): number {
  let count = startCount;
  for (const t of tokens) {
    if (t.line < startIndex + 1) continue;
    if (t.kind === '{') count++;
    else if (t.kind === '}') {
      count--;
      if (count < startCount) return t.line - 1;
    }
  }
  return lineCount;
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
