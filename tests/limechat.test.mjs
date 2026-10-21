// Synthetic data only — never commit real customer rows.
import test from 'node:test'; import assert from 'node:assert/strict';
import { standardiseLimechat, noteOutcome, coverageGaps, lcTime } from '../src/limechat.js';
import { computePdp } from '../src/pdp.js';

const T = (id, created, o = {}) => ({ 'Ticket ID': id, 'Created At': created, 'Ticket Status': 'closed', 'is_handoff?': 'FALSE', 'is_resolved?': 'TRUE', 'is_outside_working_hours?': 'FALSE',
  'First Assignee Name': '', 'Current Agent': '', 'First Assigned Time': '', 'First Agent Message Time': '', 'Agent Message Blocks': '0', 'Private Notes': '',
  'Level 1 Tags (Main)': 'storewidget', 'System Tags': 'bot, flow_id_11458, store_locator_pincode', 'Last Message Sent By': 'Bot', 'Phone Number': '919000000001', 'Customer Name': 'Test', ...o });

test('dates are DD-MM-YYYY H:MM', () => { assert.equal(lcTime('11-10-2026 8:36').d, '2026-10-11'); assert.equal(lcTime('bad'), null); });

test('notes are standardised; raw text kept; RNR spellings all map to not reached', () => {
  for (const n of ['RnR1', 'RNR1', 'rnr1', 'RnR 2, RnR1', 'Call declined', 'call not responded']) assert.equal(noteOutcome(n), 'not_reached');
  assert.equal(noteOutcome('cx will visit on 17.10.26- uk 8 slippers'), 'routed_store');
  assert.equal(noteOutcome('Cx will be ordering online, will visit on 15.10.26'), 'routed_store');
  assert.equal(noteOutcome('Not Interested., store too far, doea not want VC'), 'lost_not_interested');
  assert.equal(noteOutcome('ordered from amazon'), 'lost_bought_elsewhere');
  assert.equal(noteOutcome('purchased from website'), 'bought_online_d2c');
  assert.equal(noteOutcome('call back post 5pm'), 'followup_pending');
  assert.equal(noteOutcome('Hello Sir'), 'unclassified');
});

test('stage is rebuilt from hand-off, assignee and notes — never from Ticket Status', () => {
  const { tickets } = standardiseLimechat([
    T('1', '08-10-2026 10:00'),                                                                                  // bot only
    T('2', '08-10-2026 11:00', { 'Phone Number': '919000000002', 'is_handoff?': 'TRUE', 'First Assignee Name': 'Agent A', 'Ticket Status': 'closed' }), // closed with no action
    T('3', '08-10-2026 12:00', { 'Phone Number': '919000000003', 'is_handoff?': 'TRUE', 'First Assignee Name': 'Agent A', 'Private Notes': 'will visit this week', 'Level 1 Tags (Main)': 'chat_skycity' }),
    T('4', '08-10-2026 13:00', { 'Phone Number': '919000000004', 'System Tags': 'bot, flow_name_track_order, track_order' }),            // service, not a lead
    T('5', '09-10-2026 13:00', { 'Phone Number': '919000000003', 'Level 1 Tags (Main)': 'ergoluxepdp' }),                               // duplicate phone
    T('6', '09-10-2026 14:00', { 'Phone Number': '9.20E+11', 'Customer Name': '9.20E+11', 'First Assignee Name': 'Agent B', 'Ticket Status': 'bot' }),
  ], { cutoff: '2026-10-12' });
  const by = Object.fromEntries(tickets.map((x) => [x.id, x]));
  assert.equal(by[1].stage, 'bot_only');
  assert.equal(by[2].stage, 'assigned_no_action'); assert.ok(by[2].flags.includes('closed_without_action')); assert.equal(by[2].status, 'closed');
  assert.equal(by[3].stage, 'qualified'); assert.equal(by[3].oc, 'routed_store'); assert.equal(by[3].store, 'FRIDO_0010'); assert.equal(by[3].note, 'will visit this week');
  assert.equal(by[4].stage, 'service');
  assert.equal(by[5].dup, 1); assert.equal(by[5].pdp, 'ErgoLuxe chair');
  assert.ok(by[6].flags.includes('invalid_phone') && by[6].flags.includes('junk_name') && by[6].flags.includes('assigned_without_handoff') && by[6].flags.includes('assigned_but_bot_status'));
});

test('export gaps are detected', () => {
  const { tickets } = standardiseLimechat(['01', '02', '03'].flatMap((d) => [1, 2, 3].map((k) => T(d + k, `${d}-09-2026 10:0${k}`, { 'Phone Number': '91900000' + d + '00' + k }))).concat([1, 2, 3].map((k) => T('9' + k, `10-09-2026 10:0${k}`, { 'Phone Number': '9190000099' + k + '0' }))));
  assert.deepEqual(coverageGaps(tickets).map((g) => [g.from, g.to]), [['2026-09-04', '2026-09-09']]);
});

test('LimeChat leads match DevX orders by phone on/after the chat date; payload has no phones or names', () => {
  const sale = (id, p, d, emp, type) => ({ 'POS Order ID': id, 'Customer Phone': p, 'POS Created At': d, 'Store ID': 'FRIDO_0010', __gross: '2000', __net: '1800', 'Order Type': type, 'Ret/Exc': '-', 'Product Name': 'Frido Test Chair', 'Employee Name': emp });
  const m = computePdp({ startDate: '2026-10-08', cutoff: '2026-10-12', sample: false,
    limechatRows: [T('3', '08-10-2026 12:00', { 'Phone Number': '919000000003', 'is_handoff?': 'TRUE', 'First Assignee Name': 'Agent A', 'Private Notes': 'VC done', 'Customer Name': 'Real Person' , 'Level 1 Tags (Main)': 'storewidget' })],
    salesRows: [sale('A', '9000000003', '07/10/2026', 'Staff', 'RETAIL'), sale('B', '9000000003', '09/10/2026', 'Agent A', 'ONLINE')] });
  assert.deepEqual(m.text.attributed.map((x) => [x.d, x.net, x.path, x.ag, x.entry]), [['2026-10-09', 1800, 'video', 'Agent A', 'store_widget']]);
  const s = JSON.stringify(m); assert.ok(!s.includes('9000000003') && !s.includes('Real Person'));
});

test('new export format (ISO dates, True/False) parses; consumed = agent reply by time or message blocks', () => {
  assert.deepEqual(lcTime('2026-10-14 18:42:17'), { d: '2026-10-14', t: Date.UTC(2026, 9, 14, 18, 42, 17) });
  assert.equal(lcTime('14-10-2026 18:42').d, '2026-10-14');
  const { tickets } = standardiseLimechat([
    T('1', '2026-10-14 10:00:00', { 'Phone Number': '919000000001', 'is_handoff?': 'True', 'First Assignee Name': 'Agent A', 'First Agent Message Time': '2026-10-14 10:30:00', 'Agent Message Blocks': '2' }),
    T('2', '2026-10-14 11:00:00', { 'Phone Number': '919000000002', 'is_handoff?': 'True', 'First Assignee Name': 'Agent A', 'Agent Message Blocks': '1' }),
    T('3', '2026-10-14 12:00:00', { 'Phone Number': '919000000003', 'is_handoff?': 'True', 'First Assignee Name': 'Agent A', 'Agent Message Blocks': '0', 'Private Notes': 'RNR1' }),
  ]);
  assert.deepEqual(tickets.map((x) => [x.am, x.ho, x.minsToReply, x.flags.includes('reply_time_missing')]), [[true, true, 30, false], [true, true, null, true], [false, true, null, false]]);
});
