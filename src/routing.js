// Lead routing sheet — the backend agent routes a qualified lead to a store from the WhatsApp DSR group; the group is
// connected to a Google Sheet ("Lead routing backend") that fills automatically. Read live from the secret
// ROUTING_CSV_URL (holds customer names and phones — never commit the link or rows; this repo is public).
//
// Columns (Oct 2026): Lead ID, Submitted at (M/D/YYYY H:MM:SS), Store (DSR-style label), Customer name, Customer number,
// Product name (comma-separated), Product category ("NM - " prefix on some rows), Expected visit date (M/D/YYYY),
// Expected visit time (free text: "9:30 PM", "6pm-8pm", blank), Discount offered (free text), Remarks, Submitted by.
//
// The source is never changed: values are standardised next to the raw value and hygiene issues are flagged.
import { phone10, daysBetween } from './dates.js';

// 'M/D/YYYY' or 'M/D/YYYY H:MM[:SS]' (Google Sheets US format) → { d: 'YYYY-MM-DD', t: ms }
export function usDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, mo, da, y, h = '0', mi = '0', se = '0'] = m;
  if (+mo < 1 || +mo > 12 || +da < 1 || +da > 31) return null;
  const d = `${y}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`;
  return { d, t: Date.parse(`${d}T${h.padStart(2, '0')}:${mi}:${se.padStart(2, '0')}+05:30`) };
}

// Visit time → { kind: 'slot' | 'time' | 'blank' | 'other', from: hour }
export function visitTime(s) {
  const v = String(s || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!v) return { kind: 'blank', from: null };
  const hr = (h, ap) => (+h % 12) + (ap === 'pm' ? 12 : 0);
  let m = v.match(/^(\d{1,2})(?::\d{2})?(am|pm)?-(\d{1,2})(?::\d{2})?(am|pm)$/);
  if (m) return { kind: 'slot', from: hr(m[1], m[2] || m[4]) };
  m = v.match(/^(\d{1,2})(?::\d{2})?(am|pm)$/);
  if (m) return { kind: 'time', from: hr(m[1], m[2]) };
  return { kind: 'other', from: null };
}

export const cleanCategory = (s) => String(s || '').replace(/^\s*nm\s*-\s*/i, '').trim();
const TEST_NAME = /^(test|testing|dummy|demo)\b/i;

export function standardiseRouting(rows, { storeOf, cutoff } = {}) {
  const out = [];
  for (const r of rows) {
    const sub = usDate(r['Submitted at']); if (!sub) continue;
    const raw = String(r['Customer number'] || '').replace(/\D/g, '');
    const phone = phone10(raw);
    const storeRaw = String(r['Store'] || '').trim();
    const vd = usDate(r['Expected visit date']);
    const vt = visitTime(r['Expected visit time']);
    const disc = String(r['Discount offered'] || '').trim();
    const catRaw = String(r['Product category'] || '').trim();
    const prods = String(r['Product name'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    out.push({
      id: String(r['Lead ID'] || '').trim(), d: sub.d, ts: sub.t, phone, validPhone: !!phone && /^[6-9]/.test(phone) && raw.length <= 12,
      storeRaw, s: (storeOf && storeOf(storeRaw)) || '', prods, cat: cleanCategory(catRaw), catRaw, vd: vd ? vd.d : '', vdRaw: String(r['Expected visit date'] || '').trim(),
      vtKind: vt.kind, vtFrom: vt.from, disc: /^(na|n\/a|nil|no|none|-|0)$/i.test(disc) ? '' : disc, discRaw: disc,
      remarks: !!String(r['Remarks'] || '').trim(), video: /video/i.test(String(r['Remarks'] || '')) ? 1 : 0, // remark asks for a video consultation (owner, 23 Oct 2026) by: String(r['Submitted by'] || '').trim(),
      testName: TEST_NAME.test(String(r['Customer name'] || '').trim()),
    });
  }
  out.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  // A phone used on a "test" row marks every row with that phone as test (testers reuse their own number).
  const testPhones = new Set(out.filter((x) => x.testName && x.phone).map((x) => x.phone));
  const count = new Map(); out.forEach((x) => x.phone && count.set(x.phone, (count.get(x.phone) || 0) + 1));
  const seenId = new Set(); const first = new Map();
  for (const x of out) {
    x.test = x.testName || (x.phone && testPhones.has(x.phone)) ? 1 : 0;
    const f = [];
    if (x.test) f.push('test_row');
    if (!x.validPhone) f.push('invalid_phone');
    if (x.phone && count.get(x.phone) > 1) f.push('repeat_phone');
    if (!x.id) f.push('no_lead_id'); else if (seenId.has(x.id)) f.push('duplicate_lead_id'); seenId.add(x.id);
    if (!x.s) f.push('store_unmapped');
    if (!x.vd) f.push('no_visit_date'); else if (x.vd < x.d) f.push('visit_before_routing');
    if (x.vtKind === 'blank') f.push('no_visit_time'); else if (x.vtKind === 'other') f.push('visit_time_unreadable');
    if (/^\s*nm\s*-/i.test(x.catRaw)) f.push('category_prefix');
    if (!x.prods.length) f.push('no_product');
    x.flags = f;
    if (!x.test && x.phone) { if (first.has(x.phone)) x.dup = 1; else { first.set(x.phone, x); x.dup = 0; } } else x.dup = 0;
    x.ageD = cutoff ? daysBetween(x.d, cutoff) : null;
  }
  return { routes: out, firstByPhone: first };
}
