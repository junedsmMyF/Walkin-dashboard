// PDP analytics source (GA4 / its BigQuery export) — audit task 8, 27 Oct 2026.
// NOT CONNECTED YET: until it is, /api/pdp keeps the illustrative sample (pdp.js buildSample) and says so.
// This file fixes the interface so the PDP views / Retail CTA clicks cards switch to live data without page changes.
//
// Input contract — one row per date × product handle × CTA name (long format, what a GA4 / BigQuery GROUP BY returns):
//   date            'YYYY-MM-DD' or GA4's 'YYYYMMDD' (IST calendar day)
//   product_handle  myfrido.com product handle, e.g. 'frido-ultimate-pro-seat-cushion' (a /products/… URL also works)
//   cta_name        'pdp_view' for product page views; otherwise the retail CTA clicked (see CTA below)
//   count           events that day (integer ≥ 0)
// Optional columns: product_name, category (otherwise the handle is shown and the category is 'Unmapped').
//
// Delivery (₹0, same pattern as the routing sheet): a published CSV with those columns in the secret GA4_PDP_CSV_URL,
// e.g. a scheduled BigQuery query → Google Sheet. No secret → status 'not_connected' and the sample stays on.
//
// Output — the same shape the page already reads for the sample, so nothing else changes:
//   { isSample: false, pdps: [{ n, c, h }], pdpDaily: [{ d, p, views, clicks, wa, call }], from, to, unknownCtas }
//   clicks = lead CTAs only (WhatsApp + Call). Get Direction is not a lead CTA (owner rule): recognised and left out.

// CTA names → kind. Keys are lower-case with spaces / dashes as underscores. The GA4 event or parameter names are
// not confirmed yet: add the real ones here when the tagging is shared. Unknown names are counted, never guessed.
export const CTA = {
  pdp_view: 'view', page_view: 'view', view_item: 'view',
  whatsapp: 'wa', whatsapp_store: 'wa', chat_on_whatsapp: 'wa',
  call: 'call', call_store: 'call',
  get_direction: null, get_directions: null, // not a lead CTA — never shown
};
const ctaKey = (s) => String(s || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const isoDate = (s) => { const t = String(s || '').trim(); const m = t.match(/^(\d{4})-?(\d{2})-?(\d{2})$/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const handleOf = (s) => { const t = String(s || '').trim().toLowerCase(); const m = t.match(/\/products\/([^/?#]+)/); return (m ? m[1] : t).replace(/[^a-z0-9-]/g, '') || null; };
const titleOf = (h) => h.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// Rows (objects with the columns above) → the page's PDP shape. Rows outside [from, to] or malformed are skipped and counted.
export function ga4ToPdp(rows, { from, to } = {}) {
  const pidx = new Map(), pdps = [], daily = new Map(), unknown = {}; let skipped = 0;
  for (const r of rows || []) {
    const d = isoDate(r.date), h = handleOf(r.product_handle), n = Number(r.count);
    if (!d || !h || !Number.isFinite(n) || n < 0) { skipped++; continue; }
    if ((from && d < from) || (to && d > to)) continue;
    const name = ctaKey(r.cta_name), kind = CTA[name];
    if (kind === null) continue;
    if (!kind) { unknown[name || '(blank)'] = (unknown[name || '(blank)'] || 0) + n; continue; }
    if (!pidx.has(h)) { pidx.set(h, pdps.length); pdps.push({ n: String(r.product_name || '').trim() || titleOf(h), c: String(r.category || '').trim() || 'Unmapped', h }); }
    const p = pidx.get(h), k = d + '|' + p;
    const o = daily.get(k) || { d, p, views: 0, clicks: 0, wa: 0, call: 0 };
    if (kind === 'view') o.views += n; else o[kind] += n;
    o.clicks = o.wa + o.call;
    daily.set(k, o);
  }
  const pdpDaily = [...daily.values()].sort((a, b) => a.d.localeCompare(b.d) || a.p - b.p);
  return { isSample: false, pdps, pdpDaily, from: pdpDaily[0]?.d || null, to: pdpDaily.at(-1)?.d || null, unknownCtas: unknown, skipped };
}

// Source adapter for the PDP build. loadCsv = the Worker's published-sheet reader (rows as objects).
// Returns { status, data?, error? }: 'not_connected' (no secret), 'live', 'empty' (connected, no rows in range) or 'error'.
export async function pdpAnalytics(env, loadCsv, { from, to }) {
  if (!env.GA4_PDP_CSV_URL) return { status: 'not_connected' };
  try {
    const data = ga4ToPdp(await loadCsv(env.GA4_PDP_CSV_URL, env), { from, to });
    return data.pdpDaily.length ? { status: 'live', data } : { status: 'empty', data };
  } catch (e) { return { status: 'error', error: String(e.message || e).slice(0, 200) }; }
}
