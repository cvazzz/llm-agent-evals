import { join } from 'node:path';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { seedDb } from '../src/db.js';

loadDotEnv();
const cfg = loadConfig();
const path = join(cfg.dataDir, 'shop.db');
seedDb(path);
console.log(`Seeded synthetic shop database at ${path}`);
