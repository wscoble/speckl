// Compile one spec from a string with the real compiler. In Node this uses
// the real filesystem (a temp directory). The playground bundle aliases
// `fs`, `path`, `os`, `crypto`, and `child_process` to browser shims, so the
// same function runs in a Web Worker. It does not run the Z3 solver.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { compileSpec, type CompileOptions } from '../compile.js';
import { lower } from '../ir/lower.js';
import { parseSpeckContent } from '../parser.js';
import {
  binaryDiagnostic,
  dedupeDiagnostics,
  emptyDiagnostic,
  fromIR,
  locateDiagnostic,
  cleanErrorMessage,
  longLineDiagnostic,
  noAgentDiagnostic,
  noSpeckDiagnostic,
  sortDiagnostics,
  tooBigDiagnostic,
  uncheckedDiagnostics,
  z3InfoDiagnostic,
  type BrowserDiagnostic,
} from './diagnostics.js';
import { looksBinary, MAX_SOURCE_BYTES, sourceByteLength } from './limits.js';

export interface OutputFile {
  path: string;
  text: string;
  truncated: boolean;
}

export interface BrowserCompileResult {
  ok: boolean;
  diagnostics: BrowserDiagnostic[];
  files: OutputFile[];
  elapsedMs: number;
}

export interface CompileSourceOptions {
  /** A compiler target. Unknown values compile as `all`. */
  target?: string;
  verifyDepth?: number;
  maxBytes?: number;
  maxFileChars?: number;
  maxTotalChars?: number;
}

const TARGETS = new Set<CompileOptions['target']>([
  'typescript', 'z3', 'rust', 'go', 'protobuf', 'k8s', 'openapi', 'camel', 'elm', 'agent', 'all', 'all-ir',
]);

export function normalizeTarget(value: string | undefined): CompileOptions['target'] {
  if (value && TARGETS.has(value as CompileOptions['target'])) return value as CompileOptions['target'];
  return 'all';
}

interface Captured<T> {
  value?: T;
  error?: unknown;
  notes: BrowserDiagnostic[];
}

function captureConsole<T>(fn: () => T): Captured<T> {
  const notes: BrowserDiagnostic[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = (...args: unknown[]) => {
    const message = args.map(String).join(' ').trim();
    if (message) notes.push({ level: 'warning', message });
  };
  console.error = (...args: unknown[]) => {
    const message = args.map(String).join(' ').trim();
    if (message) notes.push({ level: 'error', message });
  };
  try {
    return { value: fn(), notes };
  } catch (error) {
    return { error, notes };
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const child = path.join(dir, String(name));
    if (fs.statSync(child).isDirectory()) out.push(...walk(child));
    else out.push(child);
  }
  return out;
}

function readOutputs(outDir: string, options: CompileSourceOptions): OutputFile[] {
  const maxFile = options.maxFileChars ?? 400_000;
  const maxTotal = options.maxTotalChars ?? 2_000_000;
  const files: OutputFile[] = [];
  let total = 0;
  for (const abs of walk(outDir)) {
    const rel = path.relative(outDir, abs).split(path.sep).join('/');
    if (total >= maxTotal) {
      files.push({ path: rel, text: '', truncated: true });
      continue;
    }
    let text = '';
    let truncated = false;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      files.push({ path: rel, text: '', truncated: true });
      continue;
    }
    if (text.includes('\0')) {
      files.push({ path: rel, text: '(binary file omitted)', truncated: true });
      continue;
    }
    if (text.length > maxFile) {
      text = text.slice(0, maxFile);
      truncated = true;
    }
    if (total + text.length > maxTotal) {
      text = text.slice(0, Math.max(0, maxTotal - total));
      truncated = true;
    }
    total += text.length;
    files.push({ path: rel, text, truncated });
  }
  return files;
}

function finish(
  started: number,
  ok: boolean,
  diagnostics: BrowserDiagnostic[],
  files: OutputFile[],
): BrowserCompileResult {
  return {
    ok,
    diagnostics: sortDiagnostics(dedupeDiagnostics(diagnostics)),
    files,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Compile `source`. Never throws: bad input comes back as diagnostics.
 * `ok` is false when any diagnostic is an error.
 */
export function compileSource(source: string, options: CompileSourceOptions = {}): BrowserCompileResult {
  const started = Date.now();
  try {
    return compileSourceInner(source, options, started);
  } catch (err) {
    return finish(started, false, [locateDiagnostic(source, cleanErrorMessage(err))], []);
  }
}

function compileSourceInner(
  source: string,
  options: CompileSourceOptions,
  started: number,
): BrowserCompileResult {
  const maxBytes = options.maxBytes ?? MAX_SOURCE_BYTES;
  const bytes = sourceByteLength(source);
  if (!Number.isFinite(maxBytes) || maxBytes < 1 || bytes > maxBytes) {
    return finish(started, false, [tooBigDiagnostic(bytes, Number.isFinite(maxBytes) ? maxBytes : MAX_SOURCE_BYTES)], []);
  }
  if (looksBinary(source)) {
    return finish(started, false, [binaryDiagnostic()], []);
  }
  if (source.trim() === '') {
    return finish(started, true, [emptyDiagnostic()], []);
  }

  const diagnostics: BrowserDiagnostic[] = [];
  const longLine = longLineDiagnostic(source);
  if (longLine) diagnostics.push(longLine);

  let ast;
  try {
    ast = parseSpeckContent(source, 'input.speckdl');
  } catch (err) {
    diagnostics.push(locateDiagnostic(source, cleanErrorMessage(err)));
    return finish(started, false, diagnostics, []);
  }
  if (ast.specks.length === 0) {
    diagnostics.push(noSpeckDiagnostic());
    return finish(started, false, diagnostics, []);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speckl-play-'));
  const file = path.join(dir, 'input.speckdl');
  const out = path.join(dir, 'out');
  try {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(file, source, 'utf8');

    const lowered = captureConsole(() => lower(ast, { filePath: file, resolveImports: false }));
    diagnostics.push(...lowered.notes.map((n) => locateDiagnostic(source, n.message).line
      ? { ...n, line: locateDiagnostic(source, n.message).line }
      : n));
    if (lowered.error) {
      diagnostics.push(locateDiagnostic(source, cleanErrorMessage(lowered.error)));
      return finish(started, false, diagnostics, []);
    }
    for (const d of lowered.value?.diagnostics ?? []) diagnostics.push(fromIR(source, d));

    const target = normalizeTarget(options.target);
    const compiled = captureConsole(() => compileSpec(file, {
      outputDir: out,
      bomFormat: 'both',
      target,
      verifyDepth: options.verifyDepth ?? 10,
    }));
    for (const note of compiled.notes) {
      const located = locateDiagnostic(source, note.message);
      diagnostics.push(located.line ? { ...note, line: located.line } : note);
    }
    const files = readOutputs(out, options);
    if (compiled.error) {
      const message = cleanErrorMessage(compiled.error);
      const redundant = message.startsWith('agent block is invalid')
        && diagnostics.some((d) => d.level === 'error' && d.message.includes('agent'));
      if (!redundant) diagnostics.push(locateDiagnostic(source, message));
    } else if ((target === 'all' || target === 'agent') && !files.some((f) => f.path.endsWith('AGENTS.md'))) {
      diagnostics.push(noAgentDiagnostic());
    }
    if (files.some((f) => f.path.endsWith('.smt2'))) diagnostics.push(z3InfoDiagnostic());
    diagnostics.push(...uncheckedDiagnostics(files));
    const ok = !compiled.error && !diagnostics.some((d) => d.level === 'error');
    return finish(started, ok, diagnostics, files);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp directory must not hide the compile result.
    }
  }
}
