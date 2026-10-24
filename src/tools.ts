import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import { CATEGORIES } from './db.js';
import type { ToolDef } from './types.js';

export interface ToolContext {
  db: Db;
  userId: string;
  lastUserMessage: string;
  today: string; // YYYY-MM-DD, "today" inside the synthetic dataset
  now: () => Date;
  onWrite?: () => void; // called after a confirmed write (e.g. to invalidate caches)
}

export interface Tool extends ToolDef {
  /** true for tools that only create a proposal; nothing is changed until confirm_action. */
  run(args: Record<string, unknown>, ctx: ToolContext): unknown;
}

export const AFFIRM_RE = /\b(yes|yep|confirm|confirmed|confirmo|go ahead|do it|apply it|apply|s[ií]|ok|okay)\b/i;
export const PENDING_TTL_MS = 30 * 60 * 1000;

// ---------- helpers ----------
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const monthRange = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return { from: `${m}-01`, to: iso(new Date(Date.UTC(y, mo, 0))) };
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

function resolvePeriod(args: Record<string, unknown>, today: string) {
  if (isDate(args.from) && isDate(args.to)) return { from: args.from, to: args.to };
  if (isMonth(args.month)) return monthRange(args.month);
  const days = Math.min(365, Math.max(1, Math.floor(Number(args.days ?? 30)) || 30));
  return { from: addDays(today, -(days - 1)), to: today };
}

function normCategory(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const hit = [...CATEGORIES].find((c) => c.toLowerCase() === v.trim().toLowerCase());
  if (!hit) throw new Error(`unknown category "${v}". Valid: ${CATEGORIES.join(', ')}`);
  return hit;
}

function newPending(ctx: ToolContext, kind: string, payload: object, summary: string) {
  ctx.db
    .prepare("UPDATE pending_actions SET status='superseded' WHERE user_id=? AND status='pending'")
    .run(ctx.userId);
  const id = randomBytes(4).toString('hex');
  ctx.db
    .prepare('INSERT INTO pending_actions VALUES (?,?,?,?,?,?,?)')
    .run(id, ctx.userId, kind, JSON.stringify(payload), summary, 'pending', ctx.now().toISOString());
  return { status: 'pending_confirmation', action_id: id, summary, requires: 'explicit user confirmation' };
}

export function getPending(db: Db, userId: string, now: Date): { id: string; summary: string } | null {
  const row = db
    .prepare("SELECT id, summary, created_at FROM pending_actions WHERE user_id=? AND status='pending' ORDER BY rowid DESC LIMIT 1")
    .get(userId) as { id: string; summary: string; created_at: string } | undefined;
  if (!row) return null;
  if (now.getTime() - Date.parse(row.created_at) > PENDING_TTL_MS) return null;
  return { id: row.id, summary: row.summary };
}

// ---------- tools ----------
const periodProps = {
  days: { type: 'integer', description: 'Look back this many days from today (default 30).' },
  month: { type: 'string', description: 'A calendar month, YYYY-MM. Overrides days.' },
  from: { type: 'string', description: 'Start date YYYY-MM-DD (use with to).' },
  to: { type: 'string', description: 'End date YYYY-MM-DD, inclusive.' },
};

export const TOOLS: Tool[] = [
  {
    name: 'sales_summary',
    description: 'Total revenue, units and order lines for a period, optionally grouped.',
    parameters: {
      type: 'object',
      properties: {
        ...periodProps,
        group_by: { type: 'string', enum: ['none', 'category', 'product', 'store', 'day', 'month'] },
        category: { type: 'string', description: `One of: ${CATEGORIES.join(', ')}` },
      },
    },
    run(args, ctx) {
      const { from, to } = resolvePeriod(args, ctx.today);
      const cat = normCategory(args.category);
      const groupBy = String(args.group_by ?? 'none');
      const keyExpr: Record<string, string> = {
        category: 'p.category',
        product: 'p.name',
        store: 'st.name',
        day: 's.sold_on',
        month: "substr(s.sold_on,1,7)",
      };
      const where = 's.sold_on BETWEEN ? AND ?' + (cat ? ' AND p.category = ?' : '');
      const params = cat ? [from, to, cat] : [from, to];
      const base = `FROM sales s JOIN products p ON p.sku=s.sku JOIN stores st ON st.id=s.store_id WHERE ${where}`;
      const t = ctx.db
        .prepare(`SELECT COALESCE(SUM(s.qty*s.unit_price),0) rev, COALESCE(SUM(s.qty),0) units, COUNT(*) lines ${base}`)
        .get(...params) as { rev: number; units: number; lines: number };
      let groups: unknown[] = [];
      if (keyExpr[groupBy]) {
        const order = groupBy === 'day' || groupBy === 'month' ? 'key ASC' : 'revenue DESC';
        groups = (
          ctx.db
            .prepare(`SELECT ${keyExpr[groupBy]} key, SUM(s.qty*s.unit_price) revenue, SUM(s.qty) units ${base} GROUP BY key ORDER BY ${order} LIMIT 31`)
            .all(...params) as Array<{ key: string; revenue: number; units: number }>
        ).map((g) => ({ key: g.key, revenue: round2(g.revenue), units: g.units }));
      }
      return { period: { from, to }, category: cat, total_revenue: round2(t.rev), total_units: t.units, order_lines: t.lines, group_by: groupBy, groups };
    },
  },
  {
    name: 'top_products',
    description: 'Best-selling products in a period, ranked by revenue or units.',
    parameters: {
      type: 'object',
      properties: {
        ...periodProps,
        by: { type: 'string', enum: ['revenue', 'units'] },
        limit: { type: 'integer', description: '1-10, default 5' },
        category: { type: 'string' },
      },
    },
    run(args, ctx) {
      const { from, to } = resolvePeriod(args, ctx.today);
      const cat = normCategory(args.category);
      const by = args.by === 'units' ? 'units' : 'revenue';
      const limit = Math.min(10, Math.max(1, Math.floor(Number(args.limit ?? 5)) || 5));
      const rows = ctx.db
        .prepare(
          `SELECT p.sku, p.name, p.category, SUM(s.qty*s.unit_price) revenue, SUM(s.qty) units
           FROM sales s JOIN products p ON p.sku=s.sku
           WHERE s.sold_on BETWEEN ? AND ? ${cat ? 'AND p.category=?' : ''}
           GROUP BY p.sku ORDER BY ${by} DESC, p.sku LIMIT ?`,
        )
        .all(...(cat ? [from, to, cat, limit] : [from, to, limit])) as Array<Record<string, unknown>>;
      return { period: { from, to }, by, items: rows.map((r) => ({ ...r, revenue: round2(Number(r.revenue)) })) };
    },
  },
  {
    name: 'product_lookup',
    description: 'Find products by name/SKU or category, with price and stock. Use low_stock to list items at or below their reorder level.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Part of a product name or a SKU like CAF-001' },
        category: { type: 'string' },
        low_stock: { type: 'boolean' },
      },
    },
    run(args, ctx) {
      const cat = normCategory(args.category);
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      const conds: string[] = [];
      const params: unknown[] = [];
      if (q) {
        conds.push('(sku LIKE ? OR name LIKE ?)');
        params.push(`%${q}%`, `%${q}%`);
      }
      if (cat) {
        conds.push('category = ?');
        params.push(cat);
      }
      if (args.low_stock === true) conds.push('stock <= reorder_level');
      const rows = ctx.db
        .prepare(`SELECT sku, name, category, price, stock, reorder_level FROM products ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY stock ASC, sku LIMIT 25`)
        .all(...params);
      return { matches: rows };
    },
  },
  {
    name: 'goal_progress',
    description: 'Sales goal vs actual revenue for a month, overall and per category.',
    parameters: {
      type: 'object',
      properties: { month: { type: 'string', description: 'YYYY-MM, default current month' }, category: { type: 'string' } },
    },
    run(args, ctx) {
      const month = isMonth(args.month) ? args.month : ctx.today.slice(0, 7);
      const cat = normCategory(args.category);
      const { from, to } = monthRange(month);
      const goals = ctx.db
        .prepare(`SELECT category, target FROM goals WHERE month=? ${cat ? 'AND category=?' : ''} ORDER BY category='all' DESC, category`)
        .all(...(cat ? [month, cat] : [month])) as Array<{ category: string; target: number }>;
      const out = goals.map((g) => {
        const actual = (
          ctx.db
            .prepare(`SELECT COALESCE(SUM(s.qty*s.unit_price),0) v FROM sales s JOIN products p ON p.sku=s.sku WHERE s.sold_on BETWEEN ? AND ? ${g.category === 'all' ? '' : 'AND p.category=?'}`)
            .get(...(g.category === 'all' ? [from, to] : [from, to, g.category])) as { v: number }
        ).v;
        return { category: g.category, target: g.target, actual: round2(actual), pct: g.target ? Math.round((actual / g.target) * 1000) / 10 : null };
      });
      return { month, goals: out, note: out.length ? undefined : 'No goals defined for that month.' };
    },
  },
  {
    name: 'propose_price_change',
    description: 'Propose a new price for a SKU. This does NOT change anything; the user must confirm afterwards.',
    parameters: {
      type: 'object',
      properties: { sku: { type: 'string' }, new_price: { type: 'number' } },
      required: ['sku', 'new_price'],
    },
    run(args, ctx) {
      const sku = String(args.sku ?? '').toUpperCase();
      const price = Number(args.new_price);
      const p = ctx.db.prepare('SELECT sku, name, price FROM products WHERE sku=?').get(sku) as { sku: string; name: string; price: number } | undefined;
      if (!p) throw new Error(`unknown SKU "${sku}"`);
      if (!Number.isFinite(price) || price <= 0) throw new Error('new_price must be a positive number');
      if (price > p.price * 2 || price < p.price * 0.5) {
        throw new Error(`new price ${price} is outside the allowed range (50%-200% of ${p.price}); needs manual review`);
      }
      const summary = `Change price of ${p.name} (${p.sku}) from $${p.price.toFixed(2)} to $${price.toFixed(2)}.`;
      return newPending(ctx, 'price_change', { sku: p.sku, new_price: round2(price) }, summary);
    },
  },
  {
    name: 'propose_goal_change',
    description: 'Propose a new monthly sales goal (overall or for a category). This does NOT change anything; the user must confirm afterwards.',
    parameters: {
      type: 'object',
      properties: { month: { type: 'string', description: 'YYYY-MM' }, category: { type: 'string', description: 'Category, or omit for the overall goal' }, amount: { type: 'number' } },
      required: ['month', 'amount'],
    },
    run(args, ctx) {
      if (!isMonth(args.month)) throw new Error('month must be YYYY-MM');
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) throw new Error('amount must be between 0 and 1,000,000');
      const cat = normCategory(args.category) ?? 'all';
      const old = ctx.db.prepare('SELECT target FROM goals WHERE month=? AND category=?').get(args.month, cat) as { target: number } | undefined;
      const label = cat === 'all' ? 'overall goal' : `${cat} goal`;
      const summary = `Set the ${args.month} ${label} to $${amount.toFixed(2)}${old ? ` (currently $${old.target.toFixed(2)})` : ' (no goal set yet)'}.`;
      return newPending(ctx, 'goal_change', { month: args.month, category: cat, amount: round2(amount) }, summary);
    },
  },
  {
    name: 'confirm_action',
    description: 'Apply or cancel the user\'s pending proposal. Only call this after the user has explicitly said confirm (or cancel) in their latest message.',
    parameters: {
      type: 'object',
      properties: { action_id: { type: 'string' }, decision: { type: 'string', enum: ['confirm', 'cancel'] } },
      required: ['action_id'],
    },
    run(args, ctx) {
      const id = String(args.action_id ?? '');
      const row = ctx.db.prepare("SELECT * FROM pending_actions WHERE id=? AND user_id=? AND status='pending'").get(id, ctx.userId) as
        | { id: string; kind: string; payload: string; summary: string; created_at: string }
        | undefined;
      if (!row) throw new Error('no such pending action for this user');
      const decision = args.decision === 'cancel' ? 'cancel' : 'confirm';
      if (decision === 'cancel') {
        ctx.db.prepare("UPDATE pending_actions SET status='cancelled' WHERE id=?").run(id);
        return { status: 'cancelled', summary: row.summary };
      }
      // Code-level guard: the model cannot confirm on its own; the latest user message must say so.
      if (!AFFIRM_RE.test(ctx.lastUserMessage)) throw new Error('explicit user confirmation required; ask the user to reply "confirm"');
      if (ctx.now().getTime() - Date.parse(row.created_at) > PENDING_TTL_MS) {
        ctx.db.prepare("UPDATE pending_actions SET status='expired' WHERE id=?").run(id);
        throw new Error('the proposal expired; please ask again');
      }
      const p = JSON.parse(row.payload);
      ctx.db.transaction(() => {
        if (row.kind === 'price_change') ctx.db.prepare('UPDATE products SET price=? WHERE sku=?').run(p.new_price, p.sku);
        else if (row.kind === 'goal_change') ctx.db.prepare('INSERT INTO goals VALUES (?,?,?) ON CONFLICT(month,category) DO UPDATE SET target=excluded.target').run(p.month, p.category, p.amount);
        ctx.db.prepare("UPDATE pending_actions SET status='applied' WHERE id=?").run(id);
      })();
      ctx.onWrite?.();
      return { status: 'applied', summary: row.summary };
    },
  },
];

export const toolByName = (name: string) => TOOLS.find((t) => t.name === name);
export const toolDefs = (): ToolDef[] => TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
