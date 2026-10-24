import type { Config } from '../config.js';
import type { LlmClient } from '../types.js';
import { MockClient } from './mock.js';
import { OpenAiClient } from './openai.js';

export function createClient(cfg: Config, fetchImpl?: typeof fetch): LlmClient {
  if (cfg.provider === 'mock') return new MockClient();
  if (!cfg.apiKey && /api\.openai\.com/.test(cfg.baseUrl)) {
    throw new Error('LLM_API_KEY is required for api.openai.com (or set LLM_PROVIDER=mock)');
  }
  return new OpenAiClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, timeoutMs: cfg.timeoutMs, fetchImpl });
}
