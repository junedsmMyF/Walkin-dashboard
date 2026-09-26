// Synthetic data only — never commit real customer rows.
import test from 'node:test'; import assert from 'node:assert/strict';
import { computeMetrics } from '../src/metrics.js';
import { parseCsv } from '../src/csv.js';

const lead = (p, d, loc, st = 'Yet to Call') => ({ p: '+91' + p, d: d + 'T12:00:00+05:30', loc, own: '', st, amt: 1000 });
const sale = (id, p, d, store, paid, extra = {}) => ({ 'POS Order ID': id, 'Customer Phone': p, 'POS Created At': d, 'Store ID': store, 'Amount Paid': String(paid), 'Return Amount': '0', 'Order Type': 'RETAIL', 'Ret/Exc': '-', ...extra });
const dsr = (store, d, ts, nw, ow) => ({ Store: store, Date: d, Timestamp: ts, 'New Walk-ins': String(nw), 'Other Walk-ins': String(ow) });
const run = (x) => computeMetrics({ startDate: '2026-09-01', cutoff: '2026-09-30', ...x });

test('attribution: order strictly after lead date, credited to billing store', () => {
  const m = run({
    leads: [lead('9000000001', '2026-09-02', 'Kopa Mall Mundhwa Rd Pune')],
    salesRows: [sale('A', '919000000001', '9/2/2026', 'FRIDO_0008', 500), sale('B', '9000000001', '9/5/2026', 'FRIDO_0001', 2000)],
  });
  assert.equal(m.attributed.length, 1);
  assert.deepEqual([m.attributed[0].s, m.attributed[0].cs, m.attributed[0].gross], ['FRIDO_0001', 'FRIDO_0008', 2000]);
});
test('captured excludes same-day buyers; same-day orders counted at the store', () => {
  const m = run({ leads: [lead('9000000001', '2026-09-02', 'Kopa Mall Mundhwa Rd Pune'), lead('9000000002', '2026-09-02', 'Kopa Mall Mundhwa Rd Pune'), lead('9000000002', '2026-09-02', 'KOPA MALL Store')],
    salesRows: [sale('A', '9000000001', '9/2/2026', 'FRIDO_0008', 500)] });
  const d = m.daily.find((x) => x.s === 'FRIDO_0008' && x.d === '2026-09-02');
  assert.equal(d.captured, 1); assert.equal(d.sameDay, 1);
});
test('net = paid − returns; cancelled lines dropped; test store excluded', () => {
  const m = run({ leads: [lead('9000000001', '2026-09-01', 'Kopa Mall Mundhwa Rd Pune')], salesRows: [
    sale('B', '9000000001', '9/3/2026', 'FRIDO_0008', 1000, { 'Return Amount': '200' }),
    sale('B', '9000000001', '9/3/2026', 'FRIDO_0008', 700, { 'Ret/Exc': 'CANCELLED' }),
    sale('C', '9000000001', '9/4/2026', 'FRIDO_0000', 999)] });
  assert.equal(m.attributed.length, 1); assert.equal(m.attributed[0].net, 800); assert.equal(m.attributed[0].gross, 1000);
});
test('DSR: latest submission per store per date wins, even if zero; New + Other', () => {
  const m = run({ dsrRows: [dsr('Kopa Mall, Ghorpadi, KP', '2026-09-03', '03/09/2026 20:00:00', 30, 5), dsr('Kopa Mall, Ghorpadi, KP', '2026-09-03', '03/09/2026 21:00:00', 0, 0), dsr('Kopa Mall, Ghorpadi, KP', '03/09/2026', '02/09/2026 09:00:00', 99, 1)] });
  assert.equal(m.daily.find((x) => x.s === 'FRIDO_0008' && x.d === '2026-09-03').walkins, 0);
});
test('payload has no phone numbers', () => {
  const m = run({ leads: [lead('9876543210', '2026-09-02', 'Kopa Mall Mundhwa Rd Pune')], salesRows: [sale('A', '9876543210', '9/9/2026', 'FRIDO_0008', 100)] });
  assert.ok(!JSON.stringify(m).includes('9876543210'));
});
test('CSV parser handles quotes and commas', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","he said ""hi"""\n'), [{ a: 'x, y', b: 'he said "hi"' }]);
});
