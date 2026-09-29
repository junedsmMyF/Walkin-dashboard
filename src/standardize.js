// Sales-sheet standardization (agreed Sep 2026). Source sheets are never changed; every tab is
// standardized when the Worker reads it, then all tabs are combined.
//  • Dates  → DD/MM/YYYY, or DD/MM/YYYY HH:MM (24-hour) when the source has a time.
//             Order is decided per column per tab when the column is consistent (a part > 12 proves it; with no proof
//             it is read month-first, as this spreadsheet publishes, and flagged "assumed"). When a column MIXES both
//             orders, every value is resolved on its own (see resolveOrders). ISO and Excel serials are read as-is.
//  • Phones → 10 digits (strips +91 / 91 / leading 0 / spaces).
//  • Numbers → plain numbers (no commas, ₹ or spaces). Yes/No flags → Yes / No / Maybe.
//  • Payment modes → UPPERCASE, one list format "A, B".
//  • "-" blanks and free text (names, emails) are left exactly as in the source.
export const DATE_COLUMNS = ['POS Created At', 'Shopify Created At', 'Returned At'];
export const NUMBER_COLUMNS = ['Quantity', 'Returned Quantity', 'MRP', 'Amount Paid', 'Return Amount', 'Total Coupon Amount', 'Combo Discount Amount', 'Price Adjustment Discount Amount', 'Freebie Discount Amount'];
export const PHONE_COLUMNS = ['Customer Phone'];
export const FLAG_COLUMNS = ['New Customer', 'Heard About Frido'];
export const LIST_COLUMNS = ['Payment Modes'];
const isBlank = (v) => v == null || String(v).trim() === '' || String(v).trim() === '-';
const pad = (n) => String(n).padStart(2, '0');

const SLASH = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;
const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
const SERIAL = /^\d{5}(\.\d+)?$/;

// Look at a whole column of one tab and decide how its slash dates are ordered.
export function detectOrder(values) {
  let dayFirst = 0, monthFirst = 0, slash = 0;
  for (const v of values) {
    const m = String(v || '').trim().match(SLASH); if (!m) continue; slash++;
    const a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) dayFirst++; else if (b > 12 && a <= 12) monthFirst++;
  }
  if (!slash) return { order: 'mdy', basis: 'no slash dates' };
  if (dayFirst && monthFirst) return { order: monthFirst >= dayFirst ? 'mdy' : 'dmy', basis: `conflict (${dayFirst} day-first vs ${monthFirst} month-first values)`, conflict: true };
  if (dayFirst) return { order: 'dmy', basis: `day-first (${dayFirst} values prove it)` };
  if (monthFirst) return { order: 'mdy', basis: `month-first (${monthFirst} values prove it)` };
  return { order: 'mdy', basis: 'assumed month-first (no value above 12 to prove the order)', assumed: true };
}
const validYMD = (y, mo, d) => { if (mo < 1 || mo > 12 || d < 1) return false; return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
function fmt(y, mo, d, hh, mm) { return `${pad(d)}/${pad(mo)}/${y}` + (hh != null ? ` ${pad(hh)}:${pad(mm)}` : ''); }

export function standardizeDate(value, order) {
  const s = String(value ?? '').trim();
  if (isBlank(s)) return { v: value, ok: true, blank: true };
  let m = s.match(ISO);
  if (m) { const [, y, mo, d, hh, mm] = m; return validYMD(+y, +mo, +d) ? { v: fmt(+y, +mo, +d, hh != null ? +hh : null, mm), ok: true } : { v: value, ok: false }; }
  m = s.match(SLASH);
  if (m) {
    let [, a, b, y, hh, mm, , ap] = m; a = +a; b = +b; y = y.length === 2 ? 2000 + +y : +y;
    const [d, mo] = order === 'dmy' ? [a, b] : [b, a];
    if (!validYMD(y, mo, d)) return { v: value, ok: false };
    let H = hh != null ? +hh : null;
    if (H != null && ap) { const pm = ap.toLowerCase() === 'pm'; if (pm && H < 12) H += 12; if (!pm && H === 12) H = 0; }
    return { v: fmt(y, mo, d, H, mm), ok: true };
  }
  if (SERIAL.test(s)) { // Excel/Sheets serial date (days since 1899-12-30)
    const n = parseFloat(s); const t = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
    const hasTime = n % 1 !== 0;
    return { v: fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), hasTime ? t.getUTCHours() : null, pad(t.getUTCMinutes())), ok: true };
  }
  return { v: value, ok: false };
}
export function standardizePhone(value) {
  if (isBlank(value)) return { v: value, ok: true };
  let d = String(value).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  else if (d.length === 13 && d.startsWith('091')) d = d.slice(3);
  return d.length === 10 ? { v: d, ok: true, changed: d !== String(value).trim() } : { v: value, ok: false };
}
export function standardizeNumber(value) {
  if (isBlank(value)) return { v: value, ok: true };
  const s = String(value).replace(/[₹,\s]/g, '').replace(/^Rs\.?/i, '');
  if (/^-?\d+(\.\d+)?$/.test(s)) { const n = Number(s); return { v: String(Number.isInteger(n) ? n : +n.toFixed(2)), ok: true }; }
  return { v: value, ok: false };
}
export function standardizeFlag(value) {
  if (isBlank(value)) return { v: value, ok: true };
  const s = String(value).trim().toLowerCase();
  const map = { yes: 'Yes', y: 'Yes', true: 'Yes', '1': 'Yes', no: 'No', n: 'No', false: 'No', '0': 'No', maybe: 'Maybe' };
  return map[s] ? { v: map[s], ok: true } : { v: value, ok: false };
}
export function standardizeList(value) {
  if (isBlank(value)) return { v: value, ok: true };
  return { v: String(value).split(/[,;|/]+/).map((x) => x.trim().toUpperCase()).filter(Boolean).join(', '), ok: true };
}

// ---- Per-value date resolution (a column may mix month-first and day-first cells) ----
// For each value in a date column:
//  1. a part > 12 proves the order;
//  2. otherwise its written "shape" (zero-padding, year digits, time style) is compared with the shapes of proven
//     values in the same column — e.g. "10/09/2026" (padded) vs "9/2/2026" (unpadded);
//  3. otherwise the other date column in the same row (POS vs Shopify Created At) is used;
//  4. otherwise the Shopify order number sequence: the date must sit between the nearest proven orders;
//  5. otherwise the column majority is used and the value is counted as "unresolved" in the summary.
// formatting signature: zero-padding ("09"), 2- or 4-digit year, time style — how a sheet format writes a date
const shapeOf = (s) => { const m = String(s).trim().match(SLASH); if (!m) return null; const z = /^0\d$/.test(m[1]) || /^0\d$/.test(m[2]); return [z ? 'pad' : 'nopad', m[3].length, m[4] != null ? (m[6] != null ? 'hms' : 'hm') : '-', m[7] ? 'ap' : ''].join('.'); };
function candidates(s) {
  const m = String(s || '').trim().match(SLASH); if (!m) return null;
  const a = +m[1], b = +m[2]; const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  const md = validYMD(y, a, b) ? `${y}-${pad(a)}-${pad(b)}` : null; // month-first reading
  const dm = validYMD(y, b, a) ? `${y}-${pad(b)}-${pad(a)}` : null; // day-first reading
  return { md, dm, proven: a > 12 ? 'dmy' : b > 12 ? 'mdy' : (a === b ? 'same' : null) };
}
function resolveOrders(rows, cols) {
  const orders = {}; const stats = {};
  const shopNum = (r) => { const m = String(r['Shopify Order ID'] || '').match(/(\d{6,})/); return m ? +m[1] : null; };
  for (const c of cols) {
    const col = rows.map((r) => r[c]); const det = detectOrder(col);
    const out = new Array(rows.length).fill(null); const shapes = { mdy: new Map(), dmy: new Map() };
    col.forEach((v, i) => { const k = candidates(v); if (k && (k.proven === 'mdy' || k.proven === 'dmy')) { out[i] = k.proven; const sh = shapeOf(v); shapes[k.proven].set(sh, (shapes[k.proven].get(sh) || 0) + 1); } });
    orders[c] = { out, det, shapes };
    stats[c] = { byShape: 0, byOtherColumn: 0, bySequence: 0, unresolved: 0, mixed: !!det.conflict };
  }
  for (const c of cols) {
    const { out, det, shapes } = orders[c]; const st = stats[c];
    if (!det.conflict) { rows.forEach((r, i) => { if (!out[i]) out[i] = det.order; }); continue; } // consistent column: one order
    // proven (order number → date) points for the sequence check
    const seq = [];
    rows.forEach((r, i) => { const k = candidates(r[c]); const n = shopNum(r); if (k && out[i] && n != null) seq.push([n, out[i] === 'dmy' ? k.dm : k.md]); });
    seq.sort((x, y) => x[0] - y[0]);
    const near = (n) => { let lo = 0, hi = seq.length - 1, prev = null, next = null; while (lo <= hi) { const mid = (lo + hi) >> 1; if (seq[mid][0] <= n) { prev = seq[mid]; lo = mid + 1; } else { next = seq[mid]; hi = mid - 1; } } return [prev, next]; };
    rows.forEach((r, i) => {
      if (out[i]) return; const v = r[c]; const k = candidates(v); if (!k) return;
      if (k.proven === 'same' || !k.md || !k.dm) { out[i] = k.md ? 'mdy' : 'dmy'; return; }
      // 2. shape
      const sh = shapeOf(v); const inM = shapes.mdy.has(sh), inD = shapes.dmy.has(sh);
      if (inM !== inD) { out[i] = inM ? 'mdy' : 'dmy'; st.byShape++; return; }
      // 3. other date column in the same row (only if that one is proven)
      for (const oc of cols) { if (oc === c) continue; const ok = candidates(r[oc]); const oo = orders[oc].out[i]; if (!ok || !oo || !(ok.proven === 'mdy' || ok.proven === 'dmy')) continue; const other = oo === 'dmy' ? ok.dm : ok.md; const dist = (x) => Math.abs(Date.parse(x) - Date.parse(other)); if (dist(k.md) !== dist(k.dm)) { out[i] = dist(k.md) < dist(k.dm) ? 'mdy' : 'dmy'; st.byOtherColumn++; return; } }
      // 4. order-number sequence
      const n = shopNum(r);
      if (n != null) { const [p, q] = near(n); const fits = (x) => (!p || x >= p[1]) && (!q || x <= q[1]); const fm = fits(k.md), fd = fits(k.dm); if (fm !== fd) { out[i] = fm ? 'mdy' : 'dmy'; st.bySequence++; return; } }
      // 5. majority
      out[i] = det.order; st.unresolved++;
    });
  }
  return { orders, stats };
}

// Standardize one tab. Returns rows + a PII-free summary.
export function standardizeTab(rows, tabLabel) {
  const summary = { tab: tabLabel, rows: rows.length, dates: {}, dateResolution: {}, unreadable: {}, phonesChanged: 0 };
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const dateCols = DATE_COLUMNS.filter((c) => cols.includes(c));
  const { orders, stats } = resolveOrders(rows, dateCols);
  for (const c of dateCols) { summary.dates[c] = orders[c].det.conflict ? `mixed: ${orders[c].det.basis.replace('conflict ', '')} — resolved value by value` : orders[c].det.basis; summary.dateResolution[c] = stats[c]; }
  const bad = (c) => { summary.unreadable[c] = (summary.unreadable[c] || 0) + 1; };
  const out = rows.map((r, i) => {
    const o = { ...r };
    for (const c of dateCols) { const x = standardizeDate(r[c], orders[c].out[i] || orders[c].det.order); o[c] = x.v; if (!x.ok) bad(c); }
    for (const c of PHONE_COLUMNS) if (c in r) { const x = standardizePhone(r[c]); o[c] = x.v; if (!x.ok) bad(c); if (x.changed) summary.phonesChanged++; }
    for (const c of NUMBER_COLUMNS) if (c in r) { const x = standardizeNumber(r[c]); o[c] = x.v; if (!x.ok) bad(c); }
    for (const c of FLAG_COLUMNS) if (c in r) { const x = standardizeFlag(r[c]); o[c] = x.v; if (!x.ok) bad(c); }
    for (const c of LIST_COLUMNS) if (c in r) o[c] = standardizeList(r[c]).v;
    o['Source Tab'] = tabLabel;
    return o;
  });
  return { rows: out, summary };
}

// Combine tabs. A line is dropped only if an identical line (same order, product, variant, qty,
// amount and time) already came from an EARLIER tab — repeated identical lines inside one tab are real items.
export function combineTabs(tabs) {
  const lineKey = (r) => [r['POS Order ID'], r['Product Name'], r['Variant Name'], r['Quantity'], r['Amount Paid'], r['POS Created At'], r['Shopify Created At']].join('\u0001');
  const seen = new Map(); const combined = [];
  for (const t of tabs) {
    const here = new Map(); let dropped = 0;
    for (const r of t.rows) {
      const k = lineKey(r); const already = (seen.get(k) || 0); const used = here.get(k) || 0;
      if (used < already) { here.set(k, used + 1); dropped++; continue; } // matches a line from an earlier tab
      here.set(k, used + 1); combined.push(r);
    }
    for (const [k, n] of here) seen.set(k, Math.max(seen.get(k) || 0, n));
    t.summary.duplicatesDropped = dropped; t.summary.rowsKept = t.rows.length - dropped;
  }
  const columns = [...new Set(tabs.flatMap((t) => (t.rows[0] ? Object.keys(t.rows[0]) : [])))];
  return { rows: combined, columns, summary: tabs.map((t) => t.summary) };
}
