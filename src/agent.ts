import { looksLikeToolCall, rescueToolCalls } from './rescue.js';
import { toolByName, toolDefs, type ToolContext } from './tools.js';
import type { AgentEvent, LlmClient, Message, ToolCall } from './types.js';

export interface RunOptions {
  llm: LlmClient;
  models: string[]; // primary first, then fallbacks
  systemPrompt: string;
  history: Message[];
  userMessage: string;
  toolCtx: ToolContext;
  maxTurns: number;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface RunResult {
  text: string; // everything the user saw streamed, trimmed
  tools: Array<{ name: string; ok: boolean }>;
  turns: number;
  model: string;
  fellBack: boolean;
  stopReason: 'answered' | 'max_turns';
}

/**
 * Holds back the first few characters of a turn so that text which is really a tool call
 * (a model that "prints" its call) is not streamed to the user before the rescue parser sees it.
 */
class StreamGate {
  private buf = '';
  private mode: 'undecided' | 'pass' | 'hold' = 'undecided';
  full = '';
  emitted = false;
  constructor(
    private emit: (d: string) => void,
    private toolNames: string[],
  ) {}

  private out(s: string) {
    if (!s) return;
    this.emitted = true;
    this.emit(s);
  }

  push(d: string) {
    this.full += d;
    if (this.mode === 'pass') return this.out(d);
    this.buf += d;
    if (this.mode === 'hold' || this.buf.trimStart().length < 24) return;
    this.decide();
  }

  private decide() {
    if (looksLikeToolCall(this.buf, this.toolNames)) this.mode = 'hold';
    else {
      this.mode = 'pass';
      this.out(this.buf);
      this.buf = '';
    }
  }

  /** Called when the turn ends. Returns text that was held back and has not been emitted. */
  finish(): string {
    if (this.mode === 'undecided') this.decide();
    return this.mode === 'hold' ? this.buf : '';
  }
}

export async function runAgent(o: RunOptions): Promise<RunResult> {
  const defs = toolDefs();
  const names = defs.map((d) => d.name);
  const messages: Message[] = [
    { role: 'system', content: o.systemPrompt },
    ...o.history,
    { role: 'user', content: o.userMessage },
  ];
  const called: Array<{ name: string; ok: boolean }> = [];
  let modelIdx = 0;
  let fellBack = false;
  let shown = '';
  const show = (d: string) => {
    shown += d;
    o.emit({ type: 'text', delta: d });
  };

  for (let turn = 1; turn <= o.maxTurns; turn++) {
    o.emit({ type: 'status', message: turn === 1 ? 'thinking' : 'working', turn });
    if (turn > 1 && shown && !shown.endsWith('\n')) show('\n\n');

    let gate!: StreamGate;
    let result;
    for (;;) {
      gate = new StreamGate(show, names);
      try {
        result = await o.llm.chat({ model: o.models[modelIdx], messages, tools: defs, signal: o.signal }, (d) => gate.push(d));
        if (!result.content.trim() && !result.toolCalls.length) throw new Error('empty response from model');
        break;
      } catch (err) {
        const canFallBack = modelIdx < o.models.length - 1 && !gate.emitted && !o.signal?.aborted;
        if (!canFallBack) throw err;
        modelIdx++;
        fellBack = true;
        o.emit({ type: 'status', message: 'fallback', model: o.models[modelIdx], reason: (err as Error).message.slice(0, 120) });
      }
    }

    const held = gate.finish();
    let calls: ToolCall[] = result.toolCalls;
    if (!calls.length) {
      const r = rescueToolCalls(result.content, names);
      if (r.calls.length) {
        calls = r.calls;
        o.emit({ type: 'status', message: 'rescued tool call from text', count: calls.length });
        // text that was streamed already can't be unsent; held text is replaced by its cleaned remainder
        if (held && r.text) show(r.text);
      } else if (held) show(held);
    } else if (held) {
      show(held);
    }

    if (!calls.length) {
      return { text: shown.trim(), tools: called, turns: turn, model: o.models[modelIdx], fellBack, stopReason: 'answered' };
    }

    messages.push({ role: 'assistant', content: result.content || null, toolCalls: calls });
    for (const c of calls) {
      let out: unknown;
      let ok = true;
      const tool = toolByName(c.name);
      try {
        if (!tool) throw new Error(`unknown tool "${c.name}"`);
        out = tool.run(c.arguments, o.toolCtx);
      } catch (err) {
        ok = false;
        out = { error: (err as Error).message };
      }
      called.push({ name: c.name, ok });
      const json = JSON.stringify(out);
      o.emit({ type: 'tool', name: c.name, args: c.arguments, ok, summary: json.slice(0, 200) });
      messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content: json.slice(0, 6000) });
    }
  }

  const msg = "I couldn't finish that within the step limit. Please try a narrower question.";
  show(shown ? `\n\n${msg}` : msg);
  return { text: shown.trim(), tools: called, turns: o.maxTurns, model: o.models[modelIdx], fellBack, stopReason: 'max_turns' };
}
