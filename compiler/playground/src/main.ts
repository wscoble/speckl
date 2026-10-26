import {
  presentDiagnostic,
  timeoutMessage,
  workerCrashMessage,
} from '../../src/browser/diagnostics';
import {
  COMPILE_TIMEOUT_MS,
  DEBOUNCE_MS,
  MAX_SOURCE_BYTES,
  formatBytes,
  sourceByteLength,
} from '../../src/browser/limits';
import {
  RequestGate,
  applyHash,
  cursorLineCol,
  hashForSource,
  historyMode,
  lineRange,
  orderOutputPaths,
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
const output = document.querySelector<HTMLElement>('#output')!;
const trunc = document.querySelector<HTMLElement>('#trunc')!;
const fileSelect = document.querySelector<HTMLSelectElement>('#file')!;
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
let worker: Worker | null = null;
/** Blob URL of the bundled worker, so a cancelled compile can spawn again offline. */
let workerObjectUrl: string | null = null;
let compileTimer = 0;
let debounceTimer = 0;
let persistTimer = 0;
let killed = false;
let markedOutput = false;
const gate = new RequestGate();

function showBanner(text: string, kind: string): void {
  banner.hidden = false;
  banner.dataset.kind = kind;
  banner.textContent = text;
}

function clearBanner(kind?: string): void {
  if (kind && banner.dataset.kind !== kind) return;
  banner.hidden = true;
  banner.textContent = '';
  delete banner.dataset.kind;
}

function updateCursor(): void {
  const pos = cursorLineCol(editor.value, editor.selectionStart ?? 0);
  cursor.textContent = `Line ${pos.line}, column ${pos.column}`;
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
  const next = hashForSource(source);
  if (!next.hash) {
    if (next.reason) showBanner(next.reason, 'share');
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
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
  const url = location.pathname + location.search + next.hash;
  if (mode === 'push') {
    history.pushState(null, '', url);
    lastPushAt = Date.now();
  } else {
    history.replaceState(null, '', url);
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

  fileMap = new Map(result.files.map((f) => [f.path, f]));
  const ordered = orderOutputPaths(result.files.map((f) => f.path));
  fileSelect.replaceChildren();
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
    if (!res.ok) return;
    const code = await res.text();
    workerObjectUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  } catch {
    // The module URL still works until the network goes away.
  }
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
      diagnostics: [{ level: 'error', message: workerCrashMessage() }],
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
      editor.focus();
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
  if (shouldConfirmDiscard(editor.value !== loadedSource)) {
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

function flash(btn: HTMLButtonElement, label: string): void {
  const previous = btn.textContent;
  btn.textContent = label;
  window.setTimeout(() => {
    btn.textContent = previous;
  }, 1400);
}

function bind(): void {
  for (const example of EXAMPLES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost';
    btn.dataset.example = example.id;
    btn.textContent = example.title;
    btn.title = example.blurb;
    btn.addEventListener('click', () => void onExample(example.id));
    examplesEl.appendChild(btn);
  }

  editor.addEventListener('input', () => {
    if (banner.dataset.kind === 'hash') clearBanner('hash');
    updateCursor();
    markExamples();
    scheduleCompile();
    schedulePersist();
  });
  editor.addEventListener('keyup', updateCursor);
  editor.addEventListener('click', updateCursor);
  editor.addEventListener('paste', (ev) => {
    const text = ev.clipboardData?.getData('text/plain') ?? '';
    if (sourceByteLength(text) > MAX_SOURCE_BYTES) {
      ev.preventDefault();
      showBanner(
        `That paste is ${formatBytes(sourceByteLength(text))}, above the ${formatBytes(MAX_SOURCE_BYTES)} limit, so it was not inserted.`,
        'share',
      );
    }
  });
  editor.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      compileNow();
    }
  });
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === editor) updateCursor();
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

  window.addEventListener('hashchange', () => {
    const decision = applyHash(location.hash, editor.value);
    if (decision.action === 'ignore') return;
    if (decision.action === 'reject') {
      showBanner(decision.message, 'hash');
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
    if (decision.action === 'reject') showBanner(decision.message, 'hash');
    return EXAMPLES[0].source;
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
  if (editor.value !== initial) {
    markExamples();
    updateCursor();
    persist(editor.value, 'edit');
    compileNow();
  } else {
    setSource(initial, 'boot');
  }
  document.querySelector('#boot')?.remove();
}

void boot().catch(() => {
  const el = document.querySelector('#boot');
  if (el) el.textContent = 'The playground failed to start. Reload the page.';
  app.hidden = false;
});
