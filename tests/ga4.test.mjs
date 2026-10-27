// Synthetic rows only — no real analytics or customer data.
import test from 'node:test'; import assert from 'node:assert/strict';
import { ga4ToPdp, pdpAnalytics } from '../src/ga4.js';

const row = (date, product_handle, cta_name, count, extra = {}) => ({ date, product_handle, cta_name, count: String(count), ...extra });

test('rows by date × handle × CTA become the page shape (views, lead clicks = WhatsApp + Call)', () => {
  const out = ga4ToPdp([
    row('20261020', 'frido-test-chair', 'pdp_view', 100, { product_name: 'Test Chair', category: 'Chairs' }),
    row('2026-10-20', 'https://myfrido.com/products/frido-test-chair?v=1', 'WhatsApp', 3),
    row('2026-10-20', 'frido-test-chair', 'call-store', 2),
    row('2026-10-21', 'frido-test-cushion', 'page_view', 40),
  ], { from: '2026-10-08', to: '2026-10-26' });
  assert.equal(out.isSample, false);
  assert.deepEqual(out.pdps, [{ n: 'Test Chair', c: 'Chairs', h: 'frido-test-chair' }, { n: 'Frido Test Cushion', c: 'Unmapped', h: 'frido-test-cushion' }]);
  assert.deepEqual(out.pdpDaily, [
    { d: '2026-10-20', p: 0, views: 100, clicks: 5, wa: 3, call: 2 },
    { d: '2026-10-21', p: 1, views: 40, clicks: 0, wa: 0, call: 0 },
  ]);
  assert.equal(out.from, '2026-10-20'); assert.equal(out.to, '2026-10-21');
});

test('Get Direction is left out; unknown CTA names are counted, never guessed; bad rows and out-of-range dates skipped', () => {
  const out = ga4ToPdp([
    row('2026-10-20', 'frido-test-chair', 'Get Direction', 9),
    row('2026-10-20', 'frido-test-chair', 'book_demo', 4),
    row('2026-10-20', 'frido-test-chair', '', 1),
    row('not a date', 'frido-test-chair', 'pdp_view', 5),
    row('2026-10-20', '', 'pdp_view', 5),
    row('2026-10-20', 'frido-test-chair', 'pdp_view', -1),
    row('2026-10-01', 'frido-test-chair', 'pdp_view', 7),
  ], { from: '2026-10-08', to: '2026-10-26' });
  assert.deepEqual(out.pdpDaily, []);
  assert.deepEqual(out.unknownCtas, { book_demo: 4, '(blank)': 1 });
  assert.equal(out.skipped, 3);
});

test('adapter: no secret = not connected (sample stays); rows = live; none in range = empty; failure = error', async () => {
  const range = { from: '2026-10-08', to: '2026-10-26' };
  assert.deepEqual(await pdpAnalytics({}, async () => { throw new Error('must not be called'); }, range), { status: 'not_connected' });
  const env = { GA4_PDP_CSV_URL: 'https://example.invalid/ga4.csv' };
  assert.equal((await pdpAnalytics(env, async () => [row('2026-10-20', 'frido-test-chair', 'pdp_view', 10)], range)).status, 'live');
  assert.equal((await pdpAnalytics(env, async () => [], range)).status, 'empty');
  const e = await pdpAnalytics(env, async () => { throw new Error('Google returned 404'); }, range);
  assert.equal(e.status, 'error'); assert.match(e.error, /404/);
});
