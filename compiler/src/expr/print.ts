// Render an expression AST back to SpeckDL-like source text. Used to label
// placeholders for forms the IR cannot represent yet, so generated output
// names what was not translated.

import type { BinaryOp, Expr } from './ast.js';

const BINOP_TEXT: Record<BinaryOp, string> = {
  eq: '==', neq: '!=', lt: '<', gt: '>', lte: '<=', gte: '>=',
  add: '+', sub: '-', mul: '*', div: '/', mod: '%',
  and: 'and', or: 'or', implies: 'implies',
  in: 'in', union: 'union', diff: '\\', notin: 'notIn', concat: '+',
};

export function exprToSource(e: Expr): string {
  switch (e.kind) {
    case 'literal':
      return e.type === 'string' ? JSON.stringify(e.value) : e.value;
    case 'ident':
      return e.name;
    case 'unary':
      return e.op === 'not' ? `not ${exprToSource(e.operand)}` : `-${exprToSource(e.operand)}`;
    case 'binary':
      return `${exprToSource(e.left)} ${BINOP_TEXT[e.op]} ${exprToSource(e.right)}`;
    case 'call':
      return `${e.callee}(${e.args.map(exprToSource).join(', ')})`;
    case 'member':
      return `${exprToSource(e.object)}.${e.property}`;
    case 'index':
      return `${exprToSource(e.object)}[${exprToSource(e.index)}]`;
    case 'if':
      return `if ${exprToSource(e.condition)}: ${exprToSource(e.thenBranch)}` +
        (e.elseBranch ? ` else ${exprToSource(e.elseBranch)}` : '');
    case 'object': {
      const parts = e.fields.map(f => `${f.key}: ${exprToSource(f.value)}`);
      if (e.spread) parts.unshift(`...${exprToSource(e.spread)}`);
      return `{ ${parts.join(', ')} }`;
    }
    case 'set':
      return `{ ${e.elements.map(exprToSource).join(', ')} }`;
    case 'map':
      return `{ ${e.entries.map(m => `${exprToSource(m.key)} -> ${exprToSource(m.value)}`).join(', ')} }`;
    case 'range':
      return `[${e.start}..${exprToSource(e.end)}]`;
    case 'parens':
      return `(${exprToSource(e.expr)})`;
    case 'unparsed':
      return e.source;
  }
}
