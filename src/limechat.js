// LimeChat (WhatsApp, inbox "FES - WA - Karix - 9096417888") → standardised lead journey.
// Built from a column-by-column read of the real export (Oct 2026, 1,126 tickets, 57 columns):
//  • There is NO lead-stage column. "Ticket Status" (closed / bot / open) is the support-ticket state, not the lead stage:
//    the bot auto-closes most chats, and assigned chats are closed with no agent action. It is kept as raw only.
//  • The journey is rebuilt from: Level 1 Tags (entry point · PDP · store card), System Tags (bot flow / customer intent),
//    is_handoff? + First Assignee Name (agent hand-off), First Agent Message Time / Agent Message Blocks (agent WhatsApp reply = "consumed") and
//    Private Notes (the only record of the agent's call outcome — free text, standardised below).
//  • Raw values are always kept next to the standardised ones (auditability). Nothing in the source is modified.
import { daysBetween, phone10 } from './dates.js';

// Export timestamps (IST) → { d: 'YYYY-MM-DD', t: epoch ms (as IST wall clock) }.
// Accepts both export formats seen so far: 'DD-MM-YYYY H:MM' (Sep 2026) and 'YYYY-MM-DD HH:MM:SS' (Oct 2026).
export function lcTime(s) {
  const v = String(s || '').trim();
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) { const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; return { d, t: Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) }; }
  m = v.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const d = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return { d, t: Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)) };
}
const isTrue = (v) => /^true$/i.test(String(v || '').trim());

// Level 1 tag `chat_<store>` (store card "Chat with store") and System Tags store words → store master id
export const LC_STORE_TAGS = {
  skycity: 'FRIDO_0010', skycity_mall: 'FRIDO_0010', atp: 'FRIDO_0003', gachibowli: 'FRIDO_0012', vegas: 'FRIDO_0017', vegas_mall: 'FRIDO_0017',
  omaxe: 'FRIDO_0019', omaxe_world_street: 'FRIDO_0019', amanora: 'FRIDO_0002', banjara: 'FRIDO_0013', banjara_hills: 'FRIDO_0013', lulu: 'FRIDO_0016',
  m5ecity: 'FRIDO_0023', kompally: 'FRIDO_0014', royalmeenakshi: 'FRIDO_0025', elpro: 'FRIDO_0005', moa: 'FRIDO_0009', elan: 'FRIDO_0024',
  westend: 'FRIDO_0006', lakeshore: 'FRIDO_0011', bhartiya: 'FRIDO_0015', dlfsummit: 'FRIDO_0022', pmcviman: 'FRIDO_0001', felix: 'FRIDO_0021',
  pmcwhitefield: 'FRIDO_0020', golfcourse: 'FRIDO_0018', kopa: 'FRIDO_0008',
};
// Level 1 PDP tags → product page
export const LC_PDP_TAGS = {
  ergoluxepdp: 'ErgoLuxe chair', aeromeshpdp: 'AeroMesh chair', '3dposturepdp': '3D Posture Plus chair', glideergopdp: 'Glide Ergo chair',
  classicwithheadrestpdp: 'Classic chair (headrest)', classicwoheadrestpdp: 'Classic chair (no headrest)', vajragamingpdp: 'Vajra gaming chair', embracechairpdp: 'Embrace chair',
};
const SERVICE_TAGS = ['track_order', 'returnexchange', 'cancel_order', 'track_refund', 'track_by_order_id', 'track_by_mobile_no', 'track_another_order', 'flow_name_track_order', 'flow_name_track_order__mobile'];

// Private Notes → standardised call outcome (first matching rule wins; order = most decisive first)
export const NOTE_RULES = [
  ['lost_not_interested', /not interested|no requirement|uninterested|does not want|doea not want|not possible|too far/],
  ['lost_bought_elsewhere', /somewhere else|amazon|elsewhere/],
  ['bought_online_d2c', /purchased from website|order(ing)? online|from app|already ordered/],
  ['purchased_stated', /\bpurchased\b/],
  ['routed_store', /visit|experience|allocated to the store|store team|connected with/],
  ['routed_video', /\bvc\b|video/],
  ['qualified_other', /interested in buying/],
  ['followup_pending', /call (back|later|by|post|\d)|follow ?up|get back|reach out later|call busy will/],
  ['not_reached', /rnr|declined|busy|unanswered|not responded|issue with connecting|unavailable/],
];
export const OUTCOME_LABEL = {
  lost_not_interested: 'Not interested', lost_bought_elsewhere: 'Bought elsewhere', bought_online_d2c: 'Bought / will buy online (D2C)', purchased_stated: 'Says purchased',
  routed_store: 'Store visit / store team', routed_video: 'Video consultation', qualified_other: 'Interested', followup_pending: 'Follow-up pending',
  not_reached: 'Not reached (RNR / declined)', unclassified: 'Note not classifiable',
};
export const noteOutcome = (n) => { const s = String(n || '').toLowerCase().trim(); if (!s) return ''; if (/visit/.test(s) && /online/.test(s) && !/not interested|uninterested|not possible/.test(s)) return 'routed_store'; for (const [k, re] of NOTE_RULES) if (re.test(s)) return k; return 'unclassified'; };
const RNR_RE = /r\s*n\s*r\s*\d?/gi;

// Standardised reporting stage (one per ticket). Raw "Ticket Status" is never used as a stage.
export const STAGES = [
  ['service', 'Not a lead (order / return query)'], ['bot_only', 'Bot only — never handed to an agent'], ['handoff_unassigned', 'Handed off, no agent assigned'],
  ['assigned_no_action', 'Assigned, no agent action recorded'], ['messaged_no_outcome', 'Agent messaged, outcome not logged'],
  ['not_reached', 'Agent tried, not reached'], ['followup_pending', 'Reached, follow-up pending'], ['qualified', 'Qualified (store / video / interested)'],
  ['lost', 'Lost'], ['online', 'Bought online (stated)'],
];
const stageOf = (x) => {
  if (x.svc) return 'service';
  if (!x.fa && !x.ho) return 'bot_only';
  if (!x.fa) return 'handoff_unassigned';
  if (x.oc === 'not_reached') return 'not_reached';
  if (x.oc === 'followup_pending') return 'followup_pending';
  if (['routed_store', 'routed_video', 'qualified_other', 'purchased_stated'].includes(x.oc)) return 'qualified';
  if (x.oc === 'lost_not_interested' || x.oc === 'lost_bought_elsewhere') return 'lost';
  if (x.oc === 'bought_online_d2c') return 'online';
  if (x.am) return 'messaged_no_outcome';
  return 'assigned_no_action';
};

// rows = parseCsv() objects with the LimeChat export headers.
export function standardiseLimechat(rows, { cutoff } = {}) {
  const tickets = [];
  for (const r of rows) {
    const c = lcTime(r['Created At']); if (!c) continue;
    const l1 = String(r['Level 1 Tags (Main)'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const sys = String(r['System Tags'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const has = (t) => sys.includes(t);
    const pdpTag = l1.find((t) => LC_PDP_TAGS[t]);
    const storeTag = l1.find((t) => t.startsWith('chat_'));
    const store = (storeTag && LC_STORE_TAGS[storeTag.slice(5)]) || (sys.map((t) => LC_STORE_TAGS[t]).find(Boolean)) || '';
    const entry = pdpTag ? 'pdp' : storeTag ? 'store_card' : l1.includes('storewidget') ? 'store_widget' : l1.includes('storeinquiry') ? 'store_inquiry' : 'generic';
    const intent = SERVICE_TAGS.some(has) || sys.some((t) => /^mf\d/.test(t)) ? 'service'
      : sys.some((t) => /video/.test(t)) ? 'video_request'
      : has('schedule_a_visit') || has('flow_name_schedule_a_visit') ? 'visit_request'
      : has('request_call_back') || has('flow_name_call_cta') ? 'callback_request'
      : has('talk_to_agent') || has('flow_name_agent_handoff') ? 'agent_request'
      : has('flow_name_chair_pdp') ? 'product_question'
      : has('store_locator_pincode') || has('flow_name_store_locator__city') || has('locate_store_near_you') ? 'store_locator' : 'other';
    const raw = String(r['Phone Number'] || '').replace(/\D/g, '');
    const phone = phone10(raw);
    const fa = String(r['First Assignee Name'] || '').trim(), ca = String(r['Current Agent'] || '').trim();
    // Consumed = a backend agent replied on WhatsApp. Two independent signals in the export: First Agent Message Time
    // and Agent Message Blocks (> 0). They disagree on some tickets (blocks but no time) — either counts; the gap is flagged.
    const famRaw = String(r['First Agent Message Time'] || '').trim(), blocks = +String(r['Agent Message Blocks'] || '0').trim() || 0;
    const am = !!famRaw || blocks > 0;
    const note = String(r['Private Notes'] || '').trim();
    const oc = noteOutcome(note);
    const asg = lcTime(r['First Assigned Time']), fam = lcTime(r['First Agent Message Time']);
    const name = String(r['Customer Name'] || '').trim();
    const x = {
      id: String(r['Ticket ID'] || ''), d: c.d, ts: c.t, phone, validPhone: /^91[6-9]\d{9}$/.test(raw) || /^[6-9]\d{9}$/.test(raw),
      status: String(r['Ticket Status'] || '').trim(), ho: isTrue(r['is_handoff?']), res: isTrue(r['is_resolved?']),
      ooh: isTrue(r['is_outside_working_hours?']), out: isTrue(r['is_outbound?']), fa, ca, am, agentBlocks: blocks, replyTimeMissing: blocks > 0 && !famRaw,
      note, oc, l1: l1.join(', '), entry, pdp: pdpTag ? LC_PDP_TAGS[pdpTag] : '', store, intent, svc: intent === 'service',
      lastBy: String(r['Last Message Sent By'] || '').trim(),
      minsToAssign: asg ? Math.round((asg.t - c.t) / 60000) : null, minsToAgentMsg: asg && fam ? Math.round((fam.t - asg.t) / 60000) : null,
      minsToReply: fam ? Math.round((fam.t - c.t) / 60000) : null,
      junkName: /^[?.\-\s]*$/.test(name) || /E\+\d+$/i.test(name) || /^\d+$/.test(name),
      rnrVariant: (note.match(RNR_RE) || []).map((v) => v.replace(/\s+/g, ' ').trim()),
    };
    x.stage = stageOf(x);
    // hygiene flags (source is never changed — these are shown next to the raw values)
    const f = [];
    if (!x.validPhone) f.push('invalid_phone');
    if (x.junkName) f.push('junk_name');
    if (x.fa && !x.ho) f.push('assigned_without_handoff');
    if (x.replyTimeMissing) f.push('reply_time_missing');
    if (x.out) f.push('outbound');
    if (x.ho && !x.fa) f.push('handoff_without_agent');
    if (x.fa && x.status === 'bot') f.push('assigned_but_bot_status');
    if (x.fa && x.status === 'closed' && !x.am && !x.note) f.push('closed_without_action');
    if (x.fa && x.ca && x.fa !== x.ca) f.push('reassigned');
    if (x.oc === 'unclassified') f.push('note_unclassifiable');
    if (cutoff && x.status === 'open' && !x.am && !x.note && daysBetween(x.d, cutoff) >= 2) f.push('open_stale');
    x.flags = f;
    tickets.push(x);
  }
  tickets.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  // one lead per phone: first sales ticket wins; later ones are duplicates (kept, flagged)
  const seen = new Map();
  for (const x of tickets) {
    if (x.svc) continue;
    const k = x.phone || 'ticket:' + x.id;
    if (seen.has(k)) { x.dup = 1; x.flags.push('duplicate_phone'); } else { seen.set(k, x); x.dup = 0; }
  }
  return { tickets, firstByPhone: seen };
}

// Which journey dates are missing (days with < 3 tickets inside the covered range) — flags export gaps.
export function coverageGaps(tickets) {
  if (!tickets.length) return [];
  const byDay = {}; tickets.forEach((x) => { byDay[x.d] = (byDay[x.d] || 0) + 1; });
  const days = Object.keys(byDay).sort(); const gaps = []; let run = null;
  for (let d = days[0]; d <= days[days.length - 1];) {
    if ((byDay[d] || 0) < 3) { run = run || { from: d, to: d, n: 0 }; run.to = d; run.n += byDay[d] || 0; } else if (run) { if (daysBetween(run.from, run.to) >= 2) gaps.push(run); run = null; }
    const [y, m, dd] = d.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, dd + 1)); d = t.toISOString().slice(0, 10);
  }
  if (run && daysBetween(run.from, run.to) >= 2) gaps.push(run);
  return gaps;
}
