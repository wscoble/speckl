// Turn compiler failures into sentences a person can act on, with a spec
// line when one can be found. Output is plain text; the page must not treat
// it as HTML.

import type { IRDiagnostic } from '../ir/types.js';
import { formatBytes, LONG_LINE_CHARS } from './limits.js';

export interface BrowserDiagnostic {
  level: 'error' | 'warning' | 'info';
  message: string;
  /** 1-based line in the spec, when the diagnostic is about the spec. */
  line?: number;
  column?: number;
  speck?: string;
}

export function cleanErrorMessage(err: unknown): string {
  const raw = err instanceof Error
    ? err.message
    : typeof err === 'string'
      ? err
      : 'The compiler failed.';
  const text = raw
    .split('\n')
    .filter((line) => !/^\s+at /.test(line))
    .join('\n')
    .trim();
  return text || 'The compiler failed.';
}

/**
 * Pull a 1-based line out of a compiler message. Prefers `Parse error at
 * line N`. Otherwise searches the spec for a quoted snippet from the message.
 */
function lineText(source: string, line: number): string {
  let start = 0;
  let n = 1;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) !== 10) continue;
    if (n === line) return source.slice(start, i);
    n++;
    start = i + 1;
  }
  return n === line ? source.slice(start) : '';
}

function columnOf(text: string, needle: string): number | undefined {
  if (!needle) return undefined;
  const at = text.indexOf(needle);
  return at >= 0 ? at + 1 : undefined;
}

/** A column for a diagnostic that names a token, or the first character on the line. */
function inferColumn(text: string, message: string): number | undefined {
  if (!text) return undefined;
  if (/unclosed comment/.test(message)) {
    const at = columnOf(text, '/*');
    if (at) return at;
  }
  if (/unexpected `\}`|ended up at line|closed early/.test(message)) {
    const at = columnOf(text, '}');
    if (at) return at;
  }
  const quoted = message.matchAll(/"([^"\n]+)"/g);
  for (const q of quoted) {
    const whole = columnOf(text, q[1]);
    if (whole) return whole;
    const word = q[1].match(/[A-Za-z_][\w.]*/)?.[0];
    const part = word ? columnOf(text, word) : undefined;
    if (part) return part;
  }
  if (/unexpected `\{`|never closed|opens twice|missing a name|missing a colon/.test(message)) {
    const at = columnOf(text, '{') ?? columnOf(text, message.match(/"([^"]+)"/)?.[1] ?? '');
    if (at) return at;
  }
  const word = /\S/.exec(text);
  return word ? word.index + 1 : undefined;
}

export function locateDiagnostic(source: string, message: string): BrowserDiagnostic {
  const cleaned = message.trim() || 'The compiler failed.';
  const at = cleaned.match(/Parse error at line (\d+)(?:, column (\d+))?/i) ?? cleaned.match(/\bline (\d+)\b/i);
  if (at) {
    const line = Number(at[1]);
    if (line >= 1) {
      let column = at[2] ? Number(at[2]) : undefined;
      if (!column) column = inferColumn(lineText(source, line), cleaned);
      return { level: 'error', message: cleaned, line, ...(column ? { column } : {}) };
    }
  }
  const quoted = cleaned.matchAll(/"([^"\n]{3,200})"/g);
  for (const q of quoted) {
    const idx = source.indexOf(q[1]);
    if (idx >= 0) {
      return { level: 'error', message: cleaned, line: source.slice(0, idx).split('\n').length };
    }
  }
  return { level: 'error', message: cleaned };
}

export function fromIR(source: string, d: IRDiagnostic): BrowserDiagnostic {
  const base: BrowserDiagnostic = {
    level: d.level,
    message: d.message,
    column: d.column,
    speck: d.speck,
  };
  if (d.line && d.line >= 1) {
    base.line = d.line;
    if (!base.column) base.column = inferColumn(lineText(source, d.line), d.message);
    return base;
  }
  const located = locateDiagnostic(source, d.message);
  if (located.line) base.line = located.line;
  if (located.column && !base.column) base.column = located.column;
  return base;
}

export function presentDiagnostic(d: BrowserDiagnostic): string {
  let msg = d.message.trim().replace(/^Parse error at line \d+(?:, column \d+)?:\s*/i, '');
  if (d.speck && !msg.includes(d.speck)) msg = `${d.speck}: ${msg}`;
  if (d.line && !/^Line \d+/.test(msg)) {
    const where = d.column ? `Line ${d.line}, column ${d.column}` : `Line ${d.line}`;
    msg = `${where}: ${msg}`;
  }
  return msg;
}

const LEVEL_RANK = { error: 0, warning: 1, info: 2 } as const;

export function sortDiagnostics(items: BrowserDiagnostic[]): BrowserDiagnostic[] {
  return [...items].sort((a, b) => {
    const byLevel = LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
    if (byLevel !== 0) return byLevel;
    return (a.line ?? 1_000_000_000) - (b.line ?? 1_000_000_000);
  });
}

export function dedupeDiagnostics(items: BrowserDiagnostic[]): BrowserDiagnostic[] {
  const seen = new Set<string>();
  const out: BrowserDiagnostic[] = [];
  for (const d of items) {
    const key = `${d.level}|${d.line ?? ''}|${d.speck ?? ''}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

const UNCHECKED = /^;\s*speckl-unchecked:\s*(.*)$/;

/** How many SMT obligations the compiler marked unchecked. Not a spec line. */
export function uncheckedObligationCount(files: { path: string; text: string }[]): number {
  let count = 0;
  for (const file of files) {
    if (!file.path.endsWith('.smt2')) continue;
    for (const line of file.text.split('\n')) {
      if (UNCHECKED.test(line.trim())) count++;
    }
  }
  return count;
}

/**
 * One note for the whole compile. The per-file unchecked markers are about
 * generated SMT, and listing each one as a warning buried real problems.
 */
export function proofNote(uncheckedCount: number): BrowserDiagnostic {
  const n = Number.isFinite(uncheckedCount) ? Math.max(0, Math.floor(uncheckedCount)) : 0;
  const extra = n > 0
    ? ` ${n} check${n === 1 ? '' : 's'} could not be proved here.`
    : '';
  return {
    level: 'info',
    message: `Proofs are not run in the browser.${extra} Use \`speckl verify\` with Z3 to check them.`,
  };
}

export function longLineDiagnostic(source: string): BrowserDiagnostic | null {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > LONG_LINE_CHARS) {
      return {
        level: 'warning',
        line: i + 1,
        message: `Line ${i + 1} is ${lines[i].length} characters on one line. The compiler still runs. If it stalls, it is stopped so the page stays responsive.`,
      };
    }
  }
  return null;
}

export function tooBigDiagnostic(bytes: number, maxBytes: number): BrowserDiagnostic {
  return {
    level: 'error',
    message: `This spec is ${formatBytes(bytes)}, above the ${formatBytes(maxBytes)} playground limit, so it was not compiled. That keeps the page responsive. The speckl command on your machine has no such limit.`,
  };
}

export function binaryDiagnostic(): BrowserDiagnostic {
  return {
    level: 'error',
    message: 'This input looks like binary data (a NUL byte, or many control characters), not a Speckl spec. Paste the spec as text.',
  };
}

export function emptyDiagnostic(): BrowserDiagnostic {
  return {
    level: 'info',
    message: 'Nothing to compile yet. Load an example, or start with a line like `speck Name { }`.',
  };
}

export function noSpeckDiagnostic(): BrowserDiagnostic {
  return {
    level: 'error',
    line: 1,
    message: 'No `speck Name {` block was found, so there is nothing to compile. Comments and blank lines are skipped until a speck starts.',
  };
}

export function noAgentDiagnostic(): BrowserDiagnostic {
  return {
    level: 'info',
    message: 'This spec has no agent block, so it does not drive an agent.',
  };
}

export function compilerLoadFailureMessage(): string {
  return "Couldn't load the compiler. Refresh the page. Your spec is still in the editor.";
}

export function z3InfoDiagnostic(): BrowserDiagnostic {
  return proofNote(0);
}

export function timeoutMessage(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `Compilation was stopped after ${seconds} seconds so the page would stay responsive. The spec may be too large, too deeply nested, or contain a very long line.`;
}

export function workerCrashMessage(): string {
  return 'The compiler stopped unexpectedly. The spec may have hit a browser limit. Try a smaller spec. Your text is still in the editor.';
}
