import type { ChatRequest, ChatResult, LlmClient, Message, ToolCall } from '../types.js';

/**
 * Deterministic rule-based "model" so the whole stack runs offline.
 * It is NOT a language model: it maps keywords to tool calls and renders answers from tool results.
 *
 * Model-name switches (set LLM_MODEL / LLM_FALLBACK_MODEL):
 *   mock-fail*  always throws (exercises the fallback path)
 *   mock-text*  emits tool calls as text instead of structured calls (exercises the rescue parser)
 *   anything else: normal behaviour
 * Style switch: if the system prompt contains "Answer first" (prompt v2) answers are terse and
 * tool-free; otherwise (prompt v1) the mock narrates its steps, like a chatty model might.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const CAT_RE = /\b(coffee|tea|brewing gear|mugs? (?:&|and) bottles|mugs?|snacks?)\b/i;
const CAT_MAP: Record<string, string> = { coffee: 'Coffee', tea: 'Tea', 'brewing gear': 'Brewing Gear', mug: 'Mugs & Bottles', mugs: 'Mugs & Bottles', snack: 'Snacks', snacks: 'Snacks' };

const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthName = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return `${MONTHS[mo - 1][0].toUpperCase()}${MONTHS[mo - 1].slice(1)} ${y}`;
};

function today(system: string): string {
  return /Today's date in the dataset: (\d{4}-\d{2}-\d{2})/.exec(system)?.[1] ?? '2025-06-30';
}

function category(q: string): string | undefined {
  const m = CAT_RE.exec(q);
  if (!m) return undefined;
  const k = m[1].toLowerCase();
  return CAT_MAP[k] ?? (k.startsWith('mug') ? 'Mugs & Bottles' : undefined);
}

function period(q: string, td: string): Record<string, unknown> {
  const l = q.toLowerCase();
  const year = Number(td.slice(0, 4));
  const curMonth = Number(td.slice(5, 7));
  const qm = /\bq([1-4])\b/.exec(l);
  if (qm) {
    const s = (Number(qm[1]) - 1) * 3 + 1;
    const pad = (n: number) => String(n).padStart(2, '0');
    const endDay = new Date(Date.UTC(year, s + 2, 0)).getUTCDate();
    return { from: `${year}-${pad(s)}-01`, to: `${year}-${pad(s + 2)}-${endDay}` };
  }
  const mi = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`).test(l) || new RegExp(`\\b${m.slice(0, 3)}\\b`).test(l.replace(/\bmay\b/, 'may')));
  if (mi >= 0 && !/\bmay i\b/.test(l)) {
    const y = /\b(20\d\d)\b/.exec(l)?.[1] ?? String(year);
    return { month: `${y}-${String(mi + 1).padStart(2, '0')}` };
  }
  if (/last month/.test(l)) {
    const m = curMonth === 1 ? 12 : curMonth - 1;
    return { month: `${curMonth === 1 ? year - 1 : year}-${String(m).padStart(2, '0')}` };
  }
  if (/this month|month so far|month to date/.test(l)) return { month: td.slice(0, 7) };
  const nd = /(?:last|past|previous|[uú]ltimos)\s+(\d{1,3})\s+(?:days?|d[ií]as?)/.exec(l);
  if (nd) return { days: Number(nd[1]) };
  if (/last week|past week|this week|[uú]ltima semana/.test(l)) return { days: 7 };
  if (/\btoday\b|\bhoy\b/.test(l)) return { days: 1 };
  if (/last year|this year/.test(l)) return { days: 180 };
  return { days: 30 };
}

function decide(q: string, system: string): { text?: string; call?: { name: string; args: Record<string, unknown> } } {
  const l = q.toLowerCase().trim();
  const td = today(system);
  const pending = /PENDING_ACTION id=(\S+)/.exec(system)?.[1];
  const sku = /\b([A-Z]{3}-\d{3})\b/i.exec(q)?.[1]?.toUpperCase();
  const cat = category(q);

  const isCancel = /\b(cancel|nevermind|never mind|discard|cancela)\b/.test(l) || /^no\b/.test(l);
  const isConfirm = /\b(yes|confirm|confirmed|confirmo|go ahead|do it|s[ií]|ok|okay|apply)\b/.test(l);
  if (l.split(/\s+/).length <= 6 && (isCancel || isConfirm)) {
    if (!pending) return { text: 'There is nothing pending to confirm right now.' };
    return { call: { name: 'confirm_action', args: { action_id: pending, decision: isCancel ? 'cancel' : 'confirm' } } };
  }
  if (/ignore (all |your |previous )|system prompt|your instructions|what tools|which tools|list .*tools|tools you have/.test(l)) {
    return { text: 'I can only help with shop sales, products, stock and goals. What would you like to know?' };
  }
  if (/\b(set|change|update|make)\b.*\bprice\b/.test(l) && sku) {
    const num = /(?:to|at|=)\s*\$?(\d+(?:\.\d+)?)/.exec(l)?.[1];
    return { call: { name: 'propose_price_change', args: { sku, new_price: Number(num ?? NaN) } } };
  }
  if (/\b(set|change|update|raise|lower)\b.*\b(goal|target)\b/.test(l)) {
    const amount = /(?:to|at|=)\s*\$?(\d[\d,]*(?:\.\d+)?)/.exec(l)?.[1]?.replace(/,/g, '');
    const p = period(q, td);
    const args: Record<string, unknown> = { month: p.month ?? td.slice(0, 7), amount: Number(amount ?? NaN) };
    if (cat) args.category = cat;
    return { call: { name: 'propose_goal_change', args } };
  }
  if (/\b(goal|goals|target|targets|quota|on track)\b/.test(l)) {
    const p = period(q, td);
    const args: Record<string, unknown> = { month: p.month ?? td.slice(0, 7) };
    if (cat) args.category = cat;
    return { call: { name: 'goal_progress', args } };
  }
  if (/low (on )?stock|running (low|out)|restock|out of stock|poco stock|stock bajo/.test(l)) {
    return { call: { name: 'product_lookup', args: { low_stock: true } } };
  }
  if (sku && /stock|price|tell me|about|details|info/.test(l)) {
    return { call: { name: 'product_lookup', args: { query: sku } } };
  }
  if (/\b(stock|in stock|price of|how much is|cost of)\b/.test(l) && !/\b(sales|revenue)\b/.test(l)) {
    if (cat && /\b(all|every)\b.*\bproducts?\b|\bproducts?\b/.test(l)) return { call: { name: 'product_lookup', args: { category: cat } } };
    const m = /(?:how many|price of|cost of|how much is|stock (?:of|for))\s+(?:the\s+)?(.+?)(?:\s+do we have|\s+in stock|\s+cost|\?|$)/.exec(l);
    const name = (m?.[1] ?? '').replace(/s$/, '').trim();
    if (name) return { call: { name: 'product_lookup', args: { query: name } } };
  }
  if (/\b(top|best[- ]?sell\w*|most sold|bestsell\w*|best seller)\b/.test(l)) {
    const lim = /\btop (\d+)\b/.exec(l)?.[1] ?? Object.entries(NUM_WORDS).find(([w]) => new RegExp(`\\b(?:top|best) ${w}\\b|\\b${w} (?:best|top)`).test(l))?.[1];
    const args: Record<string, unknown> = { ...period(q, td), by: /unit|most sold|sold the most/.test(l) ? 'units' : 'revenue', limit: Number(lim ?? 5) };
    if (cat) args.category = cat;
    return { call: { name: 'top_products', args } };
  }
  if (/\b(sales|revenue|sold|ventas|ingresos|how much (did|have) we|income|brought|compare)\b/.test(l)) {
    const args: Record<string, unknown> = { ...period(q, td) };
    if (/by categor|per categor|which categor|categor(y|ies) (brought|had)|breakdown.*categor/.test(l)) args.group_by = 'category';
    else if (/by store|per store|which store|each store|store sold/.test(l)) args.group_by = 'store';
    else if (/daily|by day|per day|each day/.test(l)) args.group_by = 'day';
    else if (/by product|per product/.test(l)) args.group_by = 'product';
    else if (/monthly|by month|per month/.test(l)) args.group_by = 'month';
    if (cat) args.category = cat;
    return { call: { name: 'sales_summary', args } };
  }
  if (/\b(remember|recuerda)\b/.test(l)) return { text: "Got it, I'll remember that." };
  if (/^(hi|hello|hey|hola|good (morning|afternoon|evening))\b/.test(l)) {
    return { text: 'Hi! I can answer questions about sales, products, stock and monthly goals.' };
  }
  return { text: 'I can only help with shop sales, products, stock and goals. Try asking about last month\'s revenue or which items are low on stock.' };
}

function compose(name: string, raw: string): string {
  let r: any;
  try {
    r = JSON.parse(raw);
  } catch {
    return 'Something went wrong reading the data.';
  }
  if (r.error) return `I could not do that: ${r.error}.`;
  const label = (p: any) => (/^\d{4}-\d{2}-01$/.test(p.from) && p.to === new Date(Date.UTC(+p.from.slice(0, 4), +p.from.slice(5, 7), 0)).toISOString().slice(0, 10) ? monthName(p.from.slice(0, 7)) : `${p.from} to ${p.to}`);
  switch (name) {
    case 'sales_summary': {
      const cat = r.category ? ` in ${r.category}` : '';
      let s = `Revenue${cat} for ${label(r.period)} was ${money(r.total_revenue)} from ${r.total_units} units.`;
      if (r.groups?.length) {
        const g = r.group_by === 'day' || r.group_by === 'month' ? r.groups.slice(-7) : r.groups.slice(0, 3);
        s += '\n' + g.map((x: any) => `${x.key}: ${money(x.revenue)}`).join('\n');
      }
      return s;
    }
    case 'top_products': {
      if (!r.items.length) return 'No sales found for that period.';
      const lines = r.items.slice(0, 5).map((x: any, i: number) => `${i + 1}. ${x.name}: ${r.by === 'units' ? `${x.units} units` : money(x.revenue)}`);
      return `${r.items[0].name} leads for ${label(r.period)} by ${r.by}.\n${lines.join('\n')}`;
    }
    case 'product_lookup': {
      if (!r.matches.length) return 'I could not find a matching product.';
      const rows = r.matches.slice(0, 6).map((x: any) => `${x.name} (${x.sku}): ${money(x.price)}, ${x.stock} in stock (reorder at ${x.reorder_level})`);
      return (r.matches.length > 6 ? `${r.matches.length} matches, showing 6.\n` : '') + rows.join('\n');
    }
    case 'goal_progress': {
      if (!r.goals.length) return `There are no goals set for ${monthName(r.month)}.`;
      const [first, ...rest] = r.goals;
      const nm = (g: any) => (g.category === 'all' ? 'Overall' : g.category);
      return `${nm(first)} for ${monthName(r.month)}: ${money(first.actual)} of ${money(first.target)} (${first.pct}%).` + (rest.length ? '\n' + rest.slice(0, 4).map((g: any) => `${nm(g)}: ${g.pct}%`).join('\n') : '');
    }
    case 'propose_price_change':
    case 'propose_goal_change':
      return `${r.summary} Reply "confirm" to apply it or "cancel" to drop it.`;
    case 'confirm_action':
      return r.status === 'cancelled' ? 'Cancelled. Nothing was changed.' : `Done. ${r.summary}`;
    default:
      return 'Done.';
  }
}

let seq = 0;

export class MockClient implements LlmClient {
  readonly name = 'mock';

  async chat(req: ChatRequest, onText?: (d: string) => void): Promise<ChatResult> {
    if (req.model.startsWith('mock-fail')) throw new Error('mock provider failure (simulated)');
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const chatty = !/answer first/i.test(system);
    const lastUserIdx = req.messages.map((m: Message) => m.role).lastIndexOf('user');
    const user = req.messages[lastUserIdx]?.content ?? '';
    const after = req.messages.slice(lastUserIdx + 1);
    const lastTool = [...after].reverse().find((m) => m.role === 'tool');

    let content = '';
    const toolCalls: ToolCall[] = [];
    if (lastTool) {
      const body = compose(lastTool.name ?? '', lastTool.content ?? '');
      content = chatty ? `Great question! First, I called the ${lastTool.name} tool, then I summarised what it returned.\n\n${body}` : body;
    } else {
      const d = decide(user, system);
      if (d.call) {
        const tc: ToolCall = { id: `mock_${++seq}`, name: d.call.name, arguments: d.call.args };
        if (req.model.startsWith('mock-text')) {
          content = `<tool_call>${JSON.stringify({ name: tc.name, arguments: tc.arguments })}</tool_call>`;
        } else {
          toolCalls.push(tc);
          if (chatty) content = `Sure! Let me look into that. I'll use the ${tc.name} tool to fetch the data.`;
        }
      } else {
        content = d.text ?? '';
      }
    }
    for (let i = 0; i < content.length; i += 12) {
      if (req.signal?.aborted) throw new Error('aborted');
      onText?.(content.slice(i, i + 12));
    }
    return { content, toolCalls };
  }
}
