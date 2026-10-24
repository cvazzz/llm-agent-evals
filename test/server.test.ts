import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/server.js';
import { testConfig, tmpDir } from './helpers.js';

async function post(base: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const raw = await res.text();
  const events = res.headers.get('content-type')?.includes('ndjson') ? raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { res, raw, events, done: events.find((e: any) => e.type === 'done') };
}

async function withApp(env: Record<string, string>, fn: (base: string) => Promise<void>) {
  const t = tmpDir();
  const app = createApp(testConfig(t.dir, env));
  const port = await app.listen(0, '127.0.0.1');
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await app.close();
    t.cleanup();
  }
}

test('streams NDJSON events: status, text, tool, done', async () => {
  await withApp({}, async (base) => {
    const r = await post(base, { user: 'ana', message: 'Top 3 products by units in the last 30 days' });
    assert.equal(r.res.status, 200);
    assert.match(r.res.headers.get('content-type')!, /application\/x-ndjson/);
    const types = r.events.map((e: any) => e.type);
    assert.equal(types[0], 'status');
    assert.ok(types.includes('text') && types.includes('tool'));
    assert.equal(types[types.length - 1], 'done');
    assert.equal(r.done.ok, true);
    assert.deepEqual(r.done.tools, ['top_products']);
  });
});

test('validation, auth, and 404', async () => {
  await withApp({ API_TOKEN: 'secret' }, async (base) => {
    assert.equal((await post(base, { user: 'a', message: 'hi' })).res.status, 401);
    const h = { authorization: 'Bearer secret' };
    assert.equal((await post(base, 'not json', h)).res.status, 400);
    assert.equal((await post(base, { user: '../x', message: 'hi' }, h)).res.status, 400);
    assert.equal((await post(base, { user: 'a', message: '' }, h)).res.status, 400);
    assert.equal((await post(base, { user: 'a', message: 'hi', prompt_version: 'v9' }, h)).res.status, 400);
    assert.equal((await post(base, { user: 'a', message: 'x'.repeat(20000) }, h)).res.status, 413);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});

test('cache hit on repeated read question; counter only counts model calls', async () => {
  await withApp({ DAILY_LIMIT: '2' }, async (base) => {
    const q = { user: 'bo', message: 'Which items are low on stock?' };
    const a = await post(base, q);
    assert.equal(a.done.cached, false);
    assert.equal(a.done.usage_remaining, 1);
    const b = await post(base, q);
    assert.equal(b.done.cached, true);
    assert.equal(b.done.text, a.done.text);
    assert.equal(b.done.usage_remaining, 1);
  });
});

test('daily limit is enforced per user', async () => {
  await withApp({ DAILY_LIMIT: '1' }, async (base) => {
    assert.equal((await post(base, { user: 'cy', message: 'hello' })).done.ok, true);
    const over = await post(base, { user: 'cy', message: 'hello there', no_cache: true });
    assert.equal(over.done.ok, false);
    assert.equal(over.done.error, 'daily_limit_reached');
    assert.equal((await post(base, { user: 'dee', message: 'hello' })).done.ok, true);
  });
});

test('fallback model is used when the primary fails', async () => {
  await withApp({ LLM_MODEL: 'mock-fail-1', LLM_FALLBACK_MODEL: 'mock-1' }, async (base) => {
    const r = await post(base, { user: 'ed', message: 'Total sales in March 2025?' });
    assert.equal(r.done.ok, true);
    assert.equal(r.done.fell_back, true);
    assert.ok(r.events.some((e: any) => e.type === 'status' && e.message === 'fallback'));
  });
});

test('primary failure without fallback ends the stream with an error done event', async () => {
  await withApp({ LLM_MODEL: 'mock-fail-1' }, async (base) => {
    const r = await post(base, { user: 'fay', message: 'hello' });
    assert.equal(r.done.ok, false);
    assert.equal(r.done.error, 'model_error');
  });
});

test('per-user memory and propose-then-confirm across requests; confirmed write clears cache', async () => {
  await withApp({}, async (base) => {
    const u = 'gus';
    const r0 = await post(base, { user: u, message: 'Remember that I prefer weekly summaries' });
    assert.equal(r0.done.ok, true);
    const stockBefore = await post(base, { user: u, message: 'What\'s the price of the Gooseneck Kettle?' });
    assert.match(stockBefore.done.text, /44\.50/);

    const p = await post(base, { user: u, message: 'Change the price of GEA-004 to 40' });
    assert.deepEqual(p.done.tools, ['propose_price_change']);
    // someone else's "yes" does nothing
    const other = await post(base, { user: 'hal', message: 'yes, confirm' });
    assert.deepEqual(other.done.tools, []);
    const c = await post(base, { user: u, message: 'yes, confirm' });
    assert.deepEqual(c.done.tools, ['confirm_action']);
    const after = await post(base, { user: u, message: 'What\'s the price of the Gooseneck Kettle?' });
    assert.equal(after.done.cached, false, 'cache was cleared by the write');
    assert.match(after.done.text, /40\.00/);
  });
});
