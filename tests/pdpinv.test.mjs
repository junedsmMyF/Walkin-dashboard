// Synthetic data only — never commit real customer rows.
import test from 'node:test'; import assert from 'node:assert/strict';
import { computePdpInv, stageGroupOf, entryOfTag } from '../src/pdpinv.js';
import { computePdp } from '../src/pdp.js';

const rec = (i, cid, st, tc, extra = {}) => ({ i, cid, st, ct: tc, mt: tc, tc, p: '', nm: 'Real Person', own: 'Agent A', loc: 'Skycity Borivali Mumbai', ctag: 'chat_skycity', tags: [], amt: 0, rem: '', lr: '', ...extra });
const NOW = '2026-10-24T12:00:00+05:30';

test('PDP Inventories stages: groups ignore case/spacing; unknown stages are flagged', () => {
  assert.equal(stageGroupOf('connected - in discussion'), 'connected');
  assert.equal(stageGroupOf('Video Call Arrange'), 'video');
  assert.equal(stageGroupOf('RNR 3'), 'attempt');
  assert.equal(stageGroupOf('Something new'), 'other');
  assert.deepEqual(entryOfTag('storewidget, start_chat'), { entry: 'store_widget', pdp: '', tagStore: '' });
  assert.equal(entryOfTag('chat_skycity').tagStore, 'FRIDO_0010');
});

test('PDP Inventories hygiene flags; PII never leaves', () => {
  const ordersByPhone = new Map([['9000000003', [{ date: '2026-10-23', net: 2500 }]], ['9000000004', [{ date: '2026-10-21', net: 900 }]]]);
  const recs = [
    rec('1', '90001', 'New Enquiry', '2026-10-22T10:00:00+05:30', { p: '+91 90000 00001' }),
    rec('2', '90002', 'RNR 1', '2026-10-22T11:00:00+05:30', { p: '9000000001', own: '' }),                        // repeat phone, no owner
    rec('3', '90003', 'Connected - In Discussion', '2026-10-22T12:00:00+05:30', { p: '9000000003', ctag: '' }),      // bought, not Converted; no tag
    rec('4', '90004', 'Converted', '2026-10-22T13:00:00+05:30', { p: '9000000004', loc: '' }),                      // order before ticket → no order
    rec('5', '90005', 'Not Interested', '2026-10-22T14:00:00+05:30', { p: '12345' }),                               // bad phone, no reason
    rec('6', '90006', 'Store Visit Scheduled', '2026-10-22T15:00:00+05:30', { p: '9000000006', rem: 'Real Person, call at 5' }),
    rec('7', '90007', 'Waiting for docs', '2026-10-22T16:00:00+05:30', { p: '9000000007' }),
  ];
  const hist = { 2: [['New Enquiry', '2026-10-22T11:00:00+05:30'], ['RNR 1', '2026-10-22T11:30:00+05:30']] };
  const r = computePdpInv({ recs, hist, cutoff: '2026-10-23', now: NOW, ordersByPhone, storeOf: (l) => ({ 'Skycity Borivali Mumbai': 'FRIDO_0010' })[l] || null, routedOn: () => null, lcFirst: (p) => (p === '9000000003' ? '2026-10-15' : null) });
  const fl = Object.fromEntries(r.tickets.map((t) => [t.i, t.fl]));
  assert.deepEqual(fl['90001'], ['new_over_24h']);
  assert.deepEqual(fl['90002'], ['dup_phone', 'no_owner', 'rnr_over_48h']);
  assert.deepEqual(fl['90003'], ['no_tag', 'order_not_converted']);
  assert.deepEqual(fl['90004'], ['converted_no_order']); // store comes from the chat_skycity tag
  assert.deepEqual(fl['90005'], ['no_phone', 'lost_no_reason']);
  assert.deepEqual(fl['90006'], ['visit_not_routed']);
  assert.deepEqual(fl['90007'], ['unknown_stage']);
  assert.deepEqual(r.unknownStages, ['Waiting for docs']);
  assert.equal(r.tickets.find((t) => t.i === '90003').lcBefore, 1);
  assert.equal(r.buyers, 1); assert.equal(r.revenue, 2500);
  const s = JSON.stringify(r); assert.ok(!s.includes('900000000') && !s.includes('Real Person') && !s.includes('call at 5'));
});

test('computePdp carries the PDP Inventories review without changing other figures', () => {
  const base = { startDate: '2026-10-08', cutoff: '2026-10-23', sample: false };
  const a = computePdp(base);
  const b = computePdp({ ...base, pdpInv: { recs: [rec('1', '90001', 'New Enquiry', '2026-10-22T10:00:00+05:30', { p: '9000000001' })], hist: {}, meta: { status: 'ok' } } });
  assert.equal(b.pinv.total, 1);
  const { pinv, generatedAt: g1, ...restB } = b; const { generatedAt: g2, ...restA } = a;
  assert.deepEqual(restB, restA);
});
