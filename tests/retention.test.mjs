// Retail retention: 60-day window, store orders only, most recent touch wins, no PII. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRetention, parseBroadcastRows, storeOrders, sampleInputs, failReason } from '../src/retention.js';

const P = '9000000001', Q = '9000000002';
const b = (o) => ({ campaign: 'Diwali', run: '2026-10-01', phone: P, failed: false, delivered: true, read: true, replied: false, clicked: false, ...o });
const o = (id, date, extra = {}) => ({ id, date, store: 'FRIDO_0002', phone: P, type: 'RETAIL', net: 1000, gross: 1200, lines: [{ p: 'Frido Dual Gel Pro Insoles', net: 1000, qty: 1 }], ...extra });
const run = (broadcasts, orders, touches = []) => computeRetention({ broadcasts, orders, touches, cutoff: '2026-12-31' });

test('window is run date to day 60, inclusive', () => {
  const m = run([b()], [o('A', '2026-09-30'), o('B', '2026-10-01'), o('C', '2026-11-30'), o('D', '2026-12-01')]);
  assert.deepEqual(m.credited.map((x) => x.o), ['B', 'C']);
  assert.deepEqual(m.credited.map((x) => x.lag), [0, 60]);
  assert.equal(m.credited[0].first, 1); assert.equal(m.credited[1].first, 0);
});

test('only delivered and read leads get orders', () => {
  assert.equal(run([b({ read: false })], [o('A', '2026-10-03')]).credited.length, 0);
  assert.equal(run([b({ delivered: false, read: false, failed: true })], [o('A', '2026-10-03')]).credited.length, 0);
  // read Navratri wins over a later, unread Diwali
  const m = run([b({ campaign: 'Navratri', run: '2026-09-20' }), b({ campaign: 'Diwali', run: '2026-10-01', read: false })], [o('A', '2026-10-05')]);
  assert.equal(m.campaigns[m.credited[0].c].name, 'Navratri');
  assert.equal(m.costPerDelivered, 0.85);
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
  assert.deepEqual(rows[0], { campaign: 'Diwali', run: '2026-10-16', phone: P, failed: false, sent: true, delivered: true, read: true, replied: true, clicked: false, reason: '' });
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
