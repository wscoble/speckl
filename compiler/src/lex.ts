/**
 * Comment- and string-aware lexer. Carried from the shared scanner, then
 * extended to emit tokens. `"` strings, `//` comments, and block comments
 * are not tokens. `'` is post-state prime notation, never a string quote.
 * A string may not cross a line. A block comment may.
 *
 * Identifiers are ASCII letters, digits, and `_`. A non-ASCII character
 * where an identifier starts or continues is an error.
 * Space, tab, CR, LF, vertical tab, form feed, NBSP (U+00A0), and
 * ideographic space (U+3000) are whitespace.
 */

export interface LexState {
  kind: 'code' | 'block' | 'string';
  openLine: number;
  openCol: number;
}

export function lexStart(): LexState {
  return { kind: 'code', openLine: 0, openCol: 0 };
}

let parseFile = '';

export function setParseFile(file: string | undefined): void {
  parseFile = file ?? '';
}

export function currentParseFile(): string {
  return parseFile;
}

export function lexWhere(line: number, col?: number): string {
  const at = col ? `${line}:${col}` : `${line}`;
  return parseFile ? `${parseFile}:${at}` : `line ${at}`;
}

export function lexProblem(line: number, detail: string, col?: number): Error {
  return new Error(`Parse error at ${lexWhere(line, col)}: ${detail}`);
}

export function assertLexClosed(state: LexState): void {
  if (state.kind === 'block') throw lexProblem(state.openLine, 'unterminated block comment', state.openCol);
  if (state.kind === 'string') throw lexProblem(state.openLine, 'unterminated string', state.openCol);
}

export interface Scan {
  mask: string;
  code: string;
  state: LexState;
}

/** Scan one line. A stray block-comment close throws. */
export function scanLine(input: string, state: LexState = lexStart(), lineNo = 1): Scan {
  let kind = state.kind;
  let openLine = state.openLine;
  let openCol = state.openCol;
  let mask = '';
  let code = '';
  const open = (next: 'block' | 'string', col: number) => {
    if (kind === 'code') {
      openLine = lineNo;
      openCol = col;
    }
    kind = next;
  };
  const close = () => {
    kind = 'code';
    openLine = 0;
    openCol = 0;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (kind === 'string') {
      if (ch === '\\' && next !== undefined) {
        mask += '  ';
        code += ch + next;
        i++;
        continue;
      }
      if (ch === '\n' || ch === '\r') break;
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
      open('block', i + 1);
      continue;
    }
    if (ch === '*' && next === '/') {
      throw lexProblem(lineNo, 'stray */', i + 1);
    }
    if (ch === '"') {
      mask += ch;
      code += ch;
      open('string', i + 1);
      continue;
    }
    mask += ch;
    code += ch;
  }
  return { mask, code, state: { kind, openLine, openCol } };
}

export function stripComments(text: string): string {
  return scanLine(text).code.trim();
}

export interface Token {
  kind: 'ident' | 'number' | 'string' | 'punct' | 'indent' | 'dedent' | 'eof';
  text: string;
  line: number;
  /** 1-based column of the first character. */
  col: number;
  /** Offset into the original source. */
  start: number;
  end: number;
}

const MULTI = ['::', ':=', '==', '!=', '<=', '>=', '->', '&&', '||', '/*', '*/'];

function isWsChar(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f'
    || ch === '\u00a0' || ch === '\u3000';
}

function isAsciiIdentStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
}

function isAsciiIdentCont(ch: string): boolean {
  return isAsciiIdentStart(ch) || (ch >= '0' && ch <= '9');
}

/** A letter that is not ASCII. Digits and marks are not identifier starts. */
function isNonAsciiLetter(ch: string): boolean {
  return /\p{L}/u.test(ch) && !isAsciiIdentStart(ch);
}

/**
 * Tokens of a whole file. Comments are dropped. Indent and dedent tokens
 * follow the indentation of lines that contain code, so a colon body does
 * not need a line heuristic in the parser.
 */
export function tokenize(src: string): { tokens: Token[]; state: LexState } {
  const tokens: Token[] = [];
  const indents: number[] = [0];
  let lex = lexStart();
  let i = 0;
  let line = 1;
  let col = 1;
  let atLineStart = true;

  const push = (kind: Token['kind'], text: string, start: number, tLine: number, tCol: number) => {
    tokens.push({ kind, text, line: tLine, col: tCol, start, end: start + text.length });
  };

  while (i < src.length) {
    if (atLineStart && lex.kind === 'code') {
      let j = i;
      let indent = 0;
      let tCol = 1;
      while (j < src.length && (src[j] === ' ' || src[j] === '\t')) {
        indent += src[j] === '\t' ? 8 : 1;
        tCol++;
        j++;
      }
      if (j >= src.length || src[j] === '\n' || src[j] === '\r' || (src[j] === '/' && (src[j + 1] === '/' || src[j + 1] === '*'))) {
        // blank or comment line: do not change indentation
      } else if (lex.kind === 'code') {
        const top = indents[indents.length - 1];
        if (indent > top) {
          indents.push(indent);
          push('indent', '', j, line, tCol);
        } else if (indent < top) {
          while (indents.length > 1 && indents[indents.length - 1] > indent) {
            indents.pop();
            push('dedent', '', j, line, tCol);
          }
        }
      }
      atLineStart = false;
    }

    const ch = src[i];
    const next = src[i + 1];

    if (lex.kind === 'string') {
      if (ch === '\n' || ch === '\r') {
        throw lexProblem(lex.openLine, 'unterminated string', lex.openCol);
      }
      if (ch === '\\' && next !== undefined && next !== '\n') {
        i += 2;
        col += 2;
        continue;
      }
      i++;
      col++;
      if (ch === '"') lex = lexStart();
      continue;
    }

    if (lex.kind === 'block') {
      if (ch === '\n') { line++; col = 1; i++; atLineStart = true; continue; }
      if (ch === '\r') { i++; col++; continue; }
      if (ch === '*' && next === '/') {
        i += 2;
        col += 2;
        lex = lexStart();
        continue;
      }
      i++;
      col++;
      continue;
    }

    if (isWsChar(ch)) {
      if (ch === '\n') { line++; col = 1; atLineStart = true; }
      else col++;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { i++; col++; }
      continue;
    }
    if (ch === '/' && next === '*') {
      lex = { kind: 'block', openLine: line, openCol: col };
      i += 2;
      col += 2;
      continue;
    }
    if (ch === '*' && next === '/') {
      throw lexProblem(line, 'stray */', col);
    }
    if (ch === '"') {
      const start = i;
      const sLine = line;
      const sCol = col;
      i++;
      col++;
      let text = '"';
      lex = { kind: 'string', openLine: sLine, openCol: sCol };
      while (i < src.length && src[i] !== '"' && src[i] !== '\n' && src[i] !== '\r') {
        if (src[i] === '\\' && i + 1 < src.length && src[i + 1] !== '\n') {
          text += src[i] + src[i + 1];
          i += 2;
          col += 2;
          continue;
        }
        text += src[i];
        i++;
        col++;
      }
      if (i >= src.length || src[i] === '\n' || src[i] === '\r') {
        throw lexProblem(sLine, 'unterminated string', sCol);
      }
      text += '"';
      i++;
      col++;
      lex = lexStart();
      push('string', text, start, sLine, sCol);
      continue;
    }

    if (isNonAsciiLetter(ch)) {
      throw lexProblem(line, `identifier must be ASCII`, col);
    }
    if (isAsciiIdentStart(ch)) {
      const start = i;
      const sCol = col;
      let text = '';
      while (i < src.length && isAsciiIdentCont(src[i])) {
        text += src[i];
        i++;
        col++;
      }
      if (i < src.length && isNonAsciiLetter(src[i])) {
        throw lexProblem(line, 'identifier must be ASCII', col);
      }
      push('ident', text, start, line, sCol);
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      const start = i;
      const sCol = col;
      let text = '';
      while (i < src.length && src[i] >= '0' && src[i] <= '9') {
        text += src[i];
        i++;
        col++;
      }
      if (src[i] === '.' && src[i + 1] >= '0' && src[i + 1] <= '9') {
        text += '.';
        i++;
        col++;
        while (i < src.length && src[i] >= '0' && src[i] <= '9') {
          text += src[i];
          i++;
          col++;
        }
      }
      // duration suffix: 24h, 500ms, 1d
      if (i < src.length && isAsciiIdentStart(src[i])) {
        const suffixStart = i;
        let suffix = '';
        while (i < src.length && isAsciiIdentCont(src[i])) {
          suffix += src[i];
          i++;
          col++;
        }
        if (/^(ms|s|m|h|d)$/.test(suffix)) text += suffix;
        else { i = suffixStart; col -= suffix.length; }
      }
      push('number', text, start, line, sCol);
      continue;
    }

    const two = src.slice(i, i + 2);
    if (MULTI.includes(two) && two !== '/*' && two !== '*/') {
      push('punct', two, i, line, col);
      i += 2;
      col += 2;
      continue;
    }
    push('punct', ch, i, line, col);
    i++;
    col++;
  }

  assertLexClosed(lex);
  while (indents.length > 1) {
    indents.pop();
    push('dedent', '', src.length, line, col);
  }
  push('eof', '', src.length, line, col);
  return { tokens, state: lex };
}

/** Body between the opening `{` and its matching `}` on this line, or null. */
export function inlineActionBody(line: string): string | null {
  const scanned = scanLine(line);
  let paren = 0;
  let depth = 0;
  let started = -1;
  for (let i = 0; i < scanned.mask.length; i++) {
    const ch = scanned.mask[i];
    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (paren === 0 && ch === '{') {
      if (depth === 0) started = i;
      depth++;
    } else if (paren === 0 && ch === '}') {
      depth--;
      if (depth === 0 && started >= 0) return line.slice(started + 1, i);
    }
  }
  return null;
}
