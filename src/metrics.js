// Turns raw Bigin leads + Retail Sales rows + DSR rows into aggregated, PII-free metrics.
// Rules agreed with the Founders Office (Sep 2026) — see public/index.html → Funnel & definitions.
import { STORE_MASTER, EXCLUDED_STORE_IDS, storeFromDsr, storeFromBigin } from './stores.js';
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
const monthsBetween = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));

export function computeMetrics({ leads: rawLeads = [], salesRows = [], dsrRows = [], startDate, cutoff }) {
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
    if (!o) { o = { id, date, store, phone: phone10(r['Customer Phone']), type: (r['Order Type'] || '').toUpperCase(), net: 0, gross: 0 }; orders.set(id, o); }
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
    const date = biginDate(l.d); if (!date) { quality.biginNoDate++; continue; }
    const phone = phone10(l.p); if (!phone) { quality.biginNoPhone++; continue; }
    let store = storeFromBigin(l.loc, l.own);
    if (!store) { const k = l.loc || l.own || '(blank)'; quality.biginUnmapped[k] = (quality.biginUnmapped[k] || 0) + 1; store = 'UNMAPPED'; }
    leads.push({ date, phone, store, stage: l.st || '', amt: num(l.amt), call: l.call ? String(l.call).slice(0, 10) : null, lost: l.lr || '' });
  }
  if (!storeNames.has('UNMAPPED')) storeNames.set('UNMAPPED', 'Unmapped Bigin owner');

  // ---------- Indexes ----------
  const leadsByPhone = new Map();
  for (const l of leads) { (leadsByPhone.get(l.phone) || leadsByPhone.set(l.phone, []).get(l.phone)).push(l); }
  for (const arr of leadsByPhone.values()) arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const leadPhoneDate = new Set(leads.map((l) => l.phone + '|' + l.date));
  const orderPhoneDate = new Set(orderList.filter((o) => o.phone).map((o) => o.phone + '|' + o.date));

  // ---------- Attribution: order date strictly after a lead date (any store); credit the ordering store ----------
  const attributed = []; // {d, s, cs, net, gross, first, lag}
  const firstAttrDate = new Map(); // phone -> first attributed order date
  const sortedOrders = orderList.filter((o) => o.phone).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const o of sortedOrders) {
    const ls = leadsByPhone.get(o.phone); if (!ls) continue;
    let prior = null; for (const l of ls) { if (l.date < o.date) prior = l; else break; } // latest lead before the order
    if (!prior) continue;
    const first = !firstAttrDate.has(o.phone);
    if (first) firstAttrDate.set(o.phone, o.date);
    if (inRange(o.date)) attributed.push({ d: o.date, s: o.store, cs: prior.store, net: Math.round(o.net), gross: Math.round(o.gross), first: first ? 1 : 0, lag: daysBetween(prior.date, o.date) });
  }
  const orderDatesByPhone = new Map();
  for (const o of sortedOrders) (orderDatesByPhone.get(o.phone) || orderDatesByPhone.set(o.phone, []).get(o.phone)).push(o.date);
  const wonAfter = (l) => (orderDatesByPhone.get(l.phone) || []).some((d) => d > l.date && d <= cutoff);

  // ---------- Daily store rows: walk-ins, captured, same-day orders, all store orders ----------
  const daily = new Map(); // store|date -> row
  const row = (s, d) => { const k = s + '|' + d; if (!daily.has(k)) daily.set(k, { d, s, walkins: null, captured: 0, sameDay: 0, orders: 0, ordersNet: 0, retail: 0, online: 0 }); return daily.get(k); };
  for (const [k, v] of dsr) { const [s, d] = k.split('|'); if (inRange(d)) row(s, d).walkins = v.walkins; }
  const capturedSeen = new Set();
  for (const l of leads) {
    if (!inRange(l.date)) continue;
    const key = l.store + '|' + l.date + '|' + l.phone;
    if (capturedSeen.has(key)) continue; capturedSeen.add(key);
    if (orderPhoneDate.has(l.phone + '|' + l.date)) continue; // bought the same day → not a captured drop-off
    row(l.store, l.date).captured++;
  }
  for (const o of orderList) {
    if (!inRange(o.date)) continue;
    const r = row(o.store, o.date);
    r.orders++; r.ordersNet += Math.round(o.net);
    if (o.type === 'RETAIL') r.retail++; else if (o.type === 'ONLINE') r.online++;
    if (o.phone && leadPhoneDate.has(o.phone + '|' + o.date)) r.sameDay++;
  }

  // ---------- Pipeline, hygiene, loss, aging, first call (leads in range, unique per store/date/phone) ----------
  const pipe = new Map(); const hyg = new Map(); const loss = new Map(); const aging = new Map(); const firstCall = new Map();
  const seen = new Set();
  for (const l of leads) {
    if (!inRange(l.date)) continue;
    const key = l.store + '|' + l.date + '|' + l.phone; if (seen.has(key)) continue; seen.add(key);
    if (orderPhoneDate.has(l.phone + '|' + l.date)) continue; // same-day buyers are not follow-up leads
    const group = STAGE_GROUPS[l.stage] || 'other';
    const won = wonAfter(l);
    const status = won ? 'won' : group;
    const pk = [l.date, l.store, status, won ? '' : l.stage].join('|');
    inc(pipe, pk, 'n'); if (!won && group !== 'lost' && group !== 'crmWon') inc(pipe, pk, 'amt', l.amt);
    if (group === 'crmWon' && !won) inc(hyg, [l.date, l.store, 'crmWonNoOrder'].join('|'), 'n');
    if (group === 'lost' && won) inc(hyg, [l.date, l.store, 'lostButBought'].join('|'), 'n');
    if (group === 'notCalled' && !won && daysBetween(l.date, cutoff) >= 7) inc(hyg, [l.date, l.store, 'notCalled7'].join('|'), 'n');
    if (group === 'lost' && !won) inc(loss, [l.date, l.store, l.lost || 'No reason recorded'].join('|'), 'n');
    if (group === 'notCalled' && !won) { const age = daysBetween(l.date, cutoff); inc(aging, [l.date, l.store, age <= 2 ? '0-2' : age <= 6 ? '3-6' : '7+'].join('|'), 'n'); }
    if (l.call && l.call >= l.date) { const k = l.date + '|' + l.store; inc(firstCall, k, 'n'); inc(firstCall, k, 'days', daysBetween(l.date, l.call)); }
  }

  // ---------- Cohorts: first capture month per customer × months to first attributed order ----------
  const cohort = new Map();
  for (const [phone, ls] of leadsByPhone) {
    const first = ls[0]; if (!inRange(first.date)) continue;
    const f = firstAttrDate.get(phone);
    const off = f && f > first.date && f <= cutoff ? monthsBetween(first.date, f) : -1;
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
    loss: expand(loss, ['d', 's', 'r']),
    aging: expand(aging, ['d', 's', 'b']),
    firstCall: expand(firstCall, ['d', 's']),
    cohorts: expand(cohort, ['m', 's', 'off']),
    quality,
    counts: { orders: orderList.length, leads: leads.length, dsrStoreDays: dsr.size },
    lastDates: {
      sales: orderList.reduce((m, o) => (o.date > m ? o.date : m), ''),
      dsr: [...dsr.keys()].reduce((m, k) => { const d = k.split('|')[1]; return d > m ? d : m; }, ''),
      bigin: leads.reduce((m, l) => (l.date > m ? l.date : m), ''),
    },
  };
}
