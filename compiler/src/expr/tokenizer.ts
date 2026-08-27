// SpeckDL Tokenizer
// Produces a token stream from SpeckDL source text.
// Used by the expression parser and statement parser.

export interface Token {
  type: TokenType;
  value: string;
  pos: number; // character offset in source
  line: number;
  col: number;
}

export enum TokenType {
  // Identifiers and literals
  IDENT = 'IDENT',
  STRING = 'STRING',
  NUMBER = 'NUMBER',
  BOOL = 'BOOL',       // true, false
  NULL = 'NULL',        // null

  // Keywords
  LET = 'LET',
  IF = 'IF',
  ELSE = 'ELSE',
  FORALL = 'FORALL',
  IN = 'IN',
  NOTIN = 'NOTIN',  // notIn keyword
  ELLIPSIS = 'ELLIPSIS',  // ...
  NOT = 'NOT',
  AND = 'AND',
  OR = 'OR',
  REQUIRE = 'REQUIRE',
  RETURN = 'RETURN',
  EMIT = 'EMIT',
  PRECONDITION = 'PRECONDITION',
  POSTCONDITION = 'POSTCONDITION',
  CONSTANT = 'CONSTANT',
  TYPE = 'TYPE',

  // Operators
  ASSIGN = 'ASSIGN',    // :=
  EQ = 'EQ',            // ==
  NEQ = 'NEQ',          // !=
  LTE = 'LTE',          // <=
  GTE = 'GTE',          // >=
  LT = 'LT',            // <
  GT = 'GT',            // >
  ADD = 'ADD',          // +
  SUB = 'SUB',          // -
  MUL = 'MUL',          // *
  DIV = 'DIV',          // /
  MOD = 'MOD',          // %

  // Delimiters
  LPAREN = 'LPAREN',    // (
  RPAREN = 'RPAREN',    // )
  LBRACE = 'LBRACE',    // {
  RBRACE = 'RBRACE',    // }
  LBRACKET = 'LBRACKET',// [
  RBRACKET = 'RBRACKET',// ]
  COLON = 'COLON',      // :
  COMMA = 'COMMA',      // ,
  SEMI = 'SEMI',        // ; — statement separator in multi-stmt lines
  DOT = 'DOT',          // .
  DOTDOT = 'DOTDOT',    // ..
  ARROW = 'ARROW',      // ->
  PIPE = 'PIPE',        // |
  DBLPIPE = 'DBLPIPE',  // ||
  BACKSLASH = 'BACKSLASH', // \
  DBLAMP = 'DBLAMP',     // &&
  AT = 'AT',            // @
  HASH = 'HASH',        // #

  // Set operations
  UNION = 'UNION',      // union keyword
  INTER = 'INTER',      // inter keyword
  DIFF = 'DIFF',        // diff keyword
  EMPTYSET = 'EMPTYSET', // emptySet keyword

  EOF = 'EOF',
}

const KEYWORDS: Record<string, TokenType> = {
  'let': TokenType.LET,
  'if': TokenType.IF,
  'else': TokenType.ELSE,
  'forall': TokenType.FORALL,
  'require': TokenType.REQUIRE,
  'return': TokenType.RETURN,
  'emit': TokenType.EMIT,
  'precondition': TokenType.PRECONDITION,
  'postcondition': TokenType.POSTCONDITION,
  'constant': TokenType.CONSTANT,
  'type': TokenType.TYPE,
  'union': TokenType.UNION,
  'inter': TokenType.INTER,
  'diff': TokenType.DIFF,
  'emptySet': TokenType.EMPTYSET,
  'notIn': TokenType.NOTIN,
  'true': TokenType.BOOL,
  'false': TokenType.BOOL,
  'null': TokenType.NULL,
};

export class Tokenizer {
  private src: string;
  private pos: number = 0;
  private line: number = 1;
  private col: number = 1;

  constructor(src: string) {
    this.src = src;
  }

  /** Tokenize the entire source and return an array of tokens (including EOF). */
  tokenize(): Token[] {
    const tokens: Token[] = [];
    let tok: Token;
    while ((tok = this.next()).type !== TokenType.EOF) {
      tokens.push(tok);
    }
    tokens.push(tok); // include EOF
    return tokens;
  }

  /** Return the next token. Returns EOF token when source is exhausted. */
  next(): Token {
    this.skipWhitespaceAndComments();

    if (this.pos >= this.src.length) {
      return this.makeToken(TokenType.EOF, '');
    }

    const ch = this.src[this.pos];

    // Two-char operators first
    if (ch === ':' && this.peek() === '=') {
      return this.advance(2, TokenType.ASSIGN, ':=');
    }
    if (ch === '=' && this.peek() === '=') {
      return this.advance(2, TokenType.EQ, '==');
    }
    if (ch === '!' && this.peek() === '=') {
      return this.advance(2, TokenType.NEQ, '!=');
    }
    if (ch === '!') {
      return this.advance(1, TokenType.NOT, '!');
    }
    if (ch === '<' && this.peek() === '=') {
      return this.advance(2, TokenType.LTE, '<=');
    }
    if (ch === '>' && this.peek() === '=') {
      return this.advance(2, TokenType.GTE, '>=');
    }
    if (ch === '-' && this.peek() === '>') {
      return this.advance(2, TokenType.ARROW, '->');
    }
    if (ch === '|' && this.peek() === '|') {
      return this.advance(2, TokenType.DBLPIPE, '||');
    }
    if (ch === '&' && this.peek() === '&') {
      return this.advance(2, TokenType.DBLAMP, '&&');
    }
    if (ch === '.' && this.peek() === '.' && this.peekAt(2) === '.') {
      return this.advance(3, TokenType.ELLIPSIS, '...');
    }
    if (ch === '.' && this.peek() === '.') {
      return this.advance(2, TokenType.DOTDOT, '..');
    }

    // Single-char operators & delimiters
    switch (ch) {
      case ':': return this.advance(1, TokenType.COLON, ':');
      case '(': return this.advance(1, TokenType.LPAREN, '(');
      case ')': return this.advance(1, TokenType.RPAREN, ')');
      case '{': return this.advance(1, TokenType.LBRACE, '{');
      case '}': return this.advance(1, TokenType.RBRACE, '}');
      case '[': return this.advance(1, TokenType.LBRACKET, '[');
      case ']': return this.advance(1, TokenType.RBRACKET, ']');
      case ',': return this.advance(1, TokenType.COMMA, ',');
      case ';': return this.advance(1, TokenType.SEMI, ';');
      case '.': return this.advance(1, TokenType.DOT, '.');
      case '|': return this.advance(1, TokenType.PIPE, '|');
      case '\\':
        // Double backslash (\\) is set difference in SpeckDL — skip the second \
        if (this.pos + 1 < this.src.length && this.src[this.pos + 1] === '\\') {
          this.pos++; this.col++; // skip second backslash
        }
        return this.advance(1, TokenType.BACKSLASH, '\\');
      case '@': return this.advance(1, TokenType.AT, '@');
      case '#': return this.advance(1, TokenType.HASH, '#');
      case '<': return this.advance(1, TokenType.LT, '<');
      case '>': return this.advance(1, TokenType.GT, '>');
      case '+': return this.advance(1, TokenType.ADD, '+');
      case '*': return this.advance(1, TokenType.MUL, '*');
      case '%': return this.advance(1, TokenType.MOD, '%');
    }

    // - can be minus or start of a negative number
    if (ch === '-') {
      if (this.isDigit(this.peek())) {
        return this.readNumber();
      }
      return this.advance(1, TokenType.SUB, '-');
    }
    // / can be division or start of a comment
    if (ch === '/') {
      return this.advance(1, TokenType.DIV, '/');
    }

    // Strings
    if (ch === '"') {
      return this.readString('"');
    }
    if (ch === "'") {
      return this.readString("'");
    }

    // Numbers
    if (this.isDigit(ch)) {
      return this.readNumber();
    }

    // Identifiers and keywords
    if (this.isIdentStart(ch)) {
      return this.readIdent();
    }

    // Unknown character — skip and warn
    console.warn(`Tokenizer: unexpected character '${ch}' at ${this.line}:${this.col}`);
    return this.advance(1, TokenType.EOF, ch);
  }

  /** Peek at the next token without consuming it (used by parser). */
  peekToken(): Token {
    const savedPos = this.pos;
    const savedLine = this.line;
    const savedCol = this.col;
    const tok = this.next();
    this.pos = savedPos;
    this.line = savedLine;
    this.col = savedCol;
    return tok;
  }

  // --- Private helpers ---

  private peek(): string {
    if (this.pos + 1 >= this.src.length) return '\0';
    return this.src[this.pos + 1];
  }

  private peekAt(offset: number): string {
    if (this.pos + offset >= this.src.length) return '\0';
    return this.src[this.pos + offset];
  }

  private advance(len: number, type: TokenType, value: string): Token {
    const token = this.makeToken(type, value);
    this.pos += len;
    this.col += len;
    return token;
  }

  private makeToken(type: TokenType, value: string): Token {
    return { type, value, pos: this.pos, line: this.line, col: this.col };
  }

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];

      // Whitespace
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        this.pos++; this.col++;
        continue;
      }
      if (ch === '\n') {
        this.pos++; this.line++; this.col = 1;
        continue;
      }

      // Line comments: //
      if (ch === '/' && this.peek() === '/') {
        this.pos += 2; this.col += 2;
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') {
          this.pos++; this.col++;
        }
        continue;
      }

      // Block comments: /* ... */
      if (ch === '/' && this.peek() === '*') {
        this.pos += 2; this.col += 2;
        while (this.pos < this.src.length) {
          if (this.src[this.pos] === '*' && this.peek() === '/') {
            this.pos += 2; this.col += 2;
            break;
          }
          if (this.src[this.pos] === '\n') {
            this.line++; this.col = 1;
          } else {
            this.col++;
          }
          this.pos++;
        }
        continue;
      }

      break;
    }
  }

  private isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
  }

  private isIdentStart(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
  }

  private isIdentPart(ch: string): boolean {
    return this.isIdentStart(ch) || this.isDigit(ch);
  }

  private readNumber(): Token {
    const start = this.pos;
    let value = '';
    // Handle leading minus
    if (this.src[this.pos] === '-') {
      value += '-';
      this.pos++; this.col++;
    }
    while (this.pos < this.src.length && this.isDigit(this.src[this.pos])) {
      value += this.src[this.pos];
      this.pos++; this.col++;
    }
    // Decimal part
    if (this.pos < this.src.length && this.src[this.pos] === '.' && this.isDigit(this.peek())) {
      value += '.';
      this.pos++; this.col++;
      while (this.pos < this.src.length && this.isDigit(this.src[this.pos])) {
        value += this.src[this.pos];
        this.pos++; this.col++;
      }
    }
    return this.makeToken(TokenType.NUMBER, value);
  }

  private readString(quote: string): Token {
    const startPos = this.pos;
    // Skip opening quote
    this.pos++; this.col++;
    let value = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '\\') {
        this.pos++; this.col++;
        if (this.pos < this.src.length) {
          const escaped = this.src[this.pos];
          value += '\\' + escaped;
          this.pos++; this.col++;
        }
        continue;
      }
      if (ch === quote) {
        this.pos++; this.col++; // skip closing quote
        return this.makeToken(TokenType.STRING, value);
      }
      if (ch === '\n') {
        console.warn(`Tokenizer: unclosed string starting at line ${this.line}`);
        return this.makeToken(TokenType.STRING, value);
      }
      value += ch;
      this.pos++; this.col++;
    }
    return this.makeToken(TokenType.STRING, value);
  }

  private readIdent(): Token {
    const startPos = this.pos;
    let value = '';
    while (this.pos < this.src.length && this.isIdentPart(this.src[this.pos])) {
      value += this.src[this.pos];
      this.pos++; this.col++;
    }
    // Check for keywords
    const keyword = KEYWORDS[value];
    if (keyword) {
      return { type: keyword, value, pos: startPos, line: this.line, col: this.col - value.length };
    }
    return { type: TokenType.IDENT, value, pos: startPos, line: this.line, col: this.col - value.length };
  }
}

/** Convenience: tokenize a string in one call. */
export function tokenize(src: string): Token[] {
  return new Tokenizer(src).tokenize();
}
