/**
 * One comment- and string-aware scanner for every brace count.
 *
 * `"` strings, `//` comments, and block comments are not structure.
 * `'` is post-state prime notation (`n'`, `log'`), never a string quote.
 * A block comment or string that runs off the end of its line stays open
 * so the next line continues it. A block-comment close outside a comment is stray.
 */

export interface LexState {
  /** code: normal. block: inside a block comment. string: inside `"..."`. */
  kind: 'code' | 'block' | 'string';
  /** 1-based line where the open block comment or string began. 0 in code. */
  openLine: number;
  /**
   * 1-based line where a block comment closed and the next character opened
   * a string, because a `"` sat immediately against the closer. 0 otherwise.
   * The string error names that close.
   */
  commentClosedInString: number;
  /** Unmatched `{` outside strings and comments. Carried across lines. */
  braceDepth: number;
  /**
   * One entry per unmatched `{`, outermost first.
   * `if` is an `if` or `else if` body (only that closer may be followed by `else`).
   * `block` is any other header body. `expr` is a set or a record.
   */
  braceKinds: ('block' | 'expr' | 'if')[];
  /**
   * 1: a `}` that closes a block may not be followed by code.
   * -1: expression fragments, where a record brace is not a block.
   */
  closeFloor: number;
}

export function lexStart(): LexState {
  return {
    kind: 'code',
    openLine: 0,
    commentClosedInString: 0,
    braceDepth: 0,
    braceKinds: [],
    closeFloor: -1,
  };
}

/**
 * Whole-file tokens. Brace roles come from this stream, not from a regex
 * over the text in front of `{` on one line.
 */
interface Tok {
  kind: 'ident' | 'punct' | 'comment' | 'nl';
  text: string;
  line: number;
  /** 0-based index in the line the parser sees (`split('\\n')`). */
  col: number;
}

type BraceRole = 'block' | 'expr' | 'if';
type FrameKind = 'members' | 'domain' | 'stmts' | 'agent' | 'expr' | 'fields';

interface Pend {
  kw: string;
  line: number;
  kind: 'block' | 'if' | 'for';
  /** Stack depth when the keyword was seen. The body `{` sits at this depth. */
  depth: number;
  colon: boolean;
}

interface OpenFrame {
  role: BraceRole;
  header: string;
  line: number;
  col: number;
  kind: FrameKind;
  closeLine: number;
  closeCol: number;
}

export interface BraceSite {
  line: number;
  col: number;
  closeLine: number;
  closeCol: number;
  role: BraceRole;
  header: string;
}

interface FileStructure {
  errors: Map<number, string>;
  unclosedLine: number;
  sites: BraceSite[];
}

const fileStructures: FileStructure[] = [];

const MEMBER_HEADERS = new Set([
  'state', 'init', 'action', 'event', 'invariant', 'verify', 'constraint',
  'agent', 'interface', 'service', 'bom', 'provenance', 'input', 'output',
  'transition', 'component', 'oneof', 'type', 'next',
]);
const AGENT_HEADERS = new Set(['stages', 'await', 'harness']);
const COLON_BRACE = new Set(['input', 'output', 'state', 'verify', 'constraint', 'next']);
const DECL_AFTER = new Set([
  ...MEMBER_HEADERS,
  ...AGENT_HEADERS,
  'speck', 'domain', 'map', 'if', 'for',
]);

/** `{` is the operand of the token before it (a set or a record). */
function braceIntroducer(text: string | undefined): boolean {
  if (!text) return false;
  return text === ':' || text === '=' || text === ':=' || text === ','
    || text === 'in' || text === 'and' || text === 'or' || text === 'not'
    || text === 'implies' || text === 'union' || text === '->' || text === '{'
    || text === '(' || text === '['
    || text === '==' || text === '!=' || text === '>=' || text === '<='
    || text === '&&' || text === '||' || text === '+' || text === '-'
    || text === '*' || text === '/' || text === '%' || text === '<'
    || text === '>' || text === '!' || text === '&' || text === '|'
    || text === '^' || text === '\\' || text === '~' || text === '?';
}

function frameKindFor(header: string, role: BraceRole): FrameKind {
  if (role === 'expr') return 'expr';
  if (role === 'if' || header === 'action' || header === 'init' || header === 'for' || header === 'else') {
    return 'stmts';
  }
  if (header === 'speck') return 'members';
  if (header === 'domain') return 'domain';
  if (header === 'agent' || header === 'harness' || header === 'stages' || header === 'await') return 'agent';
  if (header === 'invariant' || header === 'verify' || header === 'constraint') return 'expr';
  return 'fields';
}

function acceptsHeader(frame: FrameKind | 'file', kw: string): 'block' | 'if' | 'for' | null {
  if ((frame === 'file' || frame === 'members') && (kw === 'speck' || kw === 'domain')) return 'block';
  if (frame === 'members' && MEMBER_HEADERS.has(kw)) return 'block';
  if ((frame === 'stmts' || frame === 'agent') && kw === 'if') return 'if';
  if ((frame === 'stmts' || frame === 'agent') && kw === 'for') return 'for';
  if (frame === 'agent' && AGENT_HEADERS.has(kw)) return 'block';
  if (frame === 'expr' && kw === 'if') return 'if';
  return null;
}

/** Tokenize one file. Comment and string rules match `scanLine`. */
function tokenize(source: string): Tok[] {
  const out: Tok[] = [];
  let kind: 'code' | 'block' | 'string' = 'code';
  let openLine = 0;
  let commentClosedInString = 0;
  let line = 1;
  let col = 0;
  const push = (tokKind: Tok['kind'], text: string, atLine: number, atCol: number) => {
    out.push({ kind: tokKind, text, line: atLine, col: atCol });
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '\r' && next === '\n') continue;
    if (ch === '\n') {
      if (kind === 'code') push('nl', '\n', line, col);
      line++;
      col = 0;
      continue;
    }
    if (kind === 'string') {
      if (ch === '\\' && next !== undefined && next !== '\n') {
        col += 2;
        i++;
        continue;
      }
      if (ch === '"') {
        // A finished string is a value, so `if name == "access" {` is an if.
        push('punct', 'str', line, col);
        commentClosedInString = 0;
        kind = 'code';
      }
      col++;
      continue;
    }
    if (kind === 'block') {
      if (ch === '*' && next === '/') {
        const closedInsideString = source[i - 1] === '"' && source[i + 2] === '"';
        kind = 'code';
        if (closedInsideString) commentClosedInString = line;
        col += 2;
        i++;
        continue;
      }
      col++;
      continue;
    }
    if (ch === '/' && next === '/') {
      const at = col;
      while (i < source.length && source[i] !== '\n') {
        i++;
        col++;
      }
      i--;
      push('comment', '//', line, at);
      continue;
    }
    if (ch === '/' && next === '*') {
      push('comment', '/*', line, col);
      kind = 'block';
      openLine = line;
      col += 2;
      i++;
      continue;
    }
    if (ch === '*' && next === '/') throw lexProblem(line, 'stray */');
    if (ch === '"') {
      kind = 'string';
      openLine = commentClosedInString ? commentClosedInString : line;
      if (!commentClosedInString) openLine = line;
      col++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const at = col;
      let text = ch;
      col++;
      while (i + 1 < source.length && /[A-Za-z0-9_]/.test(source[i + 1])) {
        text += source[i + 1];
        i++;
        col++;
      }
      while (source[i + 1] === "'") {
        text += "'";
        i++;
        col++;
      }
      push('ident', text, line, at);
      continue;
    }
    if (ch === ':' && next === '=') {
      push('punct', ':=', line, col);
      col += 2;
      i++;
      continue;
    }
    if (ch === '-' && next === '>') {
      push('punct', '->', line, col);
      col += 2;
      i++;
      continue;
    }
    if ((ch === '=' || ch === '!' || ch === '<' || ch === '>') && next === '=') {
      push('punct', ch + '=', line, col);
      col += 2;
      i++;
      continue;
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      push('punct', ch + next, line, col);
      col += 2;
      i++;
      continue;
    }
    if (!/\s/.test(ch)) push('punct', ch, line, col);
    col++;
  }
  if (kind === 'block') throw lexProblem(openLine, 'unterminated block comment');
  if (kind === 'string') {
    const why = commentClosedInString ? ': a block comment closed inside a string' : '';
    throw lexProblem(openLine, `unterminated string${why}`);
  }
  return out;
}

function lineRest(source: string, line: number, col: number): string {
  const lines = source.split('\n');
  return (lines[line - 1] ?? '').slice(col).replace(/\r$/, '').trim();
}

/**
 * Classify every `{` and record structural errors.
 * `else` is legal when the closer before it (comments and newlines skipped)
 * is an `if` or `else if` body, including `} } else` and a newline before
 * `else`. A colon-`if` (`if cond: a else b`) is an expression.
 */
function analyze(source: string): FileStructure {
  const tokens = tokenize(source);
  const errors = new Map<number, string>();
  const sites: BraceSite[] = [];
  const stack: OpenFrame[] = [];
  let pend: Pend | null = null;
  let paren = 0;
  let bracket = 0;
  let colonIf = 0;
  let stmtElse = false;
  let exprElse = false;
  let lastPop: OpenFrame | null = null;
  let blockClosesOnLine = 0;
  let prev: Tok | null = null;
  const record = (line: number, detail: string) => {
    if (!errors.has(line)) errors.set(line, detail);
  };
  const frameNow = (): FrameKind | 'file' => stack.length ? stack[stack.length - 1].kind : 'file';
  for (const tok of tokens) {
    if (tok.kind === 'nl') {
      blockClosesOnLine = 0;
      continue;
    }
    if (tok.kind === 'comment') continue;
    if (tok.text === '{') {
      let role: BraceRole = 'expr';
      let header = '';
      if (paren > 0 || bracket > 0 || exprElse) {
        role = 'expr';
      } else if (stmtElse && prev?.text === 'else') {
        role = 'block';
        header = 'else';
        stmtElse = false;
      } else if (braceIntroducer(prev?.text) && !(pend && !pend.colon && prev?.text === ':' && COLON_BRACE.has(pend.kw))) {
        role = 'expr';
      } else if (pend && !pend.colon && stack.length === pend.depth) {
        role = pend.kind === 'if' ? 'if' : 'block';
        header = pend.kw;
        // A member header's `{` belongs on its line (`invariant Mono` / `{`).
        // An `if` or `for` condition may break before its body brace (Raft).
        if (pend.line !== tok.line && pend.kind === 'block') record(tok.line, 'header brace is on the next line');
        pend = null;
      }
      exprElse = false;
      stack.push({
        role, header, line: tok.line, col: tok.col,
        kind: frameKindFor(header, role), closeLine: 0, closeCol: 0,
      });
      prev = tok;
      continue;
    }
    if (tok.text === '}') {
      const frame = stack.pop();
      if (frame) {
        frame.closeLine = tok.line;
        frame.closeCol = tok.col;
        sites.push({
          line: frame.line, col: frame.col, closeLine: tok.line, closeCol: tok.col,
          role: frame.role, header: frame.header,
        });
        if (frame.role === 'block' || frame.role === 'if') {
          if (blockClosesOnLine > 0 && stack.length === 0) {
            record(tok.line, `text after closing '}': ${JSON.stringify(lineRest(source, tok.line, tok.col))}`);
          }
          blockClosesOnLine++;
        }
        lastPop = frame;
      }
      prev = tok;
      continue;
    }
    if (tok.text === '(') paren++;
    else if (tok.text === ')') paren = Math.max(0, paren - 1);
    else if (tok.text === '[') bracket++;
    else if (tok.text === ']') bracket = Math.max(0, bracket - 1);
    if (tok.kind === 'ident' && tok.text === 'else') {
      // Statement `else` only follows an if-body closer. A colon-if's `else`
      // follows an expression (`if cond: {a: 1} else {a: 2}`).
      if (lastPop?.role === 'if') stmtElse = true;
      else if (lastPop?.role !== 'block' && colonIf > 0) {
        colonIf--;
        exprElse = true;
      } else {
        record(tok.line, `text after closing '}': ${JSON.stringify(lineRest(source, tok.line, tok.col))}`);
      }
      lastPop = null;
      prev = tok;
      continue;
    }
    if (lastPop && (lastPop.role === 'block' || lastPop.role === 'if') && tok.line === lastPop.closeLine) {
      record(tok.line, `text after closing '}': ${JSON.stringify(lineRest(source, tok.line, tok.col))}`);
    } else if (lastPop?.role === 'expr' && tok.line === lastPop.closeLine && tok.kind === 'ident' && DECL_AFTER.has(tok.text)) {
      record(tok.line, `text after closing '}': ${JSON.stringify(lineRest(source, tok.line, tok.col))}`);
    }
    lastPop = null;
    if (tok.text === ':' && pend && stack.length === pend.depth && paren === 0 && bracket === 0) {
      if (pend.kind === 'if' && !pend.colon) {
        pend.colon = true;
        colonIf++;
        pend = null;
      } else if (pend.kind === 'for' && !pend.colon) {
        pend = null;
      }
    }
    if (tok.kind === 'ident' && paren === 0 && bracket === 0) {
      const armed = acceptsHeader(frameNow(), tok.text);
      if (armed && tok.text !== 'else') {
        if (stmtElse && tok.text === 'if') stmtElse = false;
        pend = { kw: tok.text, line: tok.line, kind: armed, depth: stack.length, colon: false };
      }
    }
    if (tok.text === '=' && pend?.kw === 'type') pend = null;
    prev = tok;
  }
  const open = stack[stack.length - 1];
  return { errors, unclosedLine: open ? open.line : 0, sites };
}

/** Tokenize and match braces for `source`. Nested parses stack. */
export function pushFileStructure(source: string): void {
  fileStructures.push(analyze(source));
}

export function popFileStructure(): void {
  fileStructures.pop();
}

export function structureErrorOnLine(lineNo: number): Error | undefined {
  const detail = fileStructures[fileStructures.length - 1]?.errors.get(lineNo);
  return detail ? lexProblem(lineNo, detail) : undefined;
}

export function throwIfUnclosed(): void {
  const line = fileStructures[fileStructures.length - 1]?.unclosedLine ?? 0;
  if (line) throw lexProblem(line, 'unterminated block');
}

/** The `{` that opens `header` on this source line, when the file structure is active. */
export function blockBodyAt(line: number, header: string): BraceSite | undefined {
  const sites = fileStructures[fileStructures.length - 1]?.sites;
  return sites?.find(s => s.line === line && s.header === header && s.role !== 'expr');
}

/** Code after the `}` that closes a block. Comments are already blank. */
export function rejectTextAfterClose(code: string, closeAt: number, lineNo: number): void {
  const rest = code.slice(closeAt + 1).trim();
  if (rest) throw lexProblem(lineNo, `text after closing '}': ${JSON.stringify(rest)}`);
}

/** File currently being parsed, so errors can name it. Empty outside a parse. */
let parseFile = '';

export function setParseFile(file: string | undefined): void {
  parseFile = file ?? '';
}

export function lexWhere(line: number): string {
  return parseFile ? `${parseFile}:${line}` : `line ${line}`;
}

export function lexProblem(line: number, detail: string): Error {
  return new Error(`Parse error at ${lexWhere(line)}: ${detail}`);
}

export function assertLexClosed(state: LexState): void {
  if (state.kind === 'block') throw lexProblem(state.openLine, 'unterminated block comment');
  if (state.kind === 'string') {
    const why = state.commentClosedInString ? ': a block comment closed inside a string' : '';
    throw lexProblem(state.openLine, `unterminated string${why}`);
  }
}

export interface Scan {
  /** Same length as the input. Comments and string interiors are spaces. Quotes stay. */
  mask: string;
  /** Same length. Comments are spaces. String contents stay, so the text can be parsed. */
  code: string;
  state: LexState;
}

/**
 * Scan one line. `lineNo` is 1-based and is recorded when a string or
 * block comment opens. A stray block-comment close throws.
 */
export function scanLine(input: string, state: LexState = lexStart(), lineNo = 1): Scan {
  let kind = state.kind;
  let openLine = state.openLine;
  let commentClosedInString = state.commentClosedInString;
  let depth = state.braceDepth;
  const kinds = state.braceKinds.slice();
  const closeFloor = state.closeFloor;
  let mask = '';
  let code = '';
  const open = (next: 'block' | 'string') => {
    if (kind === 'code') openLine = lineNo;
    kind = next;
  };
  const close = () => {
    kind = 'code';
    openLine = 0;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (kind === 'string') {
      if (ch === '\\' && next !== undefined) {
        // `\\` is an escaped backslash, so the following `"` still closes.
        mask += '  ';
        code += ch + next;
        i++;
        continue;
      }
      mask += ch === '"' ? ch : ' ';
      code += ch;
      if (ch === '"') {
        commentClosedInString = 0;
        close();
      }
      continue;
    }
    if (kind === 'block') {
      if (ch === '*' && next === '/') {
        // A quote hard against both sides of the closer means the closer
        // sat inside what the author wrote as a string. The quote after it
        // then opens a real string. Remember the line for that error.
        const closedInsideString = input[i - 1] === '"' && input[i + 2] === '"';
        mask += '  ';
        code += '  ';
        i++;
        close();
        if (closedInsideString) commentClosedInString = lineNo;
        continue;
      }
      mask += ' ';
      code += ' ';
      continue;
    }
    if (ch === '/' && next === '/') {
      mask += ' '.repeat(input.length - i);
      code += ' '.repeat(input.length - i);
      break;
    }
    if (ch === '/' && next === '*') {
      mask += '  ';
      code += '  ';
      i++;
      open('block');
      continue;
    }
    if (ch === '*' && next === '/') {
      throw lexProblem(lineNo, 'stray */');
    }
    if (ch === '"') {
      mask += ch;
      code += ch;
      open('string');
      continue;
    }
    if (ch === '{') {
      kinds.push('block');
      depth++;
    } else if (ch === '}') {
      kinds.pop();
      depth--;
    }
    mask += ch;
    code += ch;
  }
  // Structural errors come from the whole-file brace match. Fragment scans
  // leave closeFloor at -1 and do not consult it.
  if (closeFloor >= 0) {
    const structural = structureErrorOnLine(lineNo);
    if (structural) throw structural;
  }
  return {
    mask,
    code,
    state: {
      kind,
      openLine,
      commentClosedInString,
      braceDepth: depth,
      braceKinds: kinds,
      closeFloor,
    },
  };
}

/** Drop comments. String contents, including `""` and `"\\"`, stay. */
export function stripComments(text: string): string {
  return scanLine(text).code.trim();
}

/**
 * Text between the first `{` and its matching `}` when both are on this
 * line. Null when the block does not close here. Primes do not hide braces.
 */
export function inlineBlockInner(line: string): string | null {
  const scanned = scanLine(line);
  let depth = 0;
  let started = -1;
  for (let i = 0; i < scanned.mask.length; i++) {
    const ch = scanned.mask[i];
    if (ch === '{') {
      if (depth === 0) started = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && started >= 0) return scanned.code.slice(started + 1, i).trim();
    }
  }
  return null;
}
