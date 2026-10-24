import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, seedDb, type Db } from '../src/db.js';
import type { ToolContext } from '../src/tools.js';

export function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lae-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testConfig(dir: string, extra: Record<string, string> = {}): Config {
  return loadConfig({ DATA_DIR: dir, ...extra } as NodeJS.ProcessEnv);
}

export function testDb(dir: string): Db {
  const p = join(dir, 'shop.db');
  seedDb(p);
  return openDb(p);
}

export function ctx(db: Db, over: Partial<ToolContext> = {}): ToolContext {
  return { db, userId: 'u1', lastUserMessage: '', today: '2025-06-30', now: () => new Date('2025-07-01T10:00:00Z'), ...over };
}
