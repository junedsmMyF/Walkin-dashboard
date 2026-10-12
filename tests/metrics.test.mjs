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
test('bot: falls back to the next model and reports which one answered', async () => {
  const { ask } = await import('../src/bot/ask.js');
  const plan = JSON.stringify({ interpretation: 'x', sql: 'SELECT 5 AS n FROM leads LIMIT 1', cannot_answer: '' });
  const DB = { prepare: (sql) => ({ all: async () => ({ results: /bot_meta/.test(sql) ? [{ k: 'data_through', v: '2026-10-05' }, { k: 'start_date', v: '2026-09-01' }] : [{ n: 5 }] }), bind() { return this; } }) };
  const AI = { async run(model, body) { if (model.includes('qwen')) throw new Error('5007: No such model'); const m = body.messages || body.input; return { response: m[0].content.startsWith('You write the answer') ? 'There are 5.' : plan }; } };
  const out = await ask({ AI, DB }, { question: 'how many?' });
  assert.equal(out.answer, 'There are 5.'); assert.equal(out.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  const notBuilt = await ask({ AI, DB: { prepare: () => ({ all: async () => { throw new Error('D1_ERROR: no such table: bot_meta'); } }) } }, { question: 'x' });
  assert.equal(notBuilt.error, 'not_built');
});
test('bot: result passed to the answer step quotes names containing commas', async () => {
  const { ask } = await import('../src/bot/ask.js');
  let seen = '';
  const DB = { prepare: (sql) => ({ all: async () => ({ results: /bot_meta/.test(sql) ? [{ k: 'data_through', v: '2026-10-05' }, { k: 'start_date', v: '2026-09-01' }] : [{ store_name: 'Nexus Westend, Aundh', walkin_revenue: 20018 }] }), bind() { return this; } }) };
  const AI = { async run(m, b) { const msgs = b.messages || b.input; if (msgs[0].content.startsWith('You write the answer')) { seen = msgs[1].content; return { response: 'Nexus Westend earned **₹20,018**.' }; } return { response: JSON.stringify({ interpretation: 'x', sql: 'SELECT store_name, walkin_revenue FROM store_day LIMIT 1', cannot_answer: '', chart: { type: 'bar', x: 'store_name', y: ['walkin_revenue'] } }) }; } };
  const out = await ask({ AI, DB }, { question: 'q' });
  assert.match(seen, /"Nexus Westend, Aundh",20018/); assert.equal(out.verified, true); assert.deepEqual(out.chart, { type: 'bar', x: 'store_name', y: ['walkin_revenue'] });
});
// ---------------- access control ----------------
async function accessKit(aud = 'AUD123', team = 'frido.cloudflareaccess.com') {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' };
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const sign = async (payload) => { const h = b64({ alg: 'RS256', kid: 'k1' }), p = b64(payload); const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(`${h}.${p}`)); return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`; };
  const now = Math.floor(Date.now() / 1000);
  const token = (email, extra = {}) => sign({ email, aud: [aud], iss: `https://${team}`, exp: now + 3600, iat: now, ...extra });
  const fetcher = async () => new Response(JSON.stringify({ keys: [jwk] }));
  return { token, fetcher, env: { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } };
}
const kvWith = (users) => ({ get: async (k, t) => (k === 'rbac:users' ? users : null) });
const reqWith = (tok) => new Request('https://x/api/me', { headers: tok ? { 'cf-access-jwt-assertion': tok } : {} });

test('auth: only genuine, current Access tokens for this app are accepted', async () => {
  const { verifyAccessJwt } = await import('../src/auth.js');
  const k = await accessKit();
  assert.equal(await verifyAccessJwt(await k.token('Abdal@MyFrido.com'), k.env, k.fetcher), 'abdal@myfrido.com');
  await assert.rejects(verifyAccessJwt(await k.token('a@b.com', { aud: ['OTHER'] }), k.env, k.fetcher), /another application/);
  await assert.rejects(verifyAccessJwt(await k.token('a@b.com', { exp: 1 }), k.env, k.fetcher), /expired/);
  await assert.rejects(verifyAccessJwt(await k.token('a@b.com', { iss: 'https://evil.cloudflareaccess.com' }), k.env, k.fetcher), /another team/);
  const t = await k.token('a@b.com'); const [h, , sig] = t.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ email: 'ceo@myfrido.com', aud: ['AUD123'], iss: 'https://frido.cloudflareaccess.com', exp: 9e9 })).toString('base64url')}.${sig}`;
  await assert.rejects(verifyAccessJwt(forged, k.env, k.fetcher), /bad signature/);
});
test('auth: deny by default; roles, paused users, permanent admins', async () => {
  const { identify } = await import('../src/auth.js');
  const k = await accessKit();
  const users = { 'vp@myfrido.com': { role: 'retail_vp' }, 'sm@myfrido.com': { role: 'store_manager', stores: ['FRIDO_0008'] }, 'paused@myfrido.com': { role: 'leadership', disabled: true }, 'v@myfrido.com': { role: 'walkin_viewer', deny: ['walkin.loss'] } };
  const env = { ...k.env, DASH_KV: kvWith(users), ADMIN_EMAILS: 'boss@myfrido.com' };
  const who = async (email) => identify(reqWith(email ? await k.token(email) : null), env, k.fetcher);
  assert.equal((await who(null)).approved, false);
  assert.equal((await who('stranger@gmail.com')).approved, false);
  assert.equal((await who('paused@myfrido.com')).approved, false);
  const vp = await who('vp@myfrido.com'); assert.ok(vp.approved); assert.ok(vp.perms.includes('walkin.revenue')); assert.ok(!vp.perms.includes('home')); assert.ok(!vp.perms.includes('admin'));
  assert.ok(!(await who('v@myfrido.com')).perms.includes('walkin.loss'));
  assert.deepEqual((await who('boss@myfrido.com')).role, 'admin');
  const open = await identify(reqWith(null), { DASH_KV: kvWith({}) }); assert.equal(open.enforced, false); assert.ok(open.approved); assert.ok(!open.perms.includes('admin'));
});
test('auth: data is trimmed on the server to the role and stores', async () => {
  const { filterMetrics, canBot } = await import('../src/auth.js');
  const m = { stores: [{ id: 'FRIDO_0008' }, { id: 'FRIDO_0014' }], daily: [{ s: 'FRIDO_0008', d: 'x' }, { s: 'FRIDO_0014', d: 'x' }], attributed: [{ s: 'FRIDO_0014', net: 5 }],
    pipeline: [{ s: 'FRIDO_0008' }], atRisk: [{ s: 'FRIDO_0014' }], loss: [{ s: 'FRIDO_0008' }], cohortRevenue: [{ s: 'FRIDO_0008' }], productSales: [['2026-10-01', 'FRIDO_0014', 1]], interestLead: [['2026-10-01', 'FRIDO_0008', 1]], quality: { a: 1 }, counts: { orders: 9 } };
  const allTabs = ['walkin.overview', 'walkin.capture', 'walkin.followup', 'walkin.revenue', 'walkin.product', 'walkin.loss', 'walkin.definitions'];
  const vp = { approved: true, perms: ['retail', ...allTabs, 'bot'], stores: [] };
  assert.equal(filterMetrics(m, vp), m); assert.ok(canBot(vp));
  const sm = { approved: true, perms: ['walkin.overview', 'walkin.capture', 'walkin.followup', 'walkin.definitions'], stores: ['FRIDO_0008'] };
  const out = filterMetrics(m, sm);
  assert.deepEqual(out.stores.map((s) => s.id), ['FRIDO_0008']);
  assert.deepEqual(out.daily.map((x) => x.s), ['FRIDO_0008']);
  assert.equal(out.attributed.length, 0);                       // another store's walk-in revenue never leaves the server
  assert.equal(out.loss.length, 0); assert.equal(out.cohortRevenue.length, 0); assert.equal(out.productSales.length, 0); assert.equal(out.interestLead.length, 0);
  assert.equal(out.pipeline.length, 1); assert.equal(out.atRisk.length, 0);
  assert.deepEqual(out.quality, {}); assert.ok(!canBot(sm));
  assert.equal(filterMetrics(m, { approved: true, perms: ['admin'], stores: [] }), null);   // no walk-in permission → no data at all
});
// ---------------- built-in sign-in (access codes) ----------------
function memKV(init = {}) { const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { get: async (k, t) => { const v = m.get(k); if (v == null) return null; return t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, raw: m }; }
test('sign-in: sessions are signed, expire, and can be revoked', async () => {
  const { makeSession, readSession } = await import('../src/auth.js');
  const env = { ADMIN_KEY: 'secret-key-123' };
  const s = await makeSession(env, 'vp@myfrido.com', 2);
  assert.equal((await readSession(env, s)).e, 'vp@myfrido.com');
  const [body, sig] = s.split('.'); const forged = Buffer.from(JSON.stringify({ e: 'ceo@myfrido.com', sv: 2, exp: 9e9 })).toString('base64url') + '.' + sig;
  assert.equal(await readSession(env, forged), null);                                  // tampered → rejected
  assert.equal(await readSession({ ADMIN_KEY: 'other' }, s), null);                    // new admin key → everyone signed out
});
test('sign-in: email code flow — only approved emails get codes, wrong/expired codes, success, roles, sign-out-everywhere and pause', async () => {
  const { default: worker } = await import('../src/index.js');
  const sent = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => { if (String(u).startsWith('https://mailer.test')) { const b = JSON.parse(o.body); if (b.secret !== 'm-secret') return new Response('{"ok":false,"error":"forbidden"}'); sent.push(b); return new Response('{"ok":true}'); } return realFetch(u, o); };
  try {
    const KV = memKV({ 'rbac:users': { 'vp@myfrido.com': { role: 'retail_vp' }, 'gone@myfrido.com': { role: 'leadership', disabled: true } } });
    const env = { DASH_KV: KV, LOGIN: 'on', ADMIN_KEY: 'k-123', ADMIN_EMAILS: 'boss@myfrido.com', MAILER_URL: 'https://mailer.test/exec', MAILER_SECRET: 'm-secret' };
    const ctx = { waitUntil() {} };
    const post = (path, form, cookie) => worker.fetch(new Request('https://d.test' + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://d.test', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(form) }), env, ctx);
    const me = async (cookie) => (await worker.fetch(new Request('https://d.test/api/me', { headers: cookie ? { cookie } : {} }), env, ctx)).json();
    const ask = (email) => post('/login?next=%23%2Fretail', { step: 'send', email });
    const verify = async (email, code) => { const r = await post('/login?next=%23%2Fretail', { step: 'verify', email, code }); return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0], to: r.headers.get('location'), text: r.status === 200 || r.status === 401 ? await r.text() : '' }; };
    const codeIn = (m) => m.subject.match(/^(\d{6})/)[1];
    // strangers and paused users get the same screen but no email
    assert.equal((await ask('stranger@gmail.com')).status, 200); assert.equal((await ask('gone@myfrido.com')).status, 200); assert.equal(sent.length, 0);
    // approved: exactly one email, to that address only
    await ask('VP@myfrido.com'); assert.equal(sent.length, 1); assert.equal(sent[0].to, 'vp@myfrido.com');
    assert.match((await (await ask('vp@myfrido.com')).text()), /wait \d+ seconds/);                 // resend throttled
    assert.equal(sent.length, 1);
    const bad = await verify('vp@myfrido.com', '000000'); assert.equal(bad.status, 401); assert.match(bad.text, /4 tries left/);
    const ok = await verify('vp@myfrido.com', codeIn(sent[0])); assert.equal(ok.status, 302); assert.equal(ok.to, '/#/retail');
    assert.equal((await verify('vp@myfrido.com', codeIn(sent[0]))).status, 401);                   // a code works once
    const m = await me(ok.cookie); assert.ok(m.approved); assert.equal(m.role, 'retail_vp');
    assert.equal((await worker.fetch(new Request('https://d.test/admin/users', { headers: { cookie: ok.cookie } }), env, ctx)).status, 403);
    // admin: email code or the admin key
    const boss = await verify('boss@myfrido.com', 'k-123'); assert.equal(boss.status, 302); assert.equal((await me(boss.cookie)).role, 'admin');
    await post('/admin/users', { email: 'vp@myfrido.com', action: 'signout' }, boss.cookie);
    assert.equal((await me(ok.cookie)).approved, false);                                            // signed out everywhere
    // five wrong tries kill the code
    KV.raw.delete('otp:last:vp@myfrido.com'); await ask('vp@myfrido.com'); const c2 = codeIn(sent[1]);
    for (let i = 0; i < 5; i++) await verify('vp@myfrido.com', '111111');
    assert.equal((await verify('vp@myfrido.com', c2)).status, 401);
    // pause ends sessions
    KV.raw.delete('otp:last:vp@myfrido.com'); await ask('vp@myfrido.com'); const s3 = await verify('vp@myfrido.com', codeIn(sent[2]));
    await post('/admin/users', { email: 'vp@myfrido.com', name: '', role: 'retail_vp', action: 'save', disabled: 'on' }, boss.cookie);
    assert.equal((await me(s3.cookie)).approved, false);
    // a wrong mailer secret is reported, not hidden
    const env2 = { ...env, MAILER_SECRET: 'wrong' }; KV.raw.delete('otp:last:boss@myfrido.com');
    const r = await worker.fetch(new Request('https://d.test/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://d.test' }, body: new URLSearchParams({ step: 'send', email: 'boss@myfrido.com' }) }), env2, ctx);
    assert.match(await r.text(), /could not be emailed \(forbidden\)/);
  } finally { globalThis.fetch = realFetch; }
});
