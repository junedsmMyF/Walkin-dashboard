// Sales loader (DevX via BigQuery → KV monthly gzip blocks sales:m:YYYY-MM + sales:index), shared by every build.
import { isExcluded, toEngineRow, excludedSummary } from './clean.js';

export const gunzipText = async (buf) => new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
export async function readMonth(env, ym) { const b = await env.DASH_KV.get('sales:m:' + ym, 'arrayBuffer'); return b ? JSON.parse(await gunzipText(b)) : null; }
// Memory (audit 27 Oct 2026): the Worker has 128 MB. Months are read one after another and every line becomes its engine
// row straight away — the old loader held the raw rows, row objects and engine rows of every month at once (Error 1102).
// keepClean: also keep the standardised rows (only the /admin/sales.csv export needs them).
export async function salesCombined(env, { keepClean = false } = {}) {
  const index = await env.DASH_KV.get('sales:index', 'json');
  let cols = null; const rows = [], cleanRows = [], excl = [];
  const take = (columns, raw) => {
    cols = cols || columns; const pos = cols.map((c) => columns.indexOf(c));
    for (const r of raw) {
      const o = {}; for (let k = 0; k < cols.length; k++) o[cols[k]] = pos[k] < 0 ? null : r[pos[k]];
      if (keepClean) cleanRows.push(o);
      if (isExcluded(o)) excl.push(o); else rows.push(toEngineRow(o));
    }
  };
  if (index && Object.keys(index.months || {}).length) {
    for (const ym of Object.keys(index.months).sort()) { const b = await readMonth(env, ym); if (b) take(b.columns, b.rows); }
  } else {
    const buf = await env.DASH_KV.get('sales:clean', 'arrayBuffer');     // earlier one-file uploads, if any
    if (buf) { const p = JSON.parse(await gunzipText(buf)); take(p.columns, p.rows); }
  }
  if (!cols) throw new Error('Waiting for the first BigQuery sales run (Apps Script: run backfill once).');
  const meta = index || (await env.DASH_KV.get('sales:clean:meta', 'json')) || {};
  const hours = meta.uploadedAt ? (Date.now() - Date.parse(meta.uploadedAt)) / 3600e3 : 999;
  return { rows, cleanRows: keepClean ? cleanRows : null, columns: cols, meta, excluded: excludedSummary(excl), late: hours > 30, hoursSinceUpload: Math.round(hours), version: meta.uploadedAt || 'none' };
}
