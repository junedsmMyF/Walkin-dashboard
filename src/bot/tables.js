// Question-ready tables for the Chat-with-Data bot. Built by the SAME engine as the dashboard
// (computeMetrics), so every KPI matches the dashboard. No phone numbers, names or emails are kept.
import { computeMetrics, STAGE_GROUPS } from '../metrics.js';
import { STORE_MASTER, EXCLUDED_STORE_IDS, storeFromBigin } from '../stores.js';
import { categoryOf } from '../categories.js';
import { salesDate, biginDate, daysBetween, phone10 } from '../dates.js';

const SM = new Map(STORE_MASTER.map((s) => [s.id, s]));
const store = (id) => SM.get(id) || { id, name: id === 'UNMAPPED' ? 'No store (owner account)' : id, city: null, format: null };
const STAGE_LABEL = { notCalled: 'Not called', ringing: 'Ringing out', engaged: 'Engaged', crmWon: 'Won in CRM (unverified)', lost: 'Lost', other: 'Other' };
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const wd = (d) => WD[new Date(d + 'T00:00:00Z').getUTCDay()];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const splitInterest = (s) => { s = String(s || '').trim(); if (!s) return []; return [...new Set((s.includes('||') ? s.split('||') : s.split(/,\s*(?=Frido\b)/)).map((x) => x.trim()).filter(Boolean))]; };

export const BOT_TABLES = {
  sales_orders: [['order_id', 'TEXT'], ['order_date', 'TEXT'], ['weekday', 'TEXT'], ['store_id', 'TEXT'], ['store_name', 'TEXT'], ['city', 'TEXT'], ['format', 'TEXT'], ['order_type', 'TEXT'],
    ['units', 'REAL'], ['lines', 'INTEGER'], ['gross', 'REAL'], ['discount', 'REAL'], ['total_revenue', 'REAL'], ['is_walkin', 'INTEGER'], ['walkin_basis', 'TEXT'], ['lead_walkin_date', 'TEXT'], ['days_lead_to_order', 'INTEGER'], ['is_first_walkin_order', 'INTEGER']],
  sales_lines: [['order_id', 'TEXT'], ['order_date', 'TEXT'], ['store_id', 'TEXT'], ['store_name', 'TEXT'], ['city', 'TEXT'], ['format', 'TEXT'], ['order_type', 'TEXT'],
    ['product_name', 'TEXT'], ['category', 'TEXT'], ['quantity', 'REAL'], ['gross', 'REAL'], ['total_revenue', 'REAL'], ['is_walkin', 'INTEGER']],
  leads: [['lead_id', 'TEXT'], ['walkin_date', 'TEXT'], ['weekday', 'TEXT'], ['store_id', 'TEXT'], ['store_name', 'TEXT'], ['city', 'TEXT'], ['format', 'TEXT'], ['is_captured', 'INTEGER'], ['exclusion_reason', 'TEXT'],
    ['stage', 'TEXT'], ['stage_group', 'TEXT'], ['product_interest', 'TEXT'], ['interest_category', 'TEXT'], ['loss_reason', 'TEXT'], ['call_date', 'TEXT'], ['days_to_call', 'INTEGER'],
    ['converted', 'INTEGER'], ['first_order_date', 'TEXT'], ['days_to_first_order', 'INTEGER'], ['converted_revenue', 'REAL']],
  store_day: [['date', 'TEXT'], ['weekday', 'TEXT'], ['store_id', 'TEXT'], ['store_name', 'TEXT'], ['city', 'TEXT'], ['format', 'TEXT'], ['walkins', 'INTEGER'], ['dsr_sent', 'INTEGER'],
    ['orders', 'INTEGER'], ['cash_carry_orders', 'INTEGER'], ['online_orders', 'INTEGER'], ['store_revenue', 'REAL'], ['store_gross', 'REAL'],
    ['bigin_leads', 'INTEGER'], ['duplicate_leads', 'INTEGER'], ['bought_same_day_leads', 'INTEGER'], ['captured_leads', 'INTEGER'],
    ['walkin_orders', 'INTEGER'], ['walkin_revenue', 'REAL'], ['walkin_gross', 'REAL'], ['converted_customers', 'INTEGER']],
};
export const DATE_COL = { sales_orders: 'order_date', sales_lines: 'order_date', leads: 'walkin_date', store_day: 'date' };

export function buildBotTables({ leads = [], salesRows = [], dsrRows = [], startDate, cutoff }) {
  const m = computeMetrics({ leads, salesRows, dsrRows, startDate, cutoff, audit: true });
  const inRange = (d) => d && d >= startDate && d <= cutoff;
  // walk-in orders (dashboard attribution)
  const walk = new Map(m.revenueAudit.map((r) => [r['POS Order ID'], r]));
  const firstByPhone = new Map();
  for (const r of [...m.revenueAudit].sort((a, b) => (a['Order date'] < b['Order date'] ? -1 : 1))) if (r.Phone && !firstByPhone.has(r.Phone)) firstByPhone.set(r.Phone, r['POS Order ID']);
  const walkByPhone = new Map();
  for (const r of m.revenueAudit) if (r.Phone) (walkByPhone.get(r.Phone) || walkByPhone.set(r.Phone, []).get(r.Phone)).push(r);
  // orders + lines from the same sales rows the dashboard reads
  const orders = new Map(); const lines = [];
  for (const r of salesRows) {
    const id = String(r['POS Order ID'] || '').trim(); const d = salesDate(r['POS Created At']); const sid = String(r['Store ID'] || '').trim();
    if (!id || !inRange(d) || EXCLUDED_STORE_IDS.has(sid)) continue;
    const s = store(sid); const t = String(r['Order Type'] || '').toUpperCase() === 'ONLINE' ? 'Online punch-in' : 'Cash & carry';
    const g = r.__gross != null ? Number(r.__gross) : Number(r['Amount Paid']) || 0; const n = r.__net != null ? Number(r.__net) : g - (Number(r['Return Amount']) || 0);
    const q = Number(r.Quantity) || 1; const w = walk.has(id) ? 1 : 0; const prod = String(r['Product Name'] || '').trim();
    let o = orders.get(id); if (!o) { o = { id, d, sid, s, t, units: 0, lines: 0, gross: 0, net: 0 }; orders.set(id, o); }
    o.units += q; o.lines++; o.gross += g; o.net += n;
    lines.push([id, d, sid, s.name, s.city, s.format, t, prod, categoryOf(prod), q, r2(g), r2(n), w]);
  }
  const sales_orders = [...orders.values()].map((o) => { const a = walk.get(o.id); const lead = a ? a['Lead walk-in date'] : null; const leadOk = lead && /^\d{4}-/.test(lead) ? lead : null;
    return [o.id, o.d, wd(o.d), o.sid, o.s.name, o.s.city, o.s.format, o.t, o.units, o.lines, r2(o.gross), r2(o.gross - o.net), r2(o.net), a ? 1 : 0, a ? (a.Basis.startsWith('Manual') ? 'Manual override' : 'Bigin lead') : null, leadOk, leadOk ? daysBetween(leadOk, o.d) : null, a && a.Phone && firstByPhone.get(a.Phone) === o.id ? 1 : a && !a.Phone ? 1 : 0]; });
  // leads (every Bigin walk-in lead in range, with its capture status and outcome)
  const raw = new Map(leads.map((l) => [String(l.i), l]));
  const leadRows = m.captureAudit.map((a) => {
    const l = raw.get(String(a['Bigin lead ID'])) || {}; const sid = storeFromBigin(l.loc, l.own) || 'UNMAPPED'; const s = store(sid); const d = a['Walk-in date'];
    const st = String(l.st || ''); const want = splitInterest(l.prod); const call = biginDate(l.call); const ph = phone10(l.p);
    const later = ph ? (walkByPhone.get(ph) || []).filter((r) => r['Order date'] > d).sort((x, y) => (x['Order date'] < y['Order date'] ? -1 : 1)) : [];
    const status = String(a.Status || '');
    return [String(a['Bigin lead ID']), d, wd(d), sid, s.name, s.city, s.format, status.startsWith('Captured') ? 1 : 0,
      status.includes('duplicate') ? 'Duplicate (same customer, same day)' : status.includes('order') ? 'Bought the same day' : null,
      st || null, STAGE_LABEL[STAGE_GROUPS[st] || 'other'], want.join(', ') || null, [...new Set(want.map(categoryOf))].join(', ') || null, l.lr || null,
      call, call ? daysBetween(d, call) : null, later.length ? 1 : 0, later[0]?.['Order date'] || null, later[0] ? daysBetween(d, later[0]['Order date']) : null,
      r2(later.reduce((s2, r) => s2 + (r['Total Revenue (gross − discount)'] || 0), 0))];
  });
  // store-day (footfall, orders, capture and walk-in revenue per store per day)
  const att = new Map(); for (const x of m.attributed) { const k = x.d + '|' + x.s; const v = att.get(k) || { n: 0, net: 0, gross: 0, first: 0 }; v.n++; v.net += x.net; v.gross += x.gross; v.first += x.first; att.set(k, v); }
  const store_day = m.daily.filter((x) => inRange(x.d)).map((x) => { const s = store(x.s); const a = att.get(x.d + '|' + x.s) || { n: 0, net: 0, gross: 0, first: 0 };
    return [x.d, wd(x.d), x.s, s.name, s.city, s.format, x.walkins == null ? null : x.walkins, x.walkins == null ? 0 : 1, x.orders || 0, x.retail || 0, x.online || 0,
      r2(x.ordersNet), r2(x.ordersGross), x.capRaw || 0, x.capDup || 0, x.capPostOrder || 0, x.captured || 0, a.n, r2(a.net), r2(a.gross), a.first]; });
  return { tables: { sales_orders, sales_lines: lines, leads: leadRows, store_day }, dataThrough: cutoff, startDate };
}
