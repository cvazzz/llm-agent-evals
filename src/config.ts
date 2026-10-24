import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  provider: 'mock' | 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
  fallbackModel: string;
  timeoutMs: number;
  promptVersion: string;
  maxTurns: number;
  dailyLimit: number;
  cacheTtlMs: number;
  host: string;
  port: number;
  apiToken: string;
  dataDir: string;
  asOfDate: string;
}

/** Minimal .env loader (no dependency). Real environment variables win. */
export function loadDotEnv(file = '.env', env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m) continue;
    const val = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (env[m[1]] === undefined && val !== '') env[m[1]] = val;
  }
}

const int = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = (env.LLM_PROVIDER || 'mock') === 'openai' ? 'openai' : 'mock';
  return {
    provider,
    baseUrl: (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || (provider === 'mock' ? 'mock-1' : 'gpt-4o-mini'),
    fallbackModel: env.LLM_FALLBACK_MODEL || '',
    timeoutMs: int(env.LLM_TIMEOUT_MS, 60000),
    promptVersion: env.PROMPT_VERSION || 'v2',
    maxTurns: Math.max(1, int(env.MAX_TURNS, 6)),
    dailyLimit: int(env.DAILY_LIMIT, 200),
    cacheTtlMs: int(env.CACHE_TTL_MS, 600000),
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 8787),
    apiToken: env.API_TOKEN || '',
    dataDir: resolve(env.DATA_DIR || './data'),
    asOfDate: env.AS_OF_DATE || '2025-06-30',
  };
}
