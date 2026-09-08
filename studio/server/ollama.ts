const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}
export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

/** Stream an Ollama /api/chat call as NDJSON chunks. */
export async function* chatStream(
  model: string,
  messages: ChatMsg[],
  tools: unknown[],
  signal?: AbortSignal,
): AsyncGenerator<any> {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`ollama ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf.trim());
}