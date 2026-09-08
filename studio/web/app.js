/* speckl-studio frontend */
const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  sessions: [],
  specs: [],
  checks: [],
  streaming: false,
  currentAssistantEl: null,
  autoTimer: null,
  autoRunning: false,
  dirty: false,
};

// ---------- SpeckDL syntax highlighting ----------
const SPECKL_KEYWORDS = new Set((
  'speck state init invariant action next verify constraint event type import interface ' +
  'service oneof transition input output provenance review derives satisfies author source ' +
  'bom require return emit Always Eventually always eventually forall in and or not implies ' +
  'version hash via from clause ref depth license proto_package go_package event_suffix ' +
  'k8s_group k8s_version'
).split(' '));
const SPECKL_TYPES = new Set(['Nat', 'Int', 'Real', 'Bool', 'String', 'Bytes', 'List', 'Set', 'Map']);

const SPECKL_TOKEN_RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*")|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_][A-Za-z0-9_]*'?)\b|([{}()\[\];:,.<>|=+\-*\/&!'])/g;

function highlightSpeck(src) {
  let out = '';
  let last = 0;
  SPECKL_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = SPECKL_TOKEN_RE.exec(src))) {
    out += esc(src.slice(last, m.index));
    const [full, comment, str, num, ident, op] = m;
    if (comment !== undefined) out += `<span class="tk-comment">${esc(full)}</span>`;
    else if (str !== undefined) out += `<span class="tk-string">${esc(full)}</span>`;
    else if (num !== undefined) out += `<span class="tk-num">${esc(full)}</span>`;
    else if (ident !== undefined) {
      if (SPECKL_KEYWORDS.has(ident)) out += `<span class="tk-kw">${esc(full)}</span>`;
      else if (SPECKL_TYPES.has(ident)) out += `<span class="tk-type">${esc(full)}</span>`;
      else out += esc(full);
    } else out += `<span class="tk-op">${esc(full)}</span>`;
    last = m.index + full.length;
  }
  out += esc(src.slice(last));
  return out + '\n'; // trailing newline keeps last line height consistent
}

const isSpecklSource = (s) => /\bspeck\s+[A-Za-z_]\w*\s*\{/.test(s);

function updateHighlight() {
  const ta = $('specEditor');
  const code = $('specHighlight').firstElementChild;
  code.innerHTML = ta.value ? highlightSpeck(ta.value) : '';
  syncHighlightScroll();
}

function syncHighlightScroll() {
  const ta = $('specEditor');
  const pre = $('specHighlight');
  pre.scrollTop = ta.scrollTop;
  pre.scrollLeft = ta.scrollLeft;
  syncInlineScroll();
}

// ---------- inline verification (wallaby-style) ----------

const VERDICT_STYLE = {
  pass: { icon: '✔', cls: 'inl-pass' },
  violated: { icon: '✘', cls: 'inl-violated' },
  contradictory: { icon: '✘', cls: 'inl-violated' },
  error: { icon: '⚠', cls: 'inl-warn' },
  unexpected: { icon: '⚠', cls: 'inl-warn' },
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

/** Map each check to a source line: its verify block, else its invariant, else the speck. */
function annotateChecks(checks) {
  const layer = $('specInline');
  layer.innerHTML = '';
  if (!checks.length) return;
  const ta = $('specEditor');
  const lines = ta.value.split('\n');
  const lh = parseFloat(getComputedStyle($('specHighlight')).lineHeight) || 20;
  const pre = $('specHighlight');

  for (const c of checks) {
    // which speck does this file belong to? (e.g. "CallSession.smt2")
    const speckName = c.file.replace(/\.ir\.smt2$|\.smt2$/, '');
    let target = -1;
    const cm = c.check.match(/Always\((\w+)\)/);
    if (cm) {
      target = lines.findIndex((l) => new RegExp(`verify\\s+Always\\(${cm[1]}\\)`).test(l));
      if (target < 0) target = lines.findIndex((l) => new RegExp(`invariant\\s+${cm[1]}\\s*\\{`).test(l));
    }
    if (target < 0) {
      target = lines.findIndex((l) => new RegExp(`speck\\s+${speckName}\\s*\\{`).test(l));
    }
    if (target < 0) continue;

    const style = VERDICT_STYLE[c.verdict] ?? VERDICT_STYLE.unexpected;
    const label = verdictLabel(c);
    const col = Math.min(lines[target].replace(/\t/g, '    ').length + 2, 72);
    const tooltip = [label, `solver: ${c.got} (expect ${c.expect})`, c.detail ?? ''].filter(Boolean).join('\n');

    const el = document.createElement('div');
    el.className = `inl ${style.cls}`;
    el.style.top = `${14 + target * lh}px`;
    el.style.left = `calc(32px + ${col}ch)`;
    el.textContent = label;
    el.title = tooltip;
    layer.appendChild(el);

    const dot = document.createElement('span');
    dot.className = `inl-dot ${style.cls}`;
    dot.style.top = `${14 + target * lh + (lh - 8) / 2}px`;
    dot.title = tooltip;
    layer.appendChild(dot);
  }
}

function clearAnnotations() {
  $('specInline').innerHTML = '';
}

function markAnnotationsStale() {
  if ($('specInline').childNodes.length) $('specInline').classList.add('stale');
}

// live verification: re-run save+compile+verify shortly after the user stops typing,
// wallaby-style. One run at a time; only runs when the text changed since the last run.
const AUTO_VERIFY_DELAY = 1200;
function scheduleAutoVerify() {
  clearTimeout(state.autoTimer);
  state.autoTimer = setTimeout(autoVerify, AUTO_VERIFY_DELAY);
}

async function autoVerify() {
  if (!state.dirty) return;
  if (state.autoRunning) {
    scheduleAutoVerify(); // a run is in flight; re-check after it lands
    return;
  }
  const name = $('specSelect').value || $('specEditor').value.match(/speck\s+(\w+)/)?.[1];
  if (!name || !state.sessionId || !$('specEditor').value.trim()) return;
  state.dirty = false;
  state.autoRunning = true;
  setLiveStatus('busy');
  try {
    await saveAndCompile(true);
  } catch {
    state.autoRunning = false;
    setLiveStatus('err');
  }
}

function setLiveStatus(s) {
  const el = $('liveStatus');
  if (!el) return;
  const map = {
    ok: ['live-ok', '● verified'],
    fail: ['live-fail', '● failures'],
    busy: ['live-busy', '⟳ verifying'],
    err: ['live-fail', '● error'],
    stale: ['live-stale', '● edited'],
  };
  const [cls, text] = map[s] ?? map.stale;
  el.className = 'live ' + cls;
  el.textContent = text;
}

function syncInlineScroll() {
  const ta = $('specEditor');
  $('specInline').style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
}

// highlight SpeckDL code blocks inside rendered assistant messages
function highlightChatCode(scopeEl) {
  for (const codeEl of scopeEl.querySelectorAll('.body pre code')) {
    const src = codeEl.textContent;
    if (isSpecklSource(src)) codeEl.innerHTML = highlightSpeck(src);
  }
}

// ---------- tiny markdown renderer ----------
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderMd(text) {
  const parts = [];
  const re = /```(\w*)\n([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    parts.push(paragraph(esc(text.slice(last, m.index))));
    parts.push(`<pre><code>${esc(m[2])}</code></pre>`);
    last = m.index + m[0].length;
  }
  parts.push(paragraph(esc(text.slice(last))));
  return parts.join('');
}
function paragraph(s) {
  if (!s.trim()) return '';
  return (
    '<p>' +
    s
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/\n/g, '<br>') +
    '</p>'
  );
}

// ---------- sessions ----------
async function loadSessions() {
  const list = await (await fetch('/api/sessions')).json();
  state.sessions = list;
  const sel = $('sessionSelect');
  sel.innerHTML = '';
  for (const s of list) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.title} (${s.id.slice(0, 8)})`;
    sel.appendChild(opt);
  }
}

async function openSession(id) {
  state.sessionId = id;
  $('sessionSelect').value = id;
  $('chatLog').innerHTML = '';
  $('emptyState').style.display = id ? 'none' : '';
  if (!id) return;
  const data = await (await fetch(`/api/session/${id}`)).json();
  state.specs = data.specs ?? [];
  renderSpecSelect();
  for (const msg of data.messages ?? []) {
    if (msg.role === 'user') addMsg('user', msg.content);
    else if (msg.role === 'assistant') addMsg('assistant', msg.content);
  }
  scrollChat();
}

async function newSession() {
  const meta = await (
    await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  ).json();
  await loadSessions();
  await openSession(meta.id);
  $('chatInput').focus();
}

// ---------- chat rendering ----------
function addMsg(kind, content) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  if (kind === 'user') {
    div.textContent = content;
  } else if (kind === 'assistant') {
    div.innerHTML = `<div class="who">assistant</div><div class="body">${renderMd(content)}</div>`;
    highlightChatCode(div);
  } else if (kind === 'toolcall') {
    div.innerHTML = content;
  } else if (kind === 'error') {
    div.textContent = content;
  }
  $('chatLog').appendChild(div);
  scrollChat();
  return div;
}

function scrollChat() {
  const sc = $('chatScroll');
  sc.scrollTop = sc.scrollHeight;
}

function ensureAssistantMsg() {
  if (!state.currentAssistantEl) {
    state.currentAssistantEl = addMsg('assistant', '');
    state.currentAssistantEl.dataset.raw = '';
  }
  return state.currentAssistantEl;
}

// re-render every streamed assistant element as markdown in place
function finalizeAssistantEls() {
  for (const el of document.querySelectorAll('.msg.assistant[data-raw]')) {
    el.innerHTML = `<div class="who">assistant</div><div class="body">${renderMd(el.dataset.raw)}</div>`;
    highlightChatCode(el);
    delete el.dataset.raw;
  }
}

// ---------- chat send (SSE) ----------
async function sendMessage() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text || state.streaming) return;
  input.value = '';
  if (!state.sessionId) await newSession();
  $('emptyState').style.display = 'none';
  addMsg('user', text);
  setStreaming(true);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, message: text }),
    });
    if (!res.ok || !res.body) throw new Error(`chat failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 2);
        if (!frame.startsWith('data:')) continue;
        handleChatEvent(JSON.parse(frame.slice(5).trim()));
      }
    }
  } catch (e) {
    addMsg('error', `⚠ ${e.message}`);
  } finally {
    finalizeAssistantEls();
    state.currentAssistantEl = null;
    setStreaming(false);
    refreshSpecs();
  }
}

function handleChatEvent(ev) {
  switch (ev.type) {
    case 'delta': {
      const el = ensureAssistantMsg();
      el.dataset.raw += ev.text;
      const body = el.querySelector('.body');
      if (body) body.textContent = el.dataset.raw;
      scrollChat();
      break;
    }
    case 'tool_call': {
      state.currentAssistantEl = null; // break the delta target
      const detail =
        ev.name === 'write_spec'
          ? `${ev.args?.name} (${ev.args?.contentLength} bytes)`
          : Object.values(ev.args ?? {}).join(', ');
      addMsg('toolcall', `<b>⚙ ${esc(ev.name)}</b> ${esc(detail)}`);
      if (ev.name === 'write_spec' && ev.args?.preview) {
        $('specSelect').value = ev.args.name;
        // full content is fetched after done
      }
      break;
    }
    case 'tool_result': {
      const last = $('chatLog').querySelector('.msg.toolcall:last-child');
      if (last && !last.querySelector('.result')) {
        const r = document.createElement('div');
        r.className = 'result';
        const first = String(ev.result).split('\n').find((l) => l.trim()) ?? '';
        r.textContent = '→ ' + first.slice(0, 120);
        last.appendChild(r);
      }
      const out = $('toolOutput');
      out.textContent = `[${ev.name}]\n${ev.result}`;
      out.className = 'output' + (/ALL PASS/.test(ev.result) ? ' pass' : /VIOLATED|FAILURES|Error|error/.test(ev.result) ? ' fail' : '');
      break;
    }
    case 'error':
      addMsg('error', `⚠ ${ev.error}`);
      break;
  }
}

function setStreaming(on) {
  state.streaming = on;
  $('sendBtn').disabled = on;
  $('sendBtn').textContent = on ? '…' : 'Send';
}

// ---------- specs ----------
function renderSpecSelect() {
  const sel = $('specSelect');
  const cur = sel.value;
  sel.innerHTML = '<option value=""> - spec - </option>';
  for (const name of state.specs) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  if (cur && state.specs.includes(cur)) sel.value = cur;
}

async function refreshSpecs() {
  if (!state.sessionId) return;
  const data = await (await fetch(`/api/session/${state.sessionId}`)).json();
  const before = state.specs.join(',');
  state.specs = data.specs ?? [];
  renderSpecSelect();
  if (state.specs.join(',') !== before && state.specs.length > 0) {
    await openSpec(state.specs[state.specs.length - 1]);
  }
}

async function openSpec(name) {
  if (!name || !state.sessionId) return;
  const res = await fetch(`/api/spec/${state.sessionId}/${name}`);
  if (res.ok) {
    $('specEditor').value = await res.text();
    $('specSelect').value = name;
    updateHighlight();
    clearAnnotations();
    state.dirty = true; // fresh spec, not yet verified in this view
    setLiveStatus('stale');
    scheduleAutoVerify();
  }
}

async function saveAndCompile(quiet) {
  const name = $('specSelect').value || $('specEditor').value.match(/speck\s+(\w+)/)?.[1] || prompt('Spec name (PascalCase):');
  if (!name || !state.sessionId) return;
  const out = $('toolOutput');
  if (!quiet) {
    out.textContent = 'compiling…';
    out.className = 'output';
  }
  const res = await fetch(`/api/spec/${state.sessionId}/${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: $('specEditor').value }),
  });
  const data = await res.json();
  if (!quiet) {
    out.textContent = data.report;
    out.className = 'output ' + (data.ok ? 'pass' : 'fail');
  }
  await refreshSpecs();
  $('specSelect').value = name;
  if (data.ok) await verify(quiet);
}

async function verify(quiet) {
  const name = $('specSelect').value || $('specEditor').value.match(/speck\s+(\w+)/)?.[1];
  if (!name || !state.sessionId) {
    if (!quiet) $('toolOutput').textContent = 'No spec selected or found in the editor.';
    return;
  }
  const out = $('toolOutput');
  if (!quiet) {
    out.textContent = `verifying ${name} (running z3)…`;
    out.className = 'output warn';
  }
  const res = await fetch('/api/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: state.sessionId, name }),
  });
  const data = await res.json();
  if (!quiet) {
    out.textContent = data.report;
    out.className = 'output ' + (data.ok ? 'pass' : 'fail');
  }
  state.checks = data.checks ?? [];
  annotateChecks(state.checks);
  $('specInline').classList.remove('stale');
  state.autoRunning = false;
  setLiveStatus(data.ok ? 'ok' : 'fail');
}

// ---------- boot ----------
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
$('newSession').addEventListener('click', newSession);
$('sessionSelect').addEventListener('change', (e) => openSession(e.target.value));
$('specSelect').addEventListener('change', (e) => openSpec(e.target.value));
$('saveBtn').addEventListener('click', saveAndCompile);
$('verifyBtn').addEventListener('click', verify);
$('specEditor').addEventListener('input', () => {
  updateHighlight();
  markAnnotationsStale(); // keep last verdicts visible, dimmed, until the solver catches up
  state.dirty = true;
  setLiveStatus('stale');
  scheduleAutoVerify();
});
$('specEditor').addEventListener('scroll', syncHighlightScroll);
$('specEditor').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    saveAndCompile();
  }
  // Tab inserts spaces instead of leaving the editor
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    const ta = e.target;
    const { selectionStart: s, selectionEnd: en, value } = ta;
    ta.value = value.slice(0, s) + '    ' + value.slice(en);
    ta.selectionStart = ta.selectionEnd = s + 4;
    updateHighlight();
  }
});

(async function init() {
  const health = await (await fetch('/api/health')).json();
  $('modelBadge').textContent = health.model;
  await loadSessions();
  const first = state.sessions[0];
  if (first) await openSession(first.id);
  $('chatInput').focus();
})();