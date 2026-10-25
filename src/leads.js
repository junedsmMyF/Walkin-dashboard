// PDP single lead list (owner, 23 Oct 2026) — Step 3 of the PDP rebuild. Not shown on the dashboard yet: /api/pdp carries
// only the PII-free summary so the counts can be checked before any screen uses them.
//  • Contacts: Call Store (Bigin Callback Requests) · WhatsApp from the LimeChat export before the cutover · WhatsApp from
//    Bigin PDP Inventories from the cutover. Order / return queries are not leads. Mobility is out of scope (not counted).
//  • One lead per phone. A later contact within 30 days of the lead's first contact is a repeat; after 30 days it is a fresh
//    lead, unless the phone bought in between (then it stays a repeat). Contacts with no valid phone are leads of their own.
//  • Routing sheet rows (test rows left out) join to the latest lead of that phone that started on/before the routing date.
//  • Orders (Step 4): a DevX order (unique order ID) counts for the latest lead of that phone that started on/before the order
//    date, if the order is within 60 days of that lead's start. Route: routed + bought on the expected visit date = store visit;
//    routing remark mentions video, or not routed + video call arranged = video call; anything else = other.
import { daysBetween } from './dates.js';

export const REPEAT_DAYS = 30;
export const ORDER_DAYS = 60;

// contacts: [{ src: 'call'|'limechat'|'bigin', id, ts, d, phone, valid, entry, store }]
// routes: standardised routing rows ({ d, phone, test, vd, s }) · ordersByPhone: phone → date-sorted orders
// videoPhones: phones Bigin shows in a video-call stage — a routed lead with one counts as a video call even without a "video" remark
export function buildLeadList({ contacts = [], routes = [], ordersByPhone = new Map(), repeatDays = REPEAT_DAYS, videoPhones = new Set() }) {
  const sorted = contacts.filter((c) => c.d).sort((a, b) => a.ts - b.ts || (String(a.id) < String(b.id) ? -1 : 1));
  const leads = []; const open = new Map();
  const boughtBetween = (p, from, to) => (ordersByPhone.get(p) || []).some((o) => o.date >= from && o.date <= to);
  for (const c of sorted) {
    if (!c.valid || !c.phone) { leads.push(newLead(c, 0)); continue; }
    const cur = open.get(c.phone);
    if (cur) {
      const gap = daysBetween(cur.d, c.d);
      if (gap < repeatDays || boughtBetween(c.phone, cur.d, c.d)) {
        cur.repeats++; cur.srcs.add(c.src); cur.lastD = c.d; if (c.vc) cur.vc = 1;
        if (!cur.ci && c.ci) cur.ci = c.ci; if (!cur.pp && c.pp) cur.pp = c.pp; if (c.lr) cur.lr = c.lr; // interest: first known · loss reason: latest
        for (const k of ['cons', 'conn', 'qual', 'lost']) if (c[k]) cur[k] = 1; // furthest progress across the lead's contacts
        if (gap >= repeatDays) cur.boughtRepeat++;
        continue;
      }
    }
    const l = newLead(c, cur ? 1 : 0);
    leads.push(l); open.set(c.phone, l);
  }
  // routing join
  const byPhone = new Map(); for (const l of leads) if (l.phone) (byPhone.get(l.phone) || byPhone.set(l.phone, []).get(l.phone)).push(l);
  const routing = { rows: 0, test: 0, matched: 0, beforeLead: 0, unmatched: 0, repeatRows: 0 };
  for (const r of routes) {
    if (r.test) { routing.test++; continue; }
    routing.rows++;
    const ls = (r.phone && byPhone.get(r.phone)) || [];
    const l = [...ls].reverse().find((x) => x.d <= r.d);
    if (!l) { if (ls.length) routing.beforeLead++; else routing.unmatched++; continue; }
    if (l.rt) { routing.repeatRows++; continue; }
    l.rt = r.d; l.vd = r.vd || ''; l.rs = r.s || ''; l.rv = r.video || (l.phone && videoPhones.has(l.phone)) ? 1 : 0; routing.matched++;
    if (!l.ci && r.cat) l.ci = r.cat; // category from the routing sheet when the lead had none
  }
  return { leads, routing };
}

function newLead(c, again) {
  return { phone: c.phone || null, d: c.d, ts: c.ts, src: c.src, id: c.id, entry: c.entry || 'generic', store: c.store || '', vc: c.vc ? 1 : 0, rv: 0, ag: c.ag || '', cons: c.cons ? 1 : 0, conn: c.conn ? 1 : 0, qual: c.qual ? 1 : 0, lost: c.lost ? 1 : 0, again, repeats: 0, boughtRepeat: 0, srcs: new Set([c.src]), lastD: c.d, rt: '', vd: '', rs: '', ci: c.ci || '', pp: c.pp || '', lr: c.lr || '' };
}

export const routeOf = (l, o) => {
  if (l.rt && l.rv) return o.date >= (l.vd || l.rt) ? 'video' : 'other';
  if (l.rt) return l.vd && o.date === l.vd ? 'store' : 'other';
  return l.vc ? 'video' : 'other';
};

// Attach DevX orders to leads (each order once). ordersByPhone: phone → date-sorted [{ id, date, net, store }]
export function attributeOrders(LL, ordersByPhone, { cutoff, orderDays = ORDER_DAYS }) {
  const byPhone = new Map(); for (const l of LL.leads) { l.orders = []; if (l.phone) (byPhone.get(l.phone) || byPhone.set(l.phone, []).get(l.phone)).push(l); }
  const stats = { beyondWindow: 0, beforeLead: 0 }; const seen = new Set();
  for (const [p, ls] of byPhone) {
    for (const o of ordersByPhone.get(p) || []) {
      if (o.date > cutoff || seen.has(o.id)) continue;
      const l = [...ls].reverse().find((x) => x.d <= o.date);
      if (!l) { stats.beforeLead++; continue; }
      if (daysBetween(l.d, o.date) > orderDays) { stats.beyondWindow++; continue; }
      seen.add(o.id); l.orders.push({ id: o.id, date: o.date, net: o.net, store: o.store, route: routeOf(l, o), lag: daysBetween(l.d, o.date), lines: o.lines || [], gross: o.gross });
    }
  }
  LL.orderStats = stats;
  return LL;
}

// PII-free lead rows for the browser (no phone, name or ticket id). A routed lead counts as consumed, connected and qualified.
// ci / pp = category / product page of interest · lr = loss reason · order lines i: [product index (pid), category, qty, net, gross]
export const leadRows = (LL, { from, to, pid = null, catOf = () => '' }) => LL.leads.filter((l) => l.d >= from && l.d <= to).map((l) => {
  const r = l.rt ? 1 : 0;
  return { d: l.d, src: l.src, e: l.entry, s: l.store || l.rs || 'UNMAPPED', ag: l.ag, c: l.cons || r, n: l.conn || r, q: l.qual || r, x: l.lost && !r ? 1 : 0,
    rt: l.rt, vd: l.vd, rv: l.rv, vc: l.vc, rs: l.rs, rep: l.repeats, again: l.again, np: l.phone ? 0 : 1, ci: l.ci || '', pp: l.pp || '', lr: l.lr || '',
    o: (l.orders || []).map((o) => ({ d: o.date, net: Math.round(o.net), gross: Math.round(o.gross ?? o.net), r: o.route, s: o.store, lag: o.lag, ...(pid ? { i: (o.lines || []).map((x) => [pid(x.p), catOf(x.p), x.qty, Math.round(x.net), Math.round(x.gross ?? x.net)]) } : {}) })) };
});

// PII-free summary for a date window (lead start date within [from, to]).
export function summariseLeads(LL, { from, to }) {
  const { leads, routing } = LL;
  const L = leads.filter((l) => l.d >= from && l.d <= to);
  const count = (f) => L.reduce((m, l) => { const k = f(l); m[k] = (m[k] || 0) + 1; return m; }, {});
  return {
    from, to, leads: L.length,
    bySource: count((l) => l.src), byCta: count((l) => l.entry), byDay: count((l) => l.d),
    noPhone: L.filter((l) => !l.phone).length,
    freshAfter30: L.filter((l) => l.again).length,
    repeatContacts: L.reduce((u, l) => u + l.repeats, 0), leadsWithRepeats: L.filter((l) => l.repeats).length,
    boughtRepeats: L.reduce((u, l) => u + l.boughtRepeat, 0),
    crossSource: L.filter((l) => l.srcs.size > 1).length,
    routed: L.filter((l) => l.rt).length, routedBySource: count((l) => (l.rt ? l.src : '_')),
    routing,
    ...(L.some((l) => l.orders) ? orderSummary(L, LL.orderStats) : {}),
  };
}

function orderSummary(L, stats) {
  const O = L.flatMap((l) => l.orders || []); const B = L.filter((l) => l.orders && l.orders.length);
  const r = (k) => { const os = O.filter((o) => o.route === k); const b = B.filter((l) => l.orders[0].route === k); return { orders: os.length, buyers: b.length, net: Math.round(os.reduce((u, o) => u + o.net, 0)) }; };
  const lags = B.map((l) => l.orders[0].lag).sort((a, b) => a - b);
  const by = (f) => B.reduce((m, l) => { const k = f(l); const v = (m[k] = m[k] || { buyers: 0, net: 0 }); v.buyers++; v.net += Math.round(l.orders.reduce((u, o) => u + o.net, 0)); return m; }, {});
  return {
    buyers: B.length, orders: O.length, revenue: Math.round(O.reduce((u, o) => u + o.net, 0)), conversion: L.length ? Math.round(B.length / L.length * 1000) / 10 : null,
    sameDay: B.filter((l) => l.orders[0].lag === 0).length, medianLag: lags.length ? lags[Math.floor(lags.length / 2)] : null,
    byRoute: { store: r('store'), video: r('video'), other: r('other') }, buyersBySource: by((l) => l.src), buyersByCta: by((l) => l.entry),
    routedBuyers: B.filter((l) => l.rt).length, orderStats: stats,
  };
}
