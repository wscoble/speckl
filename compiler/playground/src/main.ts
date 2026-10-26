import {
  compilerLoadFailureMessage,
  presentDiagnostic,
  timeoutMessage,
  workerCrashMessage,
} from '../../src/browser/diagnostics';
import {
  COMPILE_TIMEOUT_MS,
  DEBOUNCE_MS,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_LINES,
  formatBytes,
  sourceByteLength,
  sourceLineCount,
} from '../../src/browser/limits';
import { hashRejectNotice } from '../../src/browser/share';
import {
  RequestGate,
  applyHash,
  cursorLineCol,
  hashForSource,
  historyMode,
  lineRange,
  filesForTarget,
  preferredOutput,
  shouldConfirmDiscard,
  type HistoryReason,
} from '../../src/browser/session';
import type { BrowserCompileResult, OutputFile } from '../../src/browser/compile-source';
import { EXAMPLES, matchingExampleId } from './examples';
import workerUrl from './worker.ts?worker&url';

const DRAFT_KEY = 'speckl.playground.spec';
const THEME_KEY = 'speckl.playground.theme';

const app = document.querySelector<HTMLElement>('#app')!;
const editor = document.querySelector<HTMLTextAreaElement>('#spec')!;
const cursor = document.querySelector<HTMLElement>('#cursor')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const banner = document.querySelector<HTMLElement>('#banner')!;
const diagnostics = document.querySelector<HTMLElement>('#diagnostics')!;
const errorChip = document.querySelector<HTMLButtonElement>('#error-chip')!;
const output = document.querySelector<HTMLElement>('#output')!;
const staleNote = document.querySelector<HTMLElement>('#stale')!;
const trunc = document.querySelector<HTMLElement>('#trunc')!;
const fileSelect = document.querySelector<HTMLSelectElement>('#file')!;
const fileBar = document.querySelector<HTMLElement>('.file-bar')!;
const targetSelect = document.querySelector<HTMLSelectElement>('#target')!;
const quick = document.querySelector<HTMLElement>('#quick')!;
const examplesEl = document.querySelector<HTMLElement>('#examples')!;
const shareBtn = document.querySelector<HTMLButtonElement>('#share')!;
const copyBtn = document.querySelector<HTMLButtonElement>('#copy-file')!;
const themeBtn = document.querySelector<HTMLButtonElement>('#theme')!;
const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
const dialogBody = document.querySelector<HTMLElement>('#dialog-body')!;
const keepBtn = document.querySelector<HTMLButtonElement>('#dialog-keep')!;
const discardBtn = document.querySelector<HTMLButtonElement>('#dialog-discard')!;

const params = new URLSearchParams(location.search);
const debugSpin = params.get('spin') === '1';

function compileTimeout(): number {
  if (!debugSpin) return COMPILE_TIMEOUT_MS;
  const n = Number(params.get('timeout'));
  if (!Number.isFinite(n)) return COMPILE_TIMEOUT_MS;
  return Math.min(COMPILE_TIMEOUT_MS, Math.max(50, Math.floor(n)));
}

let loadedSource = '';
let lastPushAt = 0;
let fileMap = new Map<string, OutputFile>();
/** Files from the last compile that succeeded. A later failure must not present them as current. */
let lastGood: OutputFile[] | null = null;
/** Speck name those files belong to. A rename must not keep the previous spec's files. */
let lastGoodName: string | null = null;
let sawWorkerMessage = false;
let compilerMissing = false;
let worker: Worker | null = null;
/** Blob URL of the bundled worker, so a cancelled compile can spawn again offline. */
let workerObjectUrl: string | null = null;
let compileTimer = 0;
let debounceTimer = 0;
let persistTimer = 0;
let killed = false;
let markedOutput = false;
const gate = new RequestGate();

function speckNameOf(source: string): string | null {
  const match = source.match(/(?:^|\n)\s*speck\s+([A-Za-z][\w-]*)\b/);
  return match ? match[1] : null;
}

function showBanner(text: string, kind: string): void {
  banner.hidden = false;
  banner.dataset.kind = kind;
  banner.textContent = text;
  if (kind === 'hash') window.scrollTo(0, 0);
}

function clearBanner(kind?: string): void {
  if (kind && banner.dataset.kind !== kind) return;
  banner.hidden = true;
  banner.textContent = '';
  delete banner.dataset.kind;
}

let uiFrame = 0;
function scheduleUi(): void {
  if (uiFrame) return;
  uiFrame = window.requestAnimationFrame(() => {
    uiFrame = 0;
    updateCursor();
    markExamples();
  });
}

function updateCursor(): void {
  const pos = cursorLineCol(editor.value, editor.selectionStart ?? 0);
  cursor.textContent = `Line ${pos.line}, column ${pos.column}`;
}

/** UTF-16 length is a lower bound on UTF-8 bytes, and 3 bytes is the upper bound for one unit. */
function overByteLimit(text: string): boolean {
  if (text.length > MAX_SOURCE_BYTES) return true;
  if (text.length * 3 <= MAX_SOURCE_BYTES) return false;
  // ASCII is one byte per unit. Skip TextEncoder so a large paste stays off the main thread.
  if (!/[^\u0000-\u007F]/.test(text)) return false;
  return sourceByteLength(text) > MAX_SOURCE_BYTES;
}

function markExamples(): void {
  const id = matchingExampleId(editor.value);
  for (const btn of examplesEl.querySelectorAll<HTMLButtonElement>('button')) {
    btn.setAttribute('aria-pressed', btn.dataset.example === id ? 'true' : 'false');
  }
}

function readDraft(): string | null {
  try {
    return sessionStorage.getItem(DRAFT_KEY);
  } catch {
    return null;
  }
}

function writeDraft(source: string): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, source);
  } catch {
    // Private mode and full storage still leave the spec in the editor.
  }
}

function persist(source: string, reason: HistoryReason): void {
  writeDraft(source);
  const state = { speckl: source };
  const bare = location.pathname + location.search;
  // The default example and example switches stay off the URL. A multi-kilobyte
  // hash is written when the user edits, or when they click Share.
  if (reason === 'boot') {
    const hash = location.hash;
    const keep = !!hash && hash !== '#' && applyHash(hash, '').action === 'load';
    history.replaceState(state, '', keep ? bare + hash : bare);
    return;
  }
  if (reason === 'example') {
    history.pushState(state, '', bare);
    lastPushAt = Date.now();
    return;
  }
  const next = hashForSource(source);
  if (!next.hash) {
    if (next.reason) showBanner(next.reason, 'share');
    if (location.hash) history.replaceState(state, '', bare);
    return;
  }
  clearBanner('share');
  const mode = historyMode({
    lastPushAt,
    now: Date.now(),
    hashChanged: location.hash !== next.hash,
    reason,
  });
  if (mode === 'skip') return;
  const url = bare + next.hash;
  if (mode === 'push') {
    history.pushState(state, '', url);
    lastPushAt = Date.now();
  } else {
    history.replaceState(state, '', url);
  }
}

function focusLine(line: number): void {
  const range = lineRange(editor.value, line);
  if (!range) return;
  editor.focus();
  editor.setSelectionRange(range.start, range.end);
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 20;
  editor.scrollTop = Math.max(0, (line - 3) * lineHeight);
  updateCursor();
}

function showFile(p: string): void {
  const file = fileMap.get(p);
  if (!file) {
    output.textContent = '';
    trunc.hidden = true;
    return;
  }
  output.textContent = file.text;
  trunc.hidden = !file.truncated;
  trunc.textContent = file.truncated
    ? 'This file is shortened here. The compiler emitted more than the page will show.'
    : '';
  for (const btn of quick.querySelectorAll<HTMLButtonElement>('button')) {
    btn.setAttribute('aria-current', btn.dataset.path === p ? 'true' : 'false');
  }
}

function render(result: BrowserCompileResult, state: 'done' | 'error' | 'timeout'): void {
  const errors = result.diagnostics.filter((d) => d.level === 'error').length;
  const warnings = result.diagnostics.filter((d) => d.level === 'warning').length;
  const visual = state === 'timeout' ? 'timeout' : errors > 0 ? 'error' : 'done';
  statusEl.dataset.state = visual;
  if (state === 'timeout') {
    statusEl.textContent = 'Compilation stopped so the page stays responsive.';
  } else if (errors > 0) {
    statusEl.textContent = `Did not compile. ${errors} error${errors === 1 ? '' : 's'}${warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`;
  } else if (result.files.length === 0) {
    statusEl.textContent = 'Nothing compiled.';
  } else {
    statusEl.textContent = `Compiled ${result.files.length} file${result.files.length === 1 ? '' : 's'} in ${result.elapsedMs} ms${warnings ? `. ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`;
  }

  diagnostics.replaceChildren();
  if (result.diagnostics.length === 0) {
    const li = document.createElement('li');
    const p = document.createElement('p');
    p.className = 'info';
    p.textContent = 'No diagnostics.';
    li.appendChild(p);
    diagnostics.appendChild(li);
  }
  for (const d of result.diagnostics) {
    const li = document.createElement('li');
    const text = presentDiagnostic(d);
    if (d.line) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = d.level;
      btn.textContent = text;
      const line = d.line;
      btn.addEventListener('click', () => focusLine(line));
      li.appendChild(btn);
    } else {
      const p = document.createElement('p');
      p.className = d.level;
      p.textContent = text;
      li.appendChild(p);
    }
    diagnostics.appendChild(li);
  }

  const errorList = result.diagnostics.filter((d) => d.level === 'error');
  const firstError = errorList.find((d) => d.line);
  if (errorList.length > 0) {
    errorChip.hidden = false;
    const n = errorList.length;
    const line = firstError?.line;
    errorChip.textContent = line
      ? `${n} error${n === 1 ? '' : 's'}, line ${line}`
      : `${n} error${n === 1 ? '' : 's'}`;
    errorChip.onclick = () => {
      if (line) focusLine(line);
    };
  } else {
    errorChip.hidden = true;
    errorChip.textContent = '';
    errorChip.onclick = null;
  }

  const failed = state === 'timeout' || errors > 0;
  const currentName = speckNameOf(editor.value);
  if (!failed && result.files.length > 0) {
    lastGood = result.files;
    lastGoodName = currentName;
  } else if (failed && currentName !== lastGoodName) {
    lastGood = null;
    lastGoodName = null;
  }
  const showingStale = failed && !!lastGood && lastGood.length > 0;
  const files = showingStale ? lastGood! : failed ? [] : result.files;
  staleNote.hidden = !showingStale;
  output.classList.toggle('stale', showingStale);
  fileBar.classList.toggle('dimmed', showingStale);

  fileMap = new Map(files.map((f) => [f.path, f]));
  const ordered = filesForTarget(files.map((f) => f.path), targetSelect.value);
  fileSelect.replaceChildren();
  if (ordered.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Load an example to see a compiled file';
    fileSelect.appendChild(opt);
  }
  for (const p of ordered) {
    const opt = document.createElement('option');
    opt.value = p;
    const file = fileMap.get(p);
    opt.textContent = file?.truncated ? `${p} (shortened)` : p;
    fileSelect.appendChild(opt);
  }
  quick.replaceChildren();
  for (const p of ordered.slice(0, 5)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost';
    btn.dataset.path = p;
    btn.textContent = p.split('/').pop() ?? p;
    btn.title = p;
    btn.addEventListener('click', () => {
      fileSelect.value = p;
      showFile(p);
    });
    quick.appendChild(btn);
  }
  copyBtn.disabled = ordered.length === 0;
  const pick = preferredOutput(ordered);
  if (pick) {
    fileSelect.value = pick;
    showFile(pick);
  } else {
    output.textContent = errors > 0 ? 'No files were emitted.' : 'No output for this spec.';
    trunc.hidden = true;
  }
  if (!markedOutput) {
    performance.mark('speckl-first-output');
    markedOutput = true;
  }
}

async function cacheWorkerSource(): Promise<void> {
  // Dev serves the worker as a graph of modules. The production file is one
  // script, so a blob URL keeps working after the network drops.
  if (!import.meta.env.PROD) return;
  try {
    const res = await fetch(workerUrl);
    if (!res.ok) {
      compilerMissing = true;
      return;
    }
    const code = await res.text();
    workerObjectUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  } catch {
    compilerMissing = true;
  }
}

function showCompilerLoadFailure(): void {
  const bootEl = document.querySelector('#boot');
  if (bootEl) bootEl.textContent = compilerLoadFailureMessage();
  render({
    ok: false,
    diagnostics: [{ level: 'error', message: compilerLoadFailureMessage() }],
    files: [],
    elapsedMs: 0,
  }, 'error');
}

function spawnWorker(): Worker {
  if (workerObjectUrl) return new Worker(workerObjectUrl, { type: 'module' });
  return new Worker(workerUrl, { type: 'module' });
}

function compileNow(): void {
  const source = editor.value;
  const target = targetSelect.value;
  const id = gate.issue();
  window.clearTimeout(compileTimer);
  killed = true;
  worker?.terminate();
  killed = false;
  statusEl.dataset.state = 'compiling';
  statusEl.textContent = 'Compiling…';
  worker = spawnWorker();
  worker.onmessage = (ev: MessageEvent<{ id: number; result: BrowserCompileResult }>) => {
    if (!ev.data || !gate.isCurrent(ev.data.id)) return;
    sawWorkerMessage = true;
    window.clearTimeout(compileTimer);
    const result = ev.data.result;
    const errors = result.diagnostics.some((d) => d.level === 'error');
    render(result, errors || !result.ok ? 'error' : 'done');
  };
  worker.onerror = () => {
    if (killed || !gate.isCurrent(id)) return;
    window.clearTimeout(compileTimer);
    render({
      ok: false,
      diagnostics: [{ level: 'error', message: sawWorkerMessage ? workerCrashMessage() : compilerLoadFailureMessage() }],
      files: [],
      elapsedMs: 0,
    }, 'error');
  };
  const limit = compileTimeout();
  compileTimer = window.setTimeout(() => {
    if (!gate.isCurrent(id)) return;
    killed = true;
    worker?.terminate();
    worker = null;
    render({
      ok: false,
      diagnostics: [{ level: 'error', message: timeoutMessage(limit) }],
      files: [],
      elapsedMs: limit,
    }, 'timeout');
  }, limit);
  worker.postMessage({ id, source, target, spin: debugSpin });
}

function scheduleCompile(): void {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(compileNow, DEBOUNCE_MS);
}

function schedulePersist(): void {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => persist(editor.value, 'edit'), DEBOUNCE_MS + 200);
}

function setSource(source: string, reason: HistoryReason): void {
  editor.value = source;
  loadedSource = source;
  markExamples();
  updateCursor();
  if (reason === 'example') {
    editor.setSelectionRange(0, 0);
    editor.scrollTop = 0;
    if (document.activeElement === editor) editor.blur();
    window.scrollTo(0, 0);
  }
  persist(source, reason);
  compileNow();
}

function confirmDiscard(message: string): Promise<boolean> {
  dialogBody.textContent = message;
  dialog.showModal();
  keepBtn.focus();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      resolve(ok);
      if (!ok) editor.focus();
    };
    keepBtn.onclick = () => finish(false);
    discardBtn.onclick = () => finish(true);
    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      finish(false);
    }, { once: true });
  });
}

let dialogBusy = false;

async function loadSource(source: string, reason: HistoryReason, label: string): Promise<void> {
  if (source === editor.value || dialogBusy) return;
  if (shouldConfirmDiscard(editor.value, loadedSource)) {
    dialogBusy = true;
    try {
      const ok = await confirmDiscard(`Load ${label}? The text in the editor will be replaced.`);
      if (!ok) {
        persist(editor.value, 'navigation');
        return;
      }
    } finally {
      dialogBusy = false;
    }
  }
  setSource(source, reason);
}

async function onExample(id: string): Promise<void> {
  const example = EXAMPLES.find((ex) => ex.id === id);
  if (!example) return;
  await loadSource(example.source, 'example', example.title);
}

function themeLabel(): string {
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme === 'dark') return 'Theme: dark';
  if (theme === 'light') return 'Theme: light';
  return 'Theme: match system';
}

function cycleTheme(): void {
  const theme = document.documentElement.getAttribute('data-theme');
  const next = theme === 'dark' ? 'light' : theme === 'light' ? null : 'dark';
  if (next) document.documentElement.setAttribute('data-theme', next);
  else document.documentElement.removeAttribute('data-theme');
  try {
    localStorage.setItem(THEME_KEY, next ?? 'system');
  } catch {
    // The toggle still applies for this page view.
  }
  themeBtn.textContent = themeLabel();
  themeBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const COPY_FLASH_MS = 2000;

function flash(btn: HTMLButtonElement, label: string): void {
  if (!btn.dataset.rest) btn.dataset.rest = btn.textContent ?? '';
  const pending = Number(btn.dataset.flash || '0');
  if (pending) window.clearTimeout(pending);
  btn.textContent = label;
  const deadline = performance.now() + COPY_FLASH_MS;
  const tick = () => {
    const left = deadline - performance.now();
    if (left <= 0) {
      btn.textContent = btn.dataset.rest ?? '';
      delete btn.dataset.flash;
      return;
    }
    const id = window.setTimeout(tick, Math.min(50, left));
    btn.dataset.flash = String(id);
  };
  tick();
}

function bind(): void {
  for (const example of EXAMPLES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost';
    btn.dataset.example = example.id;
    const title = document.createElement('span');
    title.className = 'ex-title';
    title.textContent = example.title;
    const blurb = document.createElement('span');
    blurb.className = 'ex-blurb';
    blurb.textContent = example.blurb;
    btn.append(title, blurb);
    btn.title = example.blurb;
    btn.addEventListener('click', () => void onExample(example.id));
    examplesEl.appendChild(btn);
  }

  editor.addEventListener('input', () => {
    if (banner.dataset.kind === 'hash') clearBanner('hash');
    scheduleUi();
    scheduleCompile();
    schedulePersist();
  });
  editor.addEventListener('keyup', scheduleUi);
  editor.addEventListener('click', scheduleUi);
  editor.addEventListener('paste', (ev) => {
    const text = ev.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    if (overByteLimit(text)) {
      ev.preventDefault();
      showBanner(
        `That paste is ${formatBytes(text.length > MAX_SOURCE_BYTES ? text.length : sourceByteLength(text))}, above the ${formatBytes(MAX_SOURCE_BYTES)} limit, so it was not inserted.`,
        'share',
      );
      return;
    }
    const lines = sourceLineCount(text);
    if (lines > MAX_SOURCE_LINES) {
      ev.preventDefault();
      showBanner(
        `That paste is ${lines.toLocaleString('en-US')} lines, above the ${MAX_SOURCE_LINES.toLocaleString('en-US')} line limit, so it was not inserted.`,
        'share',
      );
      return;
    }
    // One assignment. Letting the browser insert thousands of lines as
    // separate edits blocks the page for seconds.
    ev.preventDefault();
    const start = editor.selectionStart ?? editor.value.length;
    const end = editor.selectionEnd ?? start;
    const next = start === 0 && end === editor.value.length
      ? text
      : editor.value.slice(0, start) + text + editor.value.slice(end);
    editor.value = next;
    const caret = start + text.length;
    editor.selectionStart = caret;
    editor.selectionEnd = caret;
    clearBanner('share');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  editor.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      compileNow();
    }
  });
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === editor) scheduleUi();
  });

  targetSelect.addEventListener('change', () => compileNow());
  fileSelect.addEventListener('change', () => showFile(fileSelect.value));
  themeBtn.textContent = themeLabel();
  themeBtn.addEventListener('click', cycleTheme);

  shareBtn.addEventListener('click', () => void (async () => {
    persist(editor.value, 'edit');
    const next = hashForSource(editor.value);
    if (!next.hash) {
      showBanner(next.reason ?? 'This spec cannot be shared in a link.', 'share');
      return;
    }
    const url = location.origin + location.pathname + location.search + next.hash;
    const ok = await copyText(url);
    if (ok) flash(shareBtn, 'Copied link');
    else showBanner('The link could not be copied. Select the address bar instead.', 'share');
  })());

  copyBtn.addEventListener('click', () => void (async () => {
    const file = fileMap.get(fileSelect.value);
    if (!file) return;
    const ok = await copyText(file.text);
    if (ok) flash(copyBtn, 'Copied');
    else showBanner('The file could not be copied.', 'share');
  })());

  window.addEventListener('popstate', (ev: PopStateEvent) => {
    const state = ev.state as { speckl?: string } | null;
    if (typeof state?.speckl !== 'string' || state.speckl === editor.value) return;
    editor.value = state.speckl;
    loadedSource = state.speckl;
    markExamples();
    updateCursor();
    clearBanner('hash');
    compileNow();
  });

  window.addEventListener('hashchange', () => {
    const decision = applyHash(location.hash, editor.value);
    if (decision.action === 'ignore') return;
    if (decision.action === 'reject') {
      showBanner(hashRejectNotice(decision.message, true), 'hash');
      history.replaceState({ speckl: editor.value }, '', location.pathname + location.search);
      return;
    }
    void loadSource(decision.source, 'navigation', 'the spec from this link');
  });
}

function initialSource(): string {
  const hash = location.hash;
  if (hash && hash !== '#') {
    const decision = applyHash(hash, '');
    if (decision.action === 'load') return decision.source;
    if (decision.action === 'reject') {
      const draft = readDraft();
      const kept = draft !== null;
      showBanner(hashRejectNotice(decision.message, kept), 'hash');
      if (kept) return draft;
      return EXAMPLES[0].source;
    }
  }
  const draft = readDraft();
  if (draft !== null) return draft;
  return EXAMPLES[0].source;
}

async function boot(): Promise<void> {
  bind();
  const initial = initialSource();
  // Show the spec before the worker script is cached. A keystroke in that
  // gap must not be replaced by the example a moment later.
  editor.value = initial;
  loadedSource = initial;
  markExamples();
  updateCursor();
  app.hidden = false;
  await cacheWorkerSource();
  if (compilerMissing) {
    showCompilerLoadFailure();
    document.querySelector('#boot')?.remove();
    return;
  }
  if (editor.value !== initial) {
    markExamples();
    updateCursor();
    persist(editor.value, 'edit');
    compileNow();
  } else {
    setSource(initial, 'boot');
  }
  document.querySelector('#boot')?.remove();
  window.scrollTo(0, 0);
  editor.scrollTop = 0;
}

void boot().catch(() => {
  const el = document.querySelector('#boot');
  if (el) el.textContent = compilerLoadFailureMessage();
  app.hidden = false;
});
