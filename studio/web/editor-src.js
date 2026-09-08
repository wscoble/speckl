// SpeckDL editor built on CodeMirror 6 - bundled to web/vendor/cm.js (IIFE, global `SpecklEditor`).
// Provides: line numbers, code folding on {...} blocks, SpeckDL syntax highlighting,
// and wallaby-style inline verification annotations (gutter dots + verdict widgets).
import {
  EditorView, Decoration, WidgetType, GutterMarker, gutter, keymap,
} from '@codemirror/view';
import {
  EditorState, StateField, StateEffect,
} from '@codemirror/state';
import {
  defaultKeymap, history, historyKeymap, indentWithTab,
} from '@codemirror/commands';
import {
  StreamLanguage, foldGutter, foldService, syntaxHighlighting, HighlightStyle,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// ---------- SpeckDL tokenizer ----------

const KEYWORDS = new Set((
  'speck state init invariant action next verify constraint event type import interface ' +
  'service oneof transition input output provenance review derives satisfies author source ' +
  'bom require return emit Always Eventually always eventually forall in and or not implies ' +
  'version hash via from clause ref depth license proto_package go_package event_suffix ' +
  'k8s_group k8s_version'
).split(' '));
const TYPES = new Set(['Nat', 'Int', 'Real', 'Bool', 'String', 'Bytes', 'List', 'Set', 'Map']);

const specklMode = StreamLanguage.define({
  token(stream) {
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      while (!stream.eol()) {
        if (stream.match('*/')) return 'comment';
        stream.next();
      }
      return 'comment';
    }
    if (stream.match(/"(?:[^"\\\n]|\\.)*?"/)) return 'string';
    if (stream.match(/"/)) {
      stream.skipToEnd(); // unterminated string
      return 'string';
    }
    if (stream.match(/\d+(\.\d+)?/)) return 'number';
    if (stream.match(/[A-Za-z_][\w']*/)) {
      const w = stream.current();
      if (KEYWORDS.has(w)) return 'keyword';
      if (TYPES.has(w)) return 'typeName';
      return null;
    }
    stream.next();
    return null;
  },
});

const specklHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: t.comment, color: '#5d6b7d', fontStyle: 'italic' },
  { tag: t.keyword, color: '#c792ea' },
  { tag: t.typeName, color: '#7ee2a8' },
  { tag: t.string, color: '#ecc48d' },
  { tag: t.number, color: '#f78c6c' },
]));

// ---------- folding: any line with `{` folds to its matching `}` line ----------

const specklFoldService = foldService.of((state, from) => {
  const line = state.doc.lineAt(from);
  const openCol = line.text.indexOf('{');
  if (openCol < 0) return null;
  let depth = 0;
  for (let pos = line.from + openCol; pos < state.doc.length; pos++) {
    const ch = state.doc.sliceString(pos, pos + 1);
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const closeLine = state.doc.lineAt(pos);
        if (closeLine.number > line.number) {
          return { from: line.from + openCol + 1, to: closeLine.to };
        }
        return null;
      }
    }
  }
  return null;
});

// ---------- verification annotations ----------

const setChecksEffect = StateEffect.define();

const VERDICT_STYLE = {
  pass: 'inl-pass',
  violated: 'inl-violated',
  contradictory: 'inl-violated',
  error: 'inl-warn',
  unexpected: 'inl-warn',
};

function verdictLabel(c) {
  const name = c.check === '(consistency check)' ? 'consistency' : c.check;
  switch (c.verdict) {
    case 'pass':
      return c.check.startsWith('Always') ? `✔ ${name}: proven within depth` : `✔ ${name}: consistent`;
    case 'violated':
      return c.advisory ? `⚠ ${name}: possible violation (advisory - degraded model)` : `✘ ${name}: violated`;
    case 'contradictory':
      return `✘ ${name}: contradictory constraints`;
    case 'error':
      return `⚠ ${name}: solver error`;
    default:
      return `⚠ ${name}: unexpected solver result`;
  }
}

class VerdictWidget extends WidgetType {
  constructor(label, cls, title) {
    super();
    this.label = label;
    this.cls = cls;
    this.title = title;
  }
  eq(other) {
    return other.label === this.label && other.cls === this.cls && other.title === this.title;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = `inl ${this.cls}`;
    span.textContent = this.label;
    span.title = this.title;
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

class DotMarker extends GutterMarker {
  constructor(cls, title) {
    super();
    this.cls = cls;
    this.title = title;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = `inl-dot ${this.cls}`;
    span.title = this.title;
    return span;
  }
}

const EMPTY_MARKER = new GutterMarker();

/** Find the source line a check annotates: its verify block, its invariant, or the speck. */
function lineForCheck(docText, doc, c) {
  const speckName = c.file.replace(/\.ir\.smt2$|\.smt2$/, '');
  const lines = docText.split('\n');
  let idx = -1;
  const cm = c.check.match(/Always\((\w+)\)/);
  if (cm) {
    idx = lines.findIndex((l) => new RegExp(`verify\\s+Always\\(${cm[1]}\\)`).test(l));
    if (idx < 0) idx = lines.findIndex((l) => new RegExp(`invariant\\s+${cm[1]}\\s*\\{`).test(l));
  }
  if (idx < 0) {
    idx = lines.findIndex((l) => new RegExp(`speck\\s+${speckName}\\s*\\{`).test(l));
  }
  if (idx < 0) return null;
  return doc.line(idx + 1);
}

const checksField = StateField.define({
  create: () => ({ checks: [], stale: false }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setChecksEffect)) return e.value;
    if (tr.docChanged && value.checks.length) return { ...value, stale: true };
    return value;
  },
});

function buildDecorations(value, state) {
  const docText = state.doc.toString();
  const ranges = [];
  for (const c of value.checks) {
    const line = lineForCheck(docText, state.doc, c);
    if (!line) continue;
    const cls = VERDICT_STYLE[c.verdict] ?? VERDICT_STYLE.unexpected;
    ranges.push(Decoration.line({ class: `cm-verdict-${c.verdict}` }).range(line.from));
    const label = verdictLabel(c);
    const tooltip = [label, `solver: ${c.got} (expect ${c.expect})`, c.detail ?? ''].filter(Boolean).join('\n');
    ranges.push(Decoration.widget({ widget: new VerdictWidget(label, cls + (value.stale ? ' stale' : ''), tooltip), side: 1 }).range(line.to));
  }
  return Decoration.set(ranges, true);
}

// gutter dots: one marker per annotated line
function verdictGutter() {
  return gutter({
    class: 'cm-verdict-gutter',
    lineMarker(view, line) {
      const { checks } = view.state.field(checksField);
      if (!checks.length) return EMPTY_MARKER;
      const docText = view.state.doc.toString();
      for (const c of checks) {
        const cl = lineForCheck(docText, view.state.doc, c);
        if (cl && cl.number === line.number) {
          const cls = VERDICT_STYLE[c.verdict] ?? VERDICT_STYLE.unexpected;
          const label = verdictLabel(c);
          const tooltip = [label, `solver: ${c.got} (expect ${c.expect})`, c.detail ?? ''].filter(Boolean).join('\n');
          return new DotMarker(cls, tooltip);
        }
      }
      return EMPTY_MARKER;
    },
    lineMarkerChange: (tr) => tr.effects.some((e) => e.is(setChecksEffect)) || tr.docChanged,
    initialSpacer: () => new DotMarker('inl-pass', ''),
  });
}

// ---------- public API ----------

export function create(host, initialDoc, handlers) {
  const onChange = handlers?.onChange ?? (() => {});
  const onSave = handlers?.onSave ?? (() => {});

  const theme = EditorView.theme({
    '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--text)' },
    '.cm-content': { fontFamily: 'var(--mono)', fontSize: '13px', lineHeight: '1.55', padding: '14px 0', caretColor: 'var(--text)' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)', lineHeight: '1.55' },
    '.cm-gutters': { backgroundColor: 'var(--bg)', color: '#4a5568', border: 'none', fontFamily: 'var(--mono)', fontSize: '13px' },
    '.cm-activeLine': { backgroundColor: 'rgba(78, 161, 255, 0.06)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(78, 161, 255, 0.06)', color: 'var(--text)' },
    '.cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'rgba(78, 161, 255, 0.35) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--text)' },
    '.cm-foldGutter .cm-gutterElement': { color: 'var(--dim)', cursor: 'pointer' },
    '.cm-placeholder': { color: 'var(--dim)' },
  }, { dark: true });

  const view = new EditorView({
    state: EditorState.create({
      doc: initialDoc ?? '',
      extensions: [
        lineNumbers(),
        foldGutter(),
        specklFoldService,
        specklMode,
        specklHighlight,
        history(),
        verdictGutter(),
        checksField,
        EditorView.decorations.compute([checksField], (state) => buildDecorations(state.field(checksField), state)),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(view.state.doc.toString());
        }),
        keymap.of([{
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSave();
            return true;
          },
        }]),
        theme,
        EditorView.contentAttributes.of({ spellcheck: 'false' }),
      ],
    }),
    parent: host,
  });

  return {
    getDoc: () => view.state.doc.toString(),
    setDoc: (text) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    setChecks: (checks, stale) => {
      view.dispatch({ effects: setChecksEffect.of({ checks: checks ?? [], stale: !!stale }) });
    },
    focus: () => view.focus(),
  };
}