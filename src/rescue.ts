import type { ToolCall } from './types.js';

/**
 * Rescue parser: some models print the tool call as text instead of using the
 * structured tool_calls field. Recognised shapes (only for known tool names):
 *   <tool_call>{"name":..., "arguments":{...}}</tool_call>   (also <function_call>)
 *   ```json {"name":..., "arguments":{...}} ```
 *   bare JSON object/array: {"name":..., "arguments":{...}} or {"function":{"name","arguments"}}
 *   name({...json args...})
 * Returns the calls found and the text with those spans removed.
 */
export interface RescueResult {
  calls: ToolCall[];
  text: string;
}

export function looksLikeToolCall(text: string, toolNames: string[]): boolean {
  const t = text.trimStart();
  if (/^(```|<tool_call|<function_call|<\|python_tag\|>|\{|\[\s*\{)/i.test(t)) return true;
  return toolNames.some((n) => t.startsWith(`${n}(`));
}

/** Returns the index just past the balanced JSON value starting at `start` (string-aware), or -1. */
function findBalanced(s: string, start: number): number {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return -1;
}

function toCalls(value: unknown, names: Set<string>, counter: { n: number }): ToolCall[] {
  const items = Array.isArray(value) ? value : [value];
  const out: ToolCall[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const fn = (o.function && typeof o.function === 'object' ? o.function : o) as Record<string, unknown>;
    const name = (fn.name ?? fn.tool ?? fn.tool_name) as unknown;
    if (typeof name !== 'string' || !names.has(name)) continue;
    let args: unknown = fn.arguments ?? fn.parameters ?? fn.args ?? fn.input ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        continue;
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    out.push({ id: `rescued_${++counter.n}`, name, arguments: args as Record<string, unknown> });
  }
  return out;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function rescueToolCalls(text: string, toolNames: string[]): RescueResult {
  const names = new Set(toolNames);
  const counter = { n: 0 };
  const calls: ToolCall[] = [];
  let rest = text;

  // 1. tagged blocks and fenced blocks
  const absorb = (body: string, whole: string): string => {
    const found = toCalls(tryParse(body.trim()), names, counter);
    if (!found.length) return whole;
    calls.push(...found);
    return '';
  };
  rest = rest.replace(/<(?:tool_call|function_call)>\s*([\s\S]*?)\s*<\/(?:tool_call|function_call)>/gi, (whole, body: string) => absorb(body, whole));
  rest = rest.replace(/```(?:json|tool_call|tool)?\s*([\s\S]*?)```/gi, (whole, body: string) => absorb(body, whole));

  // 2. bare JSON values and name({...}) calls, scanning left to right
  let out = '';
  let i = 0;
  while (i < rest.length) {
    const c = rest[i];
    if (c === '{' || c === '[') {
      const end = findBalanced(rest, i);
      if (end > 0) {
        const found = toCalls(tryParse(rest.slice(i, end)), names, counter);
        if (found.length) {
          calls.push(...found);
          i = end;
          continue;
        }
      }
    } else if (/[a-z_]/i.test(c) && (i === 0 || !/[\w]/.test(rest[i - 1]))) {
      const m = /^([a-z_][a-z0-9_]*)\(\s*(?=\{)/i.exec(rest.slice(i));
      if (m && names.has(m[1])) {
        const bStart = i + m[0].length;
        const bEnd = findBalanced(rest, bStart);
        if (bEnd > 0) {
          let close = bEnd;
          while (rest[close] === ' ') close++;
          if (rest[close] === ')') {
            const args = tryParse(rest.slice(bStart, bEnd));
            if (args && typeof args === 'object' && !Array.isArray(args)) {
              calls.push({ id: `rescued_${++counter.n}`, name: m[1], arguments: args as Record<string, unknown> });
              i = close + 1;
              continue;
            }
          }
        }
      }
    }
    out += c;
    i++;
  }
  return { calls, text: out.replace(/\n{3,}/g, '\n\n').trim() };
}
