import { TOOLS } from '../src/tools.js';

export interface TurnSpec {
  q: string;
  expect_tools?: string[]; // all must be called; [] means "no tool may be called"
  forbid_tools?: string[];
  must_include?: string[]; // regex sources, case-insensitive
  must_not_include?: string[];
}
export interface GoldenCase {
  id: string;
  turns: TurnSpec[];
  max_chars?: number;
}
export interface TurnObservation {
  text: string;
  tools: string[];
  ok: boolean;
}
export type CheckName = 'answer_first' | 'no_tool_leak' | 'no_narration' | 'format' | 'tool_use' | 'content';
export const CHECKS: CheckName[] = ['answer_first', 'no_tool_leak', 'no_narration', 'format', 'tool_use', 'content'];
export type TurnScore = Partial<Record<CheckName, { pass: boolean; why?: string }>>;

const TOOL_NAMES = TOOLS.map((t) => t.name);

const FILLER_OPENERS = /^\W*(sure|certainly|of course|absolutely|great question|good question|let me|let's|i['’]ll|i will|i['’]m going to|i am going to|first,|okay[, ]|ok[, ]|to answer|happy to|i need to)/i;
const NARRATION = [
  /\bi (called|used|ran|queried|looked up|checked|fetched|invoked|executed)\b/i,
  /\b(first|then|next|finally),? i\b/i,
  /\bstep (1|2|one|two)\b/i,
  /\busing (the|a) [\w` -]*(tool|function)\b/i,
  /\b(the )?[\w`]+ (tool|function) (returned|gave|shows)\b/i,
  /\bi['’]ll (use|call|run|check|look)\b/i,
  /\blet me (check|look|fetch|query|pull|run|call)\b/i,
];
const LEAK_PATTERNS = [/tool_call/i, /function_call/i, /"arguments"\s*:/i, /"name"\s*:\s*"/i, /<\/?tool/i, /system prompt/i];

export function scoreTurn(spec: TurnSpec, obs: TurnObservation, maxChars = 700): TurnScore {
  const t = obs.text.trim();
  const s: TurnScore = {};

  s.answer_first = FILLER_OPENERS.test(t) || !t ? { pass: false, why: 'empty or filler/narrating opener' } : { pass: true };

  const leaked = TOOL_NAMES.find((n) => t.toLowerCase().includes(n)) ?? LEAK_PATTERNS.find((p) => p.test(t))?.source;
  s.no_tool_leak = leaked ? { pass: false, why: `leaks "${leaked}"` } : { pass: true };

  const nar = NARRATION.find((p) => p.test(t));
  s.no_narration = nar ? { pass: false, why: `narrates steps (${nar.source.slice(0, 30)})` } : { pass: true };

  const lines = t.split(/\r?\n/).filter((l) => l.trim()).length;
  const fmtProblems = [
    !t && 'empty',
    t.length > maxChars && `too long (${t.length} > ${maxChars})`,
    lines > 8 && `too many lines (${lines})`,
    /^#{1,6}\s/m.test(t) && 'markdown heading',
    /\*\*[^*]+\*\*/.test(t) && 'markdown bold',
    !obs.ok && 'request failed',
  ].filter(Boolean);
  s.format = fmtProblems.length ? { pass: false, why: fmtProblems.join(', ') } : { pass: true };

  if (spec.expect_tools !== undefined || spec.forbid_tools?.length) {
    const problems: string[] = [];
    const exp = spec.expect_tools;
    if (exp?.length === 0 && obs.tools.length) problems.push(`expected no tools, got ${obs.tools.join(',')}`);
    for (const n of exp ?? []) if (!obs.tools.includes(n)) problems.push(`missing ${n}`);
    for (const n of spec.forbid_tools ?? []) if (obs.tools.includes(n)) problems.push(`forbidden ${n} was called`);
    s.tool_use = problems.length ? { pass: false, why: problems.join('; ') } : { pass: true };
  }

  if (spec.must_include?.length || spec.must_not_include?.length) {
    const problems: string[] = [];
    for (const r of spec.must_include ?? []) if (!new RegExp(r, 'i').test(t)) problems.push(`missing /${r}/`);
    for (const r of spec.must_not_include ?? []) if (new RegExp(r, 'i').test(t)) problems.push(`has forbidden /${r}/`);
    s.content = problems.length ? { pass: false, why: problems.join('; ') } : { pass: true };
  }
  return s;
}

export function parseGolden(jsonl: string): GoldenCase[] {
  const cases: GoldenCase[] = [];
  jsonl.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith('//')) return;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      throw new Error(`golden set line ${i + 1}: invalid JSON`);
    }
    const turns: TurnSpec[] = o.turns ?? [{ q: o.question, expect_tools: o.expect_tools, forbid_tools: o.forbid_tools, must_include: o.must_include, must_not_include: o.must_not_include }];
    if (!o.id || !turns.length || turns.some((t) => typeof t.q !== 'string')) throw new Error(`golden set line ${i + 1}: needs id and question/turns`);
    cases.push({ id: o.id, turns, max_chars: o.max_chars });
  });
  return cases;
}

/** Per-check pass rates over a list of turn scores (only turns where the check applied). */
export function aggregate(scores: TurnScore[]): Record<CheckName, { pass: number; total: number; rate: number | null }> {
  const out = {} as Record<CheckName, { pass: number; total: number; rate: number | null }>;
  for (const c of CHECKS) {
    const applicable = scores.map((s) => s[c]).filter(Boolean) as Array<{ pass: boolean }>;
    const pass = applicable.filter((x) => x.pass).length;
    out[c] = { pass, total: applicable.length, rate: applicable.length ? pass / applicable.length : null };
  }
  return out;
}

export const turnPassed = (s: TurnScore) => Object.values(s).every((v) => !v || v.pass);
