// Chat-with-Data: question → (LLM) one read-only SQL query → (D1) result → (LLM) short answer using only returned numbers.
// The model never calculates; SQL does. Every number in the answer is checked against the result before it is shown.
export const MODELS = { fast: '@cf/qwen/qwen3-30b-a3b-fp8', deep: '@cf/openai/gpt-oss-120b' };
// If a model fails (busy, retired, or a request-format mismatch), the next free model is tried automatically.
export const MODEL_CHAIN = {
  fast: ['@cf/qwen/qwen3-30b-a3b-fp8', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/openai/gpt-oss-20b'],
  deep: ['@cf/openai/gpt-oss-120b', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/qwen/qwen3-30b-a3b-fp8'],
};
const ALLOWED = new Set(['sales_orders', 'sales_lines', 'leads', 'store_day']);

export const SCHEMA_DOC = `TABLES (SQLite). Dates are TEXT 'YYYY-MM-DD' (IST). Money in ₹. Data covers start_date → data_through (yesterday).
sales_orders — one row per store order (cancelled, refunded and partially refunded orders already removed; test store removed)
  order_id, order_date, weekday('Mon'..'Sun'), store_id, store_name, city, format('Mall'|'High street'), order_type('Cash & carry'|'Online punch-in'),
  units, lines, gross(qty×price), discount, total_revenue(gross−discount), is_walkin(1 = walk-in attributed order), walkin_basis('Bigin lead'|'Manual override'),
  lead_walkin_date, days_lead_to_order, is_first_walkin_order(1 = customer's first walk-in order)
sales_lines — one row per product line of those orders
  order_id, order_date, store_id, store_name, city, format, order_type, product_name, category, quantity, gross, total_revenue, is_walkin
  categories: Chairs, Workspace, Cushions, Pillows, Mattress, Insoles, Orthotics, Footwear, Barefoot, Socks, Personal Care, Maternity, Accessories, Masks, Combos, Services
leads — one row per Bigin walk-in lead record
  lead_id, walkin_date, weekday, store_id, store_name, city, format, is_captured(1 = counts as a Captured lead), exclusion_reason('Duplicate (same customer, same day)'|'Bought the same day'|NULL),
  stage(Bigin stage), stage_group('Not called'|'Ringing out'|'Engaged'|'Won in CRM (unverified)'|'Lost'|'Other'), product_interest, interest_category, loss_reason,
  call_date, days_to_call, converted(1 = bought later, verified by sales), first_order_date, days_to_first_order, converted_revenue
store_day — one row per store per day
  date, weekday, store_id, store_name, city, format, walkins(DSR footfall; NULL when no DSR), dsr_sent(1/0), orders(all store orders), cash_carry_orders, online_orders,
  store_revenue(all orders, total revenue), store_gross, bigin_leads, duplicate_leads, bought_same_day_leads, captured_leads, walkin_orders, walkin_revenue, walkin_gross, converted_customers

KPI DEFINITIONS (use exactly these):
- Walk-in revenue = SUM(total_revenue) FROM sales_orders WHERE is_walkin=1 (or SUM(walkin_revenue) FROM store_day). "Revenue" alone means Total Revenue (gross − discount). Gross = SUM(gross).
- Total store sales / DevX sales = SUM(total_revenue) over all sales_orders (or SUM(store_revenue) FROM store_day).
- Walk-in contribution % = walk-in revenue ÷ total store sales.
- Walk-ins (footfall) = SUM(walkins) FROM store_day.
- Conversion rate = SUM(orders) ÷ SUM(walkins) FROM store_day WHERE dsr_sent=1.
- Capture rate Formula 1 = (SUM(orders)+SUM(captured_leads)) ÷ SUM(walkins), store_day WHERE dsr_sent=1. Formula 2 = SUM(captured_leads) ÷ (SUM(walkins)−SUM(orders)), same rows. Default to Formula 1.
- Captured leads = SUM(captured_leads) FROM store_day, or COUNT(*) FROM leads WHERE is_captured=1.
- Converted leads = COUNT(*) FROM leads WHERE is_captured=1 AND converted=1. Lead conversion % = that ÷ captured leads.
- AOV = revenue ÷ COUNT(DISTINCT order_id). Discount % = SUM(discount) ÷ SUM(gross).
- Financial year runs April–March (Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar).`;

const planPrompt = (ctx) => `You are Frido's walk-in data analyst. Turn the user's question into ONE SQLite SELECT query over the tables below.
${SCHEMA_DOC}

CONTEXT: data_through = ${ctx.dataThrough} (yesterday; "today" has no data). start_date = ${ctx.startDate}. Dashboard filters now: ${ctx.filters || 'none'}.
RULES
1. Only SELECT/WITH over sales_orders, sales_lines, leads, store_day. One statement. No semicolons.
2. If the question gives no dates, use the dashboard filters' date range and say so in interpretation. "Yesterday" = data_through. "Last month" = the full calendar month before data_through's month. Month names mean the latest such month with data.
3. Match stores with LIKE on store_name (case-insensitive), e.g. store_name LIKE '%kompally%'. Cities: Pune, Mumbai, Hyderabad, Bangalore, Delhi, Gurgaon, Faridabad.
4. For rates, also return the numerator and denominator columns. Round money to 0 decimals and rates to 4 decimals (as fractions). Name columns clearly in snake_case.
5. Return at most 50 rows; ORDER BY the main measure when ranking.
6. If the question needs data these tables do not have (e.g. targets, staff salaries, Meta ads, inventory, customer names or phones), do not write SQL: set cannot_answer to a short reason.
7. Follow-up questions refer to the previous turns below; keep their filters unless the user changes them.
Reply with ONLY a JSON object: {"interpretation": "<one line: what you will calculate, incl. dates/filters>", "sql": "<query or empty>", "cannot_answer": "<empty or reason>"} /no_think`;

const answerPrompt = `You write the answer for Frido's management dashboard. Use ONLY numbers that appear in the RESULT (you may round them and format ₹ in Indian style: ₹4.2 L, ₹1.3 Cr; fractions as %).
Never invent, estimate or calculate new numbers. Reply in at most 3 short sentences, leading with the direct answer. If the result does not answer the question, say exactly what is missing. No SQL, no preamble. /no_think`;

function textOf(res) {
  let t = '';
  if (typeof res === 'string') t = res;
  else if (res?.response != null) t = res.response;
  else if (res?.choices?.[0]?.message?.content != null) t = res.choices[0].message.content;
  else if (res?.output_text != null) t = res.output_text;
  else if (Array.isArray(res?.output)) t = res.output.filter((o) => o.type === 'message' || o.content).flatMap((o) => (Array.isArray(o.content) ? o.content : [])).filter((c) => c.type === 'output_text' || c.text).map((c) => c.text).join('');
  else if (res?.result?.response != null) t = res.result.response;
  if (typeof t !== 'string') t = JSON.stringify(t);
  return t.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
const firstJson = (t) => { const i = t.indexOf('{'); const j = t.lastIndexOf('}'); if (i < 0 || j <= i) return null; try { return JSON.parse(t.slice(i, j + 1)); } catch { return null; } };

export function checkSql(sql) {
  let s = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!s) return { ok: false, error: 'empty query' };
  if (s.replace(/'[^']*'/g, "''").includes(';')) return { ok: false, error: 'only one statement is allowed' };
  if (!/^(select|with)\b/i.test(s)) return { ok: false, error: 'only SELECT queries are allowed' };
  if (/\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|load_extension)\b/i.test(s.replace(/'[^']*'/g, "''"))) return { ok: false, error: 'the query may only read data' };
  if (/sqlite_|bot_meta/i.test(s)) return { ok: false, error: 'system tables are not available' };
  const ctes = new Set([...s.matchAll(/(?:\bwith|,)\s*(?:recursive\s+)?([a-z_][a-z0-9_]*)\s+as\s*\(/gi)].map((x) => x[1].toLowerCase()));
  const used = [...s.replace(/'[^']*'/g, "''").matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)].map((x) => x[1].toLowerCase());
  const bad = used.filter((t) => !ALLOWED.has(t) && !ctes.has(t));
  if (bad.length) return { ok: false, error: `unknown table(s): ${[...new Set(bad)].join(', ')}` };
  if (!/\blimit\s+\d+\s*$/i.test(s)) s = `SELECT * FROM (${s}) LIMIT 200`;
  return { ok: true, sql: s };
}

// Every number in the answer must come from the result (allowing rounding, ₹ L/Cr/k units and fraction→% conversion).
export function numbersGrounded(answer, rows) {
  const vals = []; for (const r of rows) for (const v of Object.values(r)) if (typeof v === 'number' && isFinite(v)) vals.push(v);
  const tokens = [...String(answer).matchAll(/(-?\d[\d,]*(?:\.\d+)?)\s*(cr|crore|l|lakh|lakhs|k|%)?(?![\w])/gi)];
  for (const m of tokens) {
    const n = parseFloat(m[1].replace(/,/g, '')); const unit = (m[2] || '').toLowerCase();
    if (!isFinite(n)) continue;
    if (!unit && Math.abs(n) <= 31 && Number.isInteger(n)) continue;          // small integers: days, ranks, counts in dates
    if (!unit && n >= 2000 && n <= 2100) continue;                             // years
    const cand = unit.startsWith('cr') ? [n * 1e7] : unit === 'l' || unit.startsWith('lakh') ? [n * 1e5] : unit === 'k' ? [n * 1e3] : unit === '%' ? [n / 100, n] : [n];
    const ok = cand.some((c) => vals.some((v) => { const tol = Math.max(Math.abs(v) * 0.006, unit ? Math.abs(v) * 0.051 : 0.5); return Math.abs(v - c) <= (unit === '%' ? Math.max(0.0006, Math.abs(v) * 0.006) : tol); }));
    if (!ok) return { ok: false, offending: m[0] };
  }
  return { ok: true };
}

// One model, both request styles: chat "messages" and the Responses-style "input" (used by GPT-OSS).
export async function runModel(env, model, messages, maxTokens) {
  const styles = model.includes('gpt-oss')
    ? [{ input: messages }, { messages, max_tokens: maxTokens }]
    : [{ messages, max_tokens: maxTokens, temperature: 0 }, { input: messages }];
  let lastErr = null;
  for (const body of styles) {
    try { const t = textOf(await env.AI.run(model, body)); if (t) return t; lastErr = new Error('empty reply'); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no reply');
}
async function llm(env, mode, messages, maxTokens, used) {
  const errs = [];
  for (const model of MODEL_CHAIN[mode] || MODEL_CHAIN.fast) {
    try { const t = await runModel(env, model, messages, maxTokens); used.model = model; return t; } catch (e) { errs.push(`${model.split('/').pop()}: ${String(e.message || e).slice(0, 120)}`); }
  }
  const err = new Error('AI models unavailable — ' + errs.join(' | ')); err.kind = 'ai'; throw err;
}

export async function ask(env, { question, history = [], filters = '', mode = 'fast' }) {
  const t0 = Date.now(); const used = { model: null }; mode = MODEL_CHAIN[mode] ? mode : 'fast';
  let meta = {};
  try { meta = Object.fromEntries(((await env.DB.prepare('SELECT k, v FROM bot_meta').all()).results || []).map((r) => [r.k, r.v])); }
  catch (e) { if (!/no such table/i.test(String(e.message))) { const err = new Error('Database error — ' + String(e.message).slice(0, 160)); err.kind = 'db'; throw err; } }
  if (!meta.data_through) return { answer: 'The bot\'s data is not built yet. An admin needs to open the admin page and click "Rebuild bot data (full)" once.', error: 'not_built' };
  const ctx = { dataThrough: meta.data_through, startDate: meta.start_date, filters };
  const msgs = [{ role: 'system', content: planPrompt(ctx) }];
  for (const h of history.slice(-4)) { msgs.push({ role: 'user', content: h.q }); msgs.push({ role: 'assistant', content: JSON.stringify({ interpretation: h.interpretation || '', sql: h.sql || '', cannot_answer: '' }) }); }
  msgs.push({ role: 'user', content: question });
  let plan = null, rows = null, sql = null, lastErr = '';
  for (let attempt = 0; attempt < 2 && !rows; attempt++) {
    const out = await llm(env, mode, attempt ? [...msgs, { role: 'user', content: `That failed: ${lastErr}. Fix it and reply with the JSON only. /no_think` }] : msgs, 700, used);
    plan = firstJson(out);
    if (!plan) { lastErr = 'the reply was not valid JSON'; continue; }
    if (plan.cannot_answer && !plan.sql) return { answer: `The dashboard data can't answer this: ${plan.cannot_answer}`, interpretation: plan.interpretation || '', sql: null, rows: [], columns: [], dataThrough: meta.data_through, ms: Date.now() - t0 };
    const chk = checkSql(plan.sql);
    if (!chk.ok) { lastErr = chk.error; continue; }
    try { const r = await env.DB.prepare(chk.sql).all(); rows = r.results || []; sql = chk.sql; } catch (e) { lastErr = String(e.message || e).slice(0, 300); }
  }
  if (!rows) return { answer: `Sorry — I couldn't build a correct query for that (${lastErr}). Try rephrasing, e.g. name the metric, store and dates.`, interpretation: plan?.interpretation || '', sql: plan?.sql || null, rows: [], columns: [], dataThrough: meta.data_through, ms: Date.now() - t0, error: 'query_failed' };
  const columns = rows.length ? Object.keys(rows[0]) : [];
  if (!rows.length) return { answer: 'No data matches this question for the selected period and filters.', interpretation: plan.interpretation, sql, rows: [], columns, dataThrough: meta.data_through, ms: Date.now() - t0 };
  const shown = rows.slice(0, 50);
  const csv = [columns.join(','), ...shown.map((r) => columns.map((c) => r[c]).join(','))].join('\n');
  let answer = await llm(env, mode, [{ role: 'system', content: answerPrompt }, { role: 'user', content: `QUESTION: ${question}\nWHAT WAS CALCULATED: ${plan.interpretation}\nRESULT (${rows.length} rows${rows.length > 50 ? ', first 50 shown' : ''}):\n${csv}` }], 300, used);
  const g = numbersGrounded(answer, shown);
  let verified = g.ok;
  if (!g.ok || !answer) { answer = 'Here is the result — see the table below.'; verified = false; }
  return { answer, verified, interpretation: plan.interpretation, sql, columns, rows: shown, rowCount: rows.length, dataThrough: meta.data_through, model: used.model, ms: Date.now() - t0 };
}
