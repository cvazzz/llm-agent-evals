import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

export const CATEGORIES = ['Coffee', 'Tea', 'Brewing Gear', 'Mugs & Bottles', 'Snacks'] as const;
export const STORES = ['Harbor Street', 'Market Hall', 'Online'] as const;

// [sku, name, category, price, weight(popularity)]
const PRODUCTS: Array<[string, string, string, number, number]> = [
  ['CAF-001', 'Harbor Blend Beans 1kg', 'Coffee', 24.5, 10],
  ['CAF-002', 'Dark Roast Beans 1kg', 'Coffee', 26.0, 8],
  ['CAF-003', 'Single Origin Ethiopia 500g', 'Coffee', 18.75, 5],
  ['CAF-004', 'Decaf Beans 500g', 'Coffee', 15.9, 3],
  ['CAF-005', 'Cold Brew Concentrate', 'Coffee', 11.4, 6],
  ['TEA-001', 'Jasmine Green Tea 100g', 'Tea', 9.2, 7],
  ['TEA-002', 'Earl Grey 100g', 'Tea', 8.6, 7],
  ['TEA-003', 'Chamomile Sachets x20', 'Tea', 6.8, 5],
  ['TEA-004', 'Masala Chai Mix 250g', 'Tea', 10.5, 4],
  ['TEA-005', 'Matcha Powder 50g', 'Tea', 17.3, 3],
  ['GEA-001', 'Pour-Over Dripper', 'Brewing Gear', 22.0, 3],
  ['GEA-002', 'Glass French Press 1L', 'Brewing Gear', 29.9, 3],
  ['GEA-003', 'Hand Grinder', 'Brewing Gear', 49.0, 2],
  ['GEA-004', 'Gooseneck Kettle', 'Brewing Gear', 44.5, 2],
  ['GEA-005', 'Paper Filters x100', 'Brewing Gear', 5.9, 6],
  ['MUG-001', 'Ceramic Mug 350ml', 'Mugs & Bottles', 12.0, 6],
  ['MUG-002', 'Insulated Bottle 500ml', 'Mugs & Bottles', 27.5, 4],
  ['MUG-003', 'Travel Tumbler 400ml', 'Mugs & Bottles', 21.0, 4],
  ['MUG-004', 'Espresso Cup Set x4', 'Mugs & Bottles', 19.8, 2],
  ['SNK-001', 'Almond Biscotti 200g', 'Snacks', 7.4, 6],
  ['SNK-002', 'Dark Chocolate Bar 80g', 'Snacks', 4.2, 9],
  ['SNK-003', 'Oat Cookies x6', 'Snacks', 5.6, 7],
  ['SNK-004', 'Salted Caramel Squares', 'Snacks', 8.1, 4],
  ['SNK-005', 'Honey Granola 400g', 'Snacks', 9.0, 4],
];

const LOW_STOCK: Record<string, number> = {
  'CAF-003': 4,
  'GEA-003': 3,
  'MUG-002': 6,
  'TEA-005': 2,
  'SNK-004': 5,
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SCHEMA = `
CREATE TABLE stores (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE products (sku TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
  price REAL NOT NULL, stock INTEGER NOT NULL, reorder_level INTEGER NOT NULL);
CREATE TABLE sales (id INTEGER PRIMARY KEY, sold_on TEXT NOT NULL, sku TEXT NOT NULL REFERENCES products(sku),
  store_id INTEGER NOT NULL REFERENCES stores(id), qty INTEGER NOT NULL, unit_price REAL NOT NULL);
CREATE INDEX idx_sales_date ON sales(sold_on);
CREATE TABLE goals (month TEXT NOT NULL, category TEXT NOT NULL, target REAL NOT NULL, PRIMARY KEY (month, category));
CREATE TABLE pending_actions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
  summary TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
`;

/** Creates a fresh, deterministic synthetic database (Jan-Jun 2025). Overwrites any existing file. */
export function seedDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  const db = new Database(path);
  db.exec(SCHEMA);
  const rand = mulberry32(20250630);

  const insStore = db.prepare('INSERT INTO stores (id, name) VALUES (?, ?)');
  STORES.forEach((s, i) => insStore.run(i + 1, s));

  const insProd = db.prepare('INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)');
  for (const [sku, name, cat, price] of PRODUCTS) {
    const reorder = 8 + Math.floor(rand() * 8);
    const stock = LOW_STOCK[sku] ?? 25 + Math.floor(rand() * 115);
    insProd.run(sku, name, cat, price, stock, reorder);
  }

  const totalWeight = PRODUCTS.reduce((a, p) => a + p[4], 0);
  const pick = () => {
    let r = rand() * totalWeight;
    for (const p of PRODUCTS) {
      r -= p[4];
      if (r <= 0) return p;
    }
    return PRODUCTS[0];
  };
  const insSale = db.prepare(
    'INSERT INTO sales (sold_on, sku, store_id, qty, unit_price) VALUES (?, ?, ?, ?, ?)',
  );
  const monthRev = new Map<string, number>(); // "month|category" -> revenue
  const tx = db.transaction(() => {
    const end = new Date(Date.UTC(2025, 5, 30));
    for (let d = new Date(Date.UTC(2025, 0, 1)); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const day = d.toISOString().slice(0, 10);
      const month = day.slice(0, 7);
      const weekend = [0, 6].includes(d.getUTCDay());
      const growth = 1 + d.getUTCMonth() * 0.04;
      for (let s = 1; s <= STORES.length; s++) {
        const base = s === 3 ? 6 : 4;
        const lines = Math.round((base + rand() * 4) * (weekend ? 1.4 : 1) * growth);
        for (let i = 0; i < lines; i++) {
          const [sku, , cat, price] = pick();
          const qty = 1 + Math.floor(rand() * 4);
          insSale.run(day, sku, s, qty, price);
          const k = `${month}|${cat}`;
          monthRev.set(k, (monthRev.get(k) ?? 0) + qty * price);
        }
      }
    }
    const insGoal = db.prepare('INSERT INTO goals VALUES (?, ?, ?)');
    for (const m of ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06']) {
      let all = 0;
      for (const c of CATEGORIES) {
        const t = Math.round(((monthRev.get(`${m}|${c}`) ?? 0) * (0.93 + rand() * 0.2)) / 50) * 50;
        insGoal.run(m, c, t);
        all += t;
      }
      insGoal.run(m, 'all', all);
    }
    insGoal.run('2025-07', 'all', 52000);
    insGoal.run('2025-07', 'Coffee', 17000);
  });
  tx();
  db.close();
}

export function ensureDb(path: string): void {
  if (!existsSync(path)) seedDb(path);
}

export function openDb(path: string): Db {
  ensureDb(path);
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  return db;
}
