// Retail retention (Retail Revenue) — offer broadcast to existing retail customers → retail store order.
// Flow: offer (e.g. Diwali) → retention team sends creatives → campaign flow built on LimeChat → broadcast to
// existing retail customers → DevX order at a Frido store on/after that customer's run date. Returns PII-free rows only.
//
// Sources
//   Broadcasts : LimeChat broadcast report (secret RETENTION_CSV_URL) — not connected yet → SAMPLE (seeded, stable), flagged sample.
//   Orders     : BigQuery retail sales already in this Worker (same orders as walk-in and PDP), phone match.
//   Other touches (for last-touch): walk-in leads (Bigin), PDP call leads (Callback Requests), PDP WhatsApp (LimeChat), Meta Lead Gen.
//
// Rules (agreed with Saiyed 22 Oct 2026, pending owner sign-off):
//   Eligible    = only recipients whose message was Delivered AND Read can be credited with an order,
//                 and only if it was read BEFORE the order (Read At ≤ order time, Saiyed 22 Oct). If the export has no
//                 Read At column, read status alone is used and the dashboard says so (readTimes = false).
//   Spend       = ₹0.85 × delivered messages. ROAS = revenue ÷ spend. Conversion = orders ÷ delivered.
//   Window      = order on/after the customer's run date and within 60 days of it (day 0 … day 60).
//   Orders      = billed at a Frido retail store (store master id; test store excluded), any order type incl. ONLINE punch-ins.
//   Credit      = most recent touch before the order wins: retention broadcast, walk-in lead, PDP lead or Meta lead.
//                 Two campaigns in window → the later run date wins. Same-day tie with a lead → the lead wins (customer reached out).
//                 Walk-in touch counts only strictly before the order (walk-in leads are captured after a purchase).
//   Recipient   = unique phone per campaign; repeat rows for the same phone in a campaign are duplicates.
//   Revenue     = Total Revenue (gross − discount), as walk-in and PDP.
import { STORE_MASTER, EXCLUDED_STORE_IDS } from './stores.js';
import { categoryOf } from './categories.js';
import { salesDate, biginDate, daysBetween, phone10, addDays } from './dates.js';

export const WINDOW_DAYS = 60;
export const COST_PER_DELIVERED = 0.85; // ₹ per delivered WhatsApp message
// The LimeChat export has no broadcast name: one broadcast per send date. Names for the known runs (add new ones here).
export const BROADCAST_NAMES = { '2026-09-16': 'Retail_Retention_Ganpati', '2026-09-18': 'Retail_Retention_Ganpati_2', '2026-09-26': 'Retail_Retention_Ganpati_3' };
const STORE_IDS = new Set(STORE_MASTER.map((s) => s.id));
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : 0; };
// "2026-09-16 08:46:12" · "2026-09-16T08:46" · "16/09/2026 8:46 PM" · "16/09/2026" → "YYYY-MM-DD HH:MM" (or "YYYY-MM-DD" with no time). IST as given.
export function stamp(v) {
  const t = String(v ?? '').trim(); if (!t || t === '-') return null;
  const d = salesDate(t) || biginDate(t); if (!d) return null;
  const m = t.match(/[ T](\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/); if (!m) return d;
  let h = +m[1]; if (m[3]) { const pm = /p/i.test(m[3]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  return `${d} ${String(h).padStart(2, '0')}:${m[2]}`;
}
// read before (or at) the order: compare times when both have one, else compare dates
export const readBefore = (readAt, orderTs) => (readAt.length > 10 && orderTs.length > 10 ? readAt <= orderTs : readAt.slice(0, 10) <= orderTs.slice(0, 10));

// ---------- Orders: one per POS Order ID, Frido retail stores only (same build as PDP) ----------
export function storeOrders(salesRows) {
  const orders = new Map();
  for (const r of salesRows) {
    if (String(r['Ret/Exc'] || '').trim().toUpperCase() === 'CANCELLED') continue;
    const store = (r['Store ID'] || '').trim(); if (!STORE_IDS.has(store) || EXCLUDED_STORE_IDS.has(store)) continue;
    const date = salesDate(r['POS Created At']) || salesDate(r['Shopify Created At']); if (!date) continue;
    const id = r['POS Order ID'] || r['Shopify Order ID']; if (!id) continue;
    let o = orders.get(id);
    if (!o) { o = { id, date, ts: stamp(r['POS Created At']) || stamp(r['Shopify Created At']) || date, store, phone: phone10(r['Customer Phone']), type: (r['Order Type'] || '').toUpperCase() || 'RETAIL', net: 0, gross: 0, lines: [] }; orders.set(id, o); }
    const g = r.__gross != null ? num(r.__gross) : num(r['Amount Paid']);
    const n = r.__net != null ? num(r.__net) : g - num(r['Return Amount']);
    o.gross += g; o.net += n; o.lines.push({ p: String(r['Product Name'] || '(no product name)').trim(), net: n, gross: g, qty: num(r['Quantity']) || 1 });
  }
  return [...orders.values()];
}

// ---------- LimeChat broadcast report → recipient rows (header names vary by export; matched loosely) ----------
const H = {
  campaign: ['broadcast name', 'campaign name', 'campaign', 'broadcast', 'template name'],
  run: ['run date', 'sent at', 'sent time', 'scheduled at', 'created at', 'date'],
  phone: ['phone number', 'phone', 'mobile', 'customer phone', 'to', 'recipient'],
  status: ['message status', 'status', 'delivery status'],
  delivered: ['delivered at', 'delivered'], read: ['read status', 'read', 'seen'], readAt: ['read at', 'read time', 'read timestamp', 'seen at', 'read on'],
  replied: ['form input replies', 'replied', 'replied at', 'reply', 'responded'], clicked: ['button clicks', 'button clicked', 'clicked', 'cta clicked', 'message link clicks', 'link clicked'],
  error: ['error', 'failure reason', 'error message'],
};
// "{'data': {... 'reason': 'Per-user messaging rate limit', ...}}" → "Per-user messaging rate limit"
export const failReason = (e) => { const s = String(e || '').trim(); if (!s || s === '-') return ''; const m = s.match(/'reason':\s*'([^']+)'/) || s.match(/"error":"([^"]+)"/); return (m ? m[1] : s).slice(0, 80); };
const yes = (v) => { const s = String(v ?? '').trim().toLowerCase(); return !!s && !['0', 'false', 'no', 'n', '-', 'null', 'none'].includes(s); };
export function parseBroadcastRows(rows) {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]); const lower = new Map(keys.map((k) => [k.trim().toLowerCase(), k]));
  const col = (names) => { for (const n of names) if (lower.has(n)) return lower.get(n); return null; };
  const c = Object.fromEntries(Object.entries(H).map(([k, v]) => [k, col(v)]));
  return rows.map((r) => {
    const st = String(r[c.status] || '').trim().toLowerCase();
    const rs = String(r[c.read] ?? '').trim().toLowerCase();
    const readAt = c.readAt ? stamp(r[c.readAt]) : null;
    const read = /^read\b/.test(st) || (!/^(not|un|no)\b/.test(rs) && yes(rs)) || !!readAt;
    const delivered = read || /deliver/.test(st) || yes(r[c.delivered]);
    const failed = /fail|error|undeliver|reject/.test(st) && !delivered;
    const run = salesDate(r[c.run]) || biginDate(r[c.run]);
    const named = String(r[c.campaign] || '').trim();
    return { campaign: named || BROADCAST_NAMES[run] || (run ? 'Broadcast · ' + run : '(no date)'), run, phone: phone10(r[c.phone]),
      failed, sent: !failed, delivered, read, readAt, replied: yes(r[c.replied]), clicked: yes(r[c.clicked]), reason: failed ? failReason(r[c.error]) || 'No reason given' : '' };
  });
}

// ---------- Engine ----------
// broadcasts: [{campaign, run, phone, failed, delivered, read, replied, clicked}]
// touches   : [{phone, d, src: 'walkin'|'pdp_call'|'pdp_text'|'meta'}]
export function computeRetention({ broadcasts = [], orders = [], touches = [], cutoff, windowDays = WINDOW_DAYS }) {
  const quality = { noPhone: 0, badPhone: 0, noRunDate: 0, duplicates: 0, futureRun: 0, readNoTime: 0 };
  const readTimes = broadcasts.some((b) => b.readAt); // export carries Read At → enforce read before order
  // Recipients: first row per (campaign, phone); a later row upgrades the delivery flags (resends).
  const rec = new Map();
  for (const b of broadcasts) {
    if (!b.phone) { quality.noPhone++; continue; }
    if (!/^[6-9]/.test(b.phone)) quality.badPhone++;
    if (!b.run) { quality.noRunDate++; continue; }
    if (b.run > cutoff) { quality.futureRun++; continue; }
    const k = b.campaign + '|' + b.phone; const x = rec.get(k);
    if (!x) { rec.set(k, { ...b }); continue; }
    quality.duplicates++;
    if (b.run < x.run) x.run = b.run;
    for (const f of ['sent', 'delivered', 'read', 'replied', 'clicked']) x[f] = x[f] || b[f];
    if (b.readAt && (!x.readAt || b.readAt < x.readAt)) x.readAt = b.readAt;
    x.failed = x.failed && b.failed; if (!x.failed) x.reason = '';
  }
  const recipients = [...rec.values()];
  if (readTimes) quality.readNoTime = recipients.filter((r) => r.read && !r.readAt).length;

  const byPhone = new Map();
  for (const o of orders) if (o.phone) (byPhone.get(o.phone) || byPhone.set(o.phone, []).get(o.phone)).push(o);
  for (const a of byPhone.values()) a.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  const touchBy = new Map();
  for (const t of touches) if (t.phone && t.d) (touchBy.get(t.phone) || touchBy.set(t.phone, []).get(t.phone)).push(t);

  // Home store = store of the customer's last order before the run date (for store-level views).
  const homeOf = (p, run) => { let h = null; for (const o of byPhone.get(p) || []) { if (o.date >= run) break; h = o.store; } return h; };

  // Campaign index: id per campaign name, in run-date order.
  const camps = new Map();
  for (const r of recipients) { const c = camps.get(r.campaign) || { name: r.campaign, first: r.run, last: r.run, waves: new Map() }; if (r.run < c.first) c.first = r.run; if (r.run > c.last) c.last = r.run; c.waves.set(r.run, (c.waves.get(r.run) || 0) + 1); camps.set(r.campaign, c); }
  const campList = [...camps.values()].sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : a.name.localeCompare(b.name)));
  const cid = new Map(campList.map((c, i) => [c.name, i]));

  // Every in-window store order of a recipient → candidate (campaign, run). Pick the most recent touch.
  const recByPhone = new Map();
  for (const r of recipients) (recByPhone.get(r.phone) || recByPhone.set(r.phone, []).get(r.phone)).push(r);
  const credited = []; const lostTo = []; const lines = []; const late = [];
  const pIdx = new Map(); const pNames = []; const pid = (n) => { if (!pIdx.has(n)) { pIdx.set(n, pNames.length); pNames.push(n); } return pIdx.get(n); };
  const buyer = new Set(); // campaign|phone with a credited order
  for (const [p, rs] of recByPhone) {
    for (const o of byPhone.get(p) || []) {
      if (o.date > cutoff) continue;
      const inWin = rs.filter((r) => r.delivered && r.read && o.date >= r.run && daysBetween(r.run, o.date) <= windowDays); // read leads only
      const live = readTimes ? inWin.filter((r) => r.readAt && readBefore(r.readAt, o.ts || o.date)) : inWin; // …read before the order
      if (!live.length) { if (inWin.length) { const r0 = inWin.reduce((a, b) => (b.run > a.run ? b : a)); late.push({ o: o.id, d: o.date, run: r0.run, c: cid.get(r0.campaign), s: o.store, net: Math.round(o.net), gross: Math.round(o.gross), noTime: r0.readAt ? 0 : 1 }); } continue; }
      const camp = live.reduce((a, b) => (b.run > a.run ? b : a));
      const rival = (touchBy.get(p) || []).filter((t) => (t.src === 'walkin' ? t.d < o.date : t.d <= o.date)).reduce((a, b) => (!a || b.d > a.d ? b : a), null);
      const row = { o: o.id, d: o.date, run: camp.run, c: cid.get(camp.campaign), s: o.store, hs: homeOf(p, camp.run) || '', t: o.type, net: Math.round(o.net), gross: Math.round(o.gross), lag: daysBetween(camp.run, o.date), rep: camp.replied ? 1 : 0, qty: o.lines.reduce((t, l) => t + l.qty, 0) };
      if (rival && rival.d >= camp.run) { lostTo.push({ ...row, to: rival.src, td: rival.d }); continue; }
      row.first = buyer.has(camp.campaign + '|' + p) ? 0 : 1; buyer.add(camp.campaign + '|' + p);
      row.prior = rival ? rival.src : ''; // customer also had an older lead (credit stays with retention)
      credited.push(row);
      for (const ln of o.lines) lines.push({ o: o.id, c: row.c, d: o.date, s: o.store, p: pid(ln.p), cat: categoryOf(ln.p), net: Math.round(ln.net), gross: Math.round(ln.gross ?? ln.net), qty: ln.qty });
    }
  }

  // Recipient aggregates per campaign × run date × home store (no phones leave the Worker).
  const agg = new Map();
  for (const r of recipients) {
    const hs = homeOf(r.phone, r.run) || '';
    const k = [cid.get(r.campaign), r.run, hs].join('|');
    const a = agg.get(k) || { c: cid.get(r.campaign), run: r.run, hs, n: 0, sent: 0, failed: 0, del: 0, read: 0, rep: 0, clk: 0, buy: 0, repBuy: 0 };
    a.n++; a.sent += r.failed ? 0 : 1; a.failed += r.failed ? 1 : 0; a.del += r.delivered ? 1 : 0; a.read += r.read ? 1 : 0; a.rep += r.replied ? 1 : 0; a.clk += r.clicked ? 1 : 0;
    if (buyer.has(r.campaign + '|' + r.phone)) { a.buy++; if (r.replied) a.repBuy++; }
    agg.set(k, a);
  }

  // Failure reasons per campaign × run date
  const fails = new Map();
  for (const r of recipients) if (r.failed) { const why = r.reason || 'No reason given'; const k = [cid.get(r.campaign), r.run, why].join('|'); const f = fails.get(k) || { c: cid.get(r.campaign), run: r.run, why, n: 0 }; f.n++; fails.set(k, f); }
  const stores = STORE_MASTER.map((s) => ({ id: s.id, name: s.name, city: s.city, format: s.format }));
  return {
    cutoff, windowDays, costPerDelivered: COST_PER_DELIVERED, fails: [...fails.values()], generatedAt: new Date().toISOString(),
    campaigns: campList.map((c, i) => ({ i, name: c.name, first: c.first, last: c.last, waves: [...c.waves.entries()].sort().map(([d, n]) => ({ d, n })), closes: addDays(c.last, windowDays), open: addDays(c.last, windowDays) > cutoff ? 1 : 0 })),
    recipients: [...agg.values()], credited, lostTo, late, readTimes, lines, pnames: pNames, stores,
    quality: { ...quality, recipients: recipients.length, rows: broadcasts.length },
    rules: { eligible: readTimes ? 'Delivered and read before the order' : 'Delivered and read (no read time in export)', spend: `₹${COST_PER_DELIVERED} × delivered`, window: `Order on/after run date, within ${windowDays} days`, orders: 'Billed at a Frido retail store, same phone', credit: 'Most recent touch wins (broadcast, walk-in, PDP, Meta)', revenue: 'Total Revenue = gross − discount' },
  };
}

// ---------- SAMPLE layer — synthetic customers, broadcasts, orders and rival touches, run through the same engine ----------
const seed = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x6D2B79F5) >>> 0; return (h >>> 8) / 16777216; }; };
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
// Campaign name, waves [run date, share of the base], base size, reply rate, buy rate among delivered
export const SAMPLE_CAMPAIGNS = [
  ['Onam offer', [['2026-09-02', 1]], 5200, 0.05, 0.018],
  ['Ganesh Chaturthi offer', [['2026-09-12', 1]], 5600, 0.06, 0.022],
  ['Navratri offer', [['2026-10-09', 0.6], ['2026-10-11', 0.4]], 6100, 0.07, 0.026],
  ['Diwali exclusive offer', [['2026-10-16', 0.55], ['2026-10-19', 0.45]], 6800, 0.09, 0.034],
];
const PRODUCTS = [['Frido 3D Posture Plus Ergonomic Chair', 21990], ['Frido Ultimate Mattress Topper', 9990], ['Frido Ultimate Pro Seat Cushion', 2490], ['Frido Cloud Comfort Arch Support Slippers', 1490], ['Frido Dual Gel Pro Insoles', 1290], ['Frido Travel Neck Pillow', 1190], ['Frido Ergoluxe Electric Standing Desk', 32990], ['Frido Orthotics Posture Corrector Pro', 1990]];
export function sampleInputs(cutoff) {
  const r = seed('ret|customers'); const N = 7400;
  const storeIds = STORE_MASTER.map((s) => s.id);
  const custs = []; const orders = []; const touches = [];
  for (let i = 0; i < N; i++) {
    const phone = '90000' + String(10000 + i).slice(-5); // synthetic, never a real number
    const home = storeIds[Math.floor(Math.pow(r(), 1.6) * storeIds.length)];
    const past = addDays('2026-07-31', -Math.floor(r() * 420));
    custs.push({ phone, home, past });
    const [p, price] = pick(r, PRODUCTS);
    orders.push({ id: 'S-H' + i, date: past, store: home, phone, type: 'RETAIL', net: price, gross: price, lines: [{ p, net: price, qty: 1 }] });
    if (r() < 0.55) touches.push({ phone, d: addDays(past, -Math.floor(r() * 3)), src: 'walkin' });
  }
  const broadcasts = []; let k = 0;
  for (const [name, waves, base, repRate, buyRate] of SAMPLE_CAMPAIGNS) {
    if (waves[0][0] > cutoff) continue;
    const rc = seed('ret|' + name); const pool = custs.filter((c) => c.past < waves[0][0]).slice(0, base);
    pool.forEach((c, j) => {
      let w = 0, cum = waves[0][1]; while (w < waves.length - 1 && j >= cum * pool.length) cum += waves[++w][1];
      const run = waves[w][0]; if (run > cutoff) return;
      const failed = rc() < 0.06, delivered = !failed && rc() < 0.97, read = delivered && rc() < 0.62, readAt = read ? `${addDays(run, Math.floor(-Math.log(1 - rc() * 0.95) * 1.5))} ${String(8 + Math.floor(rc() * 14)).padStart(2, '0')}:${String(Math.floor(rc() * 60)).padStart(2, '0')}` : null, replied = read && rc() < repRate / 0.62 * 1.1, clicked = read && rc() < 0.18;
      const reason = failed ? pick(rc, ['Per-user messaging rate limit', 'Per-user messaging rate limit', 'Per-user messaging rate limit', 'Invalid Recipient', 'Message type not permitted or Invalid Receipient']) : '';
      broadcasts.push({ campaign: name, run, phone: c.phone, failed, sent: !failed, delivered, read, readAt, replied, clicked, reason });
      if (rc() < 0.02) broadcasts.push({ campaign: name, run, phone: c.phone, failed, sent: !failed, delivered, read, readAt, replied: false, clicked: false, reason }); // resend → duplicate
      if (!delivered) return;
      const pBuy = buyRate * (replied ? 4 : read ? 1.4 : 0.4);
      if (rc() < pBuy) {
        const lag = Math.min(WINDOW_DAYS, Math.floor(-Math.log(1 - rc() * 0.98) * 9)); const d = addDays(run, lag);
        const store = rc() < 0.82 ? c.home : pick(rc, storeIds);
        const n = rc() < 0.2 ? 2 : 1; const lines = []; for (let q = 0; q < n; q++) { const [p, price] = pick(rc, PRODUCTS); const net = Math.round(price * (0.8 + rc() * 0.12)); lines.push({ p, net, gross: price, qty: 1 }); }
        const net = lines.reduce((s, x) => s + x.net, 0);
        orders.push({ id: 'S-R' + (++k), date: d, ts: `${d} ${String(10 + Math.floor(rc() * 11)).padStart(2, '0')}:00`, store, phone: c.phone, type: rc() < 0.08 ? 'ONLINE' : 'RETAIL', net, gross: lines.reduce((t, l) => t + l.gross, 0), lines });
        if (rc() < 0.07) touches.push({ phone: c.phone, d: addDays(run, Math.floor(rc() * Math.max(1, lag))), src: pick(rc, ['pdp_call', 'pdp_text', 'walkin', 'meta']) });
      }
      if (rc() < 0.004) { const d = addDays(run, WINDOW_DAYS + 3 + Math.floor(rc() * 20)); const [p, price] = pick(rc, PRODUCTS); orders.push({ id: 'S-L' + (++k), date: d, store: c.home, phone: c.phone, type: 'RETAIL', net: price, gross: price, lines: [{ p, net: price, qty: 1 }] }); }
    });
  }
  return { broadcasts, orders, touches };
}
