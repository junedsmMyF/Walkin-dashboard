// PDP inventories (Retail Revenue) — website PDP → lead → store visit → retail revenue.
// Reference: Whimsical "Frido — D2C → Retail CTA Flow" (Oct 2026). Returns aggregated, PII-free rows only.
//
// Sources
//   Call route  : Bigin "Callback Requests" pipeline (website Call Store pop-up) — REAL, refreshed daily (T-1).
//   Revenue     : BigQuery retail sales already in this Worker (same orders as walk-in) — REAL, matched by phone.
//   Text route  : LimeChat export — REAL (secret LIMECHAT_CSV_URL), standardised in limechat.js.
//   Routing     : Lead routing sheet (WhatsApp DSR groups → Google Sheet) — REAL (secret ROUTING_CSV_URL), routing.js.
//   PDP layer   : GA4 / Shopify PDP views + CTA clicks — not connected yet → SAMPLE data, flagged isSample.
//
// Proposed rules (pending owner sign-off — mirror the walk-in rules where they apply):
//   Unique lead     = first Callback record per phone (last 10 digits) in the pipeline; later records for the same phone are duplicates.
//   Attributed order= any DevX order (any store, any type) on or AFTER the lead's created date for the same phone.
//                     Same day counts here (a caller can visit the same evening); walk-in uses strictly-after because
//                     the lead is captured in-store after a purchase.
//   Sales credit    = billing store; the store the caller asked for keeps "requested" credit.
//   Revenue         = Total Revenue (gross − discount), as walk-in. Gross also returned.
//   Overlap         = attributed order whose phone ALSO has an earlier walk-in lead → shown as shared, never double-counted silently.
import { STORE_MASTER, EXCLUDED_STORE_IDS, storeFromDsr, storeFromBigin } from './stores.js';
import { STAGE_GROUPS } from './metrics.js';
import { categoryOf } from './categories.js';
import { salesDate, biginDate, daysBetween, phone10, addDays } from './dates.js';
import { standardiseLimechat, coverageGaps } from './limechat.js';
import { standardiseRouting, routedKind } from './routing.js';
import { computePdpInv, pinvAsTextTickets, mergeTextSources, reconcile, stageGroupOf } from './pdpinv.js';
import { buildLeadList, summariseLeads, attributeOrders, leadRows, REPEAT_DAYS, ORDER_DAYS } from './leads.js';

// Website store labels (Store_Name1, set by the Call Store pop-up) that the store master does not already know.
export const WEB_STORE_ALIASES = {
  'Frido Store, Vegas Mall': 'FRIDO_0017', 'Omaxe World Street': 'FRIDO_0019', 'Bhartiya Mall, BLR': 'FRIDO_0015',
  'Elpro Mall, Chinchwad': 'FRIDO_0005', 'Elan Miracle': 'FRIDO_0024', 'DLF Summit': 'FRIDO_0022', 'Golf Course Rd, Gurugram': 'FRIDO_0018',
  'Royal Meenakshi': 'FRIDO_0025', 'Phoenix Whitefield': 'FRIDO_0020', 'Amar Tech Park, Pune': 'FRIDO_0003', 'Amanora Mall, Pune': 'FRIDO_0002',
  'Mall of Asia, BLR': 'FRIDO_0009', 'Kopa Mall, Pune': 'FRIDO_0008', 'Kompally, HYD': 'FRIDO_0014', 'Lakeshore, Hyderabad': 'FRIDO_0011',
  // Lead routing sheet labels (WhatsApp DSR group)
  'Felix, Gurgaon': 'FRIDO_0021', 'PMC, Vimannagar': 'FRIDO_0001',
};
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const WEB_INDEX = new Map(Object.entries(WEB_STORE_ALIASES).map(([k, v]) => [norm(k), v]));
export const storeFromWeb = (label, loc, owner) => (label && (WEB_INDEX.get(norm(label)) || storeFromDsr(label))) || storeFromBigin(loc, owner) || null;

// Callback stages → groups. Extends the walk-in groups with the two stages only this pipeline uses.
const CALL_STAGE = { ...STAGE_GROUPS, Connected: 'engaged', Resolved: 'resolved', 'Store Visit Follow-up': 'visit', 'Cx Visited Store': 'visit', 'Visit Scheduled': 'visitPlan', 'Store Visit Scheduled': 'visitPlan' };
// Video consult arranged = Bigin stage "Video call arrange" (owner, 22 Oct 2026) — a qualified stage. Spelling variants accepted.
export const isVcStage = (st) => /^video\s*call\s*arrang/i.test(String(st || '').trim());
const stageGroup = (st) => (isVcStage(st) ? 'vcPlan' : CALL_STAGE[st] || (st ? 'other' : 'blank'));
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : 0; };
const hamming1 = (a, b) => { if (!a || !b || a.length !== b.length || a === b) return false; let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++d > 1) return false; return d === 1; };
const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 6);

// Backend agents: every lead is owned by the backend agent who works it (Bigin owner / LimeChat first assignee).
// Final flow (Whimsical "Frido PDP lead funnel and store routing", updated 21 Oct 2026) — a qualified lead converts two ways:
//   store  = agent routes the lead to a store on the WhatsApp DSR group → customer visits → bill by store staff
//   video  = video consult with the store team → order placed by the store team
// (The earlier "order punched by backend agent" branch was removed from the flow.)
// Conversion route of each order (owner, 22 Oct 2026):
//   store = lead is in the routing sheet and the order date = its expected visit date (store visit conversion)
//   video = lead is NOT in the routing sheet, a video call was arranged (Bigin "Video call arrange" / "Video Call Scheduled",
//           LimeChat video outcome) and the order is on/after the lead date (video call conversion)
//   other = anything else (routed but bought on another day, or no routing / video call). pb = basis of the route.
const agentKey = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').trim().split(/\s+/).filter(Boolean);
export function isAgentName(emp, agents) {
  const e = agentKey(emp); if (!e.length) return false;
  return agents.some((a) => { const k = agentKey(a); if (!k.length) return false; if (k.join(' ') === e.join(' ')) return true;
    return k[0] === e[0] && (!k[1] || !e[1] || k[1][0] === e[1][0]); }); // "Raj B" ~ "Raj Bhardwaj"
}
export function computePdp({ callbacks = [], walkinLeads = [], salesRows = [], limechatRows = null, routingRows = null, pdpInv = null, pdpInvFrom = null, startDate, cutoff, sample = true, backendAgents = [] }) {
  const callStart = startDate;
  const LC0 = limechatRows ? standardiseLimechat(limechatRows, { cutoff }) : null;
  // WhatsApp source (owner, 22 Oct 2026): LimeChat export before PDP_INV_FROM, Bigin PDP Inventories from it. One lead per phone across both.
  const cut = pdpInvFrom && pdpInv && pdpInv.recs ? pdpInvFrom : null;
  const LC = cut ? mergeTextSources(LC0 ? LC0.tickets.filter((x) => x.d < cut) : [], pinvAsTextTickets(pdpInv.recs, { from: cut, storeOf: (l) => storeFromWeb(l) })) : LC0;
  if (LC && LC.tickets.length && LC.tickets[0].d < startDate) startDate = LC.tickets[0].d; // LimeChat history starts earlier than Callback Requests
  const inRange = (d) => d && d >= startDate && d <= cutoff;
  const quality = { noPhone: 0, badPhone: 0, unmappedStores: {}, futureDates: 0 };

  // ---------- Orders (one per POS Order ID; same build as walk-in) ----------
  const orders = new Map();
  for (const r of salesRows) {
    if (String(r['Ret/Exc'] || '').trim().toUpperCase() === 'CANCELLED') continue;
    const store = (r['Store ID'] || '').trim(); if (!store || EXCLUDED_STORE_IDS.has(store)) continue;
    const date = salesDate(r['POS Created At']) || salesDate(r['Shopify Created At']); if (!date) continue;
    const id = r['POS Order ID'] || r['Shopify Order ID']; if (!id) continue;
    let o = orders.get(id);
    if (!o) { o = { id, date, store, phone: phone10(r['Customer Phone']), type: (r['Order Type'] || '').toUpperCase(), emp: String(r['Employee Name'] || '').trim(), net: 0, gross: 0, lines: [] }; orders.set(id, o); }
    const g = r.__gross != null ? num(r.__gross) : num(r['Amount Paid']);
    const n = r.__net != null ? num(r.__net) : g - num(r['Return Amount']);
    o.gross += g; o.net += n; o.lines.push({ p: String(r['Product Name'] || '(no product name)').trim(), net: n, gross: g, qty: num(r['Quantity']) || 1 });
  }
  const ordersByPhone = new Map();
  for (const o of orders.values()) if (o.phone) (ordersByPhone.get(o.phone) || ordersByPhone.set(o.phone, []).get(o.phone)).push(o);
  for (const a of ordersByPhone.values()) a.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));

  // Earliest walk-in date per phone (for overlap with the walk-in vertical).
  const walkinFirst = new Map();
  for (const l of walkinLeads) { const p = phone10(l.p); const d = biginDate(l.d) || biginDate(l.ct); if (!p || !d) continue; if (!walkinFirst.has(p) || d < walkinFirst.get(p)) walkinFirst.set(p, d); }

  // Lead routing sheet (store routing from the WhatsApp DSR group) — read first so every lead can be marked routed.
  const RT = routingRows ? standardiseRouting(routingRows, { storeOf: (l) => storeFromWeb(l), cutoff }) : null;
  // In the routing sheet (routed by the cutoff) = store visit scheduled = qualified, whatever the recorded stage (owner, 22 Oct 2026).
  // The raw stage is kept; the mismatch is flagged on Data quality.
  const routedBy = (p) => !!(p && RT && RT.firstByPhone.has(p) && RT.firstByPhone.get(p).d <= cutoff);
  // A routed lead is a video call when the routing remark mentions video (owner, 23 Oct 2026) or Bigin says video:
  // PDP Inventories "Video Call Scheduled" / Callback Requests "Video call arrange", any ticket date (owner, 24 Oct 2026).
  const biginVideo = new Set([...((pdpInv && pdpInv.recs) || []).filter((r) => stageGroupOf(r.st) === 'video').map((r) => phone10(r.p)), ...callbacks.filter((c) => isVcStage(c.st)).map((c) => phone10(c.p))].filter(Boolean));
  // Interaction type first (owner, 27 Oct 2026); blank rows: remark "video" or Bigin video stage, as before
  const routedVideo = (p) => routedBy(p) && routedKind(RT.firstByPhone.get(p), { biginVideo: biginVideo.has(p) }).video;
  const biginVisit = new Set([...((pdpInv && pdpInv.recs) || []).filter((r) => stageGroupOf(r.st) === 'visit').map((r) => phone10(r.p)), ...callbacks.filter((c) => stageGroup(c.st) === 'visitPlan').map((c) => phone10(c.p))].filter(Boolean));
  const QUAL_G = new Set(['engaged', 'visitPlan', 'vcPlan', 'visit', 'crmWon']);
  if (LC) for (const x of LC.tickets) if (!x.svc && x.stage !== 'qualified' && routedBy(x.phone)) { x.stageRaw = x.stage; x.stage = 'qualified'; x.am = 1; x.oc = 'routed_store'; x.flags.push('routed_stage_mismatch'); }

  // ---------- Callback leads ----------
  const raw = callbacks.map((c) => {
    const ct = c.ct ? Date.parse(c.ct) : NaN; const d = biginDate(c.ct);
    const p = phone10(c.p); if (!c.p) quality.noPhone++; else if (!p || !/^[6-9]/.test(p)) quality.badPhone++;
    let s = storeFromWeb(c.web, c.loc, c.own); if (!s) { const k = c.web || c.loc || '(blank)'; quality.unmappedStores[k] = (quality.unmappedStores[k] || 0) + 1; s = 'UNMAPPED'; }
    const touchedH = c.mt && !isNaN(ct) ? (Date.parse(c.mt) - ct) / 3600e3 : 0;
    return { id: String(c.i || ''), d, ts: ct, p, nm: nameKey(c.nm), s, st: c.st || '', g: stageGroup(c.st), lr: c.lr || '', prod: c.prod || '', cat: c.cat || '', utm: !!(c.us || c.um || c.uc || c.ux), utmSrc: c.us || '', touchedH, ag: String(c.own || '').trim() };
  }).filter((x) => x.d).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));

  const firstByPhone = new Map(); const seenNames = [];
  const leads = [];
  for (const x of raw) {
    let dup = 0, near = 0;
    if (x.p) { if (firstByPhone.has(x.p)) dup = 1; else firstByPhone.set(x.p, x); }
    if (!dup && x.p && x.nm) { if (seenNames.some((y) => y.nm === x.nm && hamming1(y.p, x.p))) near = 1; seenNames.push(x); }
    if (x.d > cutoff) { if (daysBetween(cutoff, x.d) > 2) quality.futureDates++; continue; }
    if (!inRange(x.d)) continue;
    const ageD = daysBetween(x.d, cutoff);
    const rt = routedBy(x.p), rsm = rt && !QUAL_G.has(x.g) ? 1 : 0; const g = rsm ? 'visitPlan' : x.g; // routed → qualified (visit planned)
    leads.push({
      i: x.id.slice(-6), d: x.d, s: x.s, st: x.st, g, rsm, dup, near, ag: x.ag || '', cons: rsm || (x.st && x.st !== 'Yet to Call') ? 1 : 0, // consumed = moved past Yet to Call
      prod: x.prod ? 1 : 0, cat: x.cat || (x.prod ? categoryOf(x.prod.split(' || ')[0]) : ''), utm: x.utm ? 1 : 0,
      lostNoReason: g === 'lost' && !x.lr ? 1 : 0, lr: x.lr || '',
      stale: g === 'notCalled' && ageD >= 2 ? 1 : 0, ageD,
      untouched: x.touchedH < 0.05 ? 1 : 0,
      wk: x.p && walkinFirst.has(x.p) && walkinFirst.get(x.p) <= x.d ? 1 : 0, // caller was already a walk-in lead
      rt: rt && !routedVideo(x.p) ? 1 : 0, vc: isVcStage(x.st) || routedVideo(x.p) ? 1 : 0, // store visit scheduled (routing sheet) · VC arranged (Bigin)
    });
  }

  // ---------- Attribution: order on/after the unique lead date, same phone, any store ----------
  const agents = [...new Set([...raw.map((x) => x.ag).filter(Boolean), ...(LC ? LC.tickets.map((x) => x.fa).filter(Boolean) : []), ...backendAgents])];
  const vcPhones = new Set([...raw.filter((x) => x.p && isVcStage(x.st)).map((x) => x.p), ...(LC ? LC.tickets.filter((x) => !x.svc && x.phone && x.oc === 'routed_video').map((x) => x.phone) : [])]);
  const pathBasis = (p, o) => { const r = p && RT && RT.firstByPhone.get(p);
    // Routing row whose remark mentions video = video consultation via the store team: order on/after the visit (call) date counts.
    if (r && r.d <= cutoff && r.video) return o.date >= (r.vd || r.d) ? 'vc_routed' : 'routed_other_day';
    if (r && r.d <= cutoff) return r.vd && o.date === r.vd ? 'visit_day' : 'routed_other_day';
    return vcPhones.has(p) ? 'vc_arranged' : 'none'; };
  const pathOf = (p, o) => ({ visit_day: 'store', vc_arranged: 'video', vc_routed: 'video' })[pathBasis(p, o)] || 'other';
  // Lead routing sheet (store routing from the WhatsApp DSR group). Routed phone → earliest routing date.
  const routedOn = (p, d) => (RT && p && RT.firstByPhone.has(p) && RT.firstByPhone.get(p).d <= d ? 1 : 0);
  const attributed = []; const wonStageNoOrder = []; const orderNoWonStage = [];
  const productRev = new Map();
  const pIdx = new Map(); const pNames = []; const pid = (n) => { if (!pIdx.has(n)) { pIdx.set(n, pNames.length); pNames.push(n); } return pIdx.get(n); };
  const lines = []; // order lines from attributed orders: {d, ld, s, cs, p, c, net, qty}
  for (const [p, first] of firstByPhone) {
    if (!inRange(first.d)) continue;
    const os = (ordersByPhone.get(p) || []).filter((o) => o.date >= first.d && o.date <= cutoff);
    const wk = walkinFirst.has(p) && walkinFirst.get(p) < (os[0]?.date || '9999');
    os.forEach((o, k) => {
      attributed.push({ o: o.id, d: o.date, ld: first.d, s: o.store, cs: first.s, t: o.type || 'RETAIL', net: Math.round(o.net), gross: Math.round(o.gross), first: k === 0 ? 1 : 0, lag: daysBetween(first.d, o.date), shared: wk ? 1 : 0, same: o.date === first.d ? 1 : 0, path: pathOf(p, o), pb: pathBasis(p, o), ag: first.ag || '', by: isAgentName(o.emp, agents) ? o.emp : '', rtd: routedOn(p, o.date) });
      for (const ln of o.lines) lines.push({ o: o.id, d: o.date, ld: first.d, s: o.store, cs: first.s, p: pid(ln.p), c: categoryOf(ln.p), net: Math.round(ln.net), gross: Math.round(ln.gross), qty: ln.qty, r: 'c' });
      for (const ln of o.lines) { const v = productRev.get(ln.p) || { p: ln.p, c: categoryOf(ln.p), net: 0, gross: 0, qty: 0, n: 0 }; v.net += ln.net; v.gross += ln.gross; v.qty += ln.qty; v.n++; productRev.set(ln.p, v); }
    });
    if (first.g === 'crmWon' && !os.length) wonStageNoOrder.push(first.id.slice(-6));
    if (os.length && first.g !== 'crmWon') orderNoWonStage.push(first.id.slice(-6));
  }

  // ---------- LimeChat (text) — real tickets, standardised; raw values kept ----------
  let text = null;
  if (LC) {
    const callPhones = new Set(raw.map((x) => x.p).filter(Boolean));
    const tAttr = [];
    for (const [k, first] of LC.firstByPhone) {
      if (!first.phone || !first.validPhone || !inRange(first.d)) continue;
      const os = (ordersByPhone.get(first.phone) || []).filter((o) => o.date >= first.d && o.date <= cutoff);
      const wk = walkinFirst.has(first.phone) && walkinFirst.get(first.phone) < (os[0]?.date || '9999');
      os.forEach((o, j) => {
        tAttr.push({ o: o.id, i: first.id, d: o.date, ld: first.d, s: o.store, cs: first.store || 'UNMAPPED', t: o.type || 'RETAIL', net: Math.round(o.net), gross: Math.round(o.gross), first: j === 0 ? 1 : 0, lag: daysBetween(first.d, o.date), shared: wk ? 1 : 0, call: callPhones.has(first.phone) ? 1 : 0, path: pathOf(first.phone, o), pb: pathBasis(first.phone, o), ag: first.fa || '', stage: first.stage, pdp: first.pdp, entry: first.entry, rtd: routedOn(first.phone, o.date) });
        for (const ln of o.lines) lines.push({ o: o.id, d: o.date, ld: first.d, s: o.store, cs: first.store || 'UNMAPPED', p: pid(ln.p), c: categoryOf(ln.p), net: Math.round(ln.net), gross: Math.round(ln.gross), qty: ln.qty, r: 't' });
      });
    }
    const mask = (n) => String(n || '').replace(/\d{7,}/g, '#').slice(0, 120);
    text = {
      source: cut ? `LimeChat export until ${addDays(cut, -1)} · Bigin PDP Inventories from ${cut}` : 'LimeChat export (WhatsApp inbox FES - WA - Karix - 9096417888)', cutover: cut, start: LC.tickets[0]?.d || null, end: LC.tickets[LC.tickets.length - 1]?.d || null,
      tickets: LC.tickets.filter((x) => inRange(x.d)).map((x) => ({ i: x.id, d: x.d, st: x.stage, sr: x.stageRaw || '', rt: routedBy(x.phone) && !routedVideo(x.phone) ? 1 : 0, vc: x.oc === 'routed_video' || routedVideo(x.phone) ? 1 : 0, raw: x.status, src: x.src === 'bigin' ? 'b' : 'l', bst: x.bst || '', ho: x.ho ? 1 : 0, ag: x.fa, ca: x.ca, am: x.am ? 1 : 0, oc: x.oc, note: mask(x.note), entry: x.entry, pdp: x.pdp, s: x.store || 'UNMAPPED', intent: x.intent, svc: x.svc ? 1 : 0, dup: x.dup ? 1 : 0, ooh: x.ooh ? 1 : 0, ma: x.minsToAssign, mm: x.minsToAgentMsg, mr: x.minsToReply, l1: x.l1, fl: x.flags, last: x.lastBy, rnr: x.rnrVariant, ageD: daysBetween(x.d, cutoff), call: x.phone && callPhones.has(x.phone) ? 1 : 0 })),
      attributed: tAttr, gaps: coverageGaps(LC.tickets),
    };
  }

  // ---------- Routing sheet: routed lead → source lead → DevX order on/after routing date ----------
  let routing = null;
  if (RT) {
    const lcFirst = LC ? LC.firstByPhone : new Map();
    routing = {
      source: 'Lead routing backend (Google Sheet fed by the WhatsApp DSR groups)',
      start: RT.routes[0]?.d || null, end: RT.routes[RT.routes.length - 1]?.d || null, total: RT.routes.length,
      routes: RT.routes.filter((x) => x.d >= startDate).map((x) => {
        const cl = x.phone ? firstByPhone.get(x.phone) : null; const tl = x.phone ? lcFirst.get(x.phone) : null;
        const lead = [cl && { d: cl.d, src: 'call', ag: cl.ag, en: 'call_popup' }, tl && { d: tl.d, src: 'text', ag: tl.fa, en: tl.entry }].filter(Boolean).sort((a, b) => (a.d < b.d ? -1 : 1))[0];
        const os = !x.test && x.phone ? (ordersByPhone.get(x.phone) || []).filter((o) => o.date >= x.d && o.date <= cutoff) : [];
        const o = os[0];
        return {
          i: x.id, d: x.d, it: x.itype, s: x.s || 'UNMAPPED', sr: x.storeRaw, p: x.prods[0] || '', np: x.prods.length, c: x.cat, cr: x.catRaw, vd: x.vd, vt: x.vtKind, vh: x.vtFrom,
          disc: x.disc ? 1 : 0, dv: x.disc.slice(0, 12), rem: x.remarks ? 1 : 0, by: x.by, fl: x.flags, test: x.test, dup: x.dup, after: x.d > cutoff ? 1 : 0,
          src: cl && tl ? 'both' : cl ? 'call' : tl ? 'text' : '', en: lead ? lead.en : '', ld: lead ? lead.d : '', lag: lead ? daysBetween(lead.d, x.d) : null, ag: lead ? lead.ag || '' : '',
          od: o ? o.date : '', os: o ? o.store : '', same: o ? (o.store === x.s ? 1 : 0) : 0, net: Math.round(os.reduce((s, y) => s + y.net, 0)), gross: Math.round(os.reduce((s, y) => s + y.gross, 0)), n: os.length,
          path: o ? pathOf(x.phone, o) : '', onTime: o && x.vd ? (o.date <= x.vd ? 1 : 0) : 0, vlag: o && x.vd ? daysBetween(x.vd, o.date) : null,
        };
      }),
    };
  }

  const stores = STORE_MASTER.map((s) => ({ id: s.id, name: s.name, city: s.city, format: s.format }));
  stores.push({ id: 'UNMAPPED', name: 'Store not recognised', city: '—', format: null });

  const salesDaily = new Map();
  for (const o of orders.values()) { if (!inRange(o.date)) continue; const k = o.date + '|' + o.store; const v = salesDaily.get(k) || { d: o.date, s: o.store, net: 0, gross: 0, n: 0 }; v.net += o.net; v.gross += o.gross; v.n++; salesDaily.set(k, v); }
  const out = {
    startDate, callStart, cutoff, generatedAt: new Date().toISOString(), stores, text, routing,
    call: { leads, attributed, lines, pnames: pNames, salesDaily: [...salesDaily.values()].map((v) => ({ ...v, net: Math.round(v.net), gross: Math.round(v.gross) })), products: [...productRev.values()].map((v) => ({ ...v, net: Math.round(v.net), gross: Math.round(v.gross) })).sort((a, b) => b.net - a.net) },
    agents,
    quality: { ...quality, wonStageNoOrder: wonStageNoOrder.length, orderNoWonStage: orderNoWonStage.length, rawRecords: raw.length, uniquePhones: firstByPhone.size },
    rules: { attribution: 'Order on or after lead date · same phone · any store', uniqueLead: 'First record per phone', revenue: 'Total Revenue = gross − discount' },
  };
  // Bigin PDP Inventories (LimeChat → Bigin) — read-only stage / disposition hygiene review, PII-free
  if (pdpInv) out.pinv = computePdpInv({ ...pdpInv, cutoff, ordersByPhone, storeOf: (l) => storeFromWeb(l),
    routedOn: (p) => (RT && RT.firstByPhone.has(p) ? RT.firstByPhone.get(p).d : null), visitOn: (p) => (RT && RT.firstByPhone.has(p) ? RT.firstByPhone.get(p).vd : null), routedAt: (p) => (RT && RT.firstByPhone.has(p) ? RT.firstByPhone.get(p).ts : null), lcFirst: (p) => (LC0 && LC0.firstByPhone.has(p) ? LC0.firstByPhone.get(p).d : null) });
  if (out.pinv && cut && LC0) out.pinv.recon = reconcile(LC0.tickets, pdpInv.recs, { from: cut });
  // Step 3 of the PDP rebuild: one lead list across Call Store + WhatsApp (LimeChat before the cutover, Bigin from it). Summary only.
  {
    const ok = (ph) => !!(ph && /^[6-9]/.test(ph));
    // funnel flags per contact (owner, 22 Oct 2026: call rule) — call: Bigin stage group · WhatsApp: standardised stage
    const CONN_G = new Set(['engaged', 'visitPlan', 'vcPlan', 'visit', 'crmWon', 'lost', 'resolved', 'other']), QUAL_G2 = new Set(['engaged', 'visitPlan', 'vcPlan', 'visit', 'crmWon']);
    const callF = (x) => ({ cons: !!(x.st && x.st !== 'Yet to Call'), conn: CONN_G.has(x.g), qual: QUAL_G2.has(x.g), lost: x.g === 'lost' });
    // interest and loss reason per contact (product category: Bigin field, else the product page tag) · loss: Bigin Close Lost Reason,
    // else the standardised LimeChat outcome; a note / remark mentioning distance = store too far
    const FAR = /(far|distance|location|too away|nearby store)/i;
    const OC_LOST = { lost_not_interested: 'Not interested', lost_bought_elsewhere: 'Bought elsewhere', bought_online_d2c: 'Bought / will buy online' };
    const lossOf = (lr, text, oc) => (lr ? String(lr).trim() : FAR.test(text || '') ? 'Store too far' : OC_LOST[oc] || '');
    const textI = (x) => ({ ci: x.cat || (x.pdp ? categoryOf(x.pdp) : ''), pp: x.pdp || '', lr: x.stage === 'lost' || x.stage === 'online' ? lossOf(x.lr, x.note || x.rem, x.oc) : '' });
    const textF = (x) => ({ cons: !!x.am, conn: ['followup_pending', 'qualified', 'lost', 'online'].includes(x.stage), qual: x.stage === 'qualified', lost: x.stage === 'lost' || x.stage === 'online' });
    const contacts = [
      ...raw.map((x) => ({ src: 'call', id: x.id, ts: x.ts, d: x.d, phone: x.p || null, valid: ok(x.p), entry: 'call_popup', store: x.s, vc: isVcStage(x.st), ag: x.ag, ...callF(x), ci: x.cat || (x.prod ? categoryOf(x.prod.split(' || ')[0]) : ''), pp: '', lr: x.g === 'lost' ? lossOf(x.lr, '', '') : '' })),
      ...(LC0 ? LC0.tickets.filter((x) => !x.svc && (!cut || x.d < cut)).map((x) => ({ src: 'limechat', id: x.id, ts: x.ts, d: x.d, phone: x.phone || null, valid: !!x.validPhone, entry: x.entry, store: x.store, vc: x.oc === 'routed_video', ag: x.fa, ...textF(x), ...textI(x) })) : []),
      ...(cut ? pinvAsTextTickets(pdpInv.recs.filter((r) => !(r.tags || []).some((t) => /limechat history/i.test(t))), { from: cut, storeOf: (l) => storeFromWeb(l) }).map((x) => ({ src: 'bigin', id: x.id, ts: x.ts, d: x.d, phone: x.phone || null, valid: !!x.validPhone, entry: x.entry, store: x.store, vc: x.oc === 'routed_video', ag: x.fa, ...textF(x), ...textI(x) })) : []),
    ];
    const llIdx = new Map(), llNames = []; const llPid = (n) => { if (!llIdx.has(n)) { llIdx.set(n, llNames.length); llNames.push(n); } return llIdx.get(n); };
    const LL = attributeOrders(buildLeadList({ contacts, routes: RT ? RT.routes.filter((r) => r.d <= cutoff) : [], ordersByPhone, videoPhones: biginVideo, visitPhones: biginVisit }), ordersByPhone, { cutoff });
    out.leadList = { rules: { repeatDays: REPEAT_DAYS, orderDays: ORDER_DAYS, cutover: cut, sources: 'Call Store (Bigin Callback Requests) · LimeChat export before the cutover · Bigin PDP Inventories from it' },
      mtd: summariseLeads(LL, { from: cutoff.slice(0, 8) + '01', to: cutoff }), all: summariseLeads(LL, { from: startDate, to: cutoff }),
      rows: leadRows(LL, { from: startDate, to: cutoff, pid: llPid, catOf: categoryOf }), pnames: llNames };
  }
  if (sample) out.sample = buildSample({ startDate, cutoff, stores: STORE_MASTER });
  return out;
}

// ---------- SAMPLE data (deterministic) — replaced when LimeChat + GA4 exports are connected ----------
// Products are real myfrido.com PDPs; every number below is illustrative only.
export const SAMPLE_PDPS = [
  ['Frido 3D Posture Plus Ergonomic Chair', 'Chairs', 5200], ['Frido ErgoLuxe Executive Chair', 'Chairs', 3100], ['Frido Ergoluxe Electric Standing Desk', 'Workspace', 2100],
  ['Frido Ultimate Mattress Topper', 'Mattress', 4600], ['Frido Ultimate Pro Seat Cushion', 'Cushions', 7800], ['Frido Adjustable Wedge Max Cushion', 'Cushions', 2600],
  ['Frido Cloud Comfort Arch Support Slippers', 'Footwear', 9400], ["Frido Active Walking Shoes - Men's", 'Footwear', 6100], ['Frido Barefoot Sock Shoe Classic', 'Barefoot', 5300],
  ['Frido Dual Gel Pro Insoles', 'Insoles', 4800], ['Frido Orthotics Posture Corrector Pro', 'Orthotics', 3900], ['Frido Travel Neck Pillow', 'Pillows', 4400],
];
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

export function buildSample({ startDate, cutoff, stores }) {
  const pdpDaily = [];
  for (let d = startDate; d <= cutoff; d = addDays(d, 1)) {
    const r = rng(hash('pdp' + d)); const wkend = [0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay());
    SAMPLE_PDPS.forEach(([name, cat, base], i) => {
      const views = Math.round(base * 0.35 * (0.85 + r() * 0.3) * (wkend ? 1.18 : 1));
      const ctr = 0.004 + r() * 0.006; // retail-CTA clicks per PDP view (floating widget is desktop-only)
      const raw = Math.round(views * ctr * (cat === 'Chairs' || cat === 'Workspace' || cat === 'Mattress' ? 1.8 : 1));
      const wa = Math.round(raw * (0.34 + r() * 0.1)), call = Math.round(raw * (0.18 + r() * 0.08));
      pdpDaily.push({ d, p: i, views, clicks: wa + call, wa, call }); // lead CTAs only (Get Direction excluded — not a lead)
    });
  }
  return { isSample: true, note: 'Illustrative PDP views / CTA clicks — replace with GA4 / Shopify PDP data.', pdps: SAMPLE_PDPS.map(([n, c]) => ({ n, c })), pdpDaily };
}
