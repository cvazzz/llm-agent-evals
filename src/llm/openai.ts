import type { ChatRequest, ChatResult, LlmClient, Message, ToolCall } from '../types.js';

export interface OpenAiOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function toWireMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' };
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {}; // malformed arguments: the tool will report missing parameters back to the model
  }
}

/** Client for any OpenAI-compatible /chat/completions endpoint (streaming SSE, with JSON fallback). */
export class OpenAiClient implements LlmClient {
  readonly name = 'openai-compatible';
  constructor(private opts: OpenAiOptions) {}

  async chat(req: ChatRequest, onText?: (d: string) => void): Promise<ChatResult> {
    const f = this.opts.fetchImpl ?? fetch;
    const signals = [AbortSignal.timeout(this.opts.timeoutMs)];
    if (req.signal) signals.push(req.signal);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toWireMessages(req.messages),
      stream: true,
      temperature: 0.2,
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: t }));
      body.tool_choice = 'auto';
    }
    const res = await f(`${this.opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`LLM HTTP ${res.status}: ${detail}`);
    }
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      const j = (await res.json()) as any;
      const msg = j?.choices?.[0]?.message ?? {};
      const content: string = msg.content ?? '';
      if (content) onText?.(content);
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any, i: number) => ({
        id: c.id ?? `call_${i}`,
        name: c.function?.name ?? '',
        arguments: parseArgs(c.function?.arguments ?? ''),
      }));
      return { content, toolCalls };
    }
    return this.readStream(res, onText);
  }

  private async readStream(res: Response, onText?: (d: string) => void): Promise<ChatResult> {
    if (!res.body) throw new Error('LLM response has no body');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let content = '';
    const acc = new Map<number, { id: string; name: string; args: string }>();
    const handle = (line: string) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        return; // keep-alive or partial garbage
      }
      const delta = j?.choices?.[0]?.delta;
      if (!delta) return;
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        onText?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = acc.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        acc.set(idx, cur);
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
      }
    }
    if (buf.trim()) handle(buf.trim());
    const toolCalls = [...acc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: parseArgs(c.args) }))
      .filter((c) => c.name);
    return { content, toolCalls };
  }
}
