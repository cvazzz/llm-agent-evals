import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPending, toolByName } from '../src/tools.js';
import { ctx, tmpDir, testDb } from './helpers.js';

const run = (name: string, args: Record<string, unknown>, c: ReturnType<typeof ctx>) => toolByName(name)!.run(args, c) as any;

test('seed is deterministic and read tools return sane data', () => {
  const t = tmpDir();
  try {
    const db = testDb(t.dir);
    const c = ctx(db);
    const a = run('sales_summary', { month: '2025-03' }, c);
    assert.equal(a.period.from, '2025-03-01');
    assert.equal(a.period.to, '2025-03-31');
    assert.ok(a.total_revenue > 1000);
    const byCat = run('sales_summary', { month: '2025-03', group_by: 'category' }, c);
    const sum = byCat.groups.reduce((s: number, g: any) => s + g.revenue, 0);
    assert.ok(Math.abs(sum - byCat.total_revenue) < 0.05);
    assert.equal(run('top_products', { days: 30, limit: 3 }, c).items.length, 3);
    const low = run('product_lookup', { low_stock: true }, c).matches.map((m: any) => m.sku);
    assert.ok(low.includes('GEA-003'));
    assert.ok(run('goal_progress', { month: '2025-06' }, c).goals.length >= 6);
    assert.throws(() => run('sales_summary', { category: 'Furniture' }, c), /unknown category/);
    db.close();
  } finally {
    t.cleanup();
  }
});

test('write tools: propose does not change data; confirm needs explicit user words', () => {
  const t = tmpDir();
  try {
    const db = testDb(t.dir);
    const price = () => (db.prepare("SELECT price FROM products WHERE sku='GEA-003'").get() as any).price;
    assert.equal(price(), 49);

    const p = run('propose_price_change', { sku: 'GEA-003', new_price: 45 }, ctx(db));
    assert.equal(p.status, 'pending_confirmation');
    assert.equal(price(), 49, 'proposal must not write');
    assert.equal(getPending(db, 'u1', new Date('2025-07-01T10:05:00Z'))?.id, p.action_id);

    // model tries to self-confirm while the user said something unrelated
    assert.throws(() => run('confirm_action', { action_id: p.action_id }, ctx(db, { lastUserMessage: 'what is the weather' })), /explicit user confirmation/);
    assert.equal(price(), 49);

    // another user cannot confirm it
    assert.throws(() => run('confirm_action', { action_id: p.action_id }, ctx(db, { userId: 'u2', lastUserMessage: 'yes' })), /no such pending/);

    let wrote = false;
    const ok = run('confirm_action', { action_id: p.action_id }, ctx(db, { lastUserMessage: 'yes, confirm', onWrite: () => (wrote = true) }));
    assert.equal(ok.status, 'applied');
    assert.equal(price(), 45);
    assert.ok(wrote);
    assert.throws(() => run('confirm_action', { action_id: p.action_id }, ctx(db, { lastUserMessage: 'yes' })), /no such pending/);
    db.close();
  } finally {
    t.cleanup();
  }
});

test('validation: out-of-range price, unknown sku, expiry, cancel, supersede', () => {
  const t = tmpDir();
  try {
    const db = testDb(t.dir);
    assert.throws(() => run('propose_price_change', { sku: 'GEA-003', new_price: 400 }, ctx(db)), /outside the allowed range/);
    assert.throws(() => run('propose_price_change', { sku: 'NOPE-1', new_price: 4 }, ctx(db)), /unknown SKU/);
    assert.throws(() => run('propose_goal_change', { month: 'June', amount: 5 }, ctx(db)), /YYYY-MM/);

    const first = run('propose_goal_change', { month: '2025-07', category: 'Tea', amount: 4000 }, ctx(db));
    const second = run('propose_goal_change', { month: '2025-07', amount: 60000 }, ctx(db));
    assert.throws(() => run('confirm_action', { action_id: first.action_id }, ctx(db, { lastUserMessage: 'yes' })), /no such pending/);
    // expiry: confirm 31 minutes later
    const late = ctx(db, { lastUserMessage: 'yes', now: () => new Date('2025-07-01T10:31:00Z') });
    assert.equal(getPending(db, 'u1', late.now()), null);
    assert.throws(() => run('confirm_action', { action_id: second.action_id }, late), /expired/);

    const third = run('propose_goal_change', { month: '2025-07', category: 'Tea', amount: 4000 }, ctx(db));
    assert.equal(run('confirm_action', { action_id: third.action_id, decision: 'cancel' }, ctx(db)).status, 'cancelled');
    assert.equal((db.prepare("SELECT COUNT(*) n FROM goals WHERE month='2025-07' AND category='Tea'").get() as { n: number }).n, 0);
    db.close();
  } finally {
    t.cleanup();
  }
});
