// Writes the bot tables to Cloudflare D1. Sales and store-day rows are replaced only for the recent date window
// (keeps daily writes far below D1's free 100,000 rows/day); leads are replaced in full (their status changes).
import { BOT_TABLES, DATE_COL } from './tables.js';
const lit = (v) => (v == null || (typeof v === 'number' && !isFinite(v)) ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
export async function ensureSchema(db) {
  const stmts = [];
  for (const [t, cols] of Object.entries(BOT_TABLES)) {
    stmts.push(db.prepare(`CREATE TABLE IF NOT EXISTS ${t} (${cols.map(([c, ty]) => `${c} ${ty}`).join(', ')})`));
    stmts.push(db.prepare(`CREATE INDEX IF NOT EXISTS ix_${t}_date ON ${t}(${DATE_COL[t]})`));
  }
  stmts.push(db.prepare('CREATE TABLE IF NOT EXISTS bot_meta (k TEXT PRIMARY KEY, v TEXT)'));
  await db.batch(stmts);
}
export async function syncBotTables(db, built, { fromDate = null } = {}) {
  await ensureSchema(db);
  let written = 0;
  for (const [t, cols] of Object.entries(BOT_TABLES)) {
    const dc = cols.findIndex(([c]) => c === DATE_COL[t]);
    const full = !fromDate || t === 'leads';
    const rows = full ? built.tables[t] : built.tables[t].filter((r) => r[dc] >= fromDate);
    const stmts = [db.prepare(full ? `DELETE FROM ${t}` : `DELETE FROM ${t} WHERE ${DATE_COL[t]} >= ?`).bind(...(full ? [] : [fromDate]))];
    for (let i = 0; i < rows.length; i += 250) stmts.push(db.prepare(`INSERT INTO ${t} (${cols.map(([c]) => c).join(',')}) VALUES ${rows.slice(i, i + 250).map((r) => '(' + r.map(lit).join(',') + ')').join(',')}`));
    for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
    written += rows.length;
  }
  await db.batch([db.prepare("INSERT OR REPLACE INTO bot_meta (k, v) VALUES ('data_through', ?), ('start_date', ?), ('built_at', ?)").bind(built.dataThrough, built.startDate, new Date().toISOString())]);
  return { written, fromDate: fromDate || 'full' };
}
