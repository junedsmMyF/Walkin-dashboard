// Retail retention: 60-day window, store orders only, most recent touch wins, no PII. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRetention, parseBroadcastRows, parseBroadcastCsv, storeOrders, sampleInputs, failReason, stamp } from '../src/retention.js';
import { parseCsv } from '../src/csv.js';

const P = '9000000001', Q = '9000000002';
const b = (o) => ({ campaign: 'Diwali', run: '2026-10-01', phone: P, failed: false, delivered: true, read: true, replied: false, clicked: false, ...o });
const o = (id, date, extra = {}) => ({ id, date, store: 'FRIDO_0002', phone: P, type: 'RETAIL', net: 1000, gross: 1200, lines: [{ p: 'Frido Dual Gel Pro Insoles', net: 1000, qty: 1 }], ...extra });
const run = (broadcasts, orders, touches = []) => computeRetention({ broadcasts, orders, touches, cutoff: '2026-12-31' });

test('window is the day after the send to day 60; send-day orders never count', () => {
  const m = run([b()], [o('A', '2026-09-30'), o('S', '2026-10-01'), o('B', '2026-10-02'), o('C', '2026-11-30'), o('D', '2026-12-01')]);
  assert.deepEqual(m.credited.map((x) => x.o), ['B', 'C']);
  assert.deepEqual(m.credited.map((x) => x.lag), [1, 60]);
  assert.equal(m.credited[0].first, 1); assert.equal(m.credited[1].first, 0);
  assert.equal(m.quality.sameDay, 1, 'the send-day order is counted as left out');
  // a send-day order does not move to that day's broadcast; it stays with an earlier one read before
  const m2 = run([b({ campaign: 'Ganpati', run: '2026-09-16' }), b({ campaign: 'Oct', run: '2026-10-22' })], [o('X', '2026-10-22')]);
  assert.equal(m2.campaigns[m2.credited[0].c].name, 'Ganpati');
});

test('return slips are not orders; bulk orders are flagged and kept', () => {
  const rows = [
    { 'POS Order ID': 'R1', 'Store ID': 'FRIDO_0002', 'POS Created At': '05/10/2026 12:00', 'Customer Phone': P, 'Ret/Exc': 'RETURNED', __gross: -1200, __net: -1200, Quantity: '-1', 'Product Name': 'Frido Dual Gel Pro Insoles' },
    { 'POS Order ID': 'K1', 'Store ID': 'FRIDO_0002', 'POS Created At': '06/10/2026 12:00', 'Customer Phone': P, __gross: 70000, __net: 64000, Quantity: '2', 'Product Name': 'Frido Ergoluxe Electric Standing Desk' },
    { 'POS Order ID': 'K2', 'Store ID': 'FRIDO_0002', 'POS Created At': '07/10/2026 12:00', 'Customer Phone': P, __gross: 3000, __net: 2500, Quantity: '5', 'Product Name': 'Frido Travel Neck Pillow' },
    { 'POS Order ID': 'K3', 'Store ID': 'FRIDO_0002', 'POS Created At': '08/10/2026 12:00', 'Customer Phone': P, __gross: 1200, __net: 1000, Quantity: '1', 'Product Name': 'Frido Dual Gel Pro Insoles' },
  ];
  const os = storeOrders(rows); assert.equal(os.find((x) => x.id === 'R1').slip, true);
  const m = run([b()], os);
  assert.deepEqual(m.credited.map((x) => [x.o, x.bulk]), [['K1', 1], ['K2', 1], ['K3', 0]]);
  assert.equal(m.quality.returnSlips, 1);
});

test('only delivered and read leads get orders', () => {
  assert.equal(run([b({ read: false })], [o('A', '2026-10-03')]).credited.length, 0);
  assert.equal(run([b({ delivered: false, read: false, failed: true })], [o('A', '2026-10-03')]).credited.length, 0);
  // read Navratri wins over a later, unread Diwali
  const m = run([b({ campaign: 'Navratri', run: '2026-09-20' }), b({ campaign: 'Diwali', run: '2026-10-01', read: false })], [o('A', '2026-10-05')]);
  assert.equal(m.campaigns[m.credited[0].c].name, 'Navratri');
  assert.equal(m.costPerDelivered, 0.85);
});

test('with Read At in the export, only leads read before the order are credited', () => {
  const ord = (id, ts) => o(id, ts.slice(0, 10), { ts });
  const B = [b({ readAt: '2026-10-03 18:00' }), b({ phone: Q, readAt: '2026-10-05' })];
  const m = run(B, [ord('A', '2026-10-03 12:00'), ord('B', '2026-10-04 10:00'), ord('C', '2026-10-05 15:00', ), { ...ord('D', '2026-10-05 09:00'), phone: Q }, { ...ord('E', '2026-10-04 09:00'), phone: Q }]);
  assert.equal(m.readTimes, true);
  assert.deepEqual(m.credited.map((x) => x.o).sort(), ['B', 'C', 'D'], 'A was bought before the read; E was bought the day before a date-only read');
  assert.deepEqual(m.late.map((x) => x.o).sort(), ['A', 'E']);
  // a read row without a time cannot be verified once the export carries read times
  const m2 = run([b({ readAt: '2026-10-02 09:00' }), b({ phone: Q })], [o('A', '2026-10-03'), { ...o('B', '2026-10-03'), phone: Q }]);
  assert.deepEqual(m2.credited.map((x) => x.o), ['A']); assert.equal(m2.quality.readNoTime, 1);
  // no Read At column at all → read status alone (flagged)
  const m3 = run([b()], [o('A', '2026-10-03')]); assert.equal(m3.readTimes, false); assert.equal(m3.credited.length, 1);
});

test('Read At timestamps and the order time are parsed', () => {
  assert.equal(stamp('2026-09-16 08:46:12'), '2026-09-16 08:46');
  assert.equal(stamp('16/09/2026 8:05 PM'), '2026-09-16 20:05');
  assert.equal(stamp('16/09/2026'), '2026-09-16');
  assert.equal(stamp('-'), null);
  const rows = parseBroadcastRows([{ 'Created At': '16/09/2026', 'Phone Number': '91' + P, 'Message Status': 'Delivered', 'Read Status': 'Read', 'Read At': '2026-09-17 10:30:00' }]);
  assert.equal(rows[0].readAt, '2026-09-17 10:30'); assert.equal(rows[0].read, true);
  const os = storeOrders([{ 'POS Order ID': 'X', 'Store ID': 'FRIDO_0002', 'POS Created At': '17/09/2026 09:15', 'Customer Phone': P, __gross: 100, __net: 90 }]);
  assert.equal(os[0].ts, '2026-09-17 09:15');
});

test('lean CSV reader gives the same rows as the full parser', () => {
  const csv = [
    'Created At,Phone Number,Message Status,Read Status,Button Clicks,Form Input Replies,Message Link Clicks,Orders,Order IDs,Revenue,AOV,Error',
    '16/09/2026,91' + P + ',Delivered,Read,Locate by city,-,-,-,-,-,-,-',
    '18/09/2026,91' + Q + `,Failed,-,-,-,-,-,-,-,-,"{'data': {'channelErrorCode': '131049', 'reason': 'Per-user messaging rate limit', 'status': 'failed'}}"`,
    ',,,,,,,,,,,',
    '26/09/2026,"91' + P + '",Sent,-,-,"a, ""quoted""\nnote",-,-,-,-,-,-',
  ].join('\r\n') + '\n';
  const lean = parseBroadcastCsv(csv);
  assert.deepEqual(lean, parseBroadcastRows(parseCsv(csv)));
  assert.equal(lean.length, 3, 'blank rows are skipped');
  assert.equal(lean[1].reason, 'Per-user messaging rate limit');
  assert.deepEqual(lean.map((x) => x.campaign), ['Retail_Retention_Ganpati', 'Retail_Retention_Ganpati_2', 'Retail_Retention_Ganpati_3']);
});

test('only Frido retail store orders count', () => {
  const rows = [
    { 'POS Order ID': 'X1', 'Store ID': 'FRIDO_0002', 'POS Created At': '05/10/2026 12:00', 'Customer Phone': '+91' + P, __gross: 1200, __net: 1000, 'Product Name': 'Frido Travel Neck Pillow' },
    { 'POS Order ID': 'X2', 'Store ID': 'FRIDO_0000', 'POS Created At': '05/10/2026 12:00', 'Customer Phone': P, __gross: 1200, __net: 1000 },
    { 'Shopify Order ID': 'X3', 'Store ID': '', 'Shopify Created At': '05/10/2026', 'Customer Phone': P, __gross: 900, __net: 900 },
  ];
  const os = storeOrders(rows);
  assert.deepEqual(os.map((x) => x.id), ['X1']);
  assert.equal(run([b()], os).credited.length, 1);
});

test('most recent touch wins', () => {
  // PDP lead after the broadcast, before the order → PDP keeps it
  let m = run([b()], [o('A', '2026-10-10')], [{ phone: P, d: '2026-10-05', src: 'pdp_call' }]);
  assert.equal(m.credited.length, 0); assert.equal(m.lostTo[0].to, 'pdp_call');
  // older walk-in lead → retention wins, prior touch kept for context
  m = run([b()], [o('A', '2026-10-10')], [{ phone: P, d: '2026-03-01', src: 'walkin' }]);
  assert.equal(m.credited.length, 1); assert.equal(m.credited[0].prior, 'walkin');
  // same-day tie with a lead → the lead wins
  m = run([b()], [o('A', '2026-10-10')], [{ phone: P, d: '2026-10-01', src: 'meta' }]);
  assert.equal(m.credited.length, 0);
  // walk-in lead logged on the order day (captured after the purchase) is not a prior touch
  m = run([b()], [o('A', '2026-10-10')], [{ phone: P, d: '2026-10-10', src: 'walkin' }]);
  assert.equal(m.credited.length, 1);
});

test('two campaigns in window → the later run date wins', () => {
  const m = run([b({ campaign: 'Navratri', run: '2026-09-20' }), b({ campaign: 'Diwali', run: '2026-10-01' })], [o('A', '2026-09-25'), o('B', '2026-10-05')]);
  const name = (c) => m.campaigns[c].name;
  assert.deepEqual(m.credited.map((x) => name(x.c)), ['Navratri', 'Diwali']);
});

test('recipients are unique per campaign; resends upgrade flags', () => {
  const m = run([b({ read: false }), b({ read: true, replied: true }), b({ phone: Q, delivered: false, read: false, failed: true, reason: 'Invalid Recipient' })], [o('A', '2026-10-03')]);
  assert.deepEqual(m.fails.map((x) => [x.why, x.n]), [['Invalid Recipient', 1]]);
  assert.equal(m.quality.duplicates, 1);
  const t = m.recipients.reduce((a, r) => ({ n: a.n + r.n, read: a.read + r.read, rep: a.rep + r.rep, failed: a.failed + r.failed, buy: a.buy + r.buy, repBuy: a.repBuy + r.repBuy }), { n: 0, read: 0, rep: 0, failed: 0, buy: 0, repBuy: 0 });
  assert.deepEqual(t, { n: 2, read: 1, rep: 1, failed: 1, buy: 1, repBuy: 1 });
});

test('home store = last store before the run date', () => {
  const m = run([b()], [o('H', '2026-05-01', { store: 'FRIDO_0010' }), o('A', '2026-10-03')]);
  assert.equal(m.credited[0].hs, 'FRIDO_0010');
  assert.equal(m.recipients[0].hs, 'FRIDO_0010');
});

test('LimeChat retention export (no broadcast name) maps by send date', () => {
  const rows = parseBroadcastRows([
    { 'Created At': '16/09/2026', 'Phone Number': '91' + P, 'Message Status': 'Delivered', 'Read Status': 'Read', 'Button Clicks': 'Locate by city', 'Form Input Replies': '-', Error: '-' },
    { 'Created At': '16/09/2026', 'Phone Number': '91' + Q, 'Message Status': 'Delivered', 'Read Status': 'Not read', 'Button Clicks': '-', 'Form Input Replies': '-', Error: '-' },
    { 'Created At': '26/09/2026', 'Phone Number': '91' + Q, 'Message Status': 'Sent', 'Read Status': '-', 'Button Clicks': '-', 'Form Input Replies': '-', Error: '-' },
    { 'Created At': '30/09/2026', 'Phone Number': '91' + P, 'Message Status': 'Failed', 'Read Status': '-', 'Button Clicks': '-', 'Form Input Replies': '-', Error: "{'data': {'channelErrorCode': '131049', 'reason': 'Per-user messaging rate limit', 'status': 'failed'}}" },
  ]);
  assert.deepEqual(rows.map((r) => [r.campaign, r.sent, r.delivered, r.read, r.failed, r.clicked]), [
    ['Retail_Retention_Ganpati', true, true, true, false, true], ['Retail_Retention_Ganpati', true, true, false, false, false],
    ['Retail_Retention_Ganpati_3', true, false, false, false, false], ['Broadcast · 2026-09-30', false, false, false, true, false]]);
  assert.equal(rows[3].reason, 'Per-user messaging rate limit');
  assert.equal(failReason('-'), '');
});

test('LimeChat broadcast report columns are read loosely', () => {
  const rows = parseBroadcastRows([
    { 'Campaign Name': 'Diwali', 'Sent At': '2026-10-16 10:00:00', 'Phone Number': '91' + P, 'Message Status': 'Read', Replied: 'True', 'Button Clicked': 'False' },
    { 'Campaign Name': 'Diwali', 'Sent At': '16/10/2026', 'Phone Number': Q, 'Message Status': 'Failed', Replied: '', 'Button Clicked': '' },
  ]);
  assert.deepEqual(rows[0], { campaign: 'Diwali', run: '2026-10-16', phone: P, failed: false, sent: true, delivered: true, read: true, readAt: null, replied: true, clicked: false, reason: '' });
  assert.equal(rows[1].failed, true); assert.equal(rows[1].run, '2026-10-16');
});

test('output carries no phones', () => {
  const m = run([b()], [o('A', '2026-10-03')], [{ phone: P, d: '2026-01-01', src: 'walkin' }]);
  assert.ok(!JSON.stringify(m).includes(P));
  const s = computeRetention({ ...sampleInputs('2026-10-21'), cutoff: '2026-10-21' });
  assert.ok(!/90000\d{5}/.test(JSON.stringify(s)));
});

test('sample is stable and respects the cutoff', () => {
  const a = computeRetention({ ...sampleInputs('2026-10-21'), cutoff: '2026-10-21' }), c = computeRetention({ ...sampleInputs('2026-10-21'), cutoff: '2026-10-21' });
  assert.deepEqual(a.credited, c.credited);
  assert.ok(a.credited.every((x) => x.d <= '2026-10-21' && x.lag >= 0 && x.lag <= 60));
  assert.ok(a.campaigns.length >= 3);
});
