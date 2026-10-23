// Synthetic data only — never commit real customer rows.
import test from 'node:test'; import assert from 'node:assert/strict';
import { computePdp, storeFromWeb } from '../src/pdp.js';

const cb = (id, p, ct, web, st = 'Yet to Call', extra = {}) => ({ i: id, nm: 'Test Caller', p, ct, mt: ct, web, st, ...extra });
const sale = (id, p, d, store, net) => ({ 'POS Order ID': id, 'Customer Phone': p, 'POS Created At': d, 'Store ID': store, __gross: String(net), __net: String(net), 'Order Type': 'RETAIL', 'Ret/Exc': '-', 'Product Name': 'Frido Test Chair' });
const run = (x) => computePdp({ startDate: '2026-10-08', cutoff: '2026-10-12', sample: false, ...x });

test('website store labels map to the store master', () => {
  assert.equal(storeFromWeb('SkyCity Mall, Mumbai'), 'FRIDO_0010');
  assert.equal(storeFromWeb('Frido Store, Vegas Mall'), 'FRIDO_0017');
  assert.equal(storeFromWeb('Kompally, HYD'), 'FRIDO_0014');
  assert.equal(storeFromWeb('Nowhere Mall'), null);
});

test('unique lead = first record per phone; repeats are duplicates', () => {
  const m = run({ callbacks: [
    cb('1000000000000000001', '9000000001', '2026-10-08T11:00:00+05:30', 'SkyCity Mall, Mumbai'),
    cb('1000000000000000002', '+91 9000000001', '2026-10-09T11:00:00+05:30', 'Frido Store, Vegas Mall'),
    cb('1000000000000000003', '9000000002', '2026-10-09T12:00:00+05:30', 'Amanora Mall, Pune', 'Not Interested'),
  ] });
  assert.equal(m.call.leads.length, 3);
  assert.deepEqual(m.call.leads.map((x) => x.dup), [0, 1, 0]);
  assert.equal(m.call.leads[2].lostNoReason, 1);
  assert.equal(m.quality.uniquePhones, 2);
});

test('attribution: same-day and later orders count, earlier orders do not; any store', () => {
  const m = run({
    callbacks: [cb('1000000000000000001', '9000000001', '2026-10-09T11:00:00+05:30', 'SkyCity Mall, Mumbai')],
    salesRows: [sale('A', '9000000001', '08/10/2026', 'FRIDO_0010', 900), sale('B', '9000000001', '09/10/2026', 'FRIDO_0010', 1000), sale('C', '919000000001', '11/10/2026', 'FRIDO_0001', 2000)],
  });
  assert.deepEqual(m.call.attributed.map((x) => [x.d, x.s, x.cs, x.net, x.first, x.same]), [['2026-10-09', 'FRIDO_0010', 'FRIDO_0010', 1000, 1, 1], ['2026-10-11', 'FRIDO_0001', 'FRIDO_0010', 2000, 0, 0]]);
  assert.equal(m.call.products[0].net, 3000);
});

test('overlap with walk-in leads is flagged as shared', () => {
  const m = run({
    callbacks: [cb('1000000000000000001', '9000000001', '2026-10-09T11:00:00+05:30', 'SkyCity Mall, Mumbai')],
    walkinLeads: [{ p: '9000000001', d: '2026-09-20T12:00:00+05:30' }],
    salesRows: [sale('B', '9000000001', '10/10/2026', 'FRIDO_0010', 1000)],
  });
  assert.equal(m.call.attributed[0].shared, 1);
  assert.equal(m.call.leads[0].wk, 1);
});

test('typo phones (one digit off, same name) are flagged; payload has no phones or names', () => {
  const m = run({ callbacks: [
    cb('1000000000000000001', '9918268307', '2026-10-10T13:11:00+05:30', 'DLF Summit'),
    cb('1000000000000000002', '9910268307', '2026-10-10T13:12:00+05:30', 'DLF Summit'),
  ] });
  assert.deepEqual(m.call.leads.map((x) => x.near), [0, 1]);
  const s = JSON.stringify(m);
  assert.ok(!s.includes('9918268307') && !s.includes('Test Caller'));
});

test('sample block is flagged and deterministic', () => {
  const a = computePdp({ startDate: '2026-10-08', cutoff: '2026-10-09' }).sample;
  const b = computePdp({ startDate: '2026-10-08', cutoff: '2026-10-09' }).sample;
  assert.equal(a.isSample, true);
  assert.deepEqual(a.pdpDaily, b.pdpDaily);
});

test('conversion route: not routed + video call arranged = video call conversion, whatever the order type; otherwise other', () => {
  const s2 = (id, d, store, emp, type) => ({ ...sale(id, '9000000001', d, store, 1000), 'Employee Name': emp, 'Order Type': type });
  const m = run({
    callbacks: [cb('1000000000000000001', '9000000001', '2026-10-08T11:00:00+05:30', 'SkyCity Mall, Mumbai', 'Video call arrange', { own: 'Raj B' }), cb('1000000000000000003', '9000000003', '2026-10-08T12:00:00+05:30', 'SkyCity Mall, Mumbai', 'Connected')],
    salesRows: [{ ...s2('D', '09/10/2026', 'FRIDO_0010', '', 'ONLINE'), 'Customer Phone': '9000000003' }, s2('A', '09/10/2026', 'FRIDO_0010', 'Raj Bhardwaj', 'ONLINE'), s2('B', '10/10/2026', 'FRIDO_0010', 'Store Staff', 'RETAIL'), s2('C', '11/10/2026', 'FRIDO_0010', '', 'ONLINE')],
  });
  assert.deepEqual(m.call.attributed.filter((x) => x.ag === 'Raj B').map((x) => [x.path, x.pb]), [['video', 'vc_arranged'], ['video', 'vc_arranged'], ['video', 'vc_arranged']]);
  assert.deepEqual(m.call.attributed.filter((x) => x.ag !== 'Raj B').map((x) => [x.path, x.pb]), [['other', 'none']]);
  assert.equal(m.call.leads[0].ag, 'Raj B');
  assert.deepEqual(m.agents, ['Raj B']);
});

test('qualified split: routed (routing sheet) and VC arranged (Bigin stage) are marked per lead', () => {
  const row = (id, at, p) => ({ 'Lead ID': id, 'Submitted at': at, Store: 'Sky City Mall, Borivali', 'Customer name': 'Real Customer', 'Customer number': p, 'Product name': 'NM - Chair', 'Expected visit date': '10/12/2026', 'Expected visit time': '5 PM' });
  const m = run({
    callbacks: [cb('1000000000000000001', '9000000001', '2026-10-08T11:00:00+05:30', 'SkyCity Mall, Mumbai', 'Connected'), cb('1000000000000000002', '9000000002', '2026-10-09T11:00:00+05:30', 'SkyCity Mall, Mumbai', 'Video call arrange')],
    routingRows: [row('L1', '10/10/2026 10:00:00', '9000000001')],
  });
  assert.deepEqual(m.call.leads.map((x) => [x.g, x.rt, x.vc]), [['engaged', 1, 0], ['vcPlan', 0, 1]]);
  assert.ok(!JSON.stringify(m).includes('9000000002'));
});

test('routed lead counts as qualified whatever its stage; raw stage kept and mismatch flagged', () => {
  const row = (id, at, p) => ({ 'Lead ID': id, 'Submitted at': at, Store: 'Sky City Mall, Borivali', 'Customer name': 'Real Customer', 'Customer number': p, 'Product name': 'NM - Chair', 'Expected visit date': '10/12/2026', 'Expected visit time': '5 PM' });
  const T = { 'Ticket ID': '5', 'Created At': '2026-10-09 10:00:00', 'Ticket Status': 'closed', 'is_handoff?': 'FALSE', 'is_resolved?': 'TRUE', 'is_outside_working_hours?': 'FALSE', 'First Assignee Name': '', 'Current Agent': '', 'First Assigned Time': '', 'First Agent Message Time': '', 'Agent Message Blocks': '0', 'Private Notes': '', 'Level 1 Tags (Main)': 'storewidget', 'System Tags': 'bot', 'Last Message Sent By': 'Bot', 'Phone Number': '919000000007', 'Customer Name': 'Test' };
  const m = run({
    callbacks: [cb('1000000000000000001', '9000000001', '2026-10-08T11:00:00+05:30', 'SkyCity Mall, Mumbai', 'RNR 1'), cb('1000000000000000002', '9000000002', '2026-10-08T12:00:00+05:30', 'SkyCity Mall, Mumbai', 'RNR 1')],
    limechatRows: [T],
    routingRows: [row('L1', '10/10/2026 10:00:00', '9000000001'), row('L2', '10/10/2026 11:00:00', '9000000007'), row('L3', '10/20/2026 11:00:00', '9000000002')], // L3 is after the cutoff
  });
  assert.deepEqual(m.call.leads.map((x) => [x.st, x.g, x.rsm, x.cons, x.rt]), [['RNR 1', 'visitPlan', 1, 1, 1], ['RNR 1', 'ringing', 0, 1, 0]]);
  const t = m.text.tickets[0];
  assert.deepEqual([t.st, t.sr, t.am, t.oc, t.rt, t.fl.includes('routed_stage_mismatch')], ['qualified', 'bot_only', 1, 'routed_store', 1, true]);
});
