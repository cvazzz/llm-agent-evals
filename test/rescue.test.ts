import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksLikeToolCall, rescueToolCalls } from '../src/rescue.js';

const names = ['sales_summary', 'top_products'];

test('parses <tool_call> tags', () => {
  const r = rescueToolCalls('<tool_call>{"name":"sales_summary","arguments":{"days":7}}</tool_call>', names);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'sales_summary');
  assert.deepEqual(r.calls[0].arguments, { days: 7 });
  assert.equal(r.text, '');
});

test('parses fenced json and keeps surrounding prose', () => {
  const r = rescueToolCalls('Checking.\n```json\n{"name":"top_products","arguments":{"limit":3}}\n```\n', names);
  assert.equal(r.calls[0].name, 'top_products');
  assert.equal(r.text, 'Checking.');
});

test('parses bare JSON, OpenAI-style wrapper and string arguments', () => {
  const a = rescueToolCalls('{"name":"sales_summary","parameters":{"month":"2025-03"}}', names);
  assert.deepEqual(a.calls[0].arguments, { month: '2025-03' });
  const b = rescueToolCalls('{"function":{"name":"top_products","arguments":"{\\"limit\\":2}"}}', names);
  assert.deepEqual(b.calls[0].arguments, { limit: 2 });
});

test('parses name({...}) call syntax, with braces inside strings', () => {
  const r = rescueToolCalls('sales_summary({"category":"Tea {x}","days":5})', names);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].arguments.category, 'Tea {x}');
});

test('parses a list of calls', () => {
  const r = rescueToolCalls('[{"name":"sales_summary","arguments":{}},{"name":"top_products","arguments":{}}]', names);
  assert.equal(r.calls.length, 2);
});

test('ignores unknown tools, malformed JSON and plain text', () => {
  assert.equal(rescueToolCalls('{"name":"rm_rf","arguments":{}}', names).calls.length, 0);
  assert.equal(rescueToolCalls('{"name":"sales_summary","arguments":{', names).calls.length, 0);
  const plain = rescueToolCalls('Revenue was {about} $100.', names);
  assert.equal(plain.calls.length, 0);
  assert.equal(plain.text, 'Revenue was {about} $100.');
});

test('looksLikeToolCall heuristics', () => {
  assert.ok(looksLikeToolCall('  {"name": "x"', names));
  assert.ok(looksLikeToolCall('<tool_call>', names));
  assert.ok(looksLikeToolCall('sales_summary({"a":1})', names));
  assert.ok(!looksLikeToolCall('Revenue was $100', names));
});
