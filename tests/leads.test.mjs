// Synthetic data only — never commit real customer rows.
import test from 'node:test'; import assert from 'node:assert/strict';
import { buildLeadList, summariseLeads, attributeOrders, leadRows } from '../src/leads.js';

const C = (src, id, d, phone, extra = {}) => ({ src, id, ts: Date.parse(d + 'T10:00:00Z'), d, phone, valid: !!phone, entry: src === 'call' ? 'call_popup' : 'store_widget', store: '', ...extra });

test('one lead per phone: repeat within 30 days, fresh lead after 30, stays a repeat if the phone bought in between', () => {
  const contacts = [
    C('limechat', '1', '2026-09-01', '9000000001'),
    C('call', 'c1', '2026-09-10', '9000000001'),     // 9 days → repeat, cross-source
    C('bigin', '2', '2026-10-05', '9000000001'),     // 34 days → fresh lead
    C('limechat', '3', '2026-09-02', '9000000002'),
    C('bigin', '4', '2026-10-15', '9000000002'),     // 43 days, but bought on 20 Sep → repeat
    C('bigin', '5', '2026-10-16', null),             // no phone → its own lead
  ];
  const ordersByPhone = new Map([['9000000002', [{ date: '2026-09-20', net: 1000 }]]]);
  const LL = buildLeadList({ contacts, ordersByPhone });
  assert.deepEqual(LL.leads.map((l) => [l.id, l.again, l.repeats]), [['1', 0, 1], ['3', 0, 1], ['2', 1, 0], ['5', 0, 0]]);
  assert.equal(LL.leads[0].srcs.size, 2);
  assert.equal(LL.leads[1].boughtRepeat, 1);
  const s = summariseLeads(LL, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual([s.leads, s.freshAfter30, s.noPhone, s.bySource.bigin], [2, 1, 1, 2]);
});

test('routing rows join the latest lead that started on/before the routing date; test rows and strays counted', () => {
  const contacts = [C('limechat', '1', '2026-09-01', '9000000001'), C('bigin', '2', '2026-10-05', '9000000001'), C('call', 'c', '2026-10-10', '9000000003')];
  const routes = [
    { d: '2026-10-06', phone: '9000000001', vd: '2026-10-08', s: 'FRIDO_0010', test: 0 },   // → lead 2 (not lead 1)
    { d: '2026-10-07', phone: '9000000001', vd: '2026-10-09', s: 'FRIDO_0010', test: 0 },   // second row for the same lead
    { d: '2026-10-09', phone: '9000000003', vd: '2026-10-11', s: 'FRIDO_0003', test: 0 },   // routed before the call lead
    { d: '2026-10-09', phone: '9000000009', vd: '', s: '', test: 0 },                      // phone never a lead
    { d: '2026-10-09', phone: '9000000001', vd: '', s: '', test: 1 },
  ];
  const LL = buildLeadList({ contacts, routes });
  assert.deepEqual(LL.leads.map((l) => [l.id, l.rt, l.vd]), [['1', '', ''], ['2', '2026-10-06', '2026-10-08'], ['c', '', '']]);
  assert.deepEqual(LL.routing, { rows: 4, test: 1, matched: 1, beforeLead: 1, unmatched: 1, repeatRows: 1 });
  const s = JSON.stringify(summariseLeads(LL, { from: '2026-10-01', to: '2026-10-31' }));
  assert.ok(!s.includes('9000000'));
});

test('orders: latest lead before the order, within 60 days, each order once; store / video / other routes', async () => {
  const { attributeOrders } = await import('../src/leads.js');
  const contacts = [
    C('limechat', '1', '2026-08-01', '9000000001'),
    C('bigin', '2', '2026-10-05', '9000000001'),                    // fresh lead (65 days later, no purchase between)
    C('call', 'c', '2026-10-01', '9000000003', { vc: true }),      // video call arranged, not routed
    C('limechat', '4', '2026-10-02', '9000000004'),                 // routed, video remark
    C('limechat', '5', '2026-08-01', '9000000005'),                 // order 70 days later → outside the window
  ];
  const routes = [{ d: '2026-10-06', phone: '9000000001', vd: '2026-10-08', s: 'FRIDO_0010', test: 0 }, { d: '2026-10-03', phone: '9000000004', vd: '2026-10-04', s: 'FRIDO_0010', test: 0, video: 1 }];
  const ordersByPhone = new Map([
    ['9000000001', [{ id: 'A', date: '2026-10-08', net: 3000 }, { id: 'B', date: '2026-10-12', net: 500 }]],
    ['9000000003', [{ id: 'C', date: '2026-10-03', net: 9000 }]],
    ['9000000004', [{ id: 'D', date: '2026-10-05', net: 7000 }]],
    ['9000000005', [{ id: 'E', date: '2026-10-10', net: 100 }]],
  ]);
  const LL = attributeOrders(buildLeadList({ contacts, routes, ordersByPhone }), ordersByPhone, { cutoff: '2026-10-20' });
  const got = Object.fromEntries(LL.leads.filter((l) => l.orders.length).map((l) => [l.id, l.orders.map((o) => [o.id, o.route])]));
  assert.deepEqual(got, { 2: [['A', 'store'], ['B', 'other']], c: [['C', 'video']], 4: [['D', 'video']] });
  assert.deepEqual(LL.orderStats, { beyondWindow: 1, beforeLead: 0 });
  const s = summariseLeads(LL, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual([s.buyers, s.orders, s.revenue, s.byRoute.store.buyers, s.byRoute.video.buyers, s.byRoute.other.orders], [3, 4, 19500, 1, 2, 1]);
});

test('lead rows for the browser: furthest progress across contacts, routed = qualified, no phone or ticket id', async () => {
  const { leadRows } = await import('../src/leads.js');
  const contacts = [
    C('bigin', '77001', '2026-10-05', '9000000001', { cons: true }),
    C('call', 'c1', '2026-10-06', '9000000001', { cons: true, conn: true, qual: true }),   // repeat moves the lead forward
    C('bigin', '77002', '2026-10-07', '9000000002'),                                        // untouched, but routed
  ];
  const routes = [{ d: '2026-10-08', phone: '9000000002', vd: '2026-10-09', s: 'FRIDO_0010', test: 0 }];
  const LL = buildLeadList({ contacts, routes });
  const rows = leadRows(LL, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(rows.map((r) => [r.c, r.n, r.q, r.rt ? 1 : 0, r.rep]), [[1, 1, 1, 0, 1], [1, 1, 1, 1, 0]]);
  const s = JSON.stringify(rows); assert.ok(!s.includes('900000000') && !s.includes('77001') && !s.includes('c1'));
});

test('interest, loss reason and order lines: first known interest, latest loss reason, routing category as fallback', () => {
  const contacts = [
    C('limechat', '1', '2026-10-01', '9000000001', { pp: 'Frido Ultimate Car Seat', ci: 'Car seat', lost: 1, lr: 'Not interested' }),
    C('bigin', '2', '2026-10-05', '9000000001', { ci: 'Chair', lost: 1, lr: 'Store too far' }), // repeat: keeps the first interest, takes the latest reason
    C('call', 'c', '2026-10-10', '9000000003'),
  ];
  const routes = [{ d: '2026-10-11', phone: '9000000003', vd: '2026-10-12', s: 'FRIDO_0010', cat: 'Mattress', test: 0 }];
  const orders = new Map([['9000000003', [{ id: 'A', date: '2026-10-12', net: 5000, store: 'FRIDO_0010', lines: [{ p: 'Frido Mattress', qty: 1, net: 5000 }] }]]]);
  const LL = attributeOrders(buildLeadList({ contacts, routes, ordersByPhone: orders }), orders, { cutoff: '2026-10-20' });
  const names = []; const pid = (n) => (names.includes(n) ? names.indexOf(n) : names.push(n) - 1);
  const rows = leadRows(LL, { from: '2026-10-01', to: '2026-10-31', pid, catOf: () => 'Mattress' });
  assert.deepEqual(rows.map((x) => [x.ci, x.pp, x.lr]), [['Car seat', 'Frido Ultimate Car Seat', 'Store too far'], ['Mattress', '', '']]);
  assert.deepEqual(rows[1].o[0].i, [[0, 'Mattress', 1, 5000]]);
  assert.equal(rows[1].o[0].r, 'store');
  assert.deepEqual(names, ['Frido Mattress']);
});

test('routed lead without a video remark counts as a video call when Bigin shows a video-call stage (owner, 24 Oct 2026)', () => {
  const contacts = [C('limechat', '1', '2026-10-19', '9000000001'), C('bigin', '2', '2026-10-22', '9000000002')];
  const routes = [
    { d: '2026-10-20', phone: '9000000001', vd: '2026-10-21', s: 'FRIDO_0010', video: 0, test: 0 },  // Bigin says video → video
    { d: '2026-10-23', phone: '9000000002', vd: '2026-10-24', s: 'FRIDO_0010', video: 0, test: 0 },  // no video anywhere → store visit
  ];
  const LL = buildLeadList({ contacts, routes, videoPhones: new Set(['9000000001']) });
  assert.deepEqual(LL.leads.map((l) => [l.id, l.rv]), [['1', 1], ['2', 0]]);
});
