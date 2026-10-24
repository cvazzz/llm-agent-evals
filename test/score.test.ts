import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { aggregate, parseGolden, scoreTurn, turnPassed } from '../evals/score.js';

const obs = (text: string, tools: string[] = []) => ({ text, tools, ok: true });

test('good answer passes every applicable check', () => {
  const s = scoreTurn({ q: 'q', expect_tools: ['sales_summary'], must_include: ['\\$1,000'] }, obs('Revenue was $1,000 over 30 days.', ['sales_summary']));
  assert.ok(turnPassed(s));
});

test('filler opener, narration and tool-name leak are caught separately', () => {
  const s = scoreTurn({ q: 'q' }, obs('Sure! I called the sales_summary tool and then I looked at it.'));
  assert.equal(s.answer_first!.pass, false);
  assert.equal(s.no_tool_leak!.pass, false);
  assert.equal(s.no_narration!.pass, false);
});

test('leaked raw tool-call JSON is caught', () => {
  assert.equal(scoreTurn({ q: 'q' }, obs('Here: {"name": "x", "arguments": {}}')).no_tool_leak!.pass, false);
});

test('format: length, headings, bold, line count', () => {
  assert.equal(scoreTurn({ q: 'q' }, obs('x'.repeat(701))).format!.pass, false);
  assert.equal(scoreTurn({ q: 'q' }, obs('# Title\nbody')).format!.pass, false);
  assert.equal(scoreTurn({ q: 'q' }, obs('**bold** text')).format!.pass, false);
  assert.equal(scoreTurn({ q: 'q' }, obs(Array(9).fill('line').join('\n'))).format!.pass, false);
  assert.equal(scoreTurn({ q: 'q' }, obs('x'.repeat(701)), 800).format!.pass, true);
});

test('tool_use: missing, unexpected and forbidden tools', () => {
  assert.equal(scoreTurn({ q: 'q', expect_tools: ['top_products'] }, obs('ok', [])).tool_use!.pass, false);
  assert.equal(scoreTurn({ q: 'q', expect_tools: [] }, obs('ok', ['top_products'])).tool_use!.pass, false);
  assert.equal(scoreTurn({ q: 'q', forbid_tools: ['confirm_action'] }, obs('ok', ['confirm_action'])).tool_use!.pass, false);
  assert.equal(scoreTurn({ q: 'q' }, obs('ok', ['anything'])).tool_use, undefined);
});

test('aggregate counts only applicable checks', () => {
  const a = aggregate([scoreTurn({ q: 'q', expect_tools: [] }, obs('Hi there')), scoreTurn({ q: 'q' }, obs('Sure, hi'))]);
  assert.equal(a.tool_use.total, 1);
  assert.equal(a.answer_first.rate, 0.5);
  assert.equal(a.content.rate, null);
});

test('golden set parses, has >= 25 unique cases, and every tool name it expects exists', () => {
  const cases = parseGolden(readFileSync('evals/golden.jsonl', 'utf8'));
  assert.ok(cases.length >= 25);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  const known = new Set(['sales_summary', 'top_products', 'product_lookup', 'goal_progress', 'propose_price_change', 'propose_goal_change', 'confirm_action']);
  for (const c of cases) for (const t of c.turns) for (const n of [...(t.expect_tools ?? []), ...(t.forbid_tools ?? [])]) assert.ok(known.has(n), `${c.id}: ${n}`);
  assert.throws(() => parseGolden('{bad'), /invalid JSON/);
});
