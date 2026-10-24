import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgent } from '../src/agent.js';
import { MockClient } from '../src/llm/mock.js';
import { OpenAiClient } from '../src/llm/openai.js';
import { buildSystemPrompt } from '../src/prompts.js';
import type { AgentEvent, ChatResult, LlmClient } from '../src/types.js';
import { ctx, testDb, tmpDir } from './helpers.js';

function setup() {
  const t = tmpDir();
  const db = testDb(t.dir);
  const events: AgentEvent[] = [];
  const base = (over: Record<string, unknown> = {}) => ({
    llm: new MockClient(),
    models: ['mock-1'],
    systemPrompt: buildSystemPrompt('v2', { facts: [], today: '2025-06-30' }),
    history: [],
    userMessage: 'How much revenue did we make in the last 30 days?',
    toolCtx: ctx(db),
    maxTurns: 6,
    emit: (e: AgentEvent) => events.push(e),
    ...over,
  });
  return { t, db, events, base };
}

test('multi-turn tool loop: calls tool, streams text, answers', async () => {
  const s = setup();
  try {
    const r = await runAgent(s.base());
    assert.equal(r.stopReason, 'answered');
    assert.deepEqual(r.tools, [{ name: 'sales_summary', ok: true }]);
    assert.equal(r.turns, 2);
    assert.match(r.text, /^Revenue for 2025-06-01 to 2025-06-30|^Revenue for/);
    assert.ok(s.events.some((e) => e.type === 'tool'));
    assert.ok(s.events.filter((e) => e.type === 'text').length > 1, 'text arrives in several chunks');
    assert.ok(!/sales_summary/.test(r.text), 'v2 answer does not leak tool names');
  } finally {
    s.db.close();
    s.t.cleanup();
  }
});

test('turn cap: a model that never stops calling tools is cut off', async () => {
  const s = setup();
  try {
    let n = 0;
    const looper: LlmClient = {
      name: 'looper',
      async chat(): Promise<ChatResult> {
        return { content: '', toolCalls: [{ id: `c${n++}`, name: 'product_lookup', arguments: { low_stock: true } }] };
      },
    };
    const r = await runAgent(s.base({ llm: looper, maxTurns: 3 }));
    assert.equal(r.stopReason, 'max_turns');
    assert.equal(r.tools.length, 3);
    assert.match(r.text, /step limit/);
  } finally {
    s.db.close();
    s.t.cleanup();
  }
});

test('fallback: failing primary falls back to the backup model', async () => {
  const s = setup();
  try {
    const r = await runAgent(s.base({ models: ['mock-fail-1', 'mock-1'] }));
    assert.ok(r.fellBack);
    assert.equal(r.model, 'mock-1');
    assert.equal(r.stopReason, 'answered');
    assert.ok(s.events.some((e) => e.type === 'status' && e.message === 'fallback'));
  } finally {
    s.db.close();
    s.t.cleanup();
  }
});

test('no fallback configured: the error propagates', async () => {
  const s = setup();
  try {
    await assert.rejects(runAgent(s.base({ models: ['mock-fail-1'] })), /simulated/);
  } finally {
    s.db.close();
    s.t.cleanup();
  }
});

test('rescue: a model that prints the call as text still gets its tool executed, and the call text is not shown', async () => {
  const s = setup();
  try {
    const r = await runAgent(s.base({ models: ['mock-text-1'] }));
    assert.deepEqual(r.tools, [{ name: 'sales_summary', ok: true }]);
    assert.ok(!r.text.includes('tool_call'));
    assert.match(r.text, /Revenue/);
    assert.ok(s.events.some((e) => e.type === 'status' && /rescued/.test(String(e.message))));
  } finally {
    s.db.close();
    s.t.cleanup();
  }
});

test('propose then confirm through the agent: nothing is written until the user confirms', async () => {
  const s = setup();
  try {
    const price = () => (s.db.prepare("SELECT price FROM products WHERE sku='MUG-002'").get() as any).price;
    const r1 = await runAgent(s.base({ userMessage: 'Change the price of MUG-002 to 25.90' }));
    assert.deepEqual(r1.tools.map((t) => t.name), ['propose_price_change']);
    assert.match(r1.text, /confirm/i);
    assert.equal(price(), 27.5);
    const pending = s.db.prepare("SELECT id, summary FROM pending_actions WHERE status='pending'").get() as any;
    const r2 = await runAgent(
      s.base({
        userMessage: 'yes, confirm',
        toolCtx: ctx(s.db, { lastUserMessage: 'yes, confirm' }),
        systemPrompt: buildSystemPrompt('v2', { facts: [], pending, today: '2025-06-30' }),
      }),
    );
    assert.deepEqual(r2.tools, [{ name: 'confirm_action', ok: true }]);
    assert.equal(price(), 25.9);
  } finally {
    s.db.close();
    s.t.cleanup();
  }
});

test('openai client: assembles streamed text and fragmented tool-call arguments', async () => {
  const sse = [
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'sales_', arguments: '{"da' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'summary', arguments: 'ys":7}' } }] } }] },
  ]
    .map((o) => `data: ${JSON.stringify(o)}\n\n`)
    .join('') + 'data: [DONE]\n\n';
  let seenBody: any;
  let seenAuth = '';
  const fakeFetch = (async (url: string, init: any) => {
    seenBody = JSON.parse(init.body);
    seenAuth = init.headers.authorization;
    assert.equal(url, 'http://x.test/v1/chat/completions');
    // split the payload in awkward chunks to test line buffering
    const enc = new TextEncoder().encode(sse);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.slice(0, 37));
        c.enqueue(enc.slice(37));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  const client = new OpenAiClient({ baseUrl: 'http://x.test/v1', apiKey: 'k', timeoutMs: 5000, fetchImpl: fakeFetch });
  const deltas: string[] = [];
  const res = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'sales_summary', description: 'd', parameters: { type: 'object' } }] }, (d) => deltas.push(d));
  assert.equal(res.content, 'Hello');
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.deepEqual(res.toolCalls, [{ id: 'call_1', name: 'sales_summary', arguments: { days: 7 } }]);
  assert.equal(seenBody.stream, true);
  assert.equal(seenBody.tools[0].function.name, 'sales_summary');
  assert.equal(seenAuth, 'Bearer k');
});

test('openai client: HTTP errors surface with status', async () => {
  const fakeFetch = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
  const client = new OpenAiClient({ baseUrl: 'http://x.test', apiKey: '', timeoutMs: 1000, fetchImpl: fakeFetch });
  await assert.rejects(client.chat({ model: 'm', messages: [], tools: [] }), /LLM HTTP 429/);
});
