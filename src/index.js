// Cloudflare Worker: serves the dashboard (static assets), a PII-free metrics API, the Bigin admin page,
// and the 6:00 AM IST daily Bigin refresh (cron "30 0 * * *" UTC).
import { parseCsv } from './csv.js';
import { istDate, addDays } from './dates.js';
import { computeMetrics } from './metrics.js';
import { standardizeTab, combineTabs } from './standardize.js';
import { refreshBigin, biginLeads, biginMeta, biginConnected, startConnect, finishConnect } from './bigin.js';

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
const html = (body, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Dashboard admin</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#101820}button,a.btn{display:inline-block;padding:10px 16px;border-radius:999px;border:0;background:#FFD100;color:#101820;font-weight:600;text-decoration:none;cursor:pointer;margin:4px 8px 4px 0}pre{background:#F4F6F9;padding:12px;border-radius:8px;overflow:auto}</style></head><body>${body}</body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });

async function sheet(url) {
  const res = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) throw new Error(`Sheet fetch failed (${res.status})`);
  return parseCsv(await res.text());
}

// Every published sales tab: SALES_CSV_URLS (one URL per line or comma-separated); falls back to SALES_CSV_URL.
const salesUrls = (env) => String(env.SALES_CSV_URLS || env.SALES_CSV_URL || '').split(/[\s,]+/).filter((u) => /^https?:/.test(u));
const tabLabel = (u, i) => { const g = (u.match(/[?&]gid=(\d+)/) || [])[1]; return g ? `gid ${g}` : `tab ${i + 1} (default)`; };
async function salesCombined(env) {
  const urls = salesUrls(env);
  const tabs = await Promise.all(urls.map(async (u, i) => standardizeTab(await sheet(u), tabLabel(u, i))));
  return combineTabs(tabs);
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

async function metrics(env, ctx) {
  const meta = (await biginMeta(env)) || {};
  const cutoff = addDays(istDate(), -1); // T-1 for every source, so all three line up
  const cacheKey = new Request(`https://metrics.cache/v1?b=${encodeURIComponent(meta.refreshedAt || 'none')}&c=${cutoff}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey); if (hit) return hit;
  const [sales, dsrRows, leads] = await Promise.all([salesCombined(env), sheet(env.DSR_CSV_URL), biginLeads(env)]);
  const salesRows = sales.rows;
  const m = computeMetrics({ leads: leads || [], salesRows, dsrRows, startDate: env.START_DATE, cutoff });
  m.sources = {
    bigin: { status: leads ? meta.status || 'ok' : 'not_connected', refreshedAt: meta.refreshedAt || null, error: meta.status === 'error' ? meta.error : null, lastLeadDate: m.lastDates.bigin },
    sales: { status: 'live', fetchedAt: new Date().toISOString(), lastOrderDate: m.lastDates.sales, tabs: sales.summary, linesCombined: sales.rows.length },
    dsr: { status: 'live', fetchedAt: new Date().toISOString(), lastDate: m.lastDates.dsr },
  };
  const res = json(m, 200, { 'cache-control': 'public, max-age=300' });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
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
  <a class="btn" href="/admin/sales.csv?key=${key}">Download standardized sales CSV</a>
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
        if (url.pathname === '/admin/sales.csv') {
          const s = await salesCombined(env);
          const body = [s.columns.map(csvCell).join(','), ...s.rows.map((r) => s.columns.map((c) => csvCell(r[c])).join(','))].join('\r\n');
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
