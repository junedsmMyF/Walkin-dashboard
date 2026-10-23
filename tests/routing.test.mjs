// Synthetic data only — never commit real customer rows.
import test from 'node:test'; import assert from 'node:assert/strict';
import { usDate, visitTime, cleanCategory, standardiseRouting } from '../src/routing.js';
import { computePdp } from '../src/pdp.js';

const row = (id, sub, store, name, ph, extra = {}) => ({ 'Lead ID': id, 'Submitted at': sub, Store: store, 'Customer name': name, 'Customer number': ph, 'Product name': 'Frido Test Chair', 'Product category': 'NM - Ergonomic Furniture', 'Expected visit date': '10/12/2026', 'Expected visit time': '6pm-8pm', 'Discount offered': '', Remarks: '', 'Submitted by': 'Agent A', ...extra });

test('US dates, visit times and category prefix are standardised', () => {
  assert.deepEqual(usDate('10/9/2026 19:16:24').d, '2026-10-09');
  assert.equal(usDate('13/10/2026'), null);
  assert.deepEqual(visitTime('6pm-8pm'), { kind: 'slot', from: 18 });
  assert.deepEqual(visitTime('9:30 PM'), { kind: 'time', from: 21 });
  assert.deepEqual(visitTime(''), { kind: 'blank', from: null });
  assert.equal(visitTime('evening').kind, 'other');
  assert.equal(cleanCategory('NM - Footwear'), 'Footwear');
});

test('test rows (and rows sharing a test phone) are flagged; repeats and unmapped stores flagged', () => {
  const { routes, firstByPhone } = standardiseRouting([
    row('L1', '10/10/2026 10:00:00', 'Felix, Gurgaon', 'Someone', '9000000001'),
    row('L2', '10/10/2026 11:00:00', 'Nowhere', 'test', '9000000001', { 'Expected visit date': '10/9/2026', 'Expected visit time': '' }),
    row('L3', '10/11/2026 11:00:00', 'Sky City Mall, Borivali', 'Real Customer', '9000000002', { 'Discount offered': 'NA' }),
  ], { storeOf: (l) => ({ 'Felix, Gurgaon': 'FRIDO_0021', 'Sky City Mall, Borivali': 'FRIDO_0010' })[l] });
  assert.deepEqual(routes.map((x) => x.test), [1, 1, 0]);
  assert.ok(routes[1].flags.includes('store_unmapped') && routes[1].flags.includes('visit_before_routing') && routes[1].flags.includes('no_visit_time'));
  assert.ok(routes[0].flags.includes('repeat_phone') && routes[0].flags.includes('category_prefix'));
  assert.equal(routes[2].disc, '');
  assert.equal(firstByPhone.size, 1);
});

test('routed lead → source lead → order; store visit conversion only on the expected visit date; payload has no phones or names', () => {
  const sale = (id, d, store, emp, type) => ({ 'POS Order ID': id, 'Customer Phone': '9000000002', 'POS Created At': d, 'Store ID': store, __gross: '1000', __net: '1000', 'Order Type': type, 'Ret/Exc': '-', 'Product Name': 'Frido Test Chair', 'Employee Name': emp });
  const m = computePdp({ startDate: '2026-10-08', cutoff: '2026-10-14', sample: false,
    callbacks: [{ i: '1000000000000000001', nm: 'Real Customer', p: '9000000002', ct: '2026-10-09T11:00:00+05:30', mt: '2026-10-09T11:00:00+05:30', web: 'SkyCity Mall, Mumbai', st: 'Connected', own: 'Raj B' }],
    routingRows: [row('L3', '10/11/2026 11:00:00', 'Sky City Mall, Borivali', 'Real Customer', '9000000002')],
    salesRows: [sale('A', '12/10/2026', 'FRIDO_0010', 'Store Staff', 'RETAIL'), sale('B', '13/10/2026', 'FRIDO_0010', 'Raj Bhardwaj', 'RETAIL'), sale('C', '14/10/2026', 'FRIDO_0010', 'Store Staff', 'ONLINE')] });
  const r = m.routing.routes[0];
  assert.deepEqual([r.src, r.ld, r.lag, r.od, r.same, r.onTime, r.net, r.n, r.path], ['call', '2026-10-09', 2, '2026-10-12', 1, 1, 3000, 3, 'store']);
  assert.deepEqual(m.call.attributed.map((x) => [x.path, x.pb, x.rtd]), [['store', 'visit_day', 1], ['other', 'routed_other_day', 1], ['other', 'routed_other_day', 1]]);
  const s = JSON.stringify(m); assert.ok(!s.includes('9000000002') && !s.includes('Real Customer'));
});
