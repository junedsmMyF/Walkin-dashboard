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
  assert.deepEqual(fl['90001'], ['new_over_24h', 'new_over_15m']);
  assert.deepEqual(fl['90002'], ['dup_phone', 'no_owner', 'rnr1_over_3h']);
  assert.deepEqual(fl['90003'], ['no_tag', 'connected_over_24h', 'order_not_converted']);
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

test('cutover: LimeChat export before 22 Oct, Bigin from 22 Oct; one lead per phone; stages map to the call rule; coverage check', () => {
  const T = (id, created, o = {}) => ({ 'Ticket ID': id, 'Created At': created, 'Ticket Status': 'closed', 'is_handoff?': 'FALSE', 'is_resolved?': 'TRUE', 'is_outside_working_hours?': 'FALSE',
    'First Assignee Name': '', 'Current Agent': '', 'First Assigned Time': '', 'First Agent Message Time': '', 'Agent Message Blocks': '0', 'Private Notes': '',
    'Level 1 Tags (Main)': 'storewidget', 'System Tags': 'bot', 'Last Message Sent By': 'Bot', 'Phone Number': '919000000001', 'Customer Name': 'Test', ...o });
  const limechatRows = [
    T('77001', '2026-10-21 10:00:00', { 'Phone Number': '919000000001' }),                 // before cutover → from the export
    T('77700', '2026-10-22 09:00:00', { 'Phone Number': '919000000009' }),                 // export row after cutover → not used for figures
    T('77701', '2026-10-22 09:30:00', { 'Phone Number': '919000000008' }),                 // in the export, missing in Bigin → coverage gap
  ];
  const recs = [
    rec('1', '76000', 'New Enquiry', '2026-10-18T10:00:00+05:30', { p: '9000000005' }),     // before cutover → ignored (export covers it)
    rec('2', '77700', 'Store Visit Scheduled', '2026-10-22T09:00:00+05:30', { p: '9000000009' }),
    rec('3', '77702', 'RNR 1', '2026-10-22T10:00:00+05:30', { p: '9000000001' }),          // repeat of a 21 Oct export lead → duplicate
    rec('4', '77703', 'Connected - In Discussion', '2026-10-22T11:00:00+05:30', { p: '9000000003' }),
    rec('5', '77704', 'Not Interested', '2026-10-22T12:00:00+05:30', { p: '9000000004' }),
    rec('6', '77705', 'New Enquiry', '2026-10-22T13:00:00+05:30', { p: '9000000006' }),
  ];
  const salesRows = [{ 'POS Order ID': 'A', 'Customer Phone': '9000000009', 'POS Created At': '22/10/2026', 'Store ID': 'FRIDO_0010', __gross: '2000', __net: '2000', 'Order Type': 'RETAIL', 'Ret/Exc': '-', 'Product Name': 'Frido Test Chair' }];
  const m = computePdp({ startDate: '2026-10-08', cutoff: '2026-10-22', sample: false, limechatRows, salesRows, pdpInv: { recs, hist: {}, meta: { status: 'ok' } }, pdpInvFrom: '2026-10-22' });
  const t = Object.fromEntries(m.text.tickets.map((x) => [x.i, x]));
  assert.deepEqual(Object.keys(t).sort(), ['77001', '77700', '77702', '77703', '77704', '77705']);
  assert.equal(t['77700'].src, 'b'); assert.equal(t['77001'].src, 'l');
  assert.deepEqual(['77700', '77702', '77703', '77704', '77705'].map((k) => [t[k].st, t[k].am]), [['qualified', 1], ['not_reached', 1], ['qualified', 1], ['lost', 1], ['assigned_no_action', 0]]);
  assert.equal(t['77702'].dup, 1); assert.equal(t['77001'].dup, 0);
  assert.deepEqual(m.text.attributed.map((x) => [x.i, x.net]), [['77700', 2000]]);
  const day = m.pinv.recon.days.find((x) => x.d === '2026-10-22');
  assert.deepEqual([day.lcLeads, day.inBigin, day.missing, day.bigin, day.notInExport], [2, 1, 1, 5, 4]);
  const s = JSON.stringify(m); assert.ok(!s.includes('9000000009') && !s.includes('Real Person'));
});

test('turnaround times from stage history: first call, RNR gap, connected → lead form, visit date → stage update', () => {
  const recs = [rec('9', '90009', 'Converted', '2026-10-22T10:00:00+05:30', { p: '9000000009' })];
  const hist = { 9: [['New Enquiry', '2026-10-22T10:00:00+05:30'], ['RNR 1', '2026-10-22T10:10:00+05:30'], ['Connected - In Discussion', '2026-10-22T14:10:00+05:30'], ['Store Visit Scheduled', '2026-10-22T14:20:00+05:30'], ['Converted', '2026-10-24T11:00:00+05:30']] };
  const routedAt = () => Date.parse('2026-10-22T14:40:00+05:30');
  const r = computePdpInv({ recs, hist, cutoff: '2026-10-24', now: NOW, routedOn: () => '2026-10-22', visitOn: () => '2026-10-23', routedAt, storeOf: () => 'FRIDO_0010' });
  const t = r.tickets[0];
  assert.deepEqual([t.tFirst, t.rnrGap, t.tForm, t.visitUpd, t.cHour], [0.2, 4, 0.5, 1, 10]);
  assert.deepEqual([t.vcEver, t.vcH, t.vcTo], [0, null, '']);
});

test('video call: time in Video Call Scheduled and the stage it moved to', () => {
  const recs = [rec('8', '90008', 'Not Interested', '2026-10-22T10:00:00+05:30', { p: '9000000008' })];
  const hist = { 8: [['New Enquiry', '2026-10-22T10:00:00+05:30'], ['Video Call Scheduled', '2026-10-22T11:00:00+05:30'], ['Not Interested', '2026-10-23T17:00:00+05:30']] };
  const t = computePdpInv({ recs, hist, cutoff: '2026-10-24', now: NOW, storeOf: () => 'FRIDO_0010' }).tickets[0];
  assert.deepEqual([t.vcEver, t.vcH, t.vcTo], [1, 30, 'lost']);
});
