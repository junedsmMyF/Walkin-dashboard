// Turns raw Bigin leads + Retail Sales rows + DSR rows into aggregated, PII-free metrics.
// Rules agreed with the Founders Office (Sep 2026) — see public/index.html → Funnel & definitions.
import { STORE_MASTER, EXCLUDED_STORE_IDS, storeFromDsr, storeFromBigin } from './stores.js';
import { MANUAL_WALKIN_ORDERS } from './overrides.js';
import { salesDate, dsrDate, dsrTimestamp, biginDate, daysBetween, phone10 } from './dates.js';

export const STAGE_GROUPS = {
  'Yet to Call': 'notCalled',
  'RNR 1': 'ringing', 'RNR2': 'ringing', 'RNR 2': 'ringing', 'RNR 3': 'ringing',
  'Whatsapp connected': 'engaged', 'Follow-up Scheduled': 'engaged', 'Buy Later': 'engaged',
  'Cx Visited Store': 'engaged', 'Visit Scheduled': 'engaged', 'Store Visit Scheduled': 'engaged', 'Physio Visited Home': 'engaged',
  'Sold': 'crmWon', 'C&C Purchase': 'crmWon', 'Deal Closed': 'crmWon', 'Service Completed & Sold': 'crmWon',
  'Not Interested': 'lost', 'Not available for experience': 'lost', 'Product OOS': 'lost', 'Deal Lost': 'lost',
};
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : 0; };
const inc = (map, key, field, by = 1) => { const o = map.get(key) || {}; o[field] = (o[field] || 0) + by; map.set(key, o); };
const monthOf = (d) => d.slice(0, 7);
const emailKey = (e) => { const v = String(e || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null; };
const monthsBetween = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));

export function computeMetrics({ leads: rawLeads = [], salesRows = [], dsrRows = [], startDate, cutoff, overrides = MANUAL_WALKIN_ORDERS }) {
  const inRange = (d) => d && d >= startDate && d <= cutoff;
  const quality = { salesCancelledLines: 0, salesBadDate: 0, salesNoPhoneOrders: 0, dsrUnmapped: {}, dsrBadDate: 0, biginUnmapped: {}, biginNoPhone: 0, biginNoDate: 0 };
  const storeNames = new Map(STORE_MASTER.map((s) => [s.id, s.name]));

  // ---------- Retail Sales → orders (one per POS Order ID) ----------
  const orders = new Map();
  for (const r of salesRows) {
    if (String(r['Ret/Exc'] || '').trim().toUpperCase() === 'CANCELLED') { quality.salesCancelledLines++; continue; }
    const store = (r['Store ID'] || '').trim();
    if (!store || EXCLUDED_STORE_IDS.has(store)) continue;
    const date = salesDate(r['POS Created At']) || salesDate(r['Shopify Created At']);
    if (!date) { quality.salesBadDate++; continue; }
    const id = r['POS Order ID'] || r['Shopify Order ID'];
    if (!id) continue;
    if (!storeNames.has(store) && r['Store Name']) storeNames.set(store, r['Store Name']);
    let o = orders.get(id);
    if (!o) { o = { id, date, store, phone: phone10(r['Customer Phone']), email: emailKey(r['Customer Email']), type: (r['Order Type'] || '').toUpperCase(), net: 0, gross: 0 }; orders.set(id, o); }
    const paid = num(r['Amount Paid']);
    o.gross += paid; o.net += paid - num(r['Return Amount']);
  }
  const orderList = [...orders.values()];
  quality.salesNoPhoneOrders = orderList.filter((o) => !o.phone).length;

  // ---------- DSR → walk-ins: latest submission per store per date; New + Other ----------
  const dsr = new Map();
  dsrRows.forEach((r, idx) => {
    const store = storeFromDsr(r['Store']);
    if (!store) { const k = r['Store'] || '(blank)'; quality.dsrUnmapped[k] = (quality.dsrUnmapped[k] || 0) + 1; return; }
    const date = dsrDate(r['Date']); if (!date) { quality.dsrBadDate++; return; }
    const ts = dsrTimestamp(r['Timestamp']); const key = store + '|' + date; const prev = dsr.get(key);
    if (!prev || ts > prev.ts || (ts === prev.ts && idx > prev.idx)) dsr.set(key, { ts, idx, walkins: num(r['New Walk-ins']) + num(r['Other Walk-ins']) });
  });

  // ---------- Bigin → leads ----------
  const leads = [];
  for (const l of rawLeads) {
    // Walk-in date drives capture metrics; if blank, fall back to the record's created date.
    // For attribution the Excel reference treats a blank walk-in date as "captured before any order".
    const walkin = biginDate(l.d); const date = walkin || biginDate(l.ct);
    if (!walkin) quality.biginNoDate++;
    if (!date) continue;
    const phone = phone10(l.p); if (!phone) quality.biginNoPhone++;
    let store = storeFromBigin(l.loc, l.own);
    if (!store) { const k = l.loc || l.own || '(blank)'; quality.biginUnmapped[k] = (quality.biginUnmapped[k] || 0) + 1; store = 'UNMAPPED'; }
    leads.push({ id: String(l.i || ''), date, attrDate: walkin || '0000-00-00', phone, email: emailKey(l.em), store, owner: l.own || '', stage: l.st || '', amt: num(l.amt), call: l.call ? String(l.call).slice(0, 10) : null, lost: l.lr || '', prod: l.prod || '', qty: num(l.qty) || 1, cat: l.cat || '' });
  }
  if (!storeNames.has('UNMAPPED')) storeNames.set('UNMAPPED', 'Unmapped Bigin owner');

  // ---------- Indexes ----------
  const leadsByPhone = new Map();
  for (const l of leads) { if (l.phone) (leadsByPhone.get(l.phone) || leadsByPhone.set(l.phone, []).get(l.phone)).push(l); }
  // Reference rule (OLM Excel XLOOKUP): a phone's lead is its FIRST Bigin record = lowest record ID.
  const idCmp = (a, b) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const arr of leadsByPhone.values()) arr.sort(idCmp);
  const leadPhoneDate = new Set(leads.filter((l) => l.phone).map((l) => l.phone + '|' + l.date));
  const orderPhoneDate = new Set(orderList.filter((o) => o.phone).map((o) => o.phone + '|' + o.date));

  // ---------- Attribution: order date strictly after a lead date (any store); credit the ordering store ----------
  // Manual overrides: confirmed walk-in orders with no matching Bigin lead (see src/overrides.js).
  const attributedIds = new Set();
  const overrideList = [];
  for (const o of orderList) {
    if (!overrides.has(o.id)) continue;
    overrideList.push({ id: o.id, d: o.date, s: o.store, net: Math.round(o.net), gross: Math.round(o.gross), note: overrides.get(o.id) });
  }
  const attributed = []; // {d, s, cs, t, net, gross, first, lag}
  const cohortRev = new Map();
  const firstAttrDate = new Map(); // phone -> first attributed order date
  const sortedOrders = orderList.filter((o) => o.phone).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const o of sortedOrders) {
    const ls = leadsByPhone.get(o.phone); if (!ls) continue;
    const prior = ls[0]; // first Bigin record for the phone
    if (!(prior.attrDate < o.date)) continue; // walk-in date strictly before the order date (blank = earlier)
    attributedIds.add(o.id);
    const first = !firstAttrDate.has(o.phone);
    if (first) firstAttrDate.set(o.phone, o.date);
    if (inRange(o.date)) attributed.push({ d: o.date, s: o.store, cs: prior.store, t: o.type, net: Math.round(o.net), gross: Math.round(o.gross), first: first ? 1 : 0, lag: prior.attrDate === '0000-00-00' ? null : daysBetween(prior.attrDate, o.date) });
    const fl = ls[0]; if (inRange(fl.date) && o.date <= cutoff) inc(cohortRev, monthOf(fl.date) + '|' + fl.store, 'net', Math.round(o.net));
  }
  for (const ov of overrideList) {
    if (attributedIds.has(ov.id) || !inRange(ov.d)) continue; // already matched by the rule, or outside the range
    const o = orders.get(ov.id);
    const first = !o.phone || !firstAttrDate.has(o.phone);
    if (o.phone && first) firstAttrDate.set(o.phone, o.date);
    attributed.push({ d: o.date, s: o.store, cs: o.store, t: o.type, net: Math.round(o.net), gross: Math.round(o.gross), first: first ? 1 : 0, lag: null, ov: 1 });
  }
  const orderDatesByPhone = new Map();
  for (const o of sortedOrders) (orderDatesByPhone.get(o.phone) || orderDatesByPhone.set(o.phone, []).get(o.phone)).push(o.date);
  const wonAfter = (l) => (orderDatesByPhone.get(l.phone) || []).some((d) => d > l.date && d <= cutoff);

  // ---------- Daily store rows: walk-ins, captured, same-day orders, all store orders ----------
  const daily = new Map(); // store|date -> row
  const row = (s, d) => { const k = s + '|' + d; if (!daily.has(k)) daily.set(k, { d, s, walkins: null, captured: 0, capRaw: 0, capDup: 0, capPostOrder: 0, sameDay: 0, orders: 0, ordersNet: 0, retail: 0, online: 0 }); return daily.get(k); };
  for (const [k, v] of dsr) { const [s, d] = k.split('|'); if (inRange(d)) row(s, d).walkins = v.walkins; }
  // Captured Leads = unique Bigin lead IDs after validation:
  //  1. one lead per customer per walk-in date (customer = phone, else email, else the lead ID itself);
  //     the lowest record ID wins, so a customer captured twice that day at two stores counts once.
  //  2. drop the lead if the same customer has an order on that date (phone or email match) —
  //     a record created after the purchase is not a captured walk-in opportunity.
  const custKey = (x) => (x.phone ? 'p:' + x.phone : x.email ? 'e:' + x.email : null);
  const orderCustDate = new Set();
  for (const o of orderList) { if (o.phone) orderCustDate.add('p:' + o.phone + '|' + o.date); if (o.email) orderCustDate.add('e:' + o.email + '|' + o.date); }
  const boughtSameDay = (l) => (l.phone && orderCustDate.has('p:' + l.phone + '|' + l.date)) || (l.email && orderCustDate.has('e:' + l.email + '|' + l.date));
  const validLeads = []; const custDaySeen = new Set();
  for (const l of [...leads].sort(idCmp)) {
    if (!inRange(l.date)) continue;
    const r = row(l.store, l.date); r.capRaw++;
    const ck = custKey(l); const k = (ck || 'id:' + l.id) + '|' + l.date;
    if (custDaySeen.has(k)) { r.capDup++; continue; }
    custDaySeen.add(k);
    if (boughtSameDay(l)) { r.capPostOrder++; continue; }
    r.captured++; validLeads.push(l);
  }
  for (const o of orderList) {
    if (!inRange(o.date)) continue;
    const r = row(o.store, o.date);
    r.orders++; r.ordersNet += Math.round(o.net);
    if (o.type === 'RETAIL') r.retail++; else if (o.type === 'ONLINE') r.online++;
    if (o.phone && leadPhoneDate.has(o.phone + '|' + o.date)) r.sameDay++;
  }

  // ---------- Pipeline, hygiene, loss, aging, first call (leads in range, unique per store/date/phone) ----------
  const pipe = new Map(); const hyg = new Map(); const loss = new Map(); const aging = new Map(); const firstCall = new Map(); const atRisk = [];
  for (const l of validLeads) {
    const group = STAGE_GROUPS[l.stage] || 'other';
    const won = wonAfter(l);
    const status = won ? 'won' : group;
    const pk = [l.date, l.store, status, won ? '' : l.stage].join('|');
    inc(pipe, pk, 'n'); if (!won && group !== 'lost' && group !== 'crmWon') inc(pipe, pk, 'amt', l.amt);
    if (group === 'crmWon' && !won) inc(hyg, [l.date, l.store, 'crmWonNoOrder'].join('|'), 'n');
    if (group === 'lost' && won) inc(hyg, [l.date, l.store, 'lostButBought'].join('|'), 'n');
    if (won && ['notCalled', 'ringing', 'engaged'].includes(group)) inc(hyg, [l.date, l.store, 'boughtStillOpen'].join('|'), 'n');
    if (group !== 'notCalled' && group !== 'other' && !l.call) inc(hyg, [l.date, l.store, 'stageNoCall'].join('|'), 'n');
    if (group === 'notCalled' && !won && daysBetween(l.date, cutoff) >= 7) inc(hyg, [l.date, l.store, 'notCalled7'].join('|'), 'n');
    if (group === 'lost' && !won) inc(loss, [l.date, l.store, l.lost || 'No reason recorded', l.cat || ''].join('|'), 'n');
    if (group === 'notCalled' && !won) {
      const age = daysBetween(l.date, cutoff);
      const ak = [l.date, l.store, age >= 7 ? '7+' : String(age)].join('|'); inc(aging, ak, 'n'); inc(aging, ak, 'amt', l.amt);
      if (age === 5 || age === 6) atRisk.push({ id: l.id, d: l.date, s: l.store, own: l.owner, age, prod: l.prod, qty: l.qty, amt: l.amt });
    }
    if (l.call && l.call >= l.date) { const k = l.date + '|' + l.store; inc(firstCall, k, 'n'); inc(firstCall, k, 'days', daysBetween(l.date, l.call)); }
  }

  // ---------- Cohorts: first capture month per customer × months to first attributed order ----------
  const cohort = new Map();
  for (const [phone, ls] of leadsByPhone) {
    const first = ls[0]; if (!inRange(first.date)) continue;
    const f = firstAttrDate.get(phone);
    const off = f && f <= cutoff ? Math.max(0, monthsBetween(first.date, f)) : -1;
    inc(cohort, [monthOf(first.date), first.store, off].join('|'), 'n');
  }

  const expand = (map, keys) => [...map].map(([k, v]) => Object.assign(Object.fromEntries(k.split('|').map((x, i) => [keys[i], keys[i] === 'off' ? +x : x])), v));
  const cities = Object.fromEntries(STORE_MASTER.map((s) => [s.id, s.city]));
  const formats = Object.fromEntries(STORE_MASTER.map((s) => [s.id, s.format]));
  const storesUsed = new Set([...daily.values()].map((r) => r.s).concat(attributed.map((a) => a.s), attributed.map((a) => a.cs)));
  return {
    startDate, cutoff,
    stores: [...storesUsed].map((id) => ({ id, name: storeNames.get(id) || id, city: cities[id] || (id === 'UNMAPPED' ? '—' : 'Other'), format: formats[id] || null })).sort((a, b) => a.name.localeCompare(b.name)),
    daily: [...daily.values()],
    attributed,
    pipeline: expand(pipe, ['d', 's', 'g', 'st']),
    hygiene: expand(hyg, ['d', 's', 'k']),
    loss: expand(loss, ['d', 's', 'r', 'c']),
    aging: expand(aging, ['d', 's', 'b']),
    firstCall: expand(firstCall, ['d', 's']),
    cohorts: expand(cohort, ['m', 's', 'off']),
    cohortRevenue: expand(cohortRev, ['m', 's']),
    atRisk: atRisk.sort((a, b) => b.age - a.age || b.amt - a.amt),
    quality: Object.assign(quality, { manualOverrides: overrideList }),
    counts: { orders: orderList.length, leads: leads.length, dsrStoreDays: dsr.size },
    lastDates: {
      sales: orderList.reduce((m, o) => (o.date > m ? o.date : m), ''),
      dsr: [...dsr.keys()].reduce((m, k) => { const d = k.split('|')[1]; return d > m ? d : m; }, ''),
      bigin: leads.reduce((m, l) => (l.date > m ? l.date : m), ''),
    },
  };
}
