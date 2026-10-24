// Bigin "PDP Inventories" pipeline (LimeChat → Bigin integration, live 21 Oct 2026) → PII-free tickets + stage hygiene.
// Read-only analysis: raw stages are kept as recorded; issues are flagged, never fixed in place. Phones, names and remarks
// are used on the server only (matching), never returned.
import { biginDate, phone10, daysBetween } from './dates.js';
import { LC_STORE_TAGS, LC_PDP_TAGS } from './limechat.js';

// Stages seen on the pipeline (21 Oct 2026), in flow order → group. Matching ignores case and spacing.
export const PDP_STAGES = [
  ['New Enquiry', 'new'], ['RNR 1', 'attempt'], ['RNR 2', 'attempt'], ['Callback scheduled', 'attempt'],
  ['Connected - In Discussion', 'connected'], ['Store Visit Scheduled', 'visit'], ['Video Call Scheduled', 'video'], ['Video call arrange', 'video'],
  ['Converted', 'converted'], ['Not Interested', 'lost'],
];
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const GROUP = new Map(PDP_STAGES.map(([s, g]) => [key(s), g]));
export const stageGroupOf = (st) => GROUP.get(key(st)) || (/^videocall(arrang|schedul)/.test(key(st)) ? 'video' : /^rnr/.test(key(st)) ? 'attempt' : 'other');
const H = (a, b) => { const x = Date.parse(a), y = Date.parse(b); return isNaN(x) || isNaN(y) ? null : Math.round((y - x) / 36e5 * 10) / 10; };

// Conversation_Tag carries the LimeChat Level 1 tags (same entry-point rules as the LimeChat export).
export function entryOfTag(ctag) {
  const l1 = String(ctag || '').toLowerCase().split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
  const pdpTag = l1.find((t) => LC_PDP_TAGS[t]); const storeTag = l1.find((t) => t.startsWith('chat_'));
  return { entry: pdpTag ? 'pdp' : storeTag ? 'store_card' : l1.includes('storewidget') ? 'store_widget' : l1.includes('storeinquiry') ? 'store_inquiry' : 'generic',
    pdp: pdpTag ? LC_PDP_TAGS[pdpTag] : '', tagStore: (storeTag && LC_STORE_TAGS[storeTag.slice(5)]) || '' };
}

export const HYGIENE = {
  no_phone: 'No valid phone', dup_phone: 'Repeat phone (earlier ticket)', no_owner: 'No owner', no_store: 'No store',
  no_tag: 'No conversation tag', unknown_stage: 'Stage not in the flow', new_over_24h: 'New Enquiry > 24 h',
  new_over_15m: 'New Enquiry, no call in 15 min', rnr1_over_3h: 'RNR 1, next attempt overdue (3 h)', rnr2_over_3h: 'RNR 2, final attempt overdue (3 h)',
  callback_over_24h: 'Callback scheduled > 24 h', connected_over_24h: 'Connected, not routed in 24 h', visit_date_passed: 'Store Visit Scheduled, visit date passed',
  video_over_48h: 'Video Call Scheduled > 48 h', lost_no_reason: 'Not Interested, no reason', converted_no_order: 'Converted, no DevX order',
  order_not_converted: 'DevX order, stage not Converted', visit_not_routed: 'Store Visit Scheduled, not in routing sheet',
};

// recs: from bigin.js refreshPdpInventories · hist: id → [[stage, firstSeen, approx?]] · ordersByPhone: phone → orders (date-sorted)
// routedOn(phone) → first routing date or null · lcFirst(phone) → first LimeChat-export date or null · storeOf(label) → store id
export function computePdpInv({ recs, hist = {}, meta = null, cutoff, now = new Date().toISOString(), ordersByPhone = new Map(), routedOn = () => null, visitOn = () => null, routedAt = () => null, lcFirst = () => null, storeOf = () => null }) {
  if (!recs) return null;
  const sorted = [...recs].sort((a, b) => String(a.tc || a.ct).localeCompare(String(b.tc || b.ct)) || (a.i < b.i ? -1 : 1));
  const seen = new Set();
  const tickets = sorted.map((x) => {
    const created = x.tc || x.ct; const d = biginDate(created);
    const p = phone10(x.p); const okPhone = !!(p && /^[6-9]/.test(p));
    const dup = okPhone && seen.has(p) ? 1 : 0; if (okPhone) seen.add(p);
    const g = stageGroupOf(x.st); const { entry, pdp, tagStore } = entryOfTag(x.ctag);
    const s = storeOf(x.loc) || tagStore || 'UNMAPPED';
    const h = hist[x.i] && hist[x.i].length ? hist[x.i] : [[x.st, created]];
    const dwellH = h[h.length - 1][2] === 'approx' ? null : H(h[h.length - 1][1], now);
    const ageH = H(created, now);
    const k1 = h.findIndex(([s]) => stageGroupOf(s) !== 'new'); // first time the ticket left New Enquiry
    const tFirst = k1 > 0 && h[k1][2] !== 'approx' ? H(created, h[k1][1]) : null;
    const sk = key(x.st);
    // SOP 02 turnaround times from the recorded stage history (null when a move came before the first read)
    const at = (k) => (h[k] && h[k][2] !== 'approx' ? h[k][1] : null);
    const kR = h.findIndex(([s]) => key(s) === 'rnr1');
    const rnrGap = kR >= 0 && at(kR) && at(kR + 1) ? H(at(kR), at(kR + 1)) : null; // RNR 1 → next attempt
    const kC = h.findIndex(([s]) => ['connected', 'visit', 'video', 'converted'].includes(stageGroupOf(s)));
    const kV = h.findIndex(([s]) => stageGroupOf(s) === 'visit');
    const cHour = Number(new Date(Date.parse(created) + 5.5 * 36e5).toISOString().slice(11, 13));
    const os = okPhone && d ? (ordersByPhone.get(p) || []).filter((o) => o.date >= d && o.date <= cutoff) : [];
    const rd = okPhone ? routedOn(p) : null; const vd = okPhone ? visitOn(p) || '' : ''; const ra = okPhone ? routedAt(p) : null;
    const tForm = kC >= 0 && at(kC) && ra ? Math.round((ra - Date.parse(at(kC))) / 36e5 * 10) / 10 : null; // connected → lead form (routing sheet)
    const visitUpd = vd && kV >= 0 && at(kV + 1) ? daysBetween(vd, biginDate(at(kV + 1))) : null; // visit date → stage updated
    const lc = okPhone ? lcFirst(p) : null;
    const history = (x.tags || []).some((t) => /limechat history/i.test(t)) ? 1 : 0;
    const fl = [];
    if (!okPhone) fl.push('no_phone'); if (dup) fl.push('dup_phone');
    if (!x.own) fl.push('no_owner'); if (s === 'UNMAPPED') fl.push('no_store'); if (!String(x.ctag || '').trim()) fl.push('no_tag');
    if (g === 'other') fl.push('unknown_stage');
    if (g === 'new' && ageH != null && ageH > 24) fl.push('new_over_24h');
    // SOP 02 turnaround rules on the live queue (dwell = time in the current stage; unknown when the move came before the first read)
    if (g === 'new' && ageH != null && ageH > 0.25) fl.push('new_over_15m');
    if (sk === 'rnr1' && dwellH != null && dwellH > 3) fl.push('rnr1_over_3h');
    if (sk === 'rnr2' && dwellH != null && dwellH > 3) fl.push('rnr2_over_3h');
    if (sk === 'callbackscheduled' && dwellH != null && dwellH > 24) fl.push('callback_over_24h');
    if (g === 'connected' && dwellH != null && dwellH > 24) fl.push('connected_over_24h');
    if (g === 'visit' && vd && vd <= cutoff) fl.push('visit_date_passed');
    if (g === 'video' && dwellH != null && dwellH > 48) fl.push('video_over_48h');
    if (g === 'lost' && !String(x.lr || '').trim() && !String(x.rem || '').trim()) fl.push('lost_no_reason');
    if (g === 'converted' && !os.length) fl.push('converted_no_order');
    if (os.length && g !== 'converted') fl.push('order_not_converted');
    if (g === 'visit' && !rd) fl.push('visit_not_routed');
    return {
      i: x.cid, d, st: x.st, g, ag: x.own || '', s, entry, pdp, hist: history, dup, ageH, dwellH, tFirst, rnrGap, tForm, visitUpd, cHour, vd, moves: h.length - 1,
      ord: os.length, net: Math.round(os.reduce((u, o) => u + (o.net || 0), 0)), od: os[0]?.date || '', rt: rd ? 1 : 0, lc: lc ? 1 : 0, lcBefore: lc && d && lc < d ? 1 : 0,
      lr: x.lr ? 1 : 0, rem: x.rem ? 1 : 0, fl,
    };
  });
  // PII-free summary for the hygiene review
  const count = (f) => tickets.reduce((m, t) => { const k = f(t); m[k] = (m[k] || 0) + 1; return m; }, {});
  const flags = {}; for (const t of tickets) for (const f of t.fl) flags[f] = (flags[f] || 0) + 1;
  const byStage = count((t) => t.st || '(blank)');
  const moves = {}; for (const x of recs) { const h = hist[x.i] || []; for (let k = 1; k < h.length; k++) { const m = h[k - 1][0] + ' → ' + h[k][0]; moves[m] = (moves[m] || 0) + 1; } }
  const days = tickets.map((t) => t.d).filter(Boolean).sort();
  return {
    meta: meta ? { refreshedAt: meta.refreshedAt || null, status: meta.status || null, fieldSet: meta.fieldSet ?? null, otherPipelines: meta.otherPipelines ?? null } : null,
    range: days.length ? [days[0], days[days.length - 1]] : null, total: tickets.length,
    byStage, byGroup: count((t) => t.g), byDay: count((t) => t.d), byOwner: count((t) => t.ag || '(none)'), byEntry: count((t) => t.entry), byStore: count((t) => t.s),
    stageByOwner: tickets.reduce((m, t) => { const o = (m[t.ag || '(none)'] = m[t.ag || '(none)'] || {}); o[t.st] = (o[t.st] || 0) + 1; return m; }, {}),
    flags, moves, unknownStages: Object.keys(byStage).filter((s) => stageGroupOf(s) === 'other'),
    overlapLimechat: tickets.filter((t) => t.lc).length, overlapLimechatEarlier: tickets.filter((t) => t.lcBefore).length, historyTagged: tickets.filter((t) => t.hist).length,
    buyers: tickets.filter((t) => t.ord && !t.dup).length, revenue: tickets.filter((t) => !t.dup).reduce((u, t) => u + t.net, 0),
    tickets,
  };
}

// ---------- Cutover: from PDP_INV_FROM the WhatsApp journey is read from Bigin instead of the LimeChat export ----------
// Bigin stage group → the standardised WhatsApp stage the dashboard already uses (owner, 22 Oct 2026 — same as the call rule):
//   consumed = moved past New Enquiry · connected = Connected - In Discussion, Store Visit / Video Call Scheduled, Converted, Not Interested
//   qualified = Connected - In Discussion, Store Visit / Video Call Scheduled, Converted · RNR / Callback scheduled = tried, not connected
const TEXT_STAGE = {
  new: ['assigned_no_action', 0, ''], attempt: ['not_reached', 1, 'not_reached'], connected: ['qualified', 1, 'qualified_other'],
  visit: ['qualified', 1, 'routed_store'], video: ['qualified', 1, 'routed_video'], converted: ['qualified', 1, 'purchased_stated'],
  lost: ['lost', 1, 'lost_not_interested'], other: ['messaged_no_outcome', 1, 'unclassified'],
};
// LimeChat-shaped tickets (server side; the phone is used for matching and dropped before anything leaves the Worker).
export function pinvAsTextTickets(recs, { from, storeOf = () => null } = {}) {
  return (recs || []).map((x) => {
    const created = x.tc || x.ct; const d = biginDate(created); if (!d || (from && d < from)) return null;
    const p = phone10(x.p); const g = stageGroupOf(x.st); const [stage, am, oc] = TEXT_STAGE[g];
    const { entry, pdp, tagStore } = entryOfTag(x.ctag);
    const flags = [];
    if (!(p && /^[6-9]/.test(p))) flags.push('invalid_phone');
    if (g === 'other') flags.push('bigin_stage_unknown');
    if (!x.own) flags.push('bigin_no_owner');
    return {
      id: x.cid || 'bigin:' + x.i, src: 'bigin', ts: Date.parse(created) || 0, d, phone: p, validPhone: !!(p && /^[6-9]/.test(p)),
      status: 'bigin', ho: 1, fa: x.own || '', ca: x.own || '', am, oc, note: '', stage, bst: x.st, entry, pdp,
      store: storeOf(x.loc) || tagStore || '', intent: '', svc: false, l1: [], ooh: false, out: false,
      minsToAssign: null, minsToAgentMsg: null, minsToReply: null, lastBy: '', rnrVariant: [], flags, dup: 0,
    };
  }).filter(Boolean);
}

// One lead per phone across both sources (earliest ticket wins; later ones are duplicates, kept and flagged).
export function mergeTextSources(lcTickets, biginTickets) {
  const tickets = [...lcTickets, ...biginTickets].sort((a, b) => a.ts - b.ts || (String(a.id) < String(b.id) ? -1 : 1));
  const seen = new Map();
  for (const x of tickets) {
    x.flags = (x.flags || []).filter((f) => f !== 'duplicate_phone');
    if (x.svc) continue;
    const k = x.phone || 'ticket:' + x.id;
    if (seen.has(k)) { x.dup = 1; x.flags.push('duplicate_phone'); } else { seen.set(k, x); x.dup = 0; }
  }
  return { tickets, firstByPhone: seen };
}

// Daily coverage check: every LimeChat lead (export) from the cutover should exist in Bigin, by conversation id.
export function reconcile(lcTickets, recs, { from }) {
  const inBigin = new Set((recs || []).map((x) => String(x.cid)));
  const lcIds = new Set(lcTickets.map((x) => String(x.id)));
  const lcEnd = lcTickets.reduce((m, x) => (x.d > m ? x.d : m), '');
  const days = {};
  const day = (d) => (days[d] = days[d] || { d, lcLeads: 0, inBigin: 0, missing: 0, svcInBigin: 0, bigin: 0, notInExport: 0 });
  for (const x of lcTickets) { if (x.d < from) continue; const o = day(x.d); if (x.svc) { if (inBigin.has(String(x.id))) o.svcInBigin++; continue; } o.lcLeads++; if (inBigin.has(String(x.id))) o.inBigin++; else o.missing++; }
  for (const x of recs || []) { const d = biginDate(x.tc || x.ct); if (!d || d < from) continue; const o = day(d); o.bigin++; if (d <= lcEnd && !lcIds.has(String(x.cid))) o.notInExport++; }
  return { from, lcEnd: lcEnd || null, days: Object.values(days).sort((a, b) => (a.d < b.d ? -1 : 1)) };
}
