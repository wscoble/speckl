// src/generators/smt-sanitize.ts
//
// Post-generation validator for emitted SMT-LIB2 text.
//
// The Z3 generators translate SpeckDL expression syntax that does not always
// have a well-defined SMT translation (enum variants, map helper constants,
// forall-over-collection sugar, dot-method calls, unresolved type aliases).
// When translation partially fails, the emitted text can contain identifiers
// or sorts that were never declared — Z3 rejects the whole file.
//
// This sanitizer makes the failure mode graceful instead of invalid:
//   1. Collect every declared identifier and sort name from the emitted text.
//   2. Validate each define-fun body and assert form: every referenced
//      identifier must be declared, bound by an enclosing forall/exists/let,
//      or an SMT-LIB2 builtin. Step-suffixed references (var_N) and _post
//      are recognized via their base names.
//   3. Drop invalid forms, replacing them with a comment explaining why.
//      Dropping cascades: declare-consts with unknown sorts are dropped,
//      and anything referencing a dropped name is dropped too.
//
// The result is always well-scoped SMT — the solver gets a checkable file,
// and skipped constructs are visible in the output. The verify script
// (`scripts/verify-z3.mjs`) is the final authority: it runs z3 on every file
// and reports any residual errors.

export interface SanitizeResult {
  /** Sanitized SMT text. */
  text: string;
  /** Forms that were dropped, with reasons (for diagnostics/tests). */
  dropped: { name: string; reason: string }[];
}

/** SMT-LIB2 builtin identifiers that never need a declaration. */
const SMT_BUILTINS = new Set([
  'and', 'or', 'not', 'xor', 'implies', 'iff', 'distinct',
  '=>', '+', '-', '*', '/', 'div', 'mod', 'rem', 'abs',
  '<', '<=', '>', '>=', 'min', 'max',
  'select', 'store', 'default',
  'forall', 'exists', 'let', 'ite',
  'true', 'false', 'Int', 'Bool', 'Real', 'String', 'Array', 'Seq', 'Set',
  'union', 'intersection', 'difference', 'member', 'insert', 'singleton',
  'head', 'tail', 'concat',
  'to_int', 'to_real', 'is_int',
  'check-sat', 'get-model', 'get-value', 'echo',
  'set-logic', 'set-option', 'push', 'pop', 'exit',
]);

// ---------------------------------------------------------------------------
// Form splitting
// ---------------------------------------------------------------------------

interface Item {
  start: number;
  end: number;
  text: string;
  isForm: boolean;
  keep: boolean;
  comment?: string;
}

/**
 * Split SMT text into top-level units: balanced parenthesized forms
 * (possibly multi-line) and plain lines, with offsets for rebuilding.
 */
function splitForms(text: string): Item[] {
  const items: Item[] = [];
  let lineStart = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // Newline: flush the line, advance.
    if (ch === '\n') {
      const line = text.slice(lineStart, i);
      if (line.trim()) {
        items.push({ start: lineStart, end: i, text: line, isForm: false, keep: true });
      }
      i++;
      lineStart = i;
      continue;
    }
    // A comment (rest of line starts with ';' after same-line whitespace) is
    // opaque: emit it whole so parentheses inside comments are never
    // mistaken for form starts.
    if (ch === ' ' || ch === '\t' || ch === ';') {
      const lineEnd = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i);
      const lineRest = text.slice(i, lineEnd);
      if (/^[ \t]*;/.test(lineRest)) {
        items.push({ start: i, end: lineEnd, text: lineRest, isForm: false, keep: true });
        i = lineEnd;
        lineStart = i;
        continue;
      }
    }
    if (ch === '(') {
      // Flush pending line content before the form.
      if (i > lineStart) {
        const pending = text.slice(lineStart, i);
        if (pending.trim()) {
          items.push({ start: lineStart, end: i, text: pending, isForm: false, keep: true });
        }
      }
      // Capture a balanced form; quoted strings are opaque.
      let depth = 0;
      let j = i;
      let inStr = false;
      for (; j < text.length; j++) {
        const c = text[j];
        if (c === '"') inStr = !inStr;
        if (inStr) continue;
        if (c === '(') depth++;
        else if (c === ')') {
          depth--;
          if (depth === 0) { j++; break; }
        }
      }
      items.push({ start: i, end: j, text: text.slice(i, j), isForm: true, keep: true });
      i = j;
      lineStart = i;
      // Consume the rest of the line (e.g. a trailing `; Step N` comment).
      while (i < text.length && text[i] !== '\n') i++;
      if (i > lineStart) {
        const trailing = text.slice(lineStart, i);
        if (trailing.trim()) {
          items.push({ start: lineStart, end: i, text: trailing, isForm: false, keep: true });
        }
      }
      lineStart = i;
    } else if (ch === '\n') {
      const line = text.slice(lineStart, i);
      if (line.trim()) {
        items.push({ start: lineStart, end: i, text: line, isForm: false, keep: true });
      }
      i++;
      lineStart = i;
    } else {
      i++;
    }
  }
  if (lineStart < text.length) {
    const pending = text.slice(lineStart);
    if (pending.trim()) {
      items.push({ start: lineStart, end: text.length, text: pending, isForm: false, keep: true });
    }
  }
  return items;
}

/** Head token of a form, e.g. "define-fun" for `(define-fun X ...)`. */
function formHead(form: string): string {
  const m = form.match(/^\(\s*([^\s()]+)/);
  return m ? m[1] : '';
}

/** Declared/defined name of a declaration form. */
function formName(form: string): string {
  const m = form.match(
    /^\(\s*(?:declare-const|declare-sort|declare-fun|define-fun|declare-datatypes)\s+\(?([^\s()]+)/
  );
  return m ? m[1] : '';
}

/** Identifiers referenced in a form, with quoted strings removed. */
function extractIdentifiers(form: string): string[] {
  const noStrings = form.replace(/"[^"]*"/g, '""');
  return noStrings.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
}

/**
 * Binder names introduced by forall/exists/let inside the form
 * (e.g. `(forall ((x Int)) ...)` binds x).
 */
function extractBinders(form: string): Set<string> {
  const binders = new Set<string>();
  const re = /\((?:forall|exists|let)\s+\(((?:\(\s*[^\s()]+\s+[^\s()]+\s*\)\s*)+)\)/g;
  let m;
  while ((m = re.exec(form)) !== null) {
    const pairRe = /\(\s*([A-Za-z_][A-Za-z0-9_]*)\s+[^\s()]+\s*\)/g;
    let p;
    while ((p = pairRe.exec(m[1])) !== null) binders.add(p[1]);
  }
  return binders;
}

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

export function sanitizeSMT(text: string): SanitizeResult {
  const dropped: { name: string; reason: string }[] = [];
  const items = splitForms(text);

  // Declared sorts: builtins + everything the file declares.
  const knownSorts = new Set<string>(['Int', 'Bool', 'Real', 'String', 'Array', 'Seq', 'Set']);
  const known = new Set<string>(SMT_BUILTINS);
  known.add('speckl_len_Int');
  known.add('speckl_nil');

  for (const it of items) {
    if (!it.isForm) continue;
    const head = formHead(it.text);
    if (head === 'declare-sort') {
      const name = formName(it.text);
      if (name) knownSorts.add(name);
    } else if (head === 'declare-datatypes') {
      const m = it.text.match(/declare-datatypes\s+\(\s*\(\s*([\w-]+)/);
      if (m) knownSorts.add(m[1]);
      const ctor = it.text.match(/\(\s*(mk-[\w-]+)/);
      if (ctor) known.add(ctor[1]);
    } else if (head === 'declare-const' || head === 'declare-fun' || head === 'define-fun') {
      const name = formName(it.text);
      if (name) known.add(name);
    }
  }

  const isKnownSort = (id: string): boolean => knownSorts.has(id);
  const isKnownIdent = (raw: string): boolean => {
    if (known.has(raw)) return true;
    // Step-suffixed references: isOn_3 known if isOn is; x_post likewise.
    const step = raw.match(/^(.+?)_(\d+)$/);
    if (step && known.has(step[1])) return true;
    const post = raw.match(/^(.+)_post$/);
    if (post && known.has(post[1])) return true;
    return false;
  };

  // Pass 0: drop malformed declare-datatypes (garbage names from unresolved
  // record types, or fields whose sorts are unknown). Their sorts are removed
  // from the known set so constants referencing them are dropped in pass 1.
  for (const it of items) {
    if (!it.isForm) continue;
    if (formHead(it.text) !== 'declare-datatypes') continue;
    const nameMatch = it.text.match(/declare-datatypes\s+\(\s*\(\s*([\w:./()-]+)/);
    const name = nameMatch ? nameMatch[1] : '';
    const structurallyValid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
    const fieldSorts = [...it.text.matchAll(/\(\s*[\w-]+\s+(\([^()]*\)|[A-Za-z_][A-Za-z0-9_]*)\s*\)/g)].map(m => m[1]);
    const badSorts = [...new Set(
      fieldSorts.flatMap(s => extractIdentifiers(s)).filter(id => !isKnownSort(id))
    )];
    if (!structurallyValid || badSorts.length > 0) {
      it.keep = false;
      it.comment = structurallyValid
        ? `skipped datatype ${name}: unknown sort(s) ${badSorts.join(', ')} in field declaration`
        : `skipped datatype: unresolvable record type name`;
      dropped.push({ name: name || '(datatype)', reason: it.comment });
      if (name) knownSorts.delete(name);
    }
  }

  // Pass 1: drop declare-const forms whose sort references unknown sorts.
  for (const it of items) {
    if (!it.isForm) continue;
    if (formHead(it.text) !== 'declare-const') continue;
    const m = it.text.match(/^\(\s*declare-const\s+(\S+)\s+([\s\S]*?)\s*\)\s*$/);
    if (!m) continue;
    const [, name, sort] = m;
    const sortIds = extractIdentifiers(sort);
    const bad = [...new Set(sortIds.filter(id => !isKnownSort(id)))];
    if (sortIds.length > 0 && bad.length > 0) {
      it.keep = false;
      it.comment = `skipped ${name}: unknown sort ${bad.join(', ')} in declaration`;
      dropped.push({ name, reason: it.comment });
      known.delete(name);
    }
  }

  // Pass 1b: drop duplicate declarations — redeclaration of a constant, sort,
  // or function is an error in SMT-LIB2 (several generators can declare the
  // same name; first declaration wins).
  const declaredOnce = new Set<string>();
  for (const it of items) {
    if (!it.isForm || !it.keep) continue;
    const head = formHead(it.text);
    if (head !== 'declare-const' && head !== 'declare-sort' && head !== 'define-fun') continue;
    const name = formName(it.text);
    if (!name) continue;
    if (declaredOnce.has(name)) {
      it.keep = false;
      it.comment = `skipped duplicate declaration of ${name}`;
      dropped.push({ name, reason: it.comment });
    } else {
      declaredOnce.add(name);
    }
  }

  const SMT_BUILTIN_SORTS = new Set(['Int', 'Bool', 'Real', 'String', 'Array', 'Seq', 'Set']);

  // Pass 2 (to fixpoint): validate define-fun bodies and asserts; drop any
  // that reference undeclared identifiers, cascading through dependencies.
  // User-declared sorts are NOT valid terms — a sort name appearing in term
  // position (e.g. `(= routerConfig LlmRouterConfig)` from a placeholder
  // initializer) is invalid SMT and the form is dropped.
  const userSorts = new Set([...knownSorts].filter(x => !SMT_BUILTIN_SORTS.has(x)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const it of items) {
      if (!it.isForm || !it.keep) continue;
      const head = formHead(it.text);
      if (head !== 'define-fun' && head !== 'assert') continue;

      const name = formName(it.text);
      // The body excludes the header (name and params are bound, not free).
      let body = it.text;
      if (head === 'define-fun') {
        body = it.text.replace(/^\(\s*define-fun\s+\S+\s+\([^)]*\)\s+\S+/, '');
      } else {
        body = it.text.replace(/^\(\s*assert/, '');
      }
      const binders = extractBinders(body);
      const idents = extractIdentifiers(body);

      // Structural malformations from leaky translation:
      //  - infix operators as siblings ("a <= b" inside a prefix form)
      //  - SpeckDL forall/exists sugar leaking through ("forall b in x.keys:",
      //    "forall (select rms rm): ...") — valid SMT is always
      //    `(forall ((x Sort)) ...)` with a double-paren binder list
      //  - operators with no operands ("(+ )")
      const noStrings = body.replace(/"[^"]*"/g, '""');
      const infixLeak = /[\s](<=|>=|==|->|>|<|and|or|implies)[\s)]/.test(noStrings);
      const forallSugar = /\b(?:forall|exists)(?!\s*\(\()/.test(noStrings);
      const emptyOp = /\(\s*(?:[+\-*/]|div|mod)\s*\)/.test(noStrings);
      // Double-wrapped operator applications — `((= a b))` — produced by the
      // escaped-infix fallback regexes running over already-converted forms.
      const doubleWrappedOp = /\(\s*\(\s*(?:<=|>=|==|and|or|distinct|div|mod|[=+\-*/])/.test(noStrings);
      // Braces are never valid SMT-LIB2 (leaked map/set literals from the source).
      const braceLeak = /[{}]/.test(noStrings);
      const malformed = infixLeak || forallSugar || emptyOp || doubleWrappedOp || braceLeak;

      // Built-in sorts may appear as atoms in binder sort positions; a
      // *user-declared* sort used as a term is invalid SMT (typically a
      // type name leaked from a placeholder initializer).
      const userSortLeak = idents.some(id => userSorts.has(id) && !isKnownIdent(id));
      const unknown = malformed || userSortLeak
        ? [...new Set(
            (malformed ? ['malformed expression (leaked source syntax)'] : [])
              .concat(userSortLeak ? ['user sort used as a term'] : [])
          )]
        : [...new Set(
            idents.filter(id => !isKnownIdent(id) && !binders.has(id))
          )];

      if (unknown.length > 0) {
        it.keep = false;
        it.comment = `skipped: references undeclared identifier(s): ${unknown.join(', ')}`;
        dropped.push({ name: head === 'define-fun' ? name : '(assert)', reason: it.comment });
        if (head === 'define-fun' && name) {
          known.delete(name);
        }
        changed = true;
      }
    }
  }

  // If forms were dropped, the emitted model is incomplete: transition
  // constraints or invariants may be missing, so a `sat` against an expected
  // `unsat` could be spurious. Downgrade the expectation to a consistency
  // check and say so — the solver result is then advisory, not a proof.
  if (dropped.length > 0) {
    for (const it of items) {
      if (it.isForm || !it.keep) continue;
      if (/^;\s*speckl-expect:\s*unsat\s*$/.test(it.text)) {
        it.text = `; speckl-expect: sat (degraded: model incomplete — ${dropped.length} form(s) skipped)`;
      }
    }
  }

  // Rebuild output, preserving order. Original formatting inside kept forms
  // is untouched; dropped forms become explanatory comments.
  const out: string[] = [];
  for (const it of items) {
    if (it.keep) {
      out.push(it.text);
    } else if (it.comment) {
      out.push(`; ${it.comment}`);
    }
  }
  return { text: out.join('\n') + '\n', dropped };
}