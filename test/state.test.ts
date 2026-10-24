import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { AnswerCache } from '../src/cache.js';
import { MemoryStore, extractFact, isValidUserId } from '../src/memory.js';
import { UsageCounter } from '../src/usage.js';
import { tmpDir } from './helpers.js';

test('memory: persists facts and trims history, survives corrupt file, rejects bad ids', () => {
  const t = tmpDir();
  try {
    const m = new MemoryStore(join(t.dir, 'mem'), 3);
    m.addFact('ana', 'prefers weekly summaries');
    m.addFact('ana', 'prefers weekly summaries');
    for (let i = 0; i < 5; i++) m.appendTurn('ana', { user: `q${i}`, assistant: `a${i}` });
    const again = new MemoryStore(join(t.dir, 'mem'), 3).load('ana');
    assert.deepEqual(again.facts, ['prefers weekly summaries']);
    assert.deepEqual(again.history.map((h) => h.user), ['q2', 'q3', 'q4']);
    assert.throws(() => m.load('../evil'), /invalid user id/);
    assert.ok(!isValidUserId('a/b') && isValidUserId('user_1-x'));
    assert.equal(extractFact('Remember that I prefer weekly summaries'), 'I prefer weekly summaries');
    assert.equal(extractFact('what is the weather'), null);
  } finally {
    t.cleanup();
  }
});

test('usage counter: enforces the daily limit, resets on a new UTC day, persists', () => {
  const t = tmpDir();
  try {
    let now = new Date('2025-07-01T23:59:00Z');
    const f = join(t.dir, 'usage.json');
    const u = new UsageCounter(f, 2, () => now);
    assert.ok(u.tryConsume('a'));
    assert.ok(u.tryConsume('a'));
    assert.ok(!u.tryConsume('a'));
    assert.ok(u.tryConsume('b'));
    assert.equal(new UsageCounter(f, 2, () => now).used('a'), 2);
    now = new Date('2025-07-02T00:01:00Z');
    assert.equal(u.remaining('a'), 2);
    assert.ok(u.tryConsume('a'));
  } finally {
    t.cleanup();
  }
});

test('answer cache: TTL expiry and size cap', () => {
  let now = 0;
  const c = new AnswerCache(1000, 2, () => now);
  const k1 = AnswerCache.key(['a']);
  c.set(k1, { text: 'x', tools: [] });
  assert.equal(c.get(k1)?.text, 'x');
  now = 1001;
  assert.equal(c.get(k1), undefined);
  c.set('1', { text: '1', tools: [] });
  c.set('2', { text: '2', tools: [] });
  c.set('3', { text: '3', tools: [] });
  assert.equal(c.size, 2);
  assert.equal(c.get('1'), undefined);
});
