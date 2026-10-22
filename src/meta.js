// Meta ads (Retail Revenue) — two Meta ad journeys from lead to store: Lead Gen website (Bigin) and CTWA (LimeChat).
// Returns PII-free rows only: Bigin record id, dates, city, store, ad, stage flags. Never names or phones.
//
// Sources
//   Lead Gen  : Bigin "Meta Ergo Workspace Assessment" pipeline (META_PIPELINE_ID) — REAL, same daily refresh as walk-in (T-1).
//   Stage history (RNR attempts, stage when lost, first touch) — not synced yet; those cards show "Awaiting data source".
//   CTWA      : LimeChat export — not connected → SAMPLE rows (seeded per day, stable between refreshes), flagged sample.
//   Spend     : Ads Manager — not connected → SAMPLE cost per lead per ad.
//   Revenue   : DevX phone match (on/after capture date) — not wired yet → SAMPLE order values on won leads.
//
// Rules (agreed 29 Sep 2026 — do not change without the owner):
//   Net leads exclude Close Lost Reason = Duplicate Lead / Test Lead and test UTMs.
//   City comes from the preferred store. Funnel is strict: visits only from Bigin visit stages, never inferred from a sale.
import { biginDate } from './dates.js';

// Bigin "Preferred Store" → dashboard name, Meta city, store master id
export const META_STORES = {
  'Borivali — Skycity Mall, Devipada': ['Skycity Mall, Borivali', 'Mumbai', 'FRIDO_0010'],
  'Hadapsar — Amanora Mall': ['Amanora Mall, Hadapsar', 'Pune', 'FRIDO_0002'],
  'Chinchwad — Elpro City Square': ['Elpro City Square, Chinchwad', 'Pune', 'FRIDO_0005'],
  'Balewadi — Amar Tech Park': ['Amar Tech Park, Balewadi', 'Pune', 'FRIDO_0003'],
  'Viman Nagar — Phoenix Marketcity': ['Phoenix Marketcity, Viman Nagar', 'Pune', 'FRIDO_0001'],
  'Dwarka — Vegas Mall, Sector 14': ['Vegas Mall, Dwarka', 'Delhi NCR', 'FRIDO_0017'],
  'Faridabad — Omaxe World Street, Sector 79': ['Omaxe World Street, Faridabad', 'Delhi NCR', 'FRIDO_0019'],
  'Aundh — Nexus Westend': ['Nexus Westend, Aundh', 'Pune', 'FRIDO_0006'],
  'Gurugram — Golf Course Rd, DLF Phase 1 / Sector 28': ['Golf Course Road, Gurugram', 'Delhi NCR', 'FRIDO_0018'],
  'Koregaon Park — Kopa Mall': ['Kopa Mall, Koregaon Park', 'Pune', 'FRIDO_0008'],
  'Gurugram — DLF Summit Plaza, Sector 54': ['DLF Summit Plaza, Gurugram', 'Delhi NCR', 'FRIDO_0022'],
  'Gurugram — Felix Plaza, Sector 82A': ['Felix Plaza, Gurugram', 'Delhi NCR', 'FRIDO_0021'],
  'Gurugram — Elan Miracle, Sector 84': ['Elan Miracle, Gurugram', 'Delhi NCR', 'FRIDO_0024'],
};
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const STORE_INDEX = new Map(Object.entries(META_STORES).map(([k, v]) => [norm(k), v]));
const CITIES = { 'delhi ncr': 'Delhi NCR', delhi: 'Delhi NCR', pune: 'Pune', mumbai: 'Mumbai' };

const CONVERSATION_LOSS = new Set(['Out of Budget', 'Purchased from Competitor', 'Product is not meeting the use case of the cx', 'Cx Hung Up', 'Cx Needs Customization', 'No store near cx location', 'Could not meet delivery timeline', 'Particular SKU not available']);
const CONTACT_STAGES = new Set(['Whatsapp connected', 'Follow-up Scheduled', 'Physio Visited Home', 'Visit Scheduled', 'Store Visit Scheduled', 'Cx Visited Store', 'Store Visit Follow-up', 'Service Completed & Sold']);
const VISIT_SCHED = new Set(['Visit Scheduled', 'Store Visit Scheduled', 'Physio Visited Home', 'Cx Visited Store', 'Store Visit Follow-up']);
const VISITED = new Set(['Physio Visited Home', 'Cx Visited Store', 'Store Visit Follow-up']);
const WON = 'Service Completed & Sold', LOST = 'Not Interested';

// UTM content = ad name: MyFrido-LeadGen__CID04__ASID02__3828-V2__SHB__Vatsal__10092026__WebsiteLeadGen__ErgoAssessment__Marathi__BOM/PNQ__Video__Inhouse
export function parseAd(content, campaign) {
  const u = String(content || '').trim();
  if (/claude_verify|e2e|^test/i.test(u) || /e2e_test/i.test(String(campaign || ''))) return { ad: 'Test lead (e2e)', adset: 'test', lang: '—', test: true };
  if (!u) return { ad: 'Unattributed (no UTM)', adset: '—', lang: '—' };
  const p = u.split('__');
  if (p.length >= 11) return { ad: `${p[2]} · ${p[3]} · ${p[9]} · ${p[10]}`, adset: p[2], lang: p[9] };
  return { ad: u.slice(0, 80), adset: '—', lang: '—' };
}
// Close Won Reason is free text; keep only something shaped like a DevX order id (never free text into the browser).
export const orderIdOf = (s) => (String(s || '').toUpperCase().match(/\b[A-Z]{2}\d{8,}\b/) || [null])[0];

export function leadGenRow(x) {
  const st = x.st || 'Yet to Call';
  const m = STORE_INDEX.get(norm(x.ps));
  const lostReason = x.lr && x.lr !== '-None-' ? x.lr : null;
  const ad = parseAd(x.ux, x.uc);
  const won = st === WON, lost = st === LOST;
  return {
    id: String(x.i), type: 'leadgen', created: biginDate(x.ct), city: m ? m[1] : CITIES[String(x.city || '').toLowerCase()] || 'Unmapped', store: m ? m[0] : null, storeId: m ? m[2] : null,
    ad: ad.ad, adset: ad.adset, lang: ad.lang, stage: st, lastStage: won || lost ? null : st, rnr: /^RNR/.test(st) ? +st.replace(/\D/g, '') || 0 : null, ftt: null,
    lostReason, orderId: won ? orderIdOf(x.cw) : null,
    consumed: st !== 'Yet to Call', connected: CONTACT_STAGES.has(st) || (lost && CONVERSATION_LOSS.has(lostReason)),
    vsched: VISIT_SCHED.has(st), visited: VISITED.has(st), won, lost, junk: lostReason === 'Duplicate Lead' || lostReason === 'Test Lead' || !!ad.test,
  };
}

// ---------- SAMPLE layer (CTWA leads, spend, order values) — seeded, so numbers stay put between refreshes ----------
const seed = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x6D2B79F5) >>> 0; return (h >>> 8) / 16777216; }; };
const pick = (r, arr, w) => { if (!w) return arr[Math.floor(r() * arr.length)]; let t = r() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < arr.length; i++) { t -= w[i]; if (t < 0) return arr[i]; } return arr[arr.length - 1]; };
const CT_ADS = [['ASID01 · 4102-V1 · Eng · PNQ/BOM', 70], ['ASID01 · 4102-V3 · Eng · PNQ/BOM', 38], ['ASID02 · 4110-H2 · Marathi · PNQ', 33], ['ASID03 · 4118-V1 · Eng · DEL', 24]];
const CT_STORES = { Pune: ['Amanora Mall, Hadapsar', 'Elpro City Square, Chinchwad', 'Phoenix Marketcity, Viman Nagar', 'Nexus Westend, Aundh', 'Amar Tech Park, Balewadi', 'Kopa Mall, Koregaon Park'], Mumbai: ['Skycity Mall, Borivali'], 'Delhi NCR': ['Vegas Mall, Dwarka', 'Omaxe World Street, Faridabad', 'Golf Course Road, Gurugram', 'Elan Miracle, Gurugram'] };
// LimeChat status, weight, consumed, connected, assessed, vsched, visited, won, lost
const CT_BUCKETS = [['New – not replied yet', 15, 0, 0, 0, 0, 0, 0, 0], ['In conversation', 32, 1, 1, 0, 0, 0, 0, 0], ['Assessment completed', 12, 1, 1, 1, 0, 0, 0, 0], ['Report shared', 26, 1, 1, 1, 0, 0, 0, 0], ['Store visit scheduled', 14, 1, 1, 1, 1, 0, 0, 0], ['Visited store', 13, 1, 1, 1, 1, 1, 0, 0], ['Purchased', 6, 1, 1, 1, 1, 1, 1, 0], ['Lost', 47, 1, 1, 0, 0, 0, 0, 1]];
const CT_LOST = [['Stopped responding', 22, 0], ['Not Interested', 8, 1], ['Out of Budget', 7, 1], ['No store near cx location', 5, 1], ['Wants online delivery', 3, 1], ['Purchased from Competitor', 2, 1]];
const ORDER_VALUES = [18990, 22490, 24990, 27980, 34480, 41480];
// Sample cost per lead by ad (₹), shaped on the 29 Sep design; any new ad falls back to SAMPLE_CPL_DEFAULT.
export const SAMPLE_CPL = { leadgen: { 'ASID02 · 3828-V2 · Marathi · BOM/PNQ': 630, 'ASID01 · 3819-H8 · Eng · DEL/BOM/PNQ': 750, 'ASID02 · 3828-V1 · Marathi · BOM/PNQ': 890, 'Unattributed (no UTM)': 600, 'Test lead (e2e)': 0 }, ctwa: { 'ASID01 · 4102-V1 · Eng · PNQ/BOM': 585, 'ASID01 · 4102-V3 · Eng · PNQ/BOM': 725, 'ASID02 · 4110-H2 · Marathi · PNQ': 665, 'ASID03 · 4118-V1 · Eng · DEL': 810 } };
export const SAMPLE_CPL_DEFAULT = 700;

export function sampleCtwa(startDate, cutoff) {
  const out = [];
  for (let d = startDate; d <= cutoff; d = addDay(d)) {
    const r = seed('ctwa|' + d); const n = 5 + Math.floor(r() * 7);
    for (let k = 0; k < n; k++) {
      const b = pick(r, CT_BUCKETS, CT_BUCKETS.map((x) => x[1])); const city = pick(r, ['Pune', 'Mumbai', 'Delhi NCR'], [55, 25, 20]);
      const ad = pick(r, CT_ADS, CT_ADS.map((x) => x[1]))[0]; const [, , cons, conn, ass, vs, vis, won, lost] = b;
      const row = { id: `W-${d.replace(/-/g, '').slice(2)}-${k + 1}`, type: 'ctwa', created: d, city, store: pick(r, CT_STORES[city]), storeId: null, ad, adset: ad.split(' · ')[0], lang: ad.split(' · ')[2],
        stage: b[0], lastStage: b[0], rnr: null, ftt: null, lostReason: null, orderId: null, consumed: !!cons, connected: !!conn, assessed: !!ass, vsched: !!vs, visited: !!vis, won: !!won, lost: !!lost, junk: false,
        flow: ass && r() < 0.75 ? 'A1' : 'A2', sample: true };
      if (lost) { const l = pick(r, CT_LOST, CT_LOST.map((x) => x[1])); row.lostReason = l[0]; row.connected = !!l[2]; row.lastStage = l[2] ? 'In conversation' : 'No reply after follow-ups'; }
      if (won) row.orderValue = pick(r, ORDER_VALUES);
      out.push(row);
    }
  }
  return out;
}
const addDay = (d) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

export function computeMeta({ leads = [], startDate = '2026-09-09', cutoff }) {
  const lg = leads.map(leadGenRow).filter((x) => x.created && x.created >= startDate && x.created <= cutoff);
  for (const x of lg) if (x.won) x.orderValue = pick(seed('ov|' + x.id), ORDER_VALUES);   // sample until the DevX match is wired
  const ct = sampleCtwa(startDate, cutoff);
  const stageCounts = {}; for (const x of lg) stageCounts[x.stage] = (stageCounts[x.stage] || 0) + 1;
  return {
    startDate, cutoff, leads: [...lg, ...ct], cpl: SAMPLE_CPL, cplDefault: SAMPLE_CPL_DEFAULT,
    counts: { leadgen: lg.length, ctwa: ct.length, unmapped: lg.filter((x) => !x.store).length, stages: stageCounts },
  };
}
