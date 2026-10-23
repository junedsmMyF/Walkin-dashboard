// Synthetic data only — never commit real customer rows.
import test from 'node:test'; import assert from 'node:assert/strict';
import { buildLeadList, summariseLeads } from '../src/leads.js';

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
