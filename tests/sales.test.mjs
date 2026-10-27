// Synthetic data only — never commit real customer rows.
import test from 'node:test'; import assert from 'node:assert/strict';
import { salesCombined } from '../src/sales.js';
import { cleanToEngineRows, excludedSummary, EXCLUDE } from '../src/clean.js';

const gz = async (obj) => new Response(new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
const kvOf = (map) => ({ get: async (k, type) => { const v = map[k]; if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; } });
const cols = ['order_date', 'order_id', 'store_id', 'store_name', 'employee_name', 'order_type', 'phone', 'financial_status', 'is_cancelled', 'product_name', 'quantity', 'gross', 'net'];
const row = (d, id, i, extra = {}) => { const o = { order_date: d, order_id: id, store_id: 'FRIDO_0010', store_name: 'Sky', employee_name: 'E', order_type: i % 2 ? 'CASH_AND_CARRY' : 'ONLINE_ORDER', phone: '90000000' + String(i % 100).padStart(2, '0'), financial_status: i % 7 ? 'paid' : 'refunded', is_cancelled: i % 11 === 0, product_name: 'Frido Chair', quantity: 1, gross: 1000 + i, net: 900 + i, ...extra }; return cols.map((c) => o[c]); };

// The loader before the audit fix: every month at once, then row objects, then engine rows.
const oldLoader = (blocks) => { let c = null; const rows = []; for (const b of blocks) { c = c || b.columns; const pos = c.map((x) => b.columns.indexOf(x)); for (const r of b.rows) rows.push(pos.map((k) => (k < 0 ? null : r[k]))); }
  const objs = rows.map((r) => Object.fromEntries(c.map((x, k) => [x, r[k]]))); return { rows: cleanToEngineRows(objs), excluded: excludedSummary(objs), cleanRows: objs }; };

test('sales loader (one month at a time, one copy) returns exactly what the old loader did', async () => {
  // second month has its columns in a different order and one column missing, as older blocks can
  const sep = { columns: cols, rows: Array.from({ length: 40 }, (_, i) => row('2026-09-' + String(1 + (i % 28)).padStart(2, '0'), 'S' + i, i)) };
  const c2 = [...cols].reverse().filter((c) => c !== 'employee_name');
  const oct = { columns: c2, rows: Array.from({ length: 30 }, (_, i) => { const r = row('2026-10-' + String(1 + (i % 28)).padStart(2, '0'), 'O' + i, i + 3); return c2.map((c) => r[cols.indexOf(c)]); }) };
  const env = { DASH_KV: kvOf({ 'sales:index': JSON.stringify({ uploadedAt: new Date().toISOString(), months: { '2026-10': {}, '2026-09': {} } }), 'sales:m:2026-09': await gz(sep), 'sales:m:2026-10': await gz(oct) }) };
  for (const flags of [{}, { cancelled: true, refunded: true }]) {
    const keep = { ...EXCLUDE }; Object.assign(EXCLUDE, flags);
    try {
      const got = await salesCombined(env, { keepClean: true }); const want = oldLoader([sep, oct]);
      assert.deepEqual(got.rows, want.rows);
      assert.deepEqual(got.excluded, want.excluded);
      assert.deepEqual(got.cleanRows, want.cleanRows);
      assert.equal((await salesCombined(env)).cleanRows, null); // the export copy is only kept when asked for
    } finally { Object.assign(EXCLUDE, keep); }
  }
});
