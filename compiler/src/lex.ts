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
}

export function lexStart(): LexState {
  return { kind: 'code', openLine: 0 };
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
  if (state.kind === 'string') throw lexProblem(state.openLine, 'unterminated string');
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
      if (ch === '"') close();
      continue;
    }
    if (kind === 'block') {
      if (ch === '*' && next === '/') {
        mask += '  ';
        code += '  ';
        i++;
        close();
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
    mask += ch;
    code += ch;
  }
  return { mask, code, state: { kind, openLine } };
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
