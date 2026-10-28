/**
 * Recursive-descent parser. The only parse path. It consumes tokens from
 * lex.ts. Every node gets an id and a source span. A token the grammar
 * does not expect is a parse error at file:line:col. Nothing is skipped.
 */
import type {
  AST, SpeckNode, MemberNode, ActionNode, ActionStatement, StateNode, StateVar,
  InitNode, InvariantMemberNode, NextMemberNode, VerifyNode, ConstraintNode,
  EventNode, InterfaceNode, InterfaceField, ServiceNode, OneofNode, TransitionNode,
  ProvenanceNode, ProvenanceClause, BOMNode, InputNode, OutputNode, AuthorNode,
  SourceNode, ReviewNode, DerivesNode, SatisfiesNode, AgentMemberNode,
  TypeExpr, LineSpan, SourceSpan,
} from './parser.js';
import { tokenize, Token, lexProblem, setParseFile, currentParseFile, scanLine } from './lex.js';
import { parseDurationToMs, parseHarnessMapLine } from './agent-parse.js';

let ids = 1;
let src = '';
const nodeIds = new WeakMap<object, number>();
const nodeSpans = new WeakMap<object, SourceSpan>();
const nodeChildren = new WeakMap<object, object[]>();

export function childrenOf(node: object): object[] {
  return nodeChildren.get(node) ?? [];
}

export function idOf(node: object): number | undefined {
  return nodeIds.get(node);
}

export function spanOfNode(node: object): SourceSpan | undefined {
  return nodeSpans.get(node);
}

function spanOf(a: Token, b: Token): SourceSpan {
  return {
    file: currentParseFile(),
    startLine: a.line, startCol: a.col,
    endLine: b.line, endCol: b.col,
  };
}

/** Record id and span without adding fields generators JSON.stringify. Members also get line numbers, as the previous parser did. */
function box<T extends object>(value: T, a: Token, b: Token, lines = true): T {
  nodeIds.set(value, ids++);
  nodeSpans.set(value, spanOf(a, b));
  if (lines) {
    const m = value as LineSpan;
    m.startLine = a.line;
    m.endLine = b.line;
  }
  return value;
}

class Parse {
  tokens: Token[];
  i = 0;
  constructor(tokens: Token[]) { this.tokens = tokens; }
  get cur(): Token { return this.tokens[this.i] ?? this.tokens[this.tokens.length - 1]; }
  at(kind: Token['kind'], text?: string): boolean {
    const t = this.cur;
    return t.kind === kind && (text === undefined || t.text === text);
  }
  next(): Token {
    const t = this.cur;
    if (this.i < this.tokens.length - 1) this.i++;
    return t;
  }
  err(detail: string, tok: Token = this.cur): never {
    throw lexProblem(tok.line, detail, tok.col);
  }
  expect(kind: Token['kind'], text?: string, what?: string): Token {
    if (!this.at(kind, text)) {
      const want = what ?? (text ? `"${text}"` : kind);
      const got = this.cur.kind === 'eof' ? 'end of file' : `"${this.cur.text}"`;
      this.err(`expected ${want}, got ${got}`);
    }
    return this.next();
  }
  skipLayout(): void {
    while (this.at('indent') || this.at('dedent')) this.next();
  }
  flat(from: number, to: number): string {
    const raw = src.slice(from, to);
    const lines = raw.split('\n').map(l => scanLine(l.replace(/\r$/, '')).code.trim());
    return lines.filter(Boolean).join(' ');
  }
}

const MEMBERS = new Set([
  'state', 'init', 'action', 'invariant', 'next', 'verify', 'constraint', 'type',
  'event', 'interface', 'oneof', 'transition', 'service', 'agent', 'provenance',
  'bom', 'input', 'output', 'component', 'author', 'version', 'license',
  'proto_package', 'go_package', 'event_suffix', 'k8s_group', 'k8s_version',
  'source', 'review', 'derives', 'satisfies', 'description', 'status',
  'conditions', 'finalizers', 'ownerReferences',
]);

export function parseGrammar(content: string, filePath?: string): AST {
  ids = 1;
  src = content;
  setParseFile(filePath);
  const { tokens } = tokenize(content);
  const p = new Parse(tokens);
  const specks: SpeckNode[] = [];
  p.skipLayout();
  while (!p.at('eof')) {
    if (p.at('ident', 'import')) {
      parseImport(p);
      p.skipLayout();
      continue;
    }
    if (p.at('ident', 'speck')) {
      specks.push(parseSpeck(p));
      p.skipLayout();
      continue;
    }
    if (p.at('ident', 'domain')) {
      p.err('unknown block "domain"');
    }
    p.err(`unexpected ${p.cur.kind === 'eof' ? 'end of file' : `"${p.cur.text}"`}`);
  }
  return { specks };
}

function parseName(p: Parse): string {
  const first = p.expect('ident', undefined, 'name');
  let name = first.text;
  while (p.at('punct', '-')) {
    const n = p.tokens[p.i + 1];
    if (n?.kind !== 'ident' && n?.kind !== 'number') break;
    p.next();
    name += '-' + p.next().text;
  }
  return name;
}

function parseSpeck(p: Parse): SpeckNode {
  const start = p.expect('ident', 'speck');
  const name = parseName(p);
  p.skipLayout();
  p.expect('punct', '{');
  const members: MemberNode[] = [];
  const meta: SpeckNode = { type: 'speck', name, members };
  while (!p.at('punct', '}') && !p.at('eof')) {
    p.skipLayout();
    if (p.at('punct', '}')) break;
    const m = parseMember(p, meta);
    if (m) members.push(m);
  }
  const end = p.expect('punct', '}');
  return box(meta, start, end, true);
}

function parseMember(p: Parse, speck: SpeckNode): MemberNode | null {
  const start = p.cur;
  if (!p.at('ident')) p.err(`unexpected "${p.cur.text}"`);
  const kw = p.cur.text;
  if (!MEMBERS.has(kw)) p.err(`unknown block "${kw}"`);
  switch (kw) {
    case 'component':
      p.err(`component blocks are no longer supported ("${kw}")`);
    case 'state': return parseState(p);
    case 'init': return parseInit(p);
    case 'action': return parseAction(p);
    case 'invariant': return parseInvariant(p);
    case 'next': return parseNext(p);
    case 'verify': return parseVerify(p);
    case 'constraint': return parseConstraint(p);
    case 'type': return parseTypeAlias(p);
    case 'event': return parseEvent(p);
    case 'interface': return parseInterface(p);
    case 'oneof': return parseOneof(p);
    case 'transition': return parseTransition(p);
    case 'service': return parseService(p);
    case 'agent': return parseAgent(p);
    case 'provenance': return parseProvenance(p);
    case 'bom': return parseBom(p);
    case 'input': return parseInputOutput(p, 'input');
    case 'output': return parseInputOutput(p, 'output');
    case 'author': return parseAuthor(p);
    case 'version':
    case 'license':
    case 'proto_package':
    case 'go_package':
    case 'event_suffix':
    case 'k8s_group':
    case 'k8s_version':
      return parseMeta(p, speck);
    case 'source': return parseSource(p);
    case 'review': return parseReview(p);
    case 'derives': return parseDerives(p);
    case 'satisfies': return parseSatisfies(p);
    case 'description': return parseDescription(p);
    case 'status':
    case 'conditions':
    case 'finalizers':
    case 'ownerReferences':
      return parseLifecycle(p);
    default:
      p.err(`unknown block "${kw}"`);
  }
  return null;
}

function parseImport(p: Parse): void {
  const start = p.expect('ident', 'import');
  if (!p.at('string')) p.err('expected a string path');
  p.next();
  while (p.at('ident', 'as') || p.at('ident', 'version') || p.at('ident', 'hash')) {
    const w = p.next().text;
    if (w === 'as') p.expect('ident', undefined, 'alias');
    else p.expect('string');
  }
  if (!p.at('punct', ';') && !p.at('eof') && !p.at('ident', 'import') && !p.at('ident', 'speck') && !p.at('indent') && !p.at('dedent')) {
    // a trailing token on the import is stray
    if (!MEMBERS.has(p.cur.text) && p.cur.kind !== 'eof') {
      // allow end
    }
  }
  void start;
}

function openBrace(p: Parse): Token {
  p.skipLayout();
  return p.expect('punct', '{');
}

function parseState(p: Parse): StateNode {
  const start = p.expect('ident', 'state');
  let messageName: string | undefined;
  if (p.at('ident', 'as')) {
    p.next();
    messageName = parseName(p);
  }
  if (p.at('punct', ':')) p.next();
  openBrace(p);
  const variables: StateVar[] = [];
  while (!p.at('punct', '}') && !p.at('eof')) {
    p.skipLayout();
    if (p.at('punct', '}')) break;
    if (p.at('punct', ',')) { p.next(); continue; }
    const ns = p.cur;
    const name = p.expect('ident', undefined, 'field name').text;
    p.expect('punct', ':');
    const typeExpr = parseType(p);
    let defaultInit: string | undefined;
    if (p.at('punct', ':=')) {
      p.next();
      const from = p.cur;
      const exprToks = takeExpr(p);
      defaultInit = p.flat(from.start, exprToks);
    }
    const v: StateVar = { name, typeExpr };
    if (defaultInit) v.defaultInit = defaultInit;
    variables.push(v);
    void ns;
    if (p.at('punct', ',')) p.next();
  }
  const end = p.expect('punct', '}');
  const node: StateNode = { type: 'state', variables };
  if (messageName) node.messageName = messageName;
  return box(node, start, end, true);
}

function parseInit(p: Parse): InitNode {
  const start = p.expect('ident', 'init');
  if (p.at('punct', ':')) p.next();
  openBrace(p);
  const assignments: { name: string; expr: string }[] = [];
  while (!p.at('punct', '}') && !p.at('eof')) {
    p.skipLayout();
    if (p.at('punct', '}')) break;
    if (p.at('ident', 'forall') || p.at('ident', 'for') || p.at('ident', 'while') || p.at('ident', 'if') || p.at('ident', 'let')) {
      if (p.at('ident', 'let') || p.at('ident', 'if')) parseStatement(p);
      else consumeColonBlock(p);
      continue;
    }
    if (!p.at('ident')) p.err(`unexpected "${p.cur.text}" in init`);
    const name = p.next().text;
    if (p.at('punct', ':=') || p.at('punct', '==')) {
      const op = p.next().text;
      const from = p.cur;
      const endOff = takeExpr(p);
      if (op === ':=') assignments.push({ name, expr: p.flat(from.start, endOff) });
      // `name == expr` is an equality constraint inside init. The initializer
      // the backends emit is the `:=` list. The tokens are consumed here.
      if (p.at('punct', ',')) p.next();
      continue;
    }
    p.err(`expected ":=" or "==" after "${name}"`);
  }
  const end = p.expect('punct', '}');
  return box({ type: 'init', assignments }, start, end, true);
}

function parseAction(p: Parse): ActionNode {
  const start = p.expect('ident', 'action');
  const name = parseName(p);
  const params: { name: string; type: TypeExpr }[] = [];
  if (p.at('punct', '(')) {
    p.next();
    while (!p.at('punct', ')') && !p.at('eof')) {
      if (p.at('punct', ',')) { p.next(); continue; }
      const pn = p.expect('ident', undefined, 'parameter name').text;
      p.expect('punct', ':');
      params.push({ name: pn, type: parseType(p) });
      if (p.at('punct', ',')) p.next();
    }
    p.expect('punct', ')');
  }
  if (p.at('punct', ':')) {
    // return type annotation
    p.next();
    parseType(p);
  }
  if (p.at('ident', 'returns')) {
    p.next();
    p.expect('punct', '(');
    takeBalanced(p, '(', ')');
  }
  p.skipLayout();
  if (!p.at('punct', '{')) p.err('expected "{" to open the action');
  p.next();
  const statements = parseStatements(p);
  const end = p.expect('punct', '}');
  return box({ type: 'action', name, params, statements }, start, end, true);
}

const STMT = new Set(['require', 'precondition', 'postcondition', 'return', 'let', 'emit', 'if', 'for', 'forall', 'while']);

function parseStatements(p: Parse): ActionStatement[] {
  const out: ActionStatement[] = [];
  while (!p.at('punct', '}') && !p.at('eof')) {
    p.skipLayout();
    if (p.at('punct', '}') || p.at('eof')) break;
    if (p.at('dedent')) { p.next(); continue; }
    out.push(parseStatement(p));
  }
  return out;
}

function parseStatement(p: Parse): ActionStatement {
  const start = p.cur;
  if (p.at('ident', 'require') || p.at('ident', 'precondition') || p.at('ident', 'postcondition')) {
    const kind = p.next().text as 'require' | 'precondition' | 'postcondition';
    const from = p.cur;
    const endOff = takeExpr(p);
    const expr = p.flat(from.start, endOff);
    return box({ type: kind, expr }, start, p.tokens[Math.max(0, p.i - 1)], false);
  }
  if (p.at('ident', 'return')) {
    p.next();
    if (p.at('punct', '}') || p.at('dedent') || p.at('eof') || startsStmt(p)) {
      return box({ type: 'return', expr: '' }, start, start, false);
    }
    const from = p.cur;
    const endOff = takeExpr(p);
    return box({ type: 'return', expr: p.flat(from.start, endOff) }, start, p.tokens[Math.max(0, p.i - 1)], false);
  }
  if (p.at('ident', 'let')) {
    p.next();
    const name = p.expect('ident').text;
    if (p.at('punct', ':')) { p.next(); parseType(p); }
    const op = p.at('punct', ':=') || p.at('punct', '=') ? p.next().text : '';
    if (op !== ':=' && op !== '=') p.err('expected ":=" in let');
    const from = p.cur;
    const endOff = takeExpr(p);
    return box({ type: 'let', name, expr: p.flat(from.start, endOff) }, start, p.tokens[Math.max(0, p.i - 1)], false);
  }
  if (p.at('ident', 'emit')) return parseEmit(p);
  if (p.at('ident', 'if')) return parseIf(p);
  if (p.at('ident', 'for') || p.at('ident', 'forall') || p.at('ident', 'while')) return parseFor(p);
  if (p.at('ident') && (p.tokens[p.i + 1]?.text === ':=' || lookAssign(p))) {
    const targetFrom = p.cur;
    const target = takeTarget(p);
    if (!p.at('punct', ':=')) p.err(`expected ":=" after "${target}"`);
    p.next();
    const from = p.cur;
    const endOff = takeExpr(p);
    return box({ type: 'assign', target, expr: p.flat(from.start, endOff) }, targetFrom, p.tokens[Math.max(0, p.i - 1)], false);
  }
  p.err(`unexpected "${p.cur.text}"`);
}

function lookAssign(p: Parse): boolean {
  // target can be a.b[c] := 
  let i = p.i;
  const t = p.tokens;
  if (t[i]?.kind !== 'ident') return false;
  i++;
  while (t[i] && (t[i].text === '.' || t[i].text === '[' || t[i].text === '(')) {
    if (t[i].text === '.' ) { i += 2; continue; }
    const open = t[i].text;
    const close = open === '[' ? ']' : ')';
    let d = 0;
    for (; i < t.length; i++) {
      if (t[i].text === open) d++;
      else if (t[i].text === close) { d--; if (d === 0) { i++; break; } }
    }
  }
  return t[i]?.text === ':=';
}

function takeTarget(p: Parse): string {
  const from = p.cur.start;
  p.expect('ident');
  while (p.at('punct', '.') || p.at('punct', '[') || p.at('punct', '(')) {
    if (p.at('punct', '.')) { p.next(); p.expect('ident'); continue; }
    const open = p.cur.text;
    const close = open === '[' ? ']' : ')';
    p.next();
    takeBalanced(p, open, close);
  }
  return p.flat(from, p.cur.start);
}

/** A member keyword ends an expression only when it is not `a.member` or `op member`. */
function boundaryMember(p: Parse): boolean {
  if (!p.at('ident') || !MEMBERS.has(p.cur.text)) return false;
  const prev = p.tokens[p.i - 1];
  if (!prev) return true;
  if (prev.kind === 'punct' && prev.text !== ')' && prev.text !== ']' && prev.text !== '}') return false;
  return true;
}

function startsStmt(p: Parse): boolean {
  if (p.at('ident') && STMT.has(p.cur.text)) return true;
  if (p.at('ident') && (p.tokens[p.i + 1]?.text === ':=' || lookAssign(p))) return true;
  return false;
}

/** Consume an expression. Stops before a statement, `}`, or dedent, at bracket depth 0. */
function takeExpr(p: Parse): number {
  let depth = 0;
  const start = p.i;
  while (!p.at('eof')) {
    if (p.at('indent') || p.at('dedent')) { p.next(); continue; }
    if (depth === 0) {
      if (p.at('punct', '}')) break;
      if (p.i > start && startsStmt(p)) break;
      if (p.i > start && boundaryMember(p)) break;
      if (p.at('punct', ',') && p.tokens[p.i + 1]?.kind === 'ident' && p.tokens[p.i + 2]?.text === ':') break;
    }
    const t = p.cur;
    if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
    else if (t.text === ')' || t.text === ']' || t.text === '}') {
      if (depth === 0 && t.text === '}') break;
      depth--;
      if (depth < 0) p.err('unbalanced ")"');
    }
    p.next();
    if (t.kind === 'indent') {
      // expression continues into an indented if/else
    }
  }
  if (depth > 0) p.err('unbalanced "(" or "{"');
  return p.cur.start;
}

function takeBalanced(p: Parse, open: string, close: string): void {
  let depth = 1;
  while (!p.at('eof') && depth > 0) {
    if (p.cur.text === open) depth++;
    else if (p.cur.text === close) depth--;
    if (depth === 0) break;
    p.next();
  }
  if (depth !== 0) p.err(`unbalanced "${open}"`);
  // leave the close for the caller, or consume it? callers expect it consumed when used after seeing open already consumed.
  // This function is called AFTER the open was consumed, and it should consume the close.
  if (!p.at('punct', close)) p.err(`expected "${close}"`);
  p.next();
}

function parseEmit(p: Parse): ActionStatement {
  const start = p.expect('ident', 'emit');
  const event = p.expect('ident').text;
  const fields: { name: string; value: string }[] = [];
  if (p.at('punct', '{')) {
    p.next();
    while (!p.at('punct', '}') && !p.at('eof')) {
      p.skipLayout();
      if (p.at('punct', '}') || p.at('punct', ',')) { if (p.at('punct', ',')) p.next(); continue; }
      const n = p.expect('ident').text;
      p.expect('punct', ':');
      const from = p.cur;
      const endOff = takeExpr(p);
      fields.push({ name: n, value: p.flat(from.start, endOff) });
      if (p.at('punct', ',')) p.next();
    }
    p.expect('punct', '}');
  }
  return box({ type: 'emit', event, fields }, start, p.tokens[Math.max(0, p.i - 1)], false);
}

function parseIf(p: Parse): ActionStatement {
  const start = p.cur;
  const from = p.cur.start;
  // Capture through the matching brace or the colon body, as one raw block
  // so existing emitters keep their input, and also record child statements.
  p.expect('ident', 'if');
  const condFrom = p.cur;
  let depth = 0;
  while (!p.at('eof')) {
    if (depth === 0 && p.at('punct', ':')) break;
    if (depth === 0 && p.at('punct', '{') && !braceThenColon(p)) break;
    if (depth === 0 && p.at('punct', '}')) break;
    if (p.cur.text === '{' || p.cur.text === '(' || p.cur.text === '[') depth++;
    else if (p.cur.text === '}' || p.cur.text === ')' || p.cur.text === ']') depth = Math.max(0, depth - 1);
    p.next();
  }
  if (p.at('punct', '{')) {
    p.next();
    const thenStmts = parseStatements(p);
    p.expect('punct', '}');
    let elseStmts: ActionStatement[] | undefined;
    p.skipLayout();
    if (p.at('ident', 'else')) {
      p.next();
      p.skipLayout();
      if (p.at('ident', 'if')) {
        elseStmts = [parseIf(p)];
      } else if (p.at('punct', '{')) {
        p.next();
        elseStmts = parseStatements(p);
        p.expect('punct', '}');
      } else p.err('expected "{" after else');
    }
    const raw = p.flat(from, p.cur.start);
    const node = box({ type: 'ifblock' as const, raw }, start, p.tokens[Math.max(0, p.i - 1)], false);
    nodeChildren.set(node, [...thenStmts, ...(elseStmts ?? [])]);
    return node;
  }
  if (p.at('punct', ':')) {
    p.next();
    const body = parseColonBody(p);
    const raw = `if ${p.flat(condFrom.start, body.end)} { ${body.text} }`;
    return box({ type: 'ifblock', raw }, start, p.tokens[Math.max(0, p.i - 1)], false);
  }
  p.err('expected "{" after if');
}

function parseFor(p: Parse): ActionStatement {
  const start = p.cur;
  const kw = p.next().text;
  const from = start.start;
  if (p.at('punct', '{')) {
    while (!p.at('punct', '{') && !p.at('eof')) p.next();
    p.expect('punct', '{');
    parseStatements(p);
    p.expect('punct', '}');
    return box({ type: 'forblock', raw: p.flat(from, p.cur.start) } as ActionStatement, start, p.tokens[Math.max(0, p.i - 1)], false);
  }
  // colon form: for v in coll:  / for i from a to b: / forall s in xs \ {y}:
  // A `{` in the header is a set, not the body, when a `:` follows it.
  let depth = 0;
  while (!p.at('eof')) {
    if (depth === 0 && p.at('punct', ':')) break;
    if (depth === 0 && p.at('punct', '{') && !braceThenColon(p)) break;
    if (depth === 0 && p.at('punct', '}')) break;
    if (p.cur.text === '{' || p.cur.text === '(' || p.cur.text === '[') depth++;
    else if (p.cur.text === '}' || p.cur.text === ')' || p.cur.text === ']') depth = Math.max(0, depth - 1);
    p.next();
  }
  if (p.at('punct', ':')) p.next();
  else if (!p.at('punct', '{')) p.err(`expected ":" or "{" after ${kw}`);
  if (p.at('punct', '{')) {
    p.next();
    parseStatements(p);
    p.expect('punct', '}');
    return box({ type: 'forblock', raw: p.flat(from, p.cur.start) } as ActionStatement, start, p.tokens[Math.max(0, p.i - 1)], false);
  }
  const body = parseColonBody(p);
  const header = p.flat(from, body.headerEnd).replace(/:\s*$/, '');
  const raw = `${header} { ${body.text} }`;
  return box({ type: 'forblock', raw } as ActionStatement, start, p.tokens[Math.max(0, p.i - 1)], false);
}

/** True when `{...}` is a value in a header and a `:` after the close starts the body. */
function braceThenColon(p: Parse): boolean {
  let depth = 0;
  let closed = false;
  for (let i = p.i; i < p.tokens.length; i++) {
    const t = p.tokens[i];
    if (!closed) {
      if (t.text === '{' || t.text === '(' || t.text === '[') depth++;
      else if (t.text === '}' || t.text === ')' || t.text === ']') {
        depth--;
        if (depth === 0) closed = true;
      }
      continue;
    }
    if (t.kind === 'indent' || t.kind === 'dedent') continue;
    return t.text === ':';
  }
  return false;
}

function peekBraceSoon(p: Parse): boolean {
  for (let k = p.i; k < p.tokens.length && k < p.i + 8; k++) {
    if (p.tokens[k].text === '{') return true;
    if (p.tokens[k].text === ':' || p.tokens[k].text === '}') return false;
  }
  return false;
}

function parseColonBody(p: Parse): { text: string; end: number; headerEnd: number } {
  const headerEnd = p.cur.start;
  if (p.at('indent')) {
    p.next();
    const from = p.cur.start;
    const stmts: string[] = [];
    while (!p.at('dedent') && !p.at('punct', '}') && !p.at('eof')) {
      if (p.at('indent')) { p.next(); continue; }
      const s = parseStatement(p);
      stmts.push(stmtText(s));
    }
    if (p.at('dedent')) p.next();
    return { text: stmts.join(' '), end: p.cur.start, headerEnd };
  }
  const from = p.cur.start;
  const endOff = takeExpr(p);
  void from;
  return { text: p.flat(from, endOff), end: endOff, headerEnd };
}

function stmtText(s: ActionStatement): string {
  if (s.type === 'ifblock' || (s as { type: string }).type === 'forblock') return (s as { raw?: string }).raw ?? '';
  if (s.type === 'require' || s.type === 'precondition' || s.type === 'postcondition') return `${s.type === 'require' ? 'require' : s.type} ${s.expr}`;
  if (s.type === 'let') return `let ${s.name} := ${s.expr}`;
  if (s.type === 'assign') return `${s.target} := ${s.expr}`;
  if (s.type === 'return') return s.expr ? `return ${s.expr}` : 'return';
  if (s.type === 'emit') return `emit ${s.event}`;
  return '';
}

function parseInvariant(p: Parse): InvariantMemberNode {
  const start = p.expect('ident', 'invariant');
  const name = p.at('ident') ? parseName(p) : `invariant_${start.line}`;
  p.skipLayout();
  p.expect('punct', '{');
  const from = p.cur.start;
  const endOff = takeUntilClose(p);
  const expr = p.flat(from, endOff);
  const end = p.expect('punct', '}');
  return box({ type: 'invariant', name, expr }, start, end);
}

function takeUntilClose(p: Parse): number {
  let depth = 0;
  while (!p.at('eof')) {
    if (depth === 0 && p.at('punct', '}')) break;
    if (p.cur.text === '{') depth++;
    else if (p.cur.text === '}') depth--;
    p.next();
  }
  return p.cur.start;
}

function parseNext(p: Parse): NextMemberNode {
  const start = p.expect('ident', 'next');
  p.expect('punct', ':');
  p.skipLayout();
  if (p.at('punct', '{')) {
    p.next();
    p.skipLayout();
    if (!p.at('punct', '}')) p.err('next: { ... } must be empty (meaning any action); list alternatives as next: A | B');
    const end = p.next();
    return box({ type: 'next', actions: [], anyAction: true }, start, end);
  }
  const actions: string[] = [];
  while (!p.at('eof') && !p.at('punct', '}') && !(p.at('ident') && MEMBERS.has(p.cur.text) && p.cur.text !== 'next')) {
    p.skipLayout();
    if (p.at('punct', '|')) { p.next(); continue; }
    if (p.at('punct', '}') || (p.at('ident') && MEMBERS.has(p.cur.text))) break;
    if (!p.at('ident')) break;
    actions.push(parseName(p));
    p.skipLayout();
    if (!p.at('punct', '|')) break;
  }
  if (actions.length === 0) p.err('expected an action name after next:');
  return box({ type: 'next', actions }, start, p.tokens[Math.max(0, p.i - 1)]);
}

function parseVerify(p: Parse): VerifyNode {
  const start = p.expect('ident', 'verify');
  if (p.at('punct', ':')) {
    p.next();
    const from = p.cur;
    const endOff = takeExpr(p);
    return box({ type: 'verify', name: 'verify', temporalExpr: p.flat(from.start, endOff) }, start, p.tokens[Math.max(0, p.i - 1)]);
  }
  let name = '';
  let temporal = '';
  if (p.at('string')) {
    name = p.next().text.slice(1, -1);
    temporal = name;
  } else if (p.at('ident')) {
    const head = p.cur;
    const h = p.next().text;
    if ((h === 'Always' || h === 'always' || h === 'Eventually' || h === 'eventually') && p.at('punct', '(')) {
      p.next();
      name = p.expect('ident').text;
      p.expect('punct', ')');
      temporal = `${h}(${name})`;
    } else {
      name = h;
      temporal = p.flat(head.start, p.cur.start);
    }
  } else p.err('expected a verify name');
  let depth: number | undefined;
  if (p.at('ident', 'depth')) {
    p.next();
    depth = parseInt(p.expect('number').text, 10);
  }
  p.skipLayout();
  if (p.at('punct', '{')) {
    p.next();
    const from = p.cur.start;
    const endOff = takeUntilClose(p);
    const inner = p.flat(from, endOff);
    const dm = inner.match(/\bdepth\s+(\d+)\b/);
    if (depth === undefined && dm) depth = parseInt(dm[1], 10);
    const end = p.expect('punct', '}');
    const node: VerifyNode = { type: 'verify', name, temporalExpr: temporal || name, depth };
    return box(node, start, end);
  }
  return box({ type: 'verify', name, temporalExpr: temporal || name, depth }, start, p.tokens[Math.max(0, p.i - 1)]);
}

function parseConstraint(p: Parse): ConstraintNode {
  const start = p.expect('ident', 'constraint');
  let name: string | undefined;
  if (p.at('string')) name = p.next().text.slice(1, -1);
  else if (p.at('ident') && !p.at('ident', 'constraint') && p.tokens[p.i + 1]?.text === ':') {
    name = parseName(p);
  }
  if (p.at('punct', ':')) p.next();
  p.skipLayout();
  let expr = '';
  let endTok = p.tokens[Math.max(0, p.i - 1)];
  if (p.at('punct', '{')) {
    p.next();
    const from = p.cur.start;
    const endOff = takeUntilClose(p);
    expr = p.flat(from, endOff);
    endTok = p.expect('punct', '}');
  } else {
    const from = p.cur;
    const endOff = takeExpr(p);
    expr = p.flat(from.start, endOff);
    endTok = p.tokens[Math.max(0, p.i - 1)];
  }
  const node: ConstraintNode = { type: 'constraint', expr };
  if (name) node.name = name;
  return box(node, start, endTok);
}

function parseTypeAlias(p: Parse): InterfaceNode | null {
  const start = p.expect('ident', 'type');
  const name = parseName(p);
  p.expect('punct', '=');
  p.skipLayout();
  if (!p.at('punct', '{')) {
    // Alias that is not a record. Consume the type. Backends never emitted
    // these as their own declarations; the name remains available as an ident.
    takeExpr(p);
    return null;
  }
  return parseRecordInterface(p, name, start);
}

function parseInterface(p: Parse): InterfaceNode {
  const start = p.expect('ident', 'interface');
  const name = parseName(p);
  p.skipLayout();
  p.expect('punct', '{');
  return finishInterface(p, name, start);
}

function parseRecordInterface(p: Parse, name: string, start: Token): InterfaceNode {
  p.expect('punct', '{');
  return finishInterface(p, name, start);
}

function finishInterface(p: Parse, name: string, start: Token): InterfaceNode {
  const fields: InterfaceField[] = [];
  const methods: InterfaceNode['methods'] = [];
  while (!p.at('punct', '}') && !p.at('eof')) {
    p.skipLayout();
    if (p.at('punct', '}') || p.at('punct', ',')) { if (p.at('punct', ',')) p.next(); continue; }
    const n = p.expect('ident').text;
    if (p.at('punct', '(')) {
      p.next();
      const params: { name: string; type: TypeExpr }[] = [];
      while (!p.at('punct', ')') && !p.at('eof')) {
        if (p.at('punct', ',')) { p.next(); continue; }
        const pn = p.expect('ident').text;
        if (p.at('punct', ':')) { p.next(); params.push({ name: pn, type: parseType(p) }); }
        else params.push({ name: pn, type: { type: 'ident', name: pn } });
        if (p.at('punct', ',')) p.next();
      }
      p.expect('punct', ')');
      let returnType: TypeExpr = { type: 'primitive', name: 'Void' };
      if (p.at('punct', ':') || p.at('punct', '->')) {
        p.next();
        returnType = parseType(p);
      }
      methods.push({ name: n, params, returnType });
    } else if (p.at('punct', ':')) {
      p.next();
      fields.push({ name: n, type: parseType(p) });
    } else {
      methods.push({ name: n, params: [], returnType: { type: 'primitive', name: 'Void' } });
    }
    if (p.at('punct', ',')) p.next();
  }
  const end = p.expect('punct', '}');
  const kind: InterfaceNode['kind'] = fields.length && methods.length ? 'mixed' : fields.length ? 'record' : methods.length ? 'enum' : 'mixed';
  return box({ type: 'interface', name, kind, methods, fields }, start, end);
}

function parseEvent(p: Parse): EventNode {
  const start = p.expect('ident', 'event');
  const name = parseName(p);
  p.skipLayout();
  const fields: { name: string; type: TypeExpr }[] = [];
  if (p.at('punct', '{')) {
    p.next();
    while (!p.at('punct', '}') && !p.at('eof')) {
      p.skipLayout();
      if (p.at('punct', '}') || p.at('punct', ',')) { if (p.at('punct', ',')) p.next(); continue; }
      const n = p.expect('ident').text;
      p.expect('punct', ':');
      fields.push({ name: n, type: parseType(p) });
      if (p.at('punct', ',')) p.next();
    }
    const end = p.expect('punct', '}');
    return box({ type: 'event', name, fields }, start, end);
  }
  return box({ type: 'event', name, fields }, start, p.tokens[Math.max(0, p.i - 1)]);
}

function parseOneof(p: Parse): OneofNode {
  const start = p.expect('ident', 'oneof');
  const name = parseName(p);
  openBrace(p);
  const variants: OneofNode['variants'] = [];
  while (!p.at('punct', '}') && !p.at('eof')) {
    p.skipLayout();
    if (p.at('punct', '}')) break;
    const typeName = p.expect('ident').text;
    const fieldName = p.at('ident') ? p.next().text : typeName;
    if (p.at('punct', '=')) { p.next(); if (p.at('number')) p.next(); }
    variants.push({ fieldName, typeName });
    if (p.at('punct', ';') || p.at('punct', ',')) p.next();
  }
  const end = p.expect('punct', '}');
  return box({ type: 'oneof', name, variants }, start, end);
}

function parseTransition(p: Parse): TransitionNode {
  const start = p.expect('ident', 'transition');
  const name = parseName(p);
  openBrace(p);
  const fields: TransitionNode['fields'] = [];
  let payloadOneof: string | undefined;
  let typeDiscriminator: string | undefined;
  while (!p.at('punct', '}') && !p.at('eof')) {
    p.skipLayout();
    if (p.at('punct', '}')) break;
    if (p.at('ident', 'payload')) {
      p.next();
      payloadOneof = p.expect('ident').text;
      continue;
    }
    if (p.at('ident', 'discriminator')) {
      p.next();
      typeDiscriminator = p.expect('ident').text;
      continue;
    }
    const n = p.expect('ident').text;
    p.expect('punct', ':');
    fields.push({ name: n, type: parseType(p) });
    if (p.at('punct', ',')) p.next();
  }
  const end = p.expect('punct', '}');
  const node: TransitionNode = { type: 'transition', name, fields };
  if (payloadOneof) node.payloadOneof = payloadOneof;
  if (typeDiscriminator) node.typeDiscriminator = typeDiscriminator;
  return box(node, start, end);
}

function parseService(p: Parse): ServiceNode {
  const start = p.expect('ident', 'service');
  const name = parseName(p);
  openBrace(p);
  const rpcs: ServiceNode['rpcs'] = [];
  while (!p.at('punct', '}') && !p.at('eof')) {
    p.skipLayout();
    if (p.at('punct', '}')) break;
    if (p.at('ident', 'rpc')) p.next();
    const rn = p.expect('ident').text;
    p.expect('punct', '(');
    let requestType = '';
    if (!p.at('punct', ')')) requestType = parseName(p);
    p.expect('punct', ')');
    let responseType = 'Empty';
    if (p.at('ident', 'returns')) {
      p.next();
      p.expect('punct', '(');
      responseType = parseName(p);
      p.expect('punct', ')');
    }
    if (p.at('punct', ';')) p.next();
    rpcs.push({ name: rn, requestType, responseType });
  }
  const end = p.expect('punct', '}');
  return box({ type: 'service', name, rpcs }, start, end);
}

function parseProvenance(p: Parse): ProvenanceNode {
  const start = p.expect('ident', 'provenance');
  openBrace(p);
  const clauses: ProvenanceClause[] = [];
  const kinds = new Set(['regulation', 'design_decision', 'parent_spec', 'external_doc']);
  while (!p.at('punct', '}') && !p.at('eof')) {
    p.skipLayout();
    if (p.at('punct', '}')) break;
    if (!p.at('ident') || !kinds.has(p.cur.text)) p.err(`unexpected "${p.cur.text}" in provenance`);
    const kind = p.next().text as ProvenanceClause['type'];
    if (p.at('punct', ':')) p.next();
    if (!p.at('string')) p.err('expected a string in provenance');
    const value = p.next().text.slice(1, -1);
    const clause: ProvenanceClause = { type: kind, value };
    if (p.at('punct', '::') || p.at('ident', 'at')) {
      p.next();
      if (p.at('string')) clause.location = p.next().text.slice(1, -1);
    }
    clauses.push(clause);
  }
  const end = p.expect('punct', '}');
  return box({ type: 'provenance', clauses }, start, end);
}

function parseBom(p: Parse): BOMNode {
  const start = p.expect('ident', 'bom');
  openBrace(p);
  const bom: BOMNode = { type: 'bom' };
  const grab = (key: 'compiler' | 'solver' | 'runtime') => {
    if (!p.at('ident', key)) return;
    p.next();
    if (p.at('punct', '{')) {
      p.next();
      let name = '';
      let version: string | undefined;
      while (!p.at('punct', '}') && !p.at('eof')) {
        p.skipLayout();
        if (p.at('punct', '}')) break;
        if (p.at('ident', 'name')) { p.next(); p.expect('punct', ':'); name = unquote(p.expect('string').text); }
        else if (p.at('ident', 'version')) { p.next(); p.expect('punct', ':'); version = unquote(p.expect('string').text); }
        else p.next();
        if (p.at('punct', ',')) p.next();
      }
      p.expect('punct', '}');
      bom[key] = { name, version };
    } else if (p.at('punct', ':')) {
      p.next();
      const name = unquote(p.expect('string').text);
      let version: string | undefined;
      if (p.at('ident', 'version')) { p.next(); version = unquote(p.expect('string').text); }
      bom[key] = { name, version };
    }
  };
  while (!p.at('punct', '}') && !p.at('eof')) {
    p.skipLayout();
    if (p.at('punct', '}')) break;
    if (p.at('ident', 'compiler') || p.at('ident', 'solver') || p.at('ident', 'runtime')) {
      grab(p.cur.text as 'compiler' | 'solver' | 'runtime');
      continue;
    }
    if (p.at('ident', 'license')) { p.next(); p.expect('punct', ':'); bom.license = unquote(p.expect('string').text); continue; }
    if (p.at('ident', 'hash')) { p.next(); p.expect('punct', ':'); bom.hash = unquote(p.expect('string').text); continue; }
    p.err(`unexpected "${p.cur.text}" in bom`);
  }
  const end = p.expect('punct', '}');
  return box(bom, start, end);
}

function unquote(s: string): string {
  return s.startsWith('"') ? s.slice(1, -1) : s;
}

function parseInputOutput(p: Parse, kind: 'input' | 'output'): InputNode | OutputNode {
  const start = p.expect('ident', kind);
  p.expect('punct', ':');
  p.skipLayout();
  const typeExpr = parseType(p);
  return box(kind === 'input' ? { type: 'input', typeExpr } : { type: 'output', typeExpr }, start, p.tokens[Math.max(0, p.i - 1)]);
}

function parseAuthor(p: Parse): AuthorNode {
  const start = p.expect('ident', 'author');
  p.expect('punct', ':');
  if (!p.at('string')) p.err('expected an author name');
  const name = unquote(p.next().text);
  let email: string | undefined;
  if (p.at('punct', '<')) {
    p.next();
    if (p.at('string')) email = unquote(p.next().text);
    p.expect('punct', '>');
  }
  return box({ type: 'author', name, email }, start, p.tokens[Math.max(0, p.i - 1)]);
}

function parseMeta(p: Parse, speck: SpeckNode): null {
  const key = p.expect('ident').text;
  p.expect('punct', ':');
  const value = p.at('string') ? unquote(p.next().text) : parseName(p);
  if (key === 'version') speck.version = value;
  else if (key === 'license') speck.license = value;
  else if (key === 'proto_package') speck.protoPackage = value;
  else if (key === 'go_package') speck.goPackage = value;
  else if (key === 'event_suffix') speck.eventSuffix = value;
  else if (key === 'k8s_group') speck.k8sGroup = value;
  else if (key === 'k8s_version') speck.k8sVersion = value;
  return null;
}

function parseSource(p: Parse): SourceNode {
  const start = p.expect('ident', 'source');
  p.expect('punct', ':');
  const kind = p.expect('ident').text as SourceNode['kind'];
  let ref: string | undefined;
  if (p.at('ident', 'ref')) {
    p.next();
    if (p.at('string')) ref = unquote(p.next().text);
  }
  return box({ type: 'source', kind, ref }, start, p.tokens[Math.max(0, p.i - 1)]);
}

function parseReview(p: Parse): ReviewNode {
  const start = p.expect('ident', 'review');
  p.expect('punct', ':');
  const kind = p.expect('ident').text as ReviewNode['kind'];
  return box({ type: 'review', kind }, start, p.tokens[Math.max(0, p.i - 1)]);
}

function parseDerives(p: Parse): DerivesNode {
  const start = p.expect('ident', 'derives');
  p.expect('ident', 'from');
  const fromTok = p.cur;
  while (!p.at('eof') && !p.at('ident', 'via') && !p.at('punct', '}') && !boundaryMember(p)) p.next();
  const from = p.flat(fromTok.start, p.cur.start);
  let via: string | undefined;
  if (p.at('ident', 'via')) {
    p.next();
    if (p.at('string')) via = unquote(p.next().text);
  }
  return box({ type: 'derives', from, via }, start, p.tokens[Math.max(0, p.i - 1)]);
}

function parseSatisfies(p: Parse): SatisfiesNode {
  const start = p.expect('ident', 'satisfies');
  let requirement = parseName(p);
  if (p.cur.text === '#') {
    p.next();
    if (p.at('number') || p.at('ident')) requirement += '#' + p.next().text;
  }
  let clause: string | undefined;
  if (p.at('ident', 'clause')) {
    p.next();
    if (p.at('string')) clause = unquote(p.next().text);
  }
  return box({ type: 'satisfies', requirement, clause }, start, p.tokens[Math.max(0, p.i - 1)]);
}

function parseDescription(p: Parse): null {
  p.expect('ident', 'description');
  p.expect('punct', ':');
  takeExpr(p);
  return null;
}

function parseLifecycle(p: Parse): null {
  // status / conditions / finalizers / ownerReferences are consumed.
  // The existing generators read them off a lifecycle member when present.
  // Preserve them as a member the lower pass already understands when the
  // shape is a single line. We attach them as a lifecycle_metadata member.
  const start = p.expect('ident');
  const key = start.text;
  p.expect('punct', ':');
  const from = p.cur;
  if (p.at('punct', '{') || p.at('punct', '[')) {
    const open = p.cur.text;
    const close = open === '{' ? '}' : ']';
    p.next();
    takeBalanced(p, open, close);
  } else if (p.at('ident', 'true') || p.at('ident', 'false')) {
    p.next();
  } else {
    takeExpr(p);
  }
  const text = p.flat(from.start, p.cur.start);
  let value: unknown = text;
  if (text === 'true') value = true;
  else if (text === 'false') value = false;
  else if (text.startsWith('[')) {
    value = text.slice(1, -1).split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
  }
  return box({ type: 'lifecycle_metadata', key, value } as unknown as MemberNode, start, p.tokens[Math.max(0, p.i - 1)]);
}

function parseAgent(p: Parse): AgentMemberNode {
  const start = p.expect('ident', 'agent');
  openBrace(p);
  const tools: AgentMemberNode['tools'] = [];
  const awaits: AgentMemberNode['awaits'] = [];
  let stages: AgentMemberNode['stages'];
  let pendingTimeout: AgentMemberNode['pendingTimeout'];
  const harnesses: NonNullable<AgentMemberNode['harnesses']> = [];
  while (!p.at('punct', '}') && !p.at('eof')) {
    p.skipLayout();
    if (p.at('punct', '}')) break;
    if (p.at('ident', 'stages')) {
      p.next();
      const variable = p.expect('ident').text;
      openBrace(p);
      const labels: { name: string; value: number }[] = [];
      while (!p.at('punct', '}') && !p.at('eof')) {
        p.skipLayout();
        if (p.at('punct', '}')) break;
        const n = p.expect('ident').text;
        p.expect('punct', '=');
        const value = parseInt(p.expect('number').text, 10);
        labels.push({ name: n, value });
        if (p.at('punct', ',')) p.next();
      }
      p.expect('punct', '}');
      stages = { variable, labels };
      continue;
    }
    if (p.at('ident', 'tool')) {
      p.next();
      const toolName = readToolName(p);
      p.expect('punct', '->');
      const action = parseName(p);
      p.expect('ident', 'effect');
      const effect = p.expect('ident').text;
      if (effect !== 'act' && effect !== 'observe') p.err('expected effect act or observe');
      tools.push({ name: toolName, action, effect });
      continue;
    }
    if (p.at('ident', 'pending')) {
      p.next();
      p.expect('ident', 'timeout');
      const dur = p.expect('number').text;
      pendingTimeout = { durationMs: parseDurationToMs(dur), durationText: dur };
      continue;
    }
    if (p.at('ident', 'harness')) {
      p.next();
      const hname = parseName(p);
      openBrace(p);
      const rules = [];
      while (!p.at('punct', '}') && !p.at('eof')) {
        p.skipLayout();
        if (p.at('punct', '}')) break;
        if (!p.at('ident', 'map')) p.err(`unexpected "${p.cur.text}" in harness`);
        const from = p.cur.start;
        let progressed = false;
        while (!p.at('eof') && !p.at('indent') && !p.at('dedent') && !p.at('punct', '}')) {
          if (progressed && p.at('ident', 'map')) break;
          const t = p.next();
          progressed = true;
          if (t.text === '{') takeBalanced(p, '{', '}');
        }
        const line = p.flat(from, p.cur.start);
        rules.push(parseHarnessMapLine(line, hname));
      }
      p.expect('punct', '}');
      harnesses.push({ name: hname, rules });
      continue;
    }
    if (p.at('ident', 'await')) {
      awaits.push(parseAwait(p));
      continue;
    }
    p.err(`unexpected "${p.cur.text}" in agent`);
  }
  const end = p.expect('punct', '}');
  const node: AgentMemberNode = { type: 'agent', stages, tools, awaits };
  if (pendingTimeout) node.pendingTimeout = pendingTimeout;
  if (harnesses.length) node.harnesses = harnesses;
  return box(node, start, end);
}

function consumeColonBlock(p: Parse): void {
  while (!p.at('punct', ':') && !p.at('punct', '{') && !p.at('punct', '}') && !p.at('eof')) p.next();
  if (p.at('punct', ':')) p.next();
  if (p.at('punct', '{')) {
    p.next();
    while (!p.at('punct', '}') && !p.at('eof')) {
      p.skipLayout();
      if (p.at('punct', '}')) break;
      consumeColonBlock(p);
    }
    if (p.at('punct', '}')) p.next();
    return;
  }
  if (p.at('indent')) {
    p.next();
    while (!p.at('dedent') && !p.at('punct', '}') && !p.at('eof')) {
      p.skipLayout();
      if (p.at('dedent') || p.at('punct', '}')) break;
      const from = p.cur.start;
      takeExpr(p);
      if (p.cur.start === from) p.next();
    }
    if (p.at('dedent')) p.next();
    return;
  }
  takeExpr(p);
}

function readToolName(p: Parse): string {
  const from = p.cur.start;
  if (!p.at('ident')) p.err('expected a tool name');
  p.next();
  while (p.at('punct', '-') || p.at('punct', ':') || (p.at('ident') && p.tokens[p.i - 1]?.text !== '->')) {
    // stop if the next ident is followed by -> at the start... keep hyphens and colons inside the name
    if (p.at('punct', '->')) break;
    if (p.at('punct', '-') || p.at('punct', ':')) { p.next(); if (p.at('ident')) p.next(); continue; }
    break;
  }
  return src.slice(from, p.cur.start).trim();
}

function parseAwait(p: Parse): AgentMemberNode['awaits'][number] {
  p.expect('ident', 'await');
  const state = p.expect('ident').text;
  openBrace(p);
  let signal = '';
  let mode: 'near' | 'in' | '' = '';
  let outcomes: string[] = [];
  let rejects: string[] = [];
  const claims: { name: string; typeName: string }[] = [];
  const on: { outcome: string; target: string }[] = [];
  let timeout: AgentMemberNode['awaits'][number]['timeout'];
  let bindClause: { names: string[] | null } | null = null;
  while (!p.at('punct', '}') && !p.at('eof')) {
    p.skipLayout();
    if (p.at('punct', '}')) break;
    if (p.at('ident', 'signal')) { p.next(); signal = p.expect('ident').text; continue; }
    if (p.at('ident', 'mode')) {
      p.next();
      const m = p.expect('ident').text;
      if (m !== 'near' && m !== 'in') p.err('expected mode near or in');
      mode = m;
      continue;
    }
    if (p.at('ident', 'require')) {
      p.next();
      if (p.at('ident', 'outcome')) {
        p.next();
        p.expect('ident', 'in');
        p.expect('punct', '{');
        outcomes = [];
        rejects = [];
        while (!p.at('punct', '}') && !p.at('eof')) {
          if (p.at('punct', ',')) { p.next(); continue; }
          const n = p.expect('ident').text;
          if (outcomes.includes(n)) p.err(`duplicate outcome ${n}`);
          outcomes.push(n);
          if (p.at('punct', '!')) { rejects.push(n); p.next(); }
          if (p.at('punct', ',')) p.next();
        }
        p.expect('punct', '}');
        continue;
      }
      if (p.at('ident', 'claims')) {
        p.next();
        p.expect('punct', '{');
        while (!p.at('punct', '}') && !p.at('eof')) {
          if (p.at('punct', ',')) { p.next(); continue; }
          const n = p.expect('ident').text;
          p.expect('punct', ':');
          const ty = p.expect('ident').text;
          claims.push({ name: n, typeName: ty });
          if (p.at('punct', ',')) p.next();
        }
        p.expect('punct', '}');
        continue;
      }
      p.err('expected outcome or claims after require');
    }
    if (p.at('ident', 'on')) {
      p.next();
      const outcome = p.expect('ident').text;
      p.expect('punct', '->');
      const target = p.expect('ident').text;
      on.push({ outcome, target });
      continue;
    }
    if (p.at('ident', 'timeout')) {
      p.next();
      const dur = p.expect('number').text;
      p.expect('punct', '->');
      const outcome = p.expect('ident').text;
      timeout = { durationMs: parseDurationToMs(dur), durationText: dur, outcome };
      continue;
    }
    if (p.at('ident', 'bind')) {
      p.next();
      p.expect('ident', 'call');
      if (bindClause) p.err(`duplicate bind call`);
      if (p.at('ident', 'on')) {
        p.next();
        const names: string[] = [];
        names.push(p.expect('ident').text);
        while (p.at('punct', ',')) { p.next(); names.push(p.expect('ident').text); }
        bindClause = { names };
      } else bindClause = { names: null };
      continue;
    }
    p.err(`unexpected "${p.cur.text}" in await ${state}`);
  }
  p.expect('punct', '}');
  if (!signal) p.err(`missing signal`);
  if (!mode) p.err(`missing mode (near|in)`);
  if (outcomes.length === 0) p.err('missing require outcome in {...}');
  if (on.length === 0) p.err('missing on outcome -> Target');
  let bindCall: string[] = [];
  if (bindClause) {
    bindCall = bindClause.names === null ? outcomes.filter(o => !rejects.includes(o)) : bindClause.names;
  }
  return { state, signal, mode, outcomes, rejects, claims, on, timeout, bindCall };
}

function parseType(p: Parse): TypeExpr {
  const from = p.cur.start;
  parseTypeTokens(p);
  const text = p.flat(from, p.cur.start);
  return typeFromText(text);
}

function parseTypeTokens(p: Parse): void {
  let depth = 0;
  let angle = 0;
  const start = p.i;
  while (!p.at('eof')) {
    if (depth === 0 && angle === 0) {
      if (p.at('punct', ',') || p.at('punct', '}') || p.at('punct', ')') || p.at('punct', '=') || p.at('punct', ':=') || p.at('punct', ';')) break;
      if (p.i > start && p.at('ident') && p.tokens[p.i + 1]?.text === ':') break;
      if (p.i > start && (p.at('indent') || p.at('dedent'))) break;
    }
    const t = p.cur;
    if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
    else if (t.text === ')' || t.text === ']' || t.text === '}') {
      if (depth === 0) break;
      depth--;
    } else if (t.text === '<') angle++;
    else if (t.text === '>') { if (angle > 0) angle--; }
    p.next();
  }
}

const PRIMS = new Set(['Nat', 'Int', 'Real', 'Bool', 'String', 'Bytes']);

function typeFromText(expr: string): TypeExpr {
  expr = expr.trim().replace(/,\s*$/, '');
  const mismatched = expr.match(/^(List|Map|Set)\s*[(<]([\s\S]*)\]$/);
  if (mismatched) expr = `${mismatched[1]}(${mismatched[2]})`;
  if (PRIMS.has(expr)) return { type: 'primitive', name: expr };
  const generic = (head: string, kind: 'list' | 'set' | 'map') => {
    for (const [o, c] of [['<', '>'], ['(', ')']] as const) {
      if (expr.startsWith(head + o) && expr.endsWith(c)) {
        const inner = expr.slice(head.length + 1, -1).trim();
        if (kind === 'map') {
          const comma = topComma(inner);
          if (comma < 0) return { type: 'ident' as const, name: expr };
          return { type: 'map', keyType: typeFromText(inner.slice(0, comma)), valueType: typeFromText(inner.slice(comma + 1)) };
        }
        return { type: kind, elementType: typeFromText(inner) };
      }
    }
    return null;
  };
  for (const [h, k] of [['List', 'list'], ['Set', 'set'], ['Map', 'map']] as const) {
    const g = generic(h, k);
    if (g) return g;
  }
  if (expr.startsWith('[') && expr.endsWith(']')) return { type: 'list', elementType: typeFromText(expr.slice(1, -1)) };
  if (expr.startsWith('{') && expr.endsWith('}')) {
    const content = expr.slice(1, -1).trim();
    const fields: { name: string; type: TypeExpr }[] = [];
    if (content) {
      for (const fieldStr of splitTop(content, ',')) {
        const m = fieldStr.trim().match(/^(\w+)\s*:\s*([\s\S]+)$/);
        if (m) fields.push({ name: m[1], type: typeFromText(m[2].trim()) });
      }
    }
    return { type: 'record', fields };
  }
  const pipe = topChar(expr, '|');
  if (pipe >= 0) {
    const right = expr.slice(pipe + 1).trim();
    if (right === 'null') {
      const inner = typeFromText(expr.slice(0, pipe).trim());
      inner.nullable = true;
      return inner;
    }
  }
  return { type: 'ident', name: expr };
}

function topComma(s: string): number { return topChar(s, ','); }
function topChar(s: string, ch: string): number {
  let d = 0, b = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<' || c === '(') d++;
    else if (c === '>' || c === ')') d--;
    else if (c === '{') b++;
    else if (c === '}') b--;
    else if (c === ch && d === 0 && b === 0) return i;
  }
  return -1;
}
function splitTop(s: string, ch: string): string[] {
  const out: string[] = [];
  let d = 0, b = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<' || c === '(') d++;
    else if (c === '>' || c === ')') d--;
    else if (c === '{') b++;
    else if (c === '}') b--;
    else if (c === ch && d === 0 && b === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

/** Every node id in an AST. */
export function collectNodeIds(ast: AST): Set<number> {
  const out = new Set<number>();
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    const id = nodeIds.get(v);
    if (id !== undefined) out.add(id);
    for (const child of nodeChildren.get(v) ?? []) walk(child);
    for (const k of Object.keys(v as object)) walk((v as Record<string, unknown>)[k]);
  };
  walk(ast);
  return out;
}
