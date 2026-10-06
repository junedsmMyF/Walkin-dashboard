// Synthetic data only — never commit real customer rows.
import test from 'node:test'; import assert from 'node:assert/strict';
import { computeMetrics } from '../src/metrics.js';
import { parseCsv } from '../src/csv.js';

const lead = (p, d, loc, st = 'Yet to Call') => ({ p: '+91' + p, d: d + 'T12:00:00+05:30', loc, own: '', st, amt: 1000 });
const sale = (id, p, d, store, paid, extra = {}) => ({ 'POS Order ID': id, 'Customer Phone': p, 'POS Created At': d, 'Store ID': store, 'Amount Paid': String(paid), 'Return Amount': '0', 'Order Type': 'RETAIL', 'Ret/Exc': '-', ...extra });
const dsr = (store, d, ts, nw, ow) => ({ Store: store, Date: d, Timestamp: ts, 'New Walk-ins': String(nw), 'Other Walk-ins': String(ow) });
const run = (x) => computeMetrics({ startDate: '2026-09-01', cutoff: '2026-09-30', ...x });

test('attribution: order strictly after lead date, credited to billing store', () => {
  const m = run({
    leads: [lead('9000000001', '2026-09-02', 'Kopa Mall Mundhwa Rd Pune')],
    salesRows: [sale('A', '919000000001', '02/09/2026', 'FRIDO_0008', 500), sale('B', '9000000001', '05/09/2026', 'FRIDO_0001', 2000)],
  });
  assert.equal(m.attributed.length, 1);
  assert.deepEqual([m.attributed[0].s, m.attributed[0].cs, m.attributed[0].gross], ['FRIDO_0001', 'FRIDO_0008', 2000]);
});
test('captured leads: unique lead IDs, one per customer per day, post-purchase captures removed', () => {
  const L = (id, p, d, loc, em) => ({ i: id, p: p ? '+91' + p : '', em, d: d + 'T12:00:00+05:30', loc, own: '', st: 'Yet to Call' });
  const m = run({
    leads: [
      L('1000000000000000001', '9000000001', '2026-09-02', 'Kopa Mall Mundhwa Rd Pune'),        // bought same day → removed
      L('1000000000000000002', '9000000002', '2026-09-02', 'Kopa Mall Mundhwa Rd Pune'),        // kept
      L('1000000000000000003', '9000000002', '2026-09-02', 'Amanora Mall Hadapsar Pune'),       // same customer same day, other store → duplicate
      L('1000000000000000004', '', '2026-09-02', 'Kopa Mall Mundhwa Rd Pune', 'a@b.com'),        // no phone, email bought that day → removed
      L('1000000000000000005', '', '2026-09-02', 'Kopa Mall Mundhwa Rd Pune'),                  // no phone/email → kept as its own lead ID
    ],
    salesRows: [sale('A', '9000000001', '02/09/2026', 'FRIDO_0008', 500), sale('B', '9000000099', '02/09/2026', 'FRIDO_0008', 700, { 'Customer Email': 'A@B.com' })],
  });
  const k = m.daily.find((x) => x.s === 'FRIDO_0008' && x.d === '2026-09-02');
  const am = m.daily.find((x) => x.s === 'FRIDO_0002' && x.d === '2026-09-02');
  assert.deepEqual([k.capRaw, k.capPostOrder, k.captured, k.orders], [4, 2, 2, 2]);
  assert.deepEqual([am.capRaw, am.capDup, am.captured], [1, 1, 0]);
});

test('net = paid − returns; cancelled lines dropped; test store excluded', () => {
  const m = run({ leads: [lead('9000000001', '2026-09-01', 'Kopa Mall Mundhwa Rd Pune')], salesRows: [
    sale('B', '9000000001', '03/09/2026', 'FRIDO_0008', 1000, { 'Return Amount': '200' }),
    sale('B', '9000000001', '03/09/2026', 'FRIDO_0008', 700, { 'Ret/Exc': 'CANCELLED' }),
    sale('C', '9000000001', '04/09/2026', 'FRIDO_0000', 999)] });
  assert.equal(m.attributed.length, 1); assert.equal(m.attributed[0].net, 800); assert.equal(m.attributed[0].gross, 1000);
});
test('DSR: latest submission per store per date wins, even if zero; New + Other', () => {
  const m = run({ dsrRows: [dsr('Kopa Mall, Ghorpadi, KP', '2026-09-03', '03/09/2026 20:00:00', 30, 5), dsr('Kopa Mall, Ghorpadi, KP', '2026-09-03', '03/09/2026 21:00:00', 0, 0), dsr('Kopa Mall, Ghorpadi, KP', '09/03/2026', '02/09/2026 09:00:00', 99, 1)] });
  assert.equal(m.daily.find((x) => x.s === 'FRIDO_0008' && x.d === '2026-09-03').walkins, 0);
});
test('payload has no phone numbers', () => {
  const m = run({ leads: [lead('9876543210', '2026-09-02', 'Kopa Mall Mundhwa Rd Pune')], salesRows: [sale('A', '9876543210', '09/09/2026', 'FRIDO_0008', 100)] });
  assert.ok(!JSON.stringify(m).includes('9876543210'));
});
test('capture = earliest walk-in date across all records, never the lowest record ID (Zoho IDs are not time-ordered)', () => {
  const L = (id, p, d, loc) => ({ i: id, p: '+91' + p, d: d ? d + 'T12:00:00+05:30' : null, ct: '2026-08-06T16:00:00+05:30', loc, own: '', st: 'Yet to Call' });
  const m = run({
    leads: [
      L('1371203000000614389', '9052429555', '2026-10-02', 'Kompally Hyderabad'), // lower ID, created after the purchase
      L('1371203000000616163', '9052429555', '2026-09-30', 'Kompally Hyderabad'), // higher ID, the real first capture
      L('1000000000000000003', '9000000008', null, 'Elpro Mall PCMC Pune'),        // blank walk-in date counts as earlier
    ],
    salesRows: [sale('INV_2627_FRIDO_0014_2190', '9052429555', '02/10/2026', 'FRIDO_0014', 35215), sale('Y', '9000000008', '20/09/2026', 'FRIDO_0005', 999)],
    cutoff: '2026-10-31',
  });
  assert.deepEqual(m.attributed.map((a) => a.gross).sort((a, b) => a - b), [999, 35215]);
});

test('manual override counts an order with no Bigin lead, credited to the billing store', () => {
  const m = computeMetrics({ startDate: '2026-09-01', cutoff: '2026-09-30', leads: [], dsrRows: [], overrides: new Map([['Z', 'test']]),
    salesRows: [sale('Z', '9000000007', '13/09/2026', 'FRIDO_0013', 569013), sale('W', '9000000006', '13/09/2026', 'FRIDO_0013', 100)] });
  assert.deepEqual(m.attributed.map((a) => [a.s, a.gross, a.ov]), [['FRIDO_0013', 569013, 1]]);
  assert.equal(m.quality.manualOverrides.length, 1);
});
test('CSV parser handles quotes and commas', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","he said ""hi"""\n'), [{ a: 'x, y', b: 'he said "hi"' }]);
});
test('standardize: dates read per tab evidence, output DD/MM/YYYY [HH:MM]; cross-tab duplicates dropped', async () => {
  const { standardizeTab, combineTabs } = await import('../src/standardize.js');
  const row = (id, pos, shop, amt, phone) => ({ 'POS Order ID': id, 'Product Name': 'P', 'Variant Name': 'V', Quantity: '1', 'Amount Paid': amt, 'POS Created At': pos, 'Shopify Created At': shop, 'Returned At': '-', 'Customer Phone': phone, 'New Customer': 'YES', 'Payment Modes': 'cash;amazon_pay' });
  const a = standardizeTab([row('A', '9/2/2026', '9/2/26 16:24', '1,529', '919582348653'), row('B', '9/13/2026', '9/13/26 09:05', '899', '8800980816'), row('B', '9/13/2026', '9/13/26 09:05', '899', '8800980816')], 'tab 1');
  const b = standardizeTab([row('B', '13/09/2026', '13/09/26 09:05', '899', '+91 88009 80816'), row('C', '14/09/2026', '14/09/26 10:00', '100', '9000000001')], 'tab 2');
  assert.equal(a.rows[0]['POS Created At'], '02/09/2026'); assert.equal(a.rows[0]['Shopify Created At'], '02/09/2026 16:24');
  assert.equal(b.rows[0]['POS Created At'], '13/09/2026'); assert.match(b.summary.dates['POS Created At'], /day-first/);
  assert.equal(a.rows[0]['Customer Phone'], '9582348653'); assert.equal(a.rows[0]['Amount Paid'], '1529'); assert.equal(a.rows[0]['New Customer'], 'Yes'); assert.equal(a.rows[0]['Payment Modes'], 'CASH, AMAZON_PAY'); assert.equal(a.rows[0]['Returned At'], '-');
  const c = combineTabs([a, b]);
  assert.equal(c.rows.length, 4); // A, B, B (both kept: same tab), C — tab 2's B dropped as a cross-tab duplicate
  assert.equal(b.summary.duplicatesDropped, 1);
});
test('standardize: a column mixing month-first and day-first cells is resolved value by value', async () => {
  const { standardizeTab } = await import('../src/standardize.js');
  const r = (n, pos, shop) => ({ 'POS Order ID': 'O' + n, 'Shopify Order ID': '#MF02235' + String(n).padStart(5, '0'), 'POS Created At': pos, 'Shopify Created At': shop });
  const rows = [r(1, '9/2/2026', '9/2/26 16:24'), r(2, '9/13/2026', '9/13/26 10:00'), r(3, '9/20/2026', '9/20/26 11:00'),
    r(4, '26/09/2026', '26/09/2026 12:00:00'), r(5, '10/09/2026', '10/09/2026 18:00:00'), r(6, '28/09/2026', '28/09/2026 09:00:00')];
  // row 5 is "10/09/2026": ambiguous on its own, but written in the same padded style as the proven day-first rows → 10 Sep, not 9 Oct
  const t = standardizeTab(rows, 'mixed');
  assert.deepEqual(t.rows.map((x) => x['POS Created At']), ['02/09/2026', '13/09/2026', '20/09/2026', '26/09/2026', '10/09/2026', '28/09/2026']);
  assert.equal(t.summary.dateResolution['POS Created At'].unresolved, 0);
});
test('BigQuery clean rows: gross = qty × price, revenue = gross − discount, order type mapped; cancelled and refunded orders left out', async () => {
  const { cleanToEngineRows, excludedSummary } = await import('../src/clean.js');
  const base = { order_date: '2026-10-02', store_id: 'FRIDO_0014', store_name: 'Kompally Store', quantity: 1, financial_status: 'paid', is_cancelled: false };
  const raw = [
    { ...base, order_id: '#MF1', order_type: 'ONLINE_ORDER', phone: '9052429555', product_name: 'Frido ErgoLuxe Executive Chair', gross: 36999, net: 33669 },
    { ...base, order_id: '#MF2', store_id: 'FRIDO_0008', store_name: 'Kopa Mall', order_type: 'CASH_AND_CARRY', phone: '9987538484', product_name: 'Frido Premium Car Back Rest Cushion', gross: 1899, net: 1899 },
    { ...base, order_id: '#MF3', order_type: 'ONLINE_ORDER', phone: '9052429555', product_name: 'x', gross: 999, net: 999, is_cancelled: true },
    { ...base, order_id: '#MF4', order_type: 'ONLINE_ORDER', phone: '9987538484', product_name: 'x', gross: 500, net: 500, financial_status: 'refunded' },
    { ...base, order_id: '#MF5', order_type: 'ONLINE_ORDER', phone: '9987538484', product_name: 'x', gross: 700, net: 700, financial_status: 'partially_refunded' },
  ];
  const rows = cleanToEngineRows(raw);
  assert.equal(rows.length, 2);
  assert.deepEqual(excludedSummary(raw), { orders: 3, revenue: 2199, cancelled: 1, refunded: 1, partially_refunded: 1 });
  const L = (id, p, d, loc) => ({ i: id, p: '+91' + p, d: d + 'T12:00:00+05:30', ct: d + 'T12:00:00+05:30', loc, own: '', st: 'Yet to Call' });
  const m = computeMetrics({ startDate: '2026-10-01', cutoff: '2026-10-02', dsrRows: [], salesRows: rows, overrides: new Map(), leads: [L('1', '9052429555', '2026-09-30', 'Kompally Hyderabad'), L('2', '9987538484', '2026-09-28', 'Kopa Mall Mundhwa Rd Pune')] });
  assert.deepEqual(m.attributed.map((a) => [a.t, a.gross, a.net]).sort(), [['ONLINE', 36999, 33669], ['RETAIL', 1899, 1899]].sort());
});

test('bot: SQL guard allows only single read-only queries on the bot tables', async () => {
  const { checkSql } = await import('../src/bot/ask.js');
  assert.ok(checkSql('SELECT SUM(total_revenue) FROM sales_orders WHERE is_walkin=1').ok);
  assert.ok(checkSql("WITH x AS (SELECT * FROM leads) SELECT COUNT(*) FROM x WHERE stage='a; b'").ok);
  for (const bad of ['DELETE FROM leads', 'SELECT 1; DROP TABLE leads', 'SELECT * FROM sqlite_master', 'SELECT * FROM users', "UPDATE leads SET stage='x'", 'PRAGMA table_info(leads)'])
    assert.equal(checkSql(bad).ok, false, bad);
  assert.match(checkSql('SELECT * FROM leads').sql, /LIMIT 200$/);
});
test('bot: answers may only use numbers present in the result', async () => {
  const { numbersGrounded } = await import('../src/bot/ask.js');
  const rows = [{ store: 'Kompally', rev: 52215, share: 0.611 }];
  assert.ok(numbersGrounded('Kompally led with ₹52,215 (61.1% of the day).', rows).ok);
  assert.ok(numbersGrounded('Kompally led with ₹0.52 L on 2 Oct 2026.', rows).ok);
  assert.equal(numbersGrounded('Kompally led with ₹60,000, up 12%.', rows).ok, false);
});
test('bot: tables reproduce the dashboard numbers and hold no phone numbers', async () => {
  const { buildBotTables } = await import('../src/bot/tables.js');
  const L = (id, p, d, loc) => ({ i: id, p: '+91' + p, d: d + 'T12:00:00+05:30', ct: d + 'T12:00:00+05:30', loc, own: '', st: 'Yet to Call', prod: 'Frido Glide Ergo Chair' });
  const S = (id, ph, d, store, net) => ({ 'POS Order ID': id, 'Store ID': store, 'Customer Phone': ph, 'POS Created At': d, 'Order Type': 'RETAIL', 'Product Name': 'Frido Glide Ergo Chair', Quantity: '1', __gross: net, __net: net });
  const leads = [L('1', '9000000001', '2026-09-28', 'Kopa Mall Mundhwa Rd Pune'), L('2', '9000000002', '2026-10-02', 'Kopa Mall Mundhwa Rd Pune')];
  const sales = [S('A', '9000000001', '2026-10-02', 'FRIDO_0008', 6799), S('B', '9000000002', '2026-10-02', 'FRIDO_0008', 999), S('C', '9000000003', '2026-10-02', 'FRIDO_0008', 500)];
  const t = buildBotTables({ leads, salesRows: sales, dsrRows: [], startDate: '2026-09-01', cutoff: '2026-10-02' }).tables;
  const walk = t.sales_orders.filter((r) => r[13] === 1);
  assert.deepEqual(walk.map((r) => [r[0], r[12]]), [['A', 6799]]);                    // only A: lead 28 Sep, order 2 Oct
  assert.equal(t.leads.find((r) => r[0] === '2')[8], 'Bought the same day');          // lead 2 created the day it bought
  assert.equal(t.leads.find((r) => r[0] === '1')[16], 1);                             // lead 1 converted
  assert.doesNotMatch(JSON.stringify(t), /9000000001|9000000002|9000000003/);
});
