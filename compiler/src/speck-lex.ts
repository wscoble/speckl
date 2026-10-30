// File lexer for SpeckDL.
//
// One scan produces the tokens a recursive-descent parser consumes.
// Comments and strings are not tokens: a brace inside either is not
// structure. `'` is post-state prime notation (`n'`), not a string quote.
// A `"` must close on the line where it opened. Identifiers are ASCII.

export interface SpeckToken {
  kind: 'ident' | 'number' | 'string' | '{' | '}' | 'punct' | 'prime';
  text: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  start: number;
  end: number;
}

export interface SpeckLex {
  tokens: SpeckToken[];
  /** 1-based lines where a comment closer is followed by a member header. */
  headerAfterComment: number[];
}

export function parseErrorAt(file: string | undefined, line: number, column: number | undefined, detail: string): Error {
  const where = file ? `${file}:${line}` : `line ${line}`;
  const col = column !== undefined ? ` (column ${column})` : '';
  return new Error(`Parse error at ${where}: ${detail}${col}`);
}

/**
 * Tokenize `src`. Throws on an unclosed string, an unclosed block comment,
 * a non-ASCII identifier, or any other non-ASCII character outside a
 * comment or a string.
 */
export function lexSpeck(src: string, file?: string): SpeckLex {
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const tokens: SpeckToken[] = [];
  const headerAfterComment: number[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  let block = false;
  let blockLine = 0;
  let blockCol = 0;

  const bump = (n: number) => {
    i += n;
    column += n;
  };

  while (i < src.length) {
    const ch = src[i];

    if (ch === '\r') {
      bump(1);
      continue;
    }
    if (ch === '\n') {
      i++;
      line++;
      column = 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      bump(1);
      continue;
    }

    if (!block && ch === '/' && src[i + 1] === '/') {
      bump(2);
      while (i < src.length && src[i] !== '\n') bump(1);
      continue;
    }

    if (!block && ch === '/' && src[i + 1] === '*') {
      block = true;
      blockLine = line;
      blockCol = column;
      bump(2);
      continue;
    }

    if (block) {
      if (ch === '*' && src[i + 1] === '/') {
        const lineStart = src.lastIndexOf('\n', i - 1) + 1;
        const before = src.slice(lineStart, i);
        const leading = /^[ \t\r]*$/.test(before);
        bump(2);
        block = false;
        if (leading) {
          const rest = src.slice(i, src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i));
          const word = rest.match(/^[ \t\r]*(speck|action|invariant|state|init)\b/);
          if (word) headerAfterComment.push(line);
        }
        continue;
      }
      // A slash-star inside an open comment is comment text, not a nested comment.
      bump(1);
      continue;
    }

    if (ch.charCodeAt(0) > 127) {
      if (isUnicodeSpace(ch)) {
        bump(ch.length);
        continue;
      }
      if (isUnicodeIdentChar(ch)) {
        throw parseErrorAt(file, line, column, 'identifier must be ASCII');
      }
      throw parseErrorAt(file, line, column, `unexpected character ${JSON.stringify(ch)}`);
    }

    if (ch === '"') {
      const openLine = line;
      const openCol = column;
      const start = i;
      bump(1);
      let closed = false;
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') {
        if (src[i] === '\\') {
          bump(1);
          if (i < src.length && src[i] !== '\n' && src[i] !== '\r') bump(1);
          continue;
        }
        if (src[i] === '"') {
          bump(1);
          closed = true;
          break;
        }
        bump(1);
      }
      if (!closed) throw parseErrorAt(file, openLine, openCol, 'unterminated string');
      tokens.push({ kind: 'string', text: src.slice(start, i), line: openLine, column: openCol, start, end: i });
      continue;
    }

    if (ch === "'") {
      tokens.push({ kind: 'prime', text: "'", line, column, start: i, end: i + 1 });
      bump(1);
      continue;
    }

    if (ch === '{' || ch === '}') {
      tokens.push({ kind: ch, text: ch, line, column, start: i, end: i + 1 });
      bump(1);
      continue;
    }

    if (isDigit(ch)) {
      const start = i;
      const col = column;
      const ln = line;
      while (i < src.length && isDigit(src[i])) bump(1);
      if (src[i] === '.' && isDigit(src[i + 1])) {
        bump(1);
        while (i < src.length && isDigit(src[i])) bump(1);
      }
      // `9A` is an identifier that starts with a digit. `24h` and `500ms` are
      // duration suffixes and stay a number followed by a unit.
      if (isIdentStart(src[i]) && !isDurationUnit(src, i)) {
        throw parseErrorAt(file, ln, col, 'identifier must not start with a digit');
      }
      tokens.push({ kind: 'number', text: src.slice(start, i), line: ln, column: col, start, end: i });
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      const col = column;
      const ln = line;
      bump(1);
      while (i < src.length) {
        const c = src[i];
        if (c.charCodeAt(0) > 127 && isUnicodeIdentChar(c)) {
          throw parseErrorAt(file, line, column, 'identifier must be ASCII');
        }
        if (isIdentPart(c)) {
          bump(1);
          continue;
        }
        // `my-speck` and `run_tests` stay one identifier. A spaced `-` is minus.
        if (c === '-' && isIdentPart(src[i + 1])) {
          bump(1);
          continue;
        }
        break;
      }
      tokens.push({ kind: 'ident', text: src.slice(start, i), line: ln, column: col, start, end: i });
      continue;
    }

    tokens.push({ kind: 'punct', text: ch, line, column, start: i, end: i + 1 });
    bump(1);
  }

  if (block) throw parseErrorAt(file, blockLine, blockCol, 'unterminated block comment');
  return { tokens, headerAfterComment };
}

function isDurationUnit(src: string, i: number): boolean {
  if (src.startsWith('ms', i) && !isIdentPart(src[i + 2])) return true;
  const ch = src[i];
  return (ch === 'h' || ch === 'm' || ch === 's' || ch === 'd') && !isIdentPart(src[i + 1]);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string | undefined): boolean {
  return ch !== undefined && (isIdentStart(ch) || isDigit(ch));
}

function isUnicodeIdentChar(ch: string): boolean {
  return /\p{L}|\p{N}|\p{M}/u.test(ch);
}

function isUnicodeSpace(ch: string): boolean {
  return /\p{Zs}/u.test(ch);
}
