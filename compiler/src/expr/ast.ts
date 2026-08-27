// SpeckDL Expression AST nodes
// These represent parsed SpeckDL expressions as a typed tree.

import { tokenize, Token as TokenT } from './tokenizer.js';

// --- Expression nodes ---

export type Expr =
  | LiteralExpr
  | IdentExpr
  | UnaryExpr
  | BinaryExpr
  | CallExpr
  | MemberExpr
  | IndexExpr
  | IfExpr
  | ObjectExpr       // { key: val, ... }
  | SetExpr          // { elem, elem, ... }
  | MapExpr          // { key -> val, key -> val }
  | RangeExpr        // [0..N]
  | ParenthesizedExpr;

// --- Literals ---

export interface LiteralExpr {
  kind: 'literal';
  type: 'string' | 'number' | 'bool' | 'null';
  value: string;
  token: TokenT;
}

// --- Identifier ---

export interface IdentExpr {
  kind: 'ident';
  name: string;
  token: TokenT;
}

// --- Unary operators: not, - ---

export interface UnaryExpr {
  kind: 'unary';
  op: 'not' | 'neg';
  operand: Expr;
  token: TokenT;
}

// --- Binary operators ---

export type BinaryOp =
  | 'eq'    // ==
  | 'neq'   // !=
  | 'lt'    // <
  | 'gt'    // >
  | 'lte'   // <=
  | 'gte'   // >=
  | 'add'   // +
  | 'sub'   // -
  | 'mul'   // *
  | 'div'   // /
  | 'mod'   // %
  | 'and'   // and
  | 'or'    // or
  | 'in'    // in
  | 'union' // union
  | 'diff'  // \
  | 'notin' // notIn
  | 'concat'; // + for sets/lists

export interface BinaryExpr {
  kind: 'binary';
  op: BinaryOp;
  left: Expr;
  right: Expr;
  token: TokenT; // operator token
}

// --- Function calls: hash(x), length(x), size(x), etc. ---

export interface CallExpr {
  kind: 'call';
  callee: string; // function name
  args: Expr[];
  token: TokenT;
}

// --- Member access: x.field ---

export interface MemberExpr {
  kind: 'member';
  object: Expr;
  property: string;
  token: TokenT; // dot token
}

// --- Index access: x[y] ---

export interface IndexExpr {
  kind: 'index';
  object: Expr;
  index: Expr;
  token: TokenT; // [ token
}

// --- If expression: if cond: thenExpr else elseExpr ---

export interface IfExpr {
  kind: 'if';
  condition: Expr;
  thenBranch: Expr;
  elseBranch: Expr | null; // null if no else
  token: TokenT;
}

// --- Object/record literal: { key: val, ... } ---

export interface ObjectExpr {
  kind: 'object';
  fields: { key: string; value: Expr }[];
  /** Spread base: `{ ...record, field: val }` — fields override the base. */
  spread?: Expr;
  token: TokenT;
}

// --- Set literal: { elem, elem, ... } ---

export interface SetExpr {
  kind: 'set';
  elements: Expr[];
  token: TokenT;
}

// --- Map literal: { key -> val, key -> val } ---

export interface MapExpr {
  kind: 'map';
  entries: { key: Expr; value: Expr }[];
  token: TokenT;
}

// --- Range: [0..N] ---

export interface RangeExpr {
  kind: 'range';
  start: number;
  end: Expr; // identifier or number
  token: TokenT;
}

// --- Parenthesized expression ---

export interface ParenthesizedExpr {
  kind: 'parens';
  expr: Expr;
  token: TokenT;
}
