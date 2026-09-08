/* speckl-studio frontend */
const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  sessions: [],
  specs: [],
  streaming: false,
  currentAssistantEl: null,
};

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
  }
}

async function saveAndCompile() {
  const name = $('specSelect').value || prompt('Spec name (PascalCase):');
  if (!name || !state.sessionId) return;
  const out = $('toolOutput');
  out.textContent = 'compiling…';
  out.className = 'output';
  const res = await fetch(`/api/spec/${state.sessionId}/${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: $('specEditor').value }),
  });
  const data = await res.json();
  out.textContent = data.report;
  out.className = 'output ' + (data.ok ? 'pass' : 'fail');
  await refreshSpecs();
  $('specSelect').value = name;
}

async function verify() {
  const name = $('specSelect').value || $('specEditor').value.match(/speck\s+(\w+)/)?.[1];
  if (!name || !state.sessionId) {
    $('toolOutput').textContent = 'No spec selected or found in the editor.';
    return;
  }
  const out = $('toolOutput');
  out.textContent = `verifying ${name} (running z3)…`;
  out.className = 'output warn';
  const res = await fetch('/api/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: state.sessionId, name }),
  });
  const data = await res.json();
  out.textContent = data.report;
  out.className = 'output ' + (data.ok ? 'pass' : 'fail');
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
$('specEditor').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    saveAndCompile();
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