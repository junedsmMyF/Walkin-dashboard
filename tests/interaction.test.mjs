// Synthetic data only — never commit real customer rows.
import test from 'node:test'; import assert from 'node:assert/strict';
import { interactionKind, routedKind, standardiseRouting } from '../src/routing.js';
import { buildLeadList } from '../src/leads.js';

test('Interaction type mapping (agreed 27 Oct 2026): case, spaces and punctuation ignored; unknown values flagged', () => {
  for (const v of ['Video Call', 'video call', ' VC ', 'Video', 'Video consultation', 'VC arranged', 'video-call']) assert.equal(interactionKind(v), 'video', v);
  for (const v of ['Store Visit', 'store visit', 'Visit', 'Walk-in', 'Store visit scheduled']) assert.equal(interactionKind(v), 'store', v);
  for (const v of ['', '  ', null, undefined]) assert.equal(interactionKind(v), '');
  assert.equal(interactionKind('Callback'), 'unknown');
  const row = (it) => ({ 'Lead ID': 'L1', 'Submitted at': '10/27/2026 11:00:00', Store: 'X', 'Customer name': 'Real Customer', 'Customer number': '9000000001', 'Product name': 'Chair', 'Product category': 'Chairs', 'Expected visit date': '10/28/2026', 'Expected visit time': '6pm-8pm', 'Discount offered': '', Remarks: '', 'Submitted by': 'Agent A', 'Interaction type': it });
  const { routes } = standardiseRouting([row('Callback'), row('Video Call')]);
  assert.ok(routes[0].flags.includes('interaction_unrecognised'));
  assert.deepEqual([routes[1].itype, routes[1].itypeRaw, routes[1].by], ['video', 'Video Call', 'Agent A']);
});

test('classification order: Interaction type first, blank rows keep the earlier rule; disagreement is a mismatch', () => {
  assert.deepEqual(routedKind({ itype: 'video', video: 0 }), { video: true, by: 'itype', fallback: false, mismatch: true });
  assert.deepEqual(routedKind({ itype: 'store', video: 1 }), { video: false, by: 'itype', fallback: true, mismatch: true });
  assert.deepEqual(routedKind({ itype: 'video', video: 0 }, { biginVideo: true }), { video: true, by: 'itype', fallback: true, mismatch: false });
  assert.deepEqual(routedKind({ itype: 'video', video: 0 }, { otherVideo: true }).mismatch, false); // LimeChat video note agrees
  // blank and unknown: exactly the old rule (remark "video" or Bigin video stage)
  for (const itype of ['', 'unknown']) {
    assert.deepEqual(routedKind({ itype, video: 1 }), { video: true, by: 'fallback', fallback: true, mismatch: false });
    assert.deepEqual(routedKind({ itype, video: 0 }, { biginVideo: true }).video, true);
    assert.deepEqual(routedKind({ itype, video: 0 }).video, false);
  }
});

test('lead list: routed leads carry the classification, the old-rule value, the mismatch and the Bigin cross-check', () => {
  const C = (id, d, phone) => ({ src: 'bigin', id, ts: Date.parse(d + 'T10:00:00Z'), d, phone, valid: true, entry: 'store_widget', store: '' });
  const contacts = [C('1', '2026-10-20', '9000000001'), C('2', '2026-10-27', '9000000002'), C('3', '2026-10-27', '9000000003')];
  const routes = [
    { d: '2026-10-21', phone: '9000000001', vd: '2026-10-22', s: 'FRIDO_0010', video: 1, itype: '', test: 0 },      // before the column: old rule (remark) → video
    { d: '2026-10-27', phone: '9000000002', vd: '2026-10-28', s: 'FRIDO_0010', video: 1, itype: 'store', test: 0 }, // Interaction type says store, remark says video → store, mismatch
    { d: '2026-10-27', phone: '9000000003', vd: '2026-10-28', s: 'FRIDO_0010', video: 0, itype: 'video', test: 0 }, // video, Bigin agrees
  ];
  const LL = buildLeadList({ contacts, routes, videoPhones: new Set(['9000000003']), visitPhones: new Set(['9000000002']) });
  assert.deepEqual(LL.leads.map((l) => [l.id, l.rv, l.rvo, l.rby, l.rmm, l.rbg]), [['1', 1, 1, 'f', 0, ''], ['2', 0, 1, 'i', 1, 's'], ['3', 1, 1, 'i', 0, 'v']]);
});
