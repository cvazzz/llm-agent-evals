import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { createApp } from '../src/server.js';
import { CHECKS, aggregate, parseGolden, scoreTurn, turnPassed, type GoldenCase, type TurnScore } from './score.js';

/**
 * Usage: tsx evals/run.ts [--url http://host:port] [--prompt v2] [--compare v1]
 *                         [--cases evals/golden.jsonl] [--min-pass 0.9] [--out evals/reports] [--token T]
 * Without --url an in-process server is started on a temp data dir (provider from env; mock by default).
 */
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

interface TurnResult {
  q: string;
  text: string;
  tools: string[];
  ok: boolean;
  firstTextMs: number | null;
  totalMs: number;
  score: TurnScore;
}
interface CaseResult {
  id: string;
  passed: boolean;
  turns: TurnResult[];
}
interface RunSummary {
  prompt: string;
  cases: CaseResult[];
  checks: ReturnType<typeof aggregate>;
  passRate: number;
  medianFirstTextMs: number | null;
  medianTotalMs: number;
}

async function chat(base: string, token: string | undefined, user: string, message: string, prompt: string): Promise<Omit<TurnResult, 'q' | 'score'>> {
  const t0 = Date.now();
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ user, message, prompt_version: prompt, no_cache: true }),
  });
  if (!res.ok || !res.body) return { text: '', tools: [], ok: false, firstTextMs: null, totalMs: Date.now() - t0 };
  let firstTextMs: number | null = null;
  let done: any = null;
  let buf = '';
  const dec = new TextDecoder();
  const handle = (line: string) => {
    if (!line.trim()) return;
    const e = JSON.parse(line);
    if (e.type === 'text' && firstTextMs === null) firstTextMs = Date.now() - t0;
    if (e.type === 'done') done = e;
  };
  for await (const chunk of res.body as any) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf);
  return { text: done?.text ?? '', tools: done?.tools ?? [], ok: !!done?.ok, firstTextMs, totalMs: Date.now() - t0 };
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

async function runSet(base: string, token: string | undefined, cases: GoldenCase[], prompt: string, runId: string): Promise<RunSummary> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const user = `eval-${runId}-${prompt}-${c.id}`.slice(0, 64);
    const turns: TurnResult[] = [];
    for (const spec of c.turns) {
      const obs = await chat(base, token, user, spec.q, prompt);
      turns.push({ q: spec.q, ...obs, score: scoreTurn(spec, obs, c.max_chars) });
    }
    results.push({ id: c.id, passed: turns.every((t) => turnPassed(t.score)), turns });
  }
  const all = results.flatMap((r) => r.turns);
  return {
    prompt,
    cases: results,
    checks: aggregate(all.map((t) => t.score)),
    passRate: results.filter((r) => r.passed).length / results.length,
    medianFirstTextMs: median(all.map((t) => t.firstTextMs).filter((x): x is number => x !== null)),
    medianTotalMs: median(all.map((t) => t.totalMs)) ?? 0,
  };
}

const pct = (r: number | null) => (r === null ? 'n/a' : `${(r * 100).toFixed(0)}%`);

function renderReport(runs: RunSummary[], meta: { provider: string; model: string; when: string; n: number }): string {
  const L: string[] = [];
  L.push(`# Eval report`, '', `- Date: ${meta.when}`, `- Provider/model: ${meta.provider} / ${meta.model}`, `- Cases: ${meta.n}`, '');
  L.push('## Summary', '', `| prompt | cases passed | ${CHECKS.join(' | ')} | median first text (ms) | median total (ms) |`, `|---|---|${CHECKS.map(() => '---').join('|')}|---|---|`);
  for (const r of runs) {
    const passed = r.cases.filter((c) => c.passed).length;
    L.push(`| ${r.prompt} | ${passed}/${r.cases.length} (${pct(r.passRate)}) | ${CHECKS.map((c) => pct(r.checks[c].rate)).join(' | ')} | ${r.medianFirstTextMs ?? 'n/a'} | ${r.medianTotalMs} |`);
  }
  if (runs.length === 2) {
    const [a, b] = runs;
    L.push('', `## Comparison: ${a.prompt} -> ${b.prompt}`, '');
    L.push('| check | ' + a.prompt + ' | ' + b.prompt + ' | delta |', '|---|---|---|---|');
    for (const c of CHECKS) {
      const x = a.checks[c].rate;
      const y = b.checks[c].rate;
      L.push(`| ${c} | ${pct(x)} | ${pct(y)} | ${x === null || y === null ? 'n/a' : `${y - x >= 0 ? '+' : ''}${((y - x) * 100).toFixed(0)} pts`} |`);
    }
    const flips = a.cases.map((ca, i) => ({ id: ca.id, a: ca.passed, b: b.cases[i].passed })).filter((f) => f.a !== f.b);
    L.push('', `Cases whose outcome changed: ${flips.length ? flips.map((f) => `${f.id} (${f.a ? 'pass' : 'fail'} -> ${f.b ? 'pass' : 'fail'})`).join(', ') : 'none'}`);
  }
  for (const r of runs) {
    L.push('', `## Failures: prompt ${r.prompt}`, '');
    const failed = r.cases.filter((c) => !c.passed);
    if (!failed.length) L.push('None.');
    for (const c of failed) {
      for (const t of c.turns) {
        const why = CHECKS.filter((k) => t.score[k] && !t.score[k]!.pass).map((k) => `${k}: ${t.score[k]!.why ?? 'failed'}`);
        if (!why.length) continue;
        L.push(`- **${c.id}** "${t.q}"`, `  - ${why.join('; ')}`, `  - answer: ${JSON.stringify(t.text.slice(0, 160))}`);
      }
    }
  }
  return L.join('\n') + '\n';
}

async function main() {
  loadDotEnv();
  const casesFile = resolve(arg('cases') ?? 'evals/golden.jsonl');
  const cases = parseGolden(readFileSync(casesFile, 'utf8'));
  const prompt = arg('prompt') ?? 'v2';
  const compare = arg('compare');
  const minPass = arg('min-pass') ? Number(arg('min-pass')) : null;
  const token = arg('token') ?? process.env.API_TOKEN;
  const cfg = loadConfig();

  let base = arg('url');
  let cleanup = async () => {};
  if (!base) {
    const dir = mkdtempSync(join(tmpdir(), 'llm-agent-evals-'));
    const app = createApp({ ...cfg, dataDir: dir, dailyLimit: 1_000_000, apiToken: '', port: 0 });
    const port = await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${port}`;
    cleanup = async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    };
  }
  const runId = Date.now().toString(36);
  try {
    const runs: RunSummary[] = [];
    for (const p of compare ? [prompt, compare] : [prompt]) runs.push(await runSet(base, base === arg('url') ? token : undefined, cases, p, runId));
    const when = new Date().toISOString();
    const report = renderReport(runs, { provider: arg('url') ? `external ${arg('url')}` : cfg.provider, model: arg('url') ? '(server config)' : cfg.model, when, n: cases.length });
    const out = resolve(arg('out') ?? 'evals/reports');
    mkdirSync(out, { recursive: true });
    const stamp = when.replace(/[:.]/g, '-');
    writeFileSync(join(out, `report-${stamp}.md`), report);
    writeFileSync(join(out, `report-${stamp}.json`), JSON.stringify({ when, runs }, null, 2));
    console.log(report);
    const final = runs[runs.length - 1];
    console.log(`Report written to ${join(out, `report-${stamp}.md`)}`);
    if (minPass !== null && final.passRate < minPass) {
      console.error(`FAIL: pass rate ${pct(final.passRate)} for prompt ${final.prompt} is below --min-pass ${minPass}`);
      process.exitCode = 1;
    }
  } finally {
    await cleanup();
  }
}

await main();
