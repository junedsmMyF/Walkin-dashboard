// Meta ads: Lead Gen rows from Bigin, sample layer, and no PII in the output. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMeta, leadGenRow, parseAd, orderIdOf, sampleCtwa } from '../src/meta.js';

const rec = (o) => ({ i: '1371203000000999001', st: 'Yet to Call', ct: '2026-10-05T10:00:00+05:30', ps: 'Hadapsar — Amanora Mall', city: 'Pune', p: '+919999999999', lr: '', cw: '', uc: '', ux: '', ...o });

test('flags follow the strict funnel', () => {
  assert.equal(leadGenRow(rec({})).consumed, false);
  const fus = leadGenRow(rec({ st: 'Follow-up Scheduled' }));
  assert.deepEqual([fus.consumed, fus.connected, fus.vsched, fus.visited], [true, true, false, false]);
  const sold = leadGenRow(rec({ st: 'Service Completed & Sold', cw: 'order MF0223682776 done' }));
  assert.equal(sold.won, true); assert.equal(sold.visited, false, 'a sale never implies a visit');
  assert.equal(sold.orderId, 'MF0223682776');
  assert.equal(leadGenRow(rec({ st: 'Cx Visited Store' })).visited, true);
  assert.equal(leadGenRow(rec({ st: 'Not Interested', lr: 'Out of Budget' })).connected, true);
  assert.equal(leadGenRow(rec({ st: 'Not Interested', lr: 'Not responding after 4 attempts' })).connected, false);
});

test('duplicates, tests and test UTMs are junk', () => {
  assert.equal(leadGenRow(rec({ st: 'Not Interested', lr: 'Duplicate Lead' })).junk, true);
  assert.equal(leadGenRow(rec({ st: 'Not Interested', lr: 'Test Lead' })).junk, true);
  assert.equal(leadGenRow(rec({ ux: 'claude_verify', uc: 'e2e_test_0915' })).junk, true);
  assert.equal(leadGenRow(rec({})).junk, false);
});

test('city comes from the preferred store; unknown store stays in totals', () => {
  const g = leadGenRow(rec({ ps: 'Gurugram — Felix Plaza, Sector 82A', city: 'Pune' }));
  assert.deepEqual([g.city, g.store, g.storeId], ['Delhi NCR', 'Felix Plaza, Gurugram', 'FRIDO_0021']);
  const u = leadGenRow(rec({ ps: '', city: 'Mumbai' }));
  assert.deepEqual([u.city, u.store], ['Mumbai', null]);
});

test('ad name parsing', () => {
  assert.equal(parseAd('MyFrido-LeadGen__CID04__ASID02__3828-V2__SHB__Vatsal__10092026__WebsiteLeadGen__ErgoAssessment__Marathi__BOM/PNQ__Video__Inhouse').ad, 'ASID02 · 3828-V2 · Marathi · BOM/PNQ');
  assert.equal(parseAd('').ad, 'Unattributed (no UTM)');
  assert.equal(orderIdOf('Ravi paid cash'), null, 'free text never passes through');
});

test('output carries no names or phones and respects the date window', () => {
  const m = computeMeta({ leads: [rec({ Deal_Name: 'Some Name' }), rec({ i: '2', ct: '2026-09-01T10:00:00+05:30' })], startDate: '2026-09-09', cutoff: '2026-10-10' });
  const lg = m.leads.filter((x) => x.type === 'leadgen');
  assert.equal(lg.length, 1);
  const s = JSON.stringify(m);
  assert.ok(!s.includes('9999999999') && !s.includes('Some Name'));
  assert.ok(m.leads.filter((x) => x.type === 'ctwa').every((x) => x.sample));
});

test('sample CTWA is stable day by day', () => {
  const a = sampleCtwa('2026-09-09', '2026-09-20'), b = sampleCtwa('2026-09-09', '2026-09-25');
  assert.deepEqual(a, b.filter((x) => x.created <= '2026-09-20'));
});
