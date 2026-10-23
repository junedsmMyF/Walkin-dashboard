// PDP single lead list (owner, 23 Oct 2026) — Step 3 of the PDP rebuild. Not shown on the dashboard yet: /api/pdp carries
// only the PII-free summary so the counts can be checked before any screen uses them.
//  • Contacts: Call Store (Bigin Callback Requests) · WhatsApp from the LimeChat export before the cutover · WhatsApp from
//    Bigin PDP Inventories from the cutover. Order / return queries are not leads. Mobility is out of scope (not counted).
//  • One lead per phone. A later contact within 30 days of the lead's first contact is a repeat; after 30 days it is a fresh
//    lead, unless the phone bought in between (then it stays a repeat). Contacts with no valid phone are leads of their own.
//  • Routing sheet rows (test rows left out) join to the latest lead of that phone that started on/before the routing date.
import { daysBetween } from './dates.js';

export const REPEAT_DAYS = 30;

// contacts: [{ src: 'call'|'limechat'|'bigin', id, ts, d, phone, valid, entry, store }]
// routes: standardised routing rows ({ d, phone, test, vd, s }) · ordersByPhone: phone → date-sorted orders
export function buildLeadList({ contacts = [], routes = [], ordersByPhone = new Map(), repeatDays = REPEAT_DAYS }) {
  const sorted = contacts.filter((c) => c.d).sort((a, b) => a.ts - b.ts || (String(a.id) < String(b.id) ? -1 : 1));
  const leads = []; const open = new Map();
  const boughtBetween = (p, from, to) => (ordersByPhone.get(p) || []).some((o) => o.date >= from && o.date <= to);
  for (const c of sorted) {
    if (!c.valid || !c.phone) { leads.push(newLead(c, 0)); continue; }
    const cur = open.get(c.phone);
    if (cur) {
      const gap = daysBetween(cur.d, c.d);
      if (gap < repeatDays || boughtBetween(c.phone, cur.d, c.d)) {
        cur.repeats++; cur.srcs.add(c.src); cur.lastD = c.d;
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
    l.rt = r.d; l.vd = r.vd || ''; l.rs = r.s || ''; routing.matched++;
  }
  return { leads, routing };
}

function newLead(c, again) {
  return { phone: c.phone || null, d: c.d, ts: c.ts, src: c.src, id: c.id, entry: c.entry || 'generic', store: c.store || '', again, repeats: 0, boughtRepeat: 0, srcs: new Set([c.src]), lastD: c.d, rt: '', vd: '', rs: '' };
}

// PII-free summary for a date window (lead start date within [from, to]).
export function summariseLeads({ leads, routing }, { from, to }) {
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
  };
}
