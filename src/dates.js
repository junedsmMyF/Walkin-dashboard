// All dates are handled as IST calendar dates in 'YYYY-MM-DD'.
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const validDate = (y, m, d) => y >= 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31;

// Sales rows are standardized before they reach the metrics (src/standardize.js): 'DD/MM/YYYY' or
// 'DD/MM/YYYY HH:MM'. ISO 'YYYY-MM-DD…' (reference exports) is also accepted.
export function salesDate(s) {
  s = String(s || '').trim(); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return validDate(+m[1], +m[2], +m[3]) ? iso(+m[1], +m[2], +m[3]) : null;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (!m) return null;
  return validDate(+m[3], +m[2], +m[1]) ? iso(+m[3], +m[2], +m[1]) : null;
}
// DSR sheet: 'DD/MM/YYYY' or ISO 'YYYY-MM-DD'. Timestamp is 'DD/MM/YYYY HH:MM:SS'.
export function dsrDate(s) {
  s = String(s || '').trim(); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return validDate(+m[1], +m[2], +m[3]) ? iso(+m[1], +m[2], +m[3]) : null;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (!m) return null;
  return validDate(+m[3], +m[2], +m[1]) ? iso(+m[3], +m[2], +m[1]) : null;
}
export function dsrTimestamp(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return 0;
  return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
}
// Bigin ISO with offset, e.g. '2026-08-05T20:35:00+05:30' → IST date.
export function biginDate(s) {
  if (!s) return null; const t = Date.parse(s); if (isNaN(t)) return null;
  return istDate(new Date(t));
}
export function istDate(d = new Date()) {
  const t = new Date(d.getTime() + 330 * 60000);
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export function addDays(isoStr, n) {
  const [y, m, d] = isoStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export function daysBetween(a, b) { // b − a in days
  const [y1, m1, d1] = a.split('-').map(Number); const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
export const phone10 = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
