import { createServer as httpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { runAgent } from './agent.js';
import { AnswerCache } from './cache.js';
import type { Config } from './config.js';
import { openDb } from './db.js';
import { createClient } from './llm/index.js';
import { extractFact, isValidUserId, MemoryStore } from './memory.js';
import { PROMPT_VERSIONS, buildSystemPrompt } from './prompts.js';
import { getPending } from './tools.js';
import type { AgentEvent, LlmClient, Message } from './types.js';
import { UsageCounter } from './usage.js';

const MAX_BODY = 16 * 1024;
const MAX_MESSAGE = 2000;
const FOLLOW_UP_RE = /^\s*(and|also|what about|how about|then|so|y|ok|yes|no|why|those|that|it|them|same)\b/i;
const WRITE_TOOLS = new Set(['propose_price_change', 'propose_goal_change', 'confirm_action']);

export interface AppOptions {
  llm?: LlmClient;
  clock?: () => Date;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.resume(); // drain; the connection is closed after the 413 response
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', ...(status === 413 ? { connection: 'close' } : {}) });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, token: string): boolean {
  if (!token) return true;
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function createApp(cfg: Config, opts: AppOptions = {}) {
  const clock = opts.clock ?? (() => new Date());
  const llm = opts.llm ?? createClient(cfg);
  const db = openDb(join(cfg.dataDir, 'shop.db'));
  const memory = new MemoryStore(join(cfg.dataDir, 'memory'));
  const usage = new UsageCounter(join(cfg.dataDir, 'usage.json'), cfg.dailyLimit, clock);
  const cache = new AnswerCache(cfg.cacheTtlMs);

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, provider: llm.name, model: cfg.model, fallback: cfg.fallbackModel || null, prompt: cfg.promptVersion });
      }
      if (req.method !== 'POST' || url.pathname !== '/chat') return json(res, 404, { error: 'not found' });
      if (!authorized(req, cfg.apiToken)) return json(res, 401, { error: 'unauthorized' });

      let body: any;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        const status = (e as any).status ?? 400;
        return json(res, status, { error: status === 413 ? 'body too large' : 'invalid JSON body' });
      }
      const user = body?.user;
      const message = typeof body?.message === 'string' ? body.message.trim() : '';
      if (!isValidUserId(user)) return json(res, 400, { error: 'user must match [A-Za-z0-9_-]{1,64}' });
      if (!message || message.length > MAX_MESSAGE) return json(res, 400, { error: `message must be 1-${MAX_MESSAGE} characters` });
      const version = body.prompt_version ?? cfg.promptVersion;
      if (!(PROMPT_VERSIONS as readonly string[]).includes(version)) return json(res, 400, { error: `prompt_version must be one of ${PROMPT_VERSIONS.join(', ')}` });

      const started = Date.now();
      const mem = memory.load(user);
      const fact = extractFact(message);
      if (fact) mem.facts = [...mem.facts, fact].slice(-20);
      const pending = getPending(db, user, clock());
      const history: Message[] = mem.history.flatMap((t): Message[] => [
        { role: 'user', content: t.user },
        { role: 'assistant', content: t.assistant },
      ]);

      // Cache only self-contained questions: a follow-up like "and for May?" depends on history.
      const selfContained = message.split(/\s+/).length >= 3 && !FOLLOW_UP_RE.test(message);
      const cacheKey = AnswerCache.key([version, cfg.model, message.toLowerCase().replace(/\s+/g, ' '), mem.facts]);
      const useCache = !body.no_cache && selfContained && !pending;
      const hit = useCache ? cache.get(cacheKey) : undefined;

      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      const emit = (e: AgentEvent) => {
        if (!res.writableEnded) res.write(JSON.stringify(e) + '\n');
      };
      emit({ type: 'status', message: 'received', user });

      if (hit) {
        emit({ type: 'text', delta: hit.text });
        emit({ type: 'done', ok: true, text: hit.text, tools: hit.tools, cached: true, prompt_version: version, elapsed_ms: Date.now() - started, usage_remaining: usage.remaining(user) });
        return res.end();
      }
      if (!usage.tryConsume(user)) {
        emit({ type: 'done', ok: false, error: 'daily_limit_reached', limit: cfg.dailyLimit });
        return res.end();
      }

      const ac = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) ac.abort(); // client went away
      });

      let wrote = false;
      try {
        const r = await runAgent({
          llm,
          models: [cfg.model, ...(cfg.fallbackModel ? [cfg.fallbackModel] : [])],
          systemPrompt: buildSystemPrompt(version, { facts: mem.facts, pending, today: cfg.asOfDate }),
          history,
          userMessage: message,
          toolCtx: {
            db,
            userId: user,
            lastUserMessage: message,
            today: cfg.asOfDate,
            now: clock,
            onWrite: () => {
              wrote = true;
              cache.clear();
            },
          },
          maxTurns: cfg.maxTurns,
          emit,
          signal: ac.signal,
        });
        if (fact) memory.addFact(user, fact);
        memory.appendTurn(user, { user: message, assistant: r.text });
        const tools = r.tools.map((t) => t.name);
        if (useCache && !wrote && r.stopReason === 'answered' && !tools.some((t) => WRITE_TOOLS.has(t))) {
          cache.set(cacheKey, { text: r.text, tools });
        }
        emit({
          type: 'done',
          ok: true,
          text: r.text,
          tools,
          turns: r.turns,
          model: r.model,
          fell_back: r.fellBack,
          stop_reason: r.stopReason,
          cached: false,
          prompt_version: version,
          elapsed_ms: Date.now() - started,
          usage_remaining: usage.remaining(user),
        });
      } catch (err) {
        emit({ type: 'done', ok: false, error: 'model_error', detail: (err as Error).message.slice(0, 200), elapsed_ms: Date.now() - started });
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
      console.error('request failed:', (err as Error).message);
    }
  };

  const server: Server = httpServer((req, res) => void handler(req, res));
  return {
    server,
    listen: (port = cfg.port, host = cfg.host) =>
      new Promise<number>((resolve) => server.listen(port, host, () => resolve((server.address() as any).port))),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections?.();
      }),
  };
}
