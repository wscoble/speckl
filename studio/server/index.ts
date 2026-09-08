import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPrompt } from './prompt.ts';
import { chatStream, type ChatMsg } from './ollama.ts';
import { Sessions } from './session.ts';
import { listExamples, readExample, writeSpec, verifySpec, readSpecFile, listSpecs } from './tools.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');
const SESSIONS_DIR = process.env.SPECKL_SESSIONS ?? join(__dirname, '..', 'sessions');
const MODEL = process.env.OLLAMA_MODEL ?? 'glm-5.3-flash:cloud';
const PORT = Number(process.env.PORT ?? 7333);
const MAX_TOOL_ITERATIONS = 16;

const sessions = new Sessions(SESSIONS_DIR);
const SYSTEM_PROMPT = buildSystemPrompt();

// ---------- tool dispatch ----------

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_examples',
      description: 'List the bundled example SpeckDL specs available to read as references.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_example',
      description: 'Read the full SpeckDL source of an example spec by name.',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'Example name, e.g. "ToggleSwitch"' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_spec',
      description: 'Save a SpeckDL spec to the session workspace and compile it (TypeScript target) to get diagnostics. Always use this to persist a spec - never just print it.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Spec name in PascalCase, e.g. "RateLimiter" (also the filename without extension)' },
          content: { type: 'string', description: 'Full SpeckDL source' },
        },
        required: ['name', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_spec',
      description: 'Compile a saved spec to Z3 and run the real solver. Returns per-file verdicts (pass/violated/contradictory/error) with counterexample traces when violated.',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'Name of a previously written spec' } }, required: ['name'] },
    },
  },
];

async function dispatchTool(sessionDir: string, name: string, args: any): Promise<string> {
  try {
    switch (name) {
      case 'list_examples':
        return listExamples();
      case 'read_example':
        return await readExample(String(args?.name ?? ''));
      case 'write_spec':
        return (await writeSpec(sessionDir, String(args?.name ?? ''), String(args?.content ?? ''))).report;
      case 'verify_spec':
        return (await verifySpec(sessionDir, String(args?.name ?? ''))).report;
      default:
        return `Error: unknown tool "${name}"`;
    }
  } catch (e: any) {
    return `Tool error: ${e?.message ?? e}`;
  }
}

// ---------- chat loop ----------

async function handleChat(req, res, body) {
  const { sessionId, message } = body ?? {};
  if (!sessionId || !(await sessions.exists(sessionId))) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown sessionId' }));
    return;
  }
  if (!message || typeof message !== 'string') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'message required' }));
    return;
  }

  const sessionDir = join(SESSIONS_DIR, sessionId);
  const messages = await sessions.messages(sessionId);
  if (messages.length === 0) {
    messages.push({ role: 'system', content: SYSTEM_PROMPT });
    await sessions.touch(sessionId, message.slice(0, 60));
  }
  messages.push({ role: 'user', content: message });
  await sessions.saveMessages(sessionId, messages);

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      let content = '';
      const toolCalls: any[] = [];
      for await (const chunk of chatStream(MODEL, messages, TOOL_DEFS)) {
        if (chunk.error) throw new Error(chunk.error);
        const msg = chunk.message ?? {};
        if (msg.content) {
          content += msg.content;
          send({ type: 'delta', text: msg.content });
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) toolCalls.push(tc);
        }
        if (chunk.done) {
          if (chunk.done_reason) send({ type: 'meta', doneReason: chunk.done_reason, totalDuration: chunk.total_duration });
        }
      }

      if (toolCalls.length === 0) {
        messages.push({ role: 'assistant', content });
        await sessions.saveMessages(sessionId, messages);
        send({ type: 'done' });
        res.end();
        return;
      }

      messages.push({ role: 'assistant', content, tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const fnName = tc.function?.name ?? 'unknown';
        let args = tc.function?.arguments ?? {};
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        send({ type: 'tool_call', name: fnName, args: summarizeArgs(fnName, args) });
        const result = await dispatchTool(sessionDir, fnName, args);
        send({ type: 'tool_result', name: fnName, result: truncate(result, 4000) });
        messages.push({ role: 'tool', tool_name: fnName, content: result });
      }
      // loop continues so the model reacts to tool results
    }
    send({ type: 'error', error: `Exceeded ${MAX_TOOL_ITERATIONS} tool iterations` });
  } catch (e: any) {
    send({ type: 'error', error: e?.message ?? String(e) });
  }
  await sessions.saveMessages(sessionId, messages);
  res.end();
}

function summarizeArgs(name: string, args: any) {
  if (name === 'write_spec') {
    const content = String(args?.content ?? '');
    return { name: args?.name, contentLength: content.length, preview: content.slice(0, 400) };
  }
  return args;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s;
}

// ---------- http plumbing ----------

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function readBody(req): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, path: string) {
  const file = join(WEB_DIR, path === '/' ? 'index.html' : path);
  const real = file.startsWith(WEB_DIR) ? file : WEB_DIR + '/index.html';
  try {
    const st = await stat(real);
    if (!st.isFile()) throw new Error('not a file');
    const data = await readFile(real);
    res.writeHead(200, { 'content-type': MIME[extname(real)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  try {
    if (path === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model: MODEL, examples: listExamples().split('\n').length - 1 }));
      return;
    }
    if (path === '/api/sessions' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await sessions.list()));
      return;
    }
    if (path === '/api/sessions' && req.method === 'POST') {
      const body = await readBody(req);
      const meta = await sessions.create(body?.title);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(meta));
      return;
    }
    let m: RegExpExecArray | null;
    if ((m = path.match(/^\/api\/session\/([\w-]+)$/))) {
      const id = m[1];
      if (!(await sessions.exists(id))) {
        res.writeHead(404);
        res.end();
        return;
      }
      const sessionDir = join(SESSIONS_DIR, id);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          meta: await sessions.loadMeta(id),
          messages: (await sessions.messages(id)).filter((msg) => msg.role !== 'system'),
          specs: await listSpecs(sessionDir),
        }),
      );
      return;
    }
    if ((m = path.match(/^\/api\/spec\/([\w-]+)\/([\w]+)$/))) {
      const [_, id, name] = m;
      const specPath = join(SESSIONS_DIR, id, 'specs', `${name}.speckdl`);
      if (req.method === 'GET') {
        const content = await readSpecFile(specPath);
        if (content === null) {
          res.writeHead(404);
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(content);
        }
        return;
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const result = await writeSpec(join(SESSIONS_DIR, id), name, String(body?.content ?? ''));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: result.ok, report: result.report }));
        return;
      }
    }
    if (path === '/api/verify' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await verifySpec(join(SESSIONS_DIR, String(body?.sessionId ?? '')), String(body?.name ?? ''));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    if (path === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      await handleChat(req, res, body);
      return;
    }
    if (path.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    await serveStatic(res, path);
  } catch (e: any) {
    console.error(e);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: e?.message ?? String(e) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`speckl-studio  →  http://localhost:${PORT}`);
  console.log(`model: ${MODEL}   repo: ${process.env.SPECKL_REPO ?? '~/Projects/speckl'}`);
});