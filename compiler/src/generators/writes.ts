// Which actions can write machine state, for the rollback every target
// wraps around such actions (TypeScript, Rust, Go, Camel): a writing action
// saves the state it can reach and restores it if the action fails.
//
// The rule is structural: an assignment, an emit, or a statement the
// generator could not read writes, at any nesting depth; so does any
// expression that calls something not known to be a pure read (a method
// such as `seen.add(x)`, or a domain function). Guards, lets and returns
// over pure expressions only read.
import type { IRExpr, IRStmt } from '../ir/types.js';

/** Method names that only read their receiver. */
export const PURE_METHODS = new Set([
  'has', 'get', 'contains', 'containsKey', 'keys', 'values', 'entries', 'size', 'length', 'len', 'length',
  'includes', 'indexOf', 'some', 'every', 'filter', 'map', 'find', 'slice', 'concat', 'toString',
  'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase', 'trim', 'split', 'join', 'count', 'sum',
  'min', 'max', 'abs', 'floor', 'ceil', 'round', 'isEmpty', 'first', 'last',
]);

/** Free functions the generators translate to pure expressions. */
export const PURE_FUNCTIONS = new Set([
  'len', 'min', 'max', 'abs', 'floor', 'ceil', 'round', 'sum', 'count', 'now', 'size', 'contains',
  'keys', 'values', 'isEmpty', 'append', 'concat', 'old', 'not', 'and', 'or', 'has', 'str', 'int',
  'emptyMap', 'emptySet', 'emptyList', 'empty', 'implies', 'length', 'iff', 'xor',
]);

/** True if `e` calls a function or method that is not a known pure read. */
export function irExprMayWrite(e: IRExpr | undefined): boolean {
  if (!e || typeof e !== 'object') return false;
  switch (e.kind) {
    case 'call': {
      const parts = e.fn.split('.');
      const name = parts[parts.length - 1];
      const pure = parts.length > 1 ? PURE_METHODS.has(name) : PURE_FUNCTIONS.has(name) || PURE_METHODS.has(name);
      return !pure || e.args.some(irExprMayWrite);
    }
    case 'binop': return irExprMayWrite(e.left) || irExprMayWrite(e.right);
    case 'unop': return irExprMayWrite(e.operand);
    case 'field': return irExprMayWrite(e.target);
    case 'index': return irExprMayWrite(e.target) || irExprMayWrite(e.index);
    default: return false;
  }
}

/** True if running the IR statements `stmts` can change machine state. */
export function irStmtsWrite(stmts: IRStmt[]): boolean {
  return stmts.some((s) => {
    if (s.raw !== undefined) return true;
    switch (s.kind) {
      case 'let': case 'require': case 'precondition': case 'postcondition': case 'return':
        return irExprMayWrite(s.value) || irExprMayWrite(s.expr);
      case 'if':
        return irExprMayWrite(s.expr) || irStmtsWrite(s.thenBlock ?? []) || irStmtsWrite(s.elseBlock ?? []);
      default:
        return true;
    }
  });
}
