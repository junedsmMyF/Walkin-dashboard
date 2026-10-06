// Cloudflare Worker: serves the dashboard (static assets), a PII-free metrics API, the Bigin admin page,
// and the 6:00 AM IST daily Bigin refresh (cron "30 0 * * *" UTC).
import { parseCsv } from './csv.js';
import { istDate, addDays } from './dates.js';
import { computeMetrics } from './metrics.js';
import { standardizeTab, combineTabs } from './standardize.js';
import { cleanToEngineRows, excludedSummary } from './clean.js';
import { refreshBigin, biginLeads, biginMeta, biginConnected, startConnect, finishConnect } from './bigin.js';

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
const html = (body, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Dashboard admin</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#101820}button,a.btn{display:inline-block;padding:10px 16px;border-radius:999px;border:0;background:#FFD100;color:#101820;font-weight:600;text-decoration:none;cursor:pointer;margin:4px 8px 4px 0}pre{background:#F4F6F9;padding:12px;border-radius:8px;overflow:auto}</style></head><body>${body}</body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });

// Read a published sheet. Every good copy is kept in KV (at most once an hour), so if Google later
// rejects the link (tab deleted, publishing stopped, outage) the dashboard keeps working on the last
// good copy and says so, instead of going blank.
const SHEET_STATUS = new Map(); // url → { ok, status, staleSince, savedAt, error }
async function sheetText(url, env) {
  const key = 'sheet:' + url;
  try {
    const res = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!res.ok) throw new Error(`Google returned ${res.status} for this published link`);
    const text = await res.text();
    if (!text || /^\s*<(!doctype|html)/i.test(text)) throw new Error('Google returned a web page instead of CSV (link not published as CSV?)');
    if (env?.DASH_KV) {
      const meta = await env.DASH_KV.get(key + ':meta', 'json');
      if (!meta || Date.now() - Date.parse(meta.savedAt) > 3600e3) {
        await env.DASH_KV.put(key, text); await env.DASH_KV.put(key + ':meta', JSON.stringify({ savedAt: new Date().toISOString() }));
      }
    }
    SHEET_STATUS.set(url, { ok: true });
    return text;
  } catch (e) {
    const saved = env?.DASH_KV ? await env.DASH_KV.get(key) : null;
    const meta = env?.DASH_KV ? await env.DASH_KV.get(key + ':meta', 'json') : null;
    if (saved) { SHEET_STATUS.set(url, { ok: false, stale: true, savedAt: meta?.savedAt || null, error: String(e.message || e) }); return saved; }
    SHEET_STATUS.set(url, { ok: false, stale: false, error: String(e.message || e) });
    throw new Error(`${String(e.message || e)} — ${url.includes('gid=') ? 'tab gid ' + (url.match(/gid=(\d+)/) || [])[1] : 'default tab'}. Re-publish the tab (File → Share → Publish to web → CSV) and update the link.`);
  }
}
async function sheet(url, env) { return parseCsv(await sheetText(url, env)); }

// Every published sales tab: SALES_CSV_URLS (one URL per line or comma-separated); falls back to SALES_CSV_URL.
const salesUrls = (env) => String(env.SALES_CSV_URLS || env.SALES_CSV_URL || '').split(/[\s,]+/).filter((u) => /^https?:/.test(u));
const tabLabel = (u, i) => { const g = (u.match(/[?&]gid=(\d+)/) || [])[1]; return g ? `gid ${g}` : `tab ${i + 1} (default)`; };
// ---- Sales source: BigQuery, sent daily at 08:00 IST by the Google Apps Script (apps-script/SalesToDashboard.gs) ----
// Stored as gzip-compressed column blocks, one per month (KV key sales:m:YYYY-MM), plus an index (sales:index).
// Each daily run sends only a date range (last 7 days); those dates are replaced inside their month blocks.
const gzipBytes = async (text) => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
const gunzipText = async (buf) => new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
async function readMonth(env, ym) { const b = await env.DASH_KV.get('sales:m:' + ym, 'arrayBuffer'); return b ? JSON.parse(await gunzipText(b)) : null; }
async function salesCombined(env) {
  const index = await env.DASH_KV.get('sales:index', 'json');
  let cols = null, rows = [];
  if (index && Object.keys(index.months || {}).length) {
    const blocks = await Promise.all(Object.keys(index.months).sort().map((ym) => readMonth(env, ym)));
    for (const b of blocks) if (b) { cols = cols || b.columns; const pos = cols.map((c) => b.columns.indexOf(c)); for (const r of b.rows) rows.push(pos.map((k) => (k < 0 ? null : r[k]))); }
  } else {
    const buf = await env.DASH_KV.get('sales:clean', 'arrayBuffer');     // earlier one-file uploads, if any
    if (buf) { const p = JSON.parse(await gunzipText(buf)); cols = p.columns; rows = p.rows; }
  }
  if (!cols) throw new Error('Waiting for the first BigQuery sales run (Apps Script: run backfill once).');
  const objs = rows.map((r) => Object.fromEntries(cols.map((c, k) => [c, r[k]])));
  const meta = index || (await env.DASH_KV.get('sales:clean:meta', 'json')) || {};
  const hours = meta.uploadedAt ? (Date.now() - Date.parse(meta.uploadedAt)) / 3600e3 : 999;
  return { rows: cleanToEngineRows(objs), cleanRows: objs, columns: cols, meta, excluded: excludedSummary(objs), late: hours > 30, hoursSinceUpload: Math.round(hours), version: meta.uploadedAt || 'none' };
}
// Merge a date range into the monthly blocks: rows for dates in [from, to] are replaced; everything else is kept.
async function ingestSales(env, payload) {
  const { columns, rows, from, to } = payload;
  const di = columns.indexOf('order_date');
  const byMonth = {};
  for (const r of rows) (byMonth[String(r[di]).slice(0, 7)] = byMonth[String(r[di]).slice(0, 7)] || []).push(r);
  const months = new Set(Object.keys(byMonth));
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1, 1)) months.add(d.toISOString().slice(0, 7));
  const index = (await env.DASH_KV.get('sales:index', 'json')) || { months: {} };
  for (const ym of [...months].sort()) {
    const old = await readMonth(env, ym);
    let kept = [];
    if (old) { const odi = old.columns.indexOf('order_date'); const pos = columns.map((c) => old.columns.indexOf(c));
      kept = old.rows.filter((r) => { const d = String(r[odi]); return d < from || d > to; }).map((r) => pos.map((k) => (k < 0 ? null : r[k]))); }
    const merged = kept.concat(byMonth[ym] || []);
    if (!merged.length) { await env.DASH_KV.delete('sales:m:' + ym); delete index.months[ym]; continue; }
    const buf = await gzipBytes(JSON.stringify({ columns, rows: merged }));
    await env.DASH_KV.put('sales:m:' + ym, buf);
    index.months[ym] = { rows: merged.length, bytes: buf.byteLength, updatedAt: new Date().toISOString() };
  }
  Object.assign(index, { uploadedAt: new Date().toISOString(), lastRange: { from, to, rows: rows.length }, summary: payload.summary || null });
  await env.DASH_KV.put('sales:index', JSON.stringify(index));
  await env.DASH_KV.delete('metrics:cache');
  return index;
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

async function metrics(env, ctx) {
  const meta = (await biginMeta(env)) || {};
  const cutoff = addDays(istDate(), -1); // T-1 for every source, so all three line up
  // Compute once, serve many: the result is kept in KV for 15 minutes (DSR is live) and recomputed at once when
  // new sales arrive (the ingest clears it) or Bigin refreshes (part of the key).
  const idx = await env.DASH_KV.get('sales:index', 'json');
  const ver = [idx?.uploadedAt || 'none', meta.refreshedAt || 'none', cutoff].join('|');
  const cached = await env.DASH_KV.get('metrics:cache', 'json');
  if (cached && cached.k === ver && Date.now() - cached.at < 15 * 60e3) return json(cached.body, 200, { 'cache-control': 'public, max-age=60', 'x-metrics-cache': 'hit' });
  const [sales, dsrRows, leads] = await Promise.all([salesCombined(env), sheet(env.DSR_CSV_URL, env), biginLeads(env)]);
  const salesRows = sales.rows;
  const m = computeMetrics({ leads: leads || [], salesRows, dsrRows, startDate: env.START_DATE, cutoff });
  m.sources = {
    bigin: { status: leads ? meta.status || 'ok' : 'not_connected', refreshedAt: meta.refreshedAt || null, error: meta.status === 'error' ? meta.error : null, lastLeadDate: m.lastDates.bigin },
    sales: { source: 'bigquery', status: sales.late ? 'stale' : 'live', uploadedAt: sales.meta.uploadedAt, hoursSinceUpload: sales.hoursSinceUpload, lastOrderDate: m.lastDates.sales, lines: sales.rows.length, run: sales.meta.summary || null, lastRange: sales.meta.lastRange || null, excluded: sales.excluded, months: sales.meta.months ? Object.keys(sales.meta.months).length : null },
    dsr: { status: (SHEET_STATUS.get(env.DSR_CSV_URL) || { ok: true }).ok ? 'live' : 'stale', fetchedAt: new Date().toISOString(), lastDate: m.lastDates.dsr, link: SHEET_STATUS.get(env.DSR_CSV_URL) || null },
  };
  ctx.waitUntil(env.DASH_KV.put('metrics:cache', JSON.stringify({ k: ver, at: Date.now(), body: m })));
  return json(m, 200, { 'cache-control': 'public, max-age=60', 'x-metrics-cache': 'miss' });
}

function isAdmin(env, url) {
  const k = url.searchParams.get('key') || ''; const want = env.ADMIN_KEY || '';
  if (!want || k.length !== want.length) return false;
  let diff = 0; for (let i = 0; i < k.length; i++) diff |= k.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

async function adminPage(env, url) {
  const meta = (await biginMeta(env)) || {}; const connected = await biginConnected(env);
  const key = encodeURIComponent(url.searchParams.get('key'));
  return html(`<h1>Walk-in dashboard admin</h1>
  <p>Bigin connection: <strong>${connected ? 'connected' : 'not connected (or using a keyed MCP URL)'}</strong></p>
  <p>Last Bigin refresh: <strong>${meta.refreshedAt || 'never'}</strong> · status: <strong>${meta.status || '—'}</strong> · leads: <strong>${meta.count ?? '—'}</strong></p>
  ${meta.error ? `<pre>${String(meta.error).replace(/</g, '&lt;')}</pre>` : ''}
  <a class="btn" href="/admin/connect?key=${key}">Connect Bigin</a>
  <form method="post" action="/admin/refresh?key=${key}" style="display:inline"><button type="submit">Refresh Bigin now</button></form>
  <a class="btn" href="/admin/sales.csv?key=${key}">Download BigQuery sales dataset (CSV)</a>
  <a class="btn" href="/admin/captured.csv?key=${key}">Captured-leads audit (yesterday)</a>
  <a class="btn" href="/admin/revenue.csv?key=${key}">Walk-in revenue audit (yesterday)</a>
  <a class="btn" href="/api/status">Data status</a> <a class="btn" href="/">Open dashboard</a>`);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/metrics') return await metrics(env, ctx);
      if (url.pathname === '/api/status') {
        const r = await metrics(env, ctx); const m = await r.json();
        return json({ cutoff: m.cutoff, startDate: m.startDate, sources: m.sources, counts: m.counts, quality: m.quality });
      }
      if (url.pathname === '/admin/callback') {
        await finishConnect(env, url);
        const r = await refreshBigin(env);
        return html(`<h1>Bigin connected</h1><p>First refresh: ${r.ok ? `${r.count} walk-in leads loaded.` : `failed — ${String(r.error).replace(/</g, '&lt;')}`}</p><a class="btn" href="/">Open dashboard</a>`);
      }
      if (url.pathname.startsWith('/admin')) {
        if (!isAdmin(env, url)) return html('<h1>Not authorised</h1>', 403);
        if (url.pathname === '/admin/connect') {
          const r = await startConnect(env, url.origin);
          if (r.noAuth) return html('<h1>No sign-in needed</h1><p>The configured Bigin MCP URL accepts requests without OAuth. Use “Refresh Bigin now”.</p>');
          return Response.redirect(r.authorizeUrl, 302);
        }
        if (url.pathname === '/admin/captured.csv') {
          const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : addDays(istDate(), -1);
          const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : day;
          const [sales, leads] = await Promise.all([salesCombined(env), biginLeads(env)]);
          const a = computeMetrics({ leads: leads || [], salesRows: sales.rows, dsrRows: [], startDate: from, cutoff: day, audit: true }).captureAudit || [];
          a.sort((x, y) => (x['Walk-in date'] + x.Store).localeCompare(y['Walk-in date'] + y.Store));
          const cols = ['Walk-in date', 'Store', 'Bigin Store Location', 'Bigin lead ID', 'Phone', 'Status', 'Same-day order(s)', 'Order store(s)'];
          const body = [cols.map(csvCell).join(','), ...a.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
          return new Response('\ufeff' + body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="captured-leads-audit-${from === day ? day : from + '_to_' + day}.csv"`, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
        }
        if (url.pathname === '/admin/revenue.csv') {
          const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : addDays(istDate(), -1);
          const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : day;
          const [sales, leads] = await Promise.all([salesCombined(env), biginLeads(env)]);
          const a = (computeMetrics({ leads: leads || [], salesRows: sales.rows, dsrRows: [], startDate: from, cutoff: day, audit: true }).revenueAudit || []).sort((x, y) => (x['Order date'] + x['Billing store']).localeCompare(y['Order date'] + y['Billing store']));
          const cols = ['Order date', 'POS Order ID', 'Billing store', 'Order type', 'Phone', 'Gross (qty × price)', 'Total Revenue (gross − discount)', 'Matched lead ID', 'Lead walk-in date', 'Lead store', 'All Bigin walk-in dates for this phone', 'Basis'];
          const body = [cols.map(csvCell).join(','), ...a.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
          return new Response('\ufeff' + body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="walkin-revenue-audit-${from === day ? day : from + '_to_' + day}.csv"`, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
        }
        if (url.pathname === '/admin/ingest-sales' && request.method === 'POST') {
          // body: gzip(JSON {columns, rows, from: YYYY-MM-DD, to: YYYY-MM-DD, summary}) — sent daily by the Apps Script
          let payload; try { payload = JSON.parse(await gunzipText(await request.arrayBuffer())); } catch (e) { return json({ ok: false, error: 'Body must be gzip-compressed JSON' }, 400); }
          const need = ['order_date', 'order_id', 'store_id', 'store_name', 'order_type', 'phone', 'product_name', 'quantity', 'gross', 'net'];
          const missing = need.filter((c) => !(payload.columns || []).includes(c));
          if (missing.length) return json({ ok: false, error: 'Missing columns: ' + missing.join(', ') }, 400);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(payload.to || '') || payload.from > payload.to) return json({ ok: false, error: 'from/to must be YYYY-MM-DD with from ≤ to' }, 400);
          if (!Array.isArray(payload.rows)) return json({ ok: false, error: 'rows must be an array' }, 400);
          const bad = payload.rows.filter((r) => { const d = String(r[payload.columns.indexOf('order_date')]); return d < payload.from || d > payload.to; }).length;
          if (bad) return json({ ok: false, error: `${bad} rows fall outside ${payload.from} → ${payload.to}` }, 400);
          const index = await ingestSales(env, payload);
          const totalRows = Object.values(index.months).reduce((s, m) => s + m.rows, 0);
          return json({ ok: true, received: payload.rows.length, from: payload.from, to: payload.to, totalRows, months: Object.keys(index.months).length, uploadedAt: index.uploadedAt });
        }
        if (url.pathname === '/admin/upload-sales' && request.method === 'POST') {
          // body: gzip(JSON {columns:[...], rows:[[...]], summary:{...}})
          const buf = await request.arrayBuffer();
          let payload; try { payload = JSON.parse(await gunzipText(buf)); } catch (e) { return json({ ok: false, error: 'Body must be gzip-compressed JSON' }, 400); }
          const need = ['order_date', 'order_id', 'store_id', 'store_name', 'order_type', 'phone', 'product_name', 'quantity', 'gross', 'net'];
          const missing = need.filter((c) => !(payload.columns || []).includes(c));
          if (missing.length) return json({ ok: false, error: 'Missing columns: ' + missing.join(', ') }, 400);
          if (!Array.isArray(payload.rows) || !payload.rows.length) return json({ ok: false, error: 'No rows' }, 400);
          await env.DASH_KV.put('sales:clean', buf);
          const meta = { uploadedAt: new Date().toISOString(), rows: payload.rows.length, bytes: buf.byteLength, summary: payload.summary || null };
          await env.DASH_KV.put('sales:clean:meta', JSON.stringify(meta));
          return json({ ok: true, ...meta });
        }
        if (url.pathname === '/admin/sales.csv') {
          const s = await salesCombined(env);
          const body = [s.columns.map(csvCell).join(','), ...s.cleanRows.map((r) => s.columns.map((c) => csvCell(r[c])).join(','))].join('\r\n');
          return new Response('\ufeff' + body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="sales-standardized-${new Date().toISOString().slice(0, 10)}.csv"`, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
        }
        if (url.pathname === '/admin/refresh' && request.method === 'POST') {
          const r = await refreshBigin(env);
          return html(`<h1>${r.ok ? 'Refreshed' : 'Refresh failed'}</h1><p>${r.ok ? `${r.count} walk-in leads loaded.` : String(r.error).replace(/</g, '&lt;')}</p><a class="btn" href="/admin?key=${encodeURIComponent(url.searchParams.get('key'))}">Back</a>`);
        }
        return adminPage(env, url);
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshBigin(env));
  },
};
