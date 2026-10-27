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
 * What the `{` that follows `maskBefore` opens, from the header still in
 * front of it. Balanced `()`, `[]`, and `{}` are values, so a keyword
 * earlier on the line does not make a set or a record into a block.
 * `n in {1, 2}`, `{a: 1}`, `:= { ... }`, `ballots[{ ... }]`, and
 * `if cond: a else {record}` are expressions. `type Name = { ... }` is too.
 * `if` / `else if` bodies are `if`, so only their `}` may be followed by `else`.
 */
function isBlockOpen(maskBefore: string): 'expr' | 'block' | 'if' {
  let s = maskBefore.replace(/"[^"]*"/g, ' STR ');
  for (;;) {
    const n = s
      .replace(/\{[^{}]*\}/g, ' BRACE ')
      .replace(/\([^()]*\)/g, ' PAREN ')
      .replace(/\[[^\[\]]*\]/g, ' BRACK ');
    if (n === s) break;
    s = n;
  }
  // Still inside a call or an index: `Map(ClientId, {` and `ballots[{`.
  if (s.includes('[') || s.includes('(')) return 'expr';
  const cut = s.lastIndexOf('{');
  const clause = (cut >= 0 ? s.slice(cut + 1) : s).trim();
  if (!clause) return 'expr';
  // `input: {` / `output: {` keep the colon. `status: {` and `msg: {` do not.
  if (/^(?:input|output|state|verify|constraint)\s*:$/.test(clause)) return 'block';
  // The `{` is the operand, not the body: `in {`, `= {`, `if {1}`, `for x in {`.
  if (/(?:\b(?:in|and|or|not|implies|union|if|for)\b|&&|\|\||==|!=|>=|<=|:=|->|[+\-*/%<>=!&|^\\([,:.~?])\s*$/.test(clause)) {
    return 'expr';
  }
  if (/\belse\s+if\b/.test(clause)) return 'if';
  if (/^[}\s]*else$/.test(clause) || /\bBRACE\s+else$/.test(clause)) return 'block';
  if (/\belse$/.test(clause)) return 'expr';
  if (/^if\b/.test(clause)) return 'if';
  if (/^for\b/.test(clause)) return 'block';
  if (/^(?:speck|domain|state|init|action|event|invariant|verify|constraint|agent|interface|service|bom|provenance|input|output|transition|component|oneof|type|stages|await|next|harness)\b/.test(clause)) {
    return 'block';
  }
  return 'expr';
}

/**
 * `else` continues an `if` or `else if` only. A run of `}` may close blocks
 * that are still inside the speck (`n := n - 1 } }`). A `}` that steps out
 * of the speck (`false } }`) is not that run.
 */
function blockCloseRestAllowed(rest: string, depthAfter: number, kind: 'block' | 'if'): boolean {
  if (/^else\b/.test(rest)) return kind === 'if';
  if (!/^\}(?:\s*\})*$/.test(rest)) return false;
  let depth = depthAfter;
  for (const ch of rest) {
    if (ch !== '}') continue;
    depth--;
    if (depth < 1) return false;
  }
  return true;
}

/**
 * A finished set or record is not a block. Another block on that same line
 * is still a parse error (`status: { phase: n } invariant`,
 * `emit Log { ... } invariant`, `map M { a -> b } invariant`).
 */
const HEADER_AFTER_EXPR = /^(?:speck|domain|state|init|action|event|invariant|verify|constraint|agent|interface|service|bom|provenance|input|output|transition|component|oneof|type|stages|await|if|for|else|next|harness|map)\b/;

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
  const blockCloses: { at: number; depth: number; kind: 'block' | 'if' }[] = [];
  const exprCloses: number[] = [];
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
      kinds.push(isBlockOpen(mask));
      depth++;
    } else if (ch === '}') {
      const opened = kinds.pop();
      depth--;
      // Record the closer. The rest of the line is checked after comments
      // on this line have been blanked, so a trailing line comment is empty.
      if (closeFloor >= 0 && (opened === 'block' || opened === 'if')) {
        blockCloses.push({ at: i, depth, kind: opened });
      } else if (closeFloor >= 0 && opened === 'expr') {
        exprCloses.push(i);
      }
    }
    mask += ch;
    code += ch;
  }
  if (closeFloor >= 0) {
    for (const hit of blockCloses) {
      const rest = code.slice(hit.at + 1).trim();
      if (!rest || blockCloseRestAllowed(rest, hit.depth, hit.kind)) continue;
      throw lexProblem(lineNo, `text after closing '}': ${JSON.stringify(rest)}`);
    }
    for (const at of exprCloses) {
      const rest = code.slice(at + 1).trim();
      if (!rest || !HEADER_AFTER_EXPR.test(rest)) continue;
      throw lexProblem(lineNo, `text after closing '}': ${JSON.stringify(rest)}`);
    }
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
