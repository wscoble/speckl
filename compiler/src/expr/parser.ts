// SpeckDL Expression Parser
// Recursive-descent + Pratt parser for SpeckDL expressions.
// Takes a token stream and produces an Expr AST.

import { TokenType, tokenize, Token as TokenT, Tokenizer } from './tokenizer.js';
import {
  Expr, BinaryOp, LiteralExpr, IdentExpr, UnaryExpr, BinaryExpr,
  CallExpr, MemberExpr, IndexExpr, IfExpr, ObjectExpr, SetExpr,
  MapExpr, RangeExpr, ParenthesizedExpr
} from './ast.js';

// --- Precedence (higher = binds tighter) ---

const PREC = {
  LOWEST: 0,
  LOGICAL: 1,    // or, and, ||, &&
  EQUALITY: 2,   // ==, !=
  COMPARISON: 3, // <, >, <=, >=
  SET: 4,        // in, notIn
  ADDITIVE: 5,   // +, -, union, \
  MULTIPLY: 6,   // *, /, %
  PREFIX: 7,     // not, -
  POSTFIX: 8,    // f(), x.y, x[y]
} as const;

/** Get operator precedence. Handles both symbol tokens and ident-based keywords. */
function precOf(type: TokenType, value?: string): number {
  // Ident-based keywords (or, and, in, not, union)
  if (type === TokenType.IDENT) {
    switch (value) {
      case 'or': case 'and': return PREC.LOGICAL;
      case 'in': case 'notIn': return PREC.SET;
      case 'not': return PREC.PREFIX;
      case 'union': return PREC.ADDITIVE;
    }
  }
  switch (type) {
    case TokenType.DBLPIPE: case TokenType.DBLAMP: return PREC.LOGICAL;
    case TokenType.EQ: case TokenType.NEQ: return PREC.EQUALITY;
    case TokenType.LT: case TokenType.GT:
    case TokenType.LTE: case TokenType.GTE: return PREC.COMPARISON;
    case TokenType.NOTIN: return PREC.SET;
    case TokenType.ADD: case TokenType.SUB:
    case TokenType.UNION: case TokenType.BACKSLASH: return PREC.ADDITIVE;
    case TokenType.MUL: case TokenType.DIV: case TokenType.MOD: return PREC.MULTIPLY;
    case TokenType.LPAREN: case TokenType.DOT:
    case TokenType.LBRACKET: return PREC.POSTFIX;
    default: return PREC.LOWEST;
  }
}

/** Map token type + value to binary operator name. */
function binOp(type: TokenType, value?: string): BinaryOp | null {
  if (type === TokenType.IDENT) {
    switch (value) {
      case 'or': return 'or';
      case 'and': return 'and';
      case 'in': return 'in';
      case 'notIn': return 'notin';
      case 'union': return 'union';
    }
  }
  switch (type) {
    case TokenType.EQ: return 'eq';
    case TokenType.NEQ: return 'neq';
    case TokenType.LT: return 'lt';
    case TokenType.GT: return 'gt';
    case TokenType.LTE: return 'lte';
    case TokenType.GTE: return 'gte';
    case TokenType.ADD: return 'add';
    case TokenType.SUB: return 'sub';
    case TokenType.MUL: return 'mul';
    case TokenType.DIV: return 'div';
    case TokenType.MOD: return 'mod';
    case TokenType.DBLPIPE: return 'or';
    case TokenType.DBLAMP: return 'and';
    case TokenType.BACKSLASH: return 'diff';
    case TokenType.UNION: return 'union';
    case TokenType.NOTIN: return 'notin';
    default: return null;
  }
}

export class ExpressionParser {
  private tokens: TokenT[];
  private pos: number = 0;

  constructor(tokens: TokenT[]) {
    this.tokens = tokens;
  }

  parse(): Expr {
    return this.expr(PREC.LOWEST);
  }

  /** Parse expression with given minimum precedence. */
  private expr(minPrec: number): Expr {
    const tok = this.advance();
    let left = this.prefix(tok);

    while (this.pos < this.tokens.length) {
      const peek = this.current();
      const p = precOf(peek.type, peek.value);
      if (p <= minPrec) break;
      // COLON only used inside if-expr (handled in prefix) — stop here
      if (peek.type === TokenType.COLON) break;
      const opTok = this.advance();
      left = this.infix(left, opTok);
    }

    return left;
  }

  // --- Prefix parsers ---

  private prefix(tok: TokenT): Expr {
    switch (tok.type) {
      case TokenType.IDENT:
      case TokenType.TYPE:
      case TokenType.FORALL:
      case TokenType.CONSTANT:
        return this.identOrCall(tok);
      case TokenType.NUMBER:
        return { kind: 'literal', type: 'number', value: tok.value, token: tok } as LiteralExpr;
      case TokenType.STRING:
        return { kind: 'literal', type: 'string', value: tok.value, token: tok } as LiteralExpr;
      case TokenType.BOOL:
        return { kind: 'literal', type: 'bool', value: tok.value, token: tok } as LiteralExpr;
      case TokenType.NULL:
        return { kind: 'literal', type: 'null', value: 'null', token: tok } as LiteralExpr;
      case TokenType.NOT:
        return { kind: 'unary', op: 'not', operand: this.expr(PREC.PREFIX), token: tok } as UnaryExpr;
      case TokenType.SUB:
        return { kind: 'unary', op: 'neg', operand: this.expr(PREC.PREFIX), token: tok } as UnaryExpr;
      case TokenType.IF:
        return this.parseIf(tok);
      case TokenType.LBRACE:
        return this.parseBrace(tok);
      case TokenType.LBRACKET:
        return this.parseBracket(tok);
      case TokenType.LPAREN:
        return this.parseParens(tok);
      case TokenType.EMPTYSET:
        return { kind: 'call', callee: 'emptySet', args: [], token: tok } as CallExpr;
      default:
        throw new Error(`Unexpected token '${tok.value}' (${tok.type}) at ${tok.line}:${tok.col}`);
    }
  }

  private identOrCall(tok: TokenT): Expr {
    // "not" as unary prefix keyword (when not followed by . or ()
    if (tok.value === 'not' && this.current().type !== TokenType.LPAREN && this.current().type !== TokenType.DOT) {
      return { kind: 'unary', op: 'not', operand: this.expr(PREC.PREFIX), token: tok } as UnaryExpr;
    }
    // Function call: ident(
    if (this.current().type === TokenType.LPAREN) {
      const lp = this.advance();
      return this.parseCallWithCallee(tok, lp);
    }
    return { kind: 'ident', name: tok.value, token: tok } as IdentExpr;
  }

  // --- Infix parsers ---

  private infix(left: Expr, opTok: TokenT): Expr {
    const p = precOf(opTok.type, opTok.value);

    switch (opTok.type) {
      case TokenType.LPAREN:
        return this.parseCallWithCallee((left as IdentExpr).token, opTok);
      case TokenType.DOT:
        return this.parseMember(left, opTok);
      case TokenType.LBRACKET:
        return this.parseIndex(left, opTok);
      default: {
        // Binary operator (symbol or ident-based keyword)
        const op = binOp(opTok.type, opTok.value);
        if (!op) throw new Error(`Not an infix operator: ${opTok.type} '${opTok.value}'`);
        const right = this.expr(p);
        return { kind: 'binary', op, left, right, token: opTok } as BinaryExpr;
      }
    }
  }

  // --- Specific parsers ---

  private parseIf(ifTok: TokenT): IfExpr {
    const condition = this.expr(PREC.LOWEST);
    this.expect(TokenType.COLON, 'Expected : after if condition');
    const thenBranch = this.expr(PREC.LOWEST);
    let elseBranch: Expr | null = null;
    if (this.current().type === TokenType.ELSE) {
      this.advance();
      elseBranch = this.expr(PREC.LOWEST);
    }
    return { kind: 'if', condition, thenBranch, elseBranch, token: ifTok };
  }

  private parseBrace(openTok: TokenT): Expr {
    if (this.current().type === TokenType.RBRACE) {
      this.advance();
      return { kind: 'set', elements: [], token: openTok } as SetExpr;
    }

    const first = this.expr(PREC.LOWEST);

    // Map literal: key -> val
    if (this.current().type === TokenType.ARROW) {
      this.advance();
      const val = this.expr(PREC.LOWEST);
      const entries = [{ key: first, value: val }];
      while (this.current().type === TokenType.COMMA) {
        this.advance();
        if (this.current().type === TokenType.RBRACE) break;
        const k = this.expr(PREC.LOWEST);
        this.expect(TokenType.ARROW, 'Expected -> in map literal');
        const v = this.expr(PREC.LOWEST);
        entries.push({ key: k, value: v });
      }
      this.expect(TokenType.RBRACE, 'Expected }');
      return { kind: 'map', entries, token: openTok } as MapExpr;
    }

    // Object literal: ident: val
    if (first.kind === 'ident' && this.current().type === TokenType.COLON) {
      this.advance();
      const val = this.expr(PREC.LOWEST);
      const fields = [{ key: (first as IdentExpr).name, value: val }];
      while (this.current().type === TokenType.COMMA) {
        this.advance();
        if (this.current().type === TokenType.RBRACE) break;
        const keyTok = this.expect(TokenType.IDENT, 'Expected field name');
        this.expect(TokenType.COLON, 'Expected :');
        const v = this.expr(PREC.LOWEST);
        fields.push({ key: keyTok.value, value: v });
      }
      this.expect(TokenType.RBRACE, 'Expected }');
      return { kind: 'object', fields, token: openTok } as ObjectExpr;
    }

    // Set literal: expr, expr, ...
    const elements = [first];
    while (this.current().type === TokenType.COMMA) {
      this.advance();
      if (this.current().type === TokenType.RBRACE) break;
      elements.push(this.expr(PREC.LOWEST));
    }
    this.expect(TokenType.RBRACE, 'Expected }');
    return { kind: 'set', elements, token: openTok } as SetExpr;
  }

  private parseBracket(openTok: TokenT): Expr {
    const first = this.expr(PREC.LOWEST);

    // Range: [start..end]
    if (this.current().type === TokenType.DOTDOT) {
      this.advance();
      const startNum = first.kind === 'literal' && first.type === 'number'
        ? parseInt((first as LiteralExpr).value) : 0;
      const end = this.expr(PREC.LOWEST);
      this.expect(TokenType.RBRACKET, 'Expected ]');
      return { kind: 'range', start: startNum, end, token: openTok } as RangeExpr;
    }

    // List: [a, b, c]
    const elements = [first];
    while (this.current().type === TokenType.COMMA) {
      this.advance();
      if (this.current().type === TokenType.RBRACKET) break;
      elements.push(this.expr(PREC.LOWEST));
    }
    this.expect(TokenType.RBRACKET, 'Expected ]');
    return { kind: 'call', callee: 'Array', args: elements, token: openTok } as CallExpr;
  }

  private parseParens(openTok: TokenT): Expr {
    const expr = this.expr(PREC.LOWEST);
    this.expect(TokenType.RPAREN, 'Expected )');
    return { kind: 'parens', expr, token: openTok } as ParenthesizedExpr;
  }

  private parseCallWithCallee(nameTok: TokenT, lpTok: TokenT): Expr {
    const callee = nameTok.value;
    const args: Expr[] = [];
    if (this.current().type !== TokenType.RPAREN) {
      args.push(this.expr(PREC.LOWEST));
      while (this.current().type === TokenType.COMMA) {
        this.advance();
        if (this.current().type === TokenType.RPAREN) break;
        args.push(this.expr(PREC.LOWEST));
      }
    }
    this.expect(TokenType.RPAREN, 'Expected )');

    const call: CallExpr = { kind: 'call', callee, args, token: nameTok };

    // Check for postfix continuation (chaining: f(x).y, f(x)[z], f(x) \ {y})
    while (this.pos < this.tokens.length) {
      const peek = this.current();
      if (peek.type === TokenType.DOT) {
        const dotTok = this.advance();
        return this.parseMember(call, dotTok);
      }
      if (peek.type === TokenType.LBRACKET) {
        const bracketTok = this.advance();
        return this.parseIndex(call, bracketTok);
      }
      const p = precOf(peek.type, peek.value);
      if (p <= PREC.LOWEST) break;
      if (peek.type === TokenType.COLON) break;
      // Infix continuation (e.g., \ operator)
      const opTok = this.advance();
      return this.infix(call, opTok);
    }
    return call;
  }

  private parseMember(obj: Expr, dotTok: TokenT): Expr {
    const propTok = this.expect(TokenType.IDENT, 'Expected property name after .');
    const member: MemberExpr = {
      kind: 'member', object: obj, property: propTok.value, token: dotTok
    };
    // Chain: x.y.z() or x.y[z]
    while (this.pos < this.tokens.length) {
      const peek = this.current();
      if (peek.type === TokenType.DOT) {
        const d = this.advance();
        return this.parseMember(member, d);
      }
      if (peek.type === TokenType.LBRACKET) {
        const b = this.advance();
        return this.parseIndex(member, b);
      }
      if (peek.type === TokenType.LPAREN) {
        const lp = this.advance();
        // Method call: x.y(args) — wrap as call with member as callee
        const args: Expr[] = [];
        if (this.current().type !== TokenType.RPAREN) {
          args.push(this.expr(PREC.LOWEST));
          while (this.current().type === TokenType.COMMA) {
            this.advance();
            if (this.current().type === TokenType.RPAREN) break;
            args.push(this.expr(PREC.LOWEST));
          }
        }
        this.expect(TokenType.RPAREN, 'Expected )');
        // Return as a method call on the member
        const methodCall: CallExpr = {
          kind: 'call', callee: `${propTok.value}()`, args: [obj, ...args], token: dotTok
        };
        // Actually, for TS generation we want: obj.prop(args)
        // Let's represent this as a call with the member expression as the callee
        // For now, keep it as a member + separate call representation
        return { kind: 'call', callee: propTok.value, args: [obj, ...args], token: dotTok } as CallExpr;
      }
      break;
    }
    return member;
  }

  private parseIndex(obj: Expr, bracketTok: TokenT): Expr {
    const idx = this.expr(PREC.LOWEST);
    this.expect(TokenType.RBRACKET, 'Expected ]');
    const index: IndexExpr = {
      kind: 'index', object: obj, index: idx, token: bracketTok
    };
    // Chain: x[y].z or x[y][z]
    while (this.pos < this.tokens.length) {
      const peek = this.current();
      if (peek.type === TokenType.DOT) {
        const d = this.advance();
        return this.parseMember(index, d);
      }
      if (peek.type === TokenType.LBRACKET) {
        const b = this.advance();
        return this.parseIndex(index, b);
      }
      break;
    }
    return index;
  }

  // --- Helpers ---

  private current(): TokenT {
    return this.pos < this.tokens.length
      ? this.tokens[this.pos]
      : { type: TokenType.EOF, value: '', pos: 0, line: 0, col: 0 };
  }

  private advance(): TokenT {
    const tok = this.current();
    if (this.pos < this.tokens.length) this.pos++;
    return tok;
  }

  private expect(type: TokenType, msg?: string): TokenT {
    const tok = this.current();
    if (tok.type !== type) {
      throw new Error(msg || `Expected ${type} but got ${tok.type} ('${tok.value}') at ${tok.line}:${tok.col}`);
    }
    return this.advance();
  }
}

/** Parse a single SpeckDL expression string to AST. */
export function parseExpression(src: string): Expr {
  const tokens = new Tokenizer(src).tokenize();
  return new ExpressionParser(tokens).parse();
}