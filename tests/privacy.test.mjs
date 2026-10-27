// Audit task 5 (27 Oct 2026): the app shell is only served after sign-in; nothing is indexed or shared-cached.
import test from 'node:test'; import assert from 'node:assert/strict';
import worker from '../src/index.js';

const SHELL = '<!doctype html><title>Founders Office Dashboard</title><script>/* KPI rules */</script>';
const envOf = (extra = {}) => ({
  DASH_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  ASSETS: { fetch: async () => new Response(SHELL, { headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=0, must-revalidate' } }) },
  ...extra,
});
const get = (path, env) => worker.fetch(new Request('https://fo.example' + path), env, { waitUntil() {} });

test('signed out (sign-in on): no app shell — a tiny page that sends the visitor to /login with the deep link', async () => {
  const r = await get('/', envOf({ LOGIN: 'on' })); const body = await r.text();
  assert.equal(r.status, 200);
  assert.ok(!body.includes('KPI rules') && !body.includes('Founders Office Dashboard'));
  assert.match(body, /location\.replace\("\/login" \+ '\?next=' \+ encodeURIComponent\(location\.hash/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('signed in / sign-in off: the shell, never stored in a shared cache', async () => {
  const r = await get('/', envOf()); assert.equal(await r.text(), SHELL);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.match(r.headers.get('vary') || '', /Cookie/);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('robots.txt disallows everything; every response carries X-Robots-Tag', async () => {
  const r = await get('/robots.txt', envOf({ LOGIN: 'on' }));
  assert.equal(await r.text(), 'User-agent: *\nDisallow: /\n');
  for (const p of ['/robots.txt', '/api/me', '/login', '/api/pdp']) assert.equal((await get(p, envOf({ LOGIN: 'on' }))).headers.get('x-robots-tag'), 'noindex, nofollow', p);
  assert.equal((await get('/api/pdp', envOf({ LOGIN: 'on' }))).status, 401); // APIs unchanged: still need sign-in
});
