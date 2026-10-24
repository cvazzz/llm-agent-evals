// Cross-platform test launcher (Node 20 does not expand globs for --test).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`);
const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
