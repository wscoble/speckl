// SpeckDL Statement AST
// Typed statement nodes with parsed expression subtrees.

import { Expr } from './ast.js';

// --- Action statement types ---

export type ActionStatement =
  | AssignStmt
  | LetStmt
  | RequireStmt
  | PreconditionStmt
  | PostconditionStmt
  | EmitStmt
  | ReturnStmt
  | IfBlockStmt;

export interface AssignStmt {
  type: 'assign';
  target: AssignTarget;
  expr: Expr;
}

/** Target of an assignment: plain ident or map[x] bracket access. */
export type AssignTarget =
  | { kind: 'plain'; name: string }
  | { kind: 'map_index'; mapName: string; index: Expr };

export interface LetStmt {
  type: 'let';
  name: string;
  expr: Expr;
}

export interface RequireStmt {
  type: 'require';
  expr: Expr;
}

export interface PreconditionStmt {
  type: 'precondition';
  expr: Expr;
}

export interface PostconditionStmt {
  type: 'postcondition';
  expr: Expr;
}

export interface EmitStmt {
  type: 'emit';
  event: string;
  fields: { name: string; value: Expr }[];
}

export interface ReturnStmt {
  type: 'return';
  expr: Expr;
}

/** Incomplete if/else block — preserved as raw text for manual handling. */
export interface IfBlockStmt {
  type: 'ifblock';
  raw: string;
  // Future: properly parsed conditional block
}
