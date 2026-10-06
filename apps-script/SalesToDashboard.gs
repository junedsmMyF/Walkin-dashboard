/**
 * Frido · Walk-in dashboard · Daily sales sync (BigQuery → dashboard)
 * ------------------------------------------------------------------
 * Runs as YOU (your existing BigQuery access) — no service account, no IAM, no files.
 * Every day at 08:00 IST it queries the last 7 days of retail sales, cleans and enriches them,
 * validates them and sends them (compressed) to the dashboard, which replaces just those dates.
 *
 * One-time setup (see README in this folder):
 *   1. Project Settings → Script properties: DASHBOARD_URL, ADMIN_KEY
 *   2. Run `backfill` once (loads 1 Sep 2026 → yesterday), approve the permissions prompt
 *   3. Run `setup` once (creates the daily 08:00 IST trigger)
 *
 * Business rules (agreed Oct 2026): gross = qty × price · revenue (headline) = gross − discount ·
 * cancelled and refunded orders kept · test store FRIDO_0000 excluded · dates in IST.
 */
var CONFIG = {
  PROJECT_ID: 'frido-429506',
  START_DATE: '2026-09-01',        // first date the dashboard counts
  DAILY_LOOKBACK_DAYS: 7,          // re-sync the last 7 days every morning (catches late edits, refunds, cancellations)
  TEST_STORES: ['FRIDO_0000'],
  KNOWN_STORES: ['FRIDO_0001','FRIDO_0002','FRIDO_0003','FRIDO_0005','FRIDO_0006','FRIDO_0008','FRIDO_0009','FRIDO_0010','FRIDO_0011','FRIDO_0012','FRIDO_0013','FRIDO_0014','FRIDO_0015','FRIDO_0016','FRIDO_0017','FRIDO_0018','FRIDO_0019','FRIDO_0020','FRIDO_0021','FRIDO_0022','FRIDO_0023','FRIDO_0024','FRIDO_0025'],
  OUT_COLS: ['order_date','order_id','store_id','store_name','employee_name','order_type','phone','financial_status','is_cancelled','sku','product_name','category','quantity','price','gross','discount','net','discount_codes']
};

var SQL = [
  'WITH staff_orders AS (',
  '  SELECT id, name, financial_status, customer_phone, created_at, cancelled_at, line_items, discount_codes',
  '  FROM `frido-429506.Frido_Local_Dev.shopify_orders_view`',
  '  QUALIFY ROW_NUMBER() OVER (PARTITION BY name ORDER BY _daton_batch_runtime DESC) = 1',
  '),',
  'retail_orders AS (',
  '  SELECT order_name, store_id, store_name, employee_name, delivery_type',
  '  FROM `frido-429506.Frido_Local_Dev.retail_pos_orders_flat`',
  '  QUALIFY ROW_NUMBER() OVER (PARTITION BY order_name ORDER BY order_date_ist DESC) = 1',
  ')',
  'SELECT',
  "  DATE(CAST(t.created_at AS TIMESTAMP), 'Asia/Kolkata') AS order_date_ist,",
  '  t.name AS order_name, r.store_id, r.store_name, r.employee_name, r.delivery_type,',
  "  RIGHT(REGEXP_REPLACE(t.customer_phone, r'\\D', ''), 10) AS customer_phone,",
  '  t.financial_status, t.cancelled_at IS NOT NULL AS is_cancelled,',
  '  li.sku, li.title AS product_name, li.quantity, CAST(li.price AS NUMERIC) AS price,',
  '  IFNULL((SELECT SUM(CAST(da.amount AS NUMERIC)) FROM UNNEST(li.discount_allocations) da), 0) AS discount_amount,',
  '  (li.quantity * CAST(li.price AS NUMERIC)) - IFNULL((SELECT SUM(CAST(da.amount AS NUMERIC)) FROM UNNEST(li.discount_allocations) da), 0) AS revenue,',
  "  (SELECT STRING_AGG(dc.code, ', ') FROM UNNEST(t.discount_codes) dc) AS discount_codes",
  'FROM staff_orders t',
  'INNER JOIN retail_orders r ON TRIM(t.name) = TRIM(r.order_name)',
  'LEFT JOIN UNNEST(t.line_items) li',
  "WHERE DATE(CAST(t.created_at AS TIMESTAMP), 'Asia/Kolkata') BETWEEN @start AND @end"
].join('\n');

// ---------- entry points ----------
function runDaily() {                         // the 08:00 IST trigger calls this
  var to = ymd_(addDays_(todayIst_(), -1));
  var from = ymd_(addDays_(todayIst_(), -CONFIG.DAILY_LOOKBACK_DAYS));
  if (from < CONFIG.START_DATE) from = CONFIG.START_DATE;
  return syncRange_(from, to, { requireLastDay: true });
}
function backfill() {                         // run once by hand; loads START_DATE → yesterday month by month
  var end = ymd_(addDays_(todayIst_(), -1)), d = CONFIG.START_DATE, out = [];
  while (d <= end) {
    var monthEnd = ymd_(new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)));
    var to = monthEnd < end ? monthEnd : end;
    out.push(syncRange_(d, to, { requireLastDay: false }));
    d = ymd_(addDays_(parseYmd_(to), 1));
  }
  return out;
}
function setup() {                            // run once by hand; (re)creates the daily trigger at 08:00 IST
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'runDaily') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runDaily').timeBased().atHour(8).nearMinute(0).everyDays(1).inTimezone('Asia/Kolkata').create();
  Logger.log('Daily trigger set: runDaily at 08:00 IST');
}

// ---------- pipeline ----------
function syncRange_(from, to, opts) {
  var started = Date.now();
  try {
    var raw = query_(from, to);                                   // 1 · extract
    var res = transform_(raw);                                    // 2 · clean + features
    var summary = validate_(res, from, to, opts);                 // 3 · validate (throws on critical)
    summary.query = raw.stats; summary.seconds = Math.round((Date.now() - started) / 1000);
    var ack = post_(from, to, res.rows, summary);                 // 4 · send
    Logger.log('Synced %s → %s: %s lines, %s orders, revenue ₹%s · dashboard now holds %s lines', from, to, summary.lines, summary.orders, Math.round(summary.revenue), ack.totalRows);
    return summary;
  } catch (e) {
    notify_('Walk-in dashboard: sales sync FAILED (' + from + ' → ' + to + ')', String(e && e.stack || e) + '\n\nThe dashboard keeps its previous data. Fix and run runDaily() again from the Apps Script editor.');
    throw e;
  }
}

function query_(from, to) {
  var req = { query: SQL, useLegacySql: false, parameterMode: 'NAMED', timeoutMs: 120000, maxResults: 20000,
    queryParameters: [
      { name: 'start', parameterType: { type: 'DATE' }, parameterValue: { value: from } },
      { name: 'end', parameterType: { type: 'DATE' }, parameterValue: { value: to } }] };
  var r = BigQuery.Jobs.query(req, CONFIG.PROJECT_ID);
  var job = r.jobReference, loc = job.location;
  while (!r.jobComplete) { Utilities.sleep(1500); r = BigQuery.Jobs.getQueryResults(CONFIG.PROJECT_ID, job.jobId, { location: loc, maxResults: 20000 }); }
  var names = r.schema.fields.map(function (f) { return f.name; });
  var rows = [], page = r;
  while (true) {
    (page.rows || []).forEach(function (row) { var o = {}; row.f.forEach(function (c, k) { o[names[k]] = c.v; }); rows.push(o); });
    if (!page.pageToken) break;
    page = BigQuery.Jobs.getQueryResults(CONFIG.PROJECT_ID, job.jobId, { location: loc, pageToken: page.pageToken, maxResults: 20000 });
  }
  return { rows: rows, stats: { jobId: job.jobId, bytesProcessed: Number(r.totalBytesProcessed || 0), rows: rows.length } };
}

function transform_(raw) {
  var test = {}; CONFIG.TEST_STORES.forEach(function (s) { test[s] = 1; });
  var out = [], orders = {}, cancelled = {}, refunded = {}, stats = { testLines: 0, invalidPhone: 0, revenueMismatch: 0, negative: 0, unknownStores: {} };
  var known = {}; CONFIG.KNOWN_STORES.forEach(function (s) { known[s] = 1; });
  raw.rows.forEach(function (r) {
    var storeId = str_(r.store_id).toUpperCase();
    if (test[storeId]) { stats.testLines++; return; }
    if (!known[storeId]) stats.unknownStores[storeId] = (stats.unknownStores[storeId] || 0) + 1;
    var qty = num_(r.quantity), price = num_(r.price), disc = num_(r.discount_amount);
    var gross = round2_(qty * price), net = round2_(gross - disc);
    if (Math.abs(net - num_(r.revenue)) > 0.02) stats.revenueMismatch++;
    if (qty < 0 || price < 0) stats.negative++;
    var digits = str_(r.customer_phone).replace(/\D/g, '').slice(-10);
    var phone = /^[6-9]\d{9}$/.test(digits) ? digits : '';
    if (!phone) stats.invalidPhone++;
    var dtype = str_(r.delivery_type).toUpperCase();
    var id = str_(r.order_name), status = str_(r.financial_status).toLowerCase(), isCanc = String(r.is_cancelled).toLowerCase() === 'true';
    orders[id] = 1; if (isCanc) cancelled[id] = 1; if (status === 'refunded' || status === 'partially_refunded') refunded[id] = 1;
    out.push([str_(r.order_date_ist), id, storeId, str_(r.store_name), str_(r.employee_name),
      (dtype === 'CASH_AND_CARRY' || dtype === 'ONLINE_ORDER') ? dtype : 'OTHER', phone, status, isCanc,
      str_(r.sku), str_(r.product_name), categoryOf_(r.product_name), qty, round2_(price), gross, round2_(disc), net, str_(r.discount_codes)]);
  });
  return { rows: out, stats: stats, orders: Object.keys(orders).length, cancelled: Object.keys(cancelled).length, refunded: Object.keys(refunded).length };
}

function validate_(res, from, to, opts) {
  var s = res.stats, warn = [], fail = [];
  var dates = {}; res.rows.forEach(function (r) { dates[r[0]] = 1; });
  if (opts.requireLastDay && !dates[to]) fail.push('no orders for ' + to + ' (BigQuery not updated yet?)');
  if (s.revenueMismatch) fail.push(s.revenueMismatch + ' lines where revenue ≠ qty × price − discount');
  if (s.negative) fail.push(s.negative + ' lines with negative quantity or price');
  if (Object.keys(s.unknownStores).length) warn.push('unknown store ids ' + JSON.stringify(s.unknownStores) + ' — add them to the dashboard store list');
  if (res.rows.length && s.invalidPhone / res.rows.length > 0.05) warn.push(Math.round(100 * s.invalidPhone / res.rows.length) + '% of lines have no valid phone');
  if (fail.length) throw new Error('Critical checks failed — NOT sending: ' + fail.join('; '));
  var revenue = 0, gross = 0; res.rows.forEach(function (r) { revenue += r[16]; gross += r[14]; });
  return { run_at_ist: Utilities.formatDate(new Date(), 'Asia/Kolkata', "yyyy-MM-dd'T'HH:mm"), source: 'apps-script', date_min: from, date_max: to,
    lines: res.rows.length, orders: res.orders, revenue: round2_(revenue), gross: round2_(gross), cancelled_orders: res.cancelled, refunded_orders: res.refunded,
    invalid_phone_lines: s.invalidPhone, test_store_lines_removed: s.testLines, checks_failed: 0, checks_warned: warn.length, warnings: warn };
}

function post_(from, to, rows, summary) {
  var p = PropertiesService.getScriptProperties();
  var url = String(p.getProperty('DASHBOARD_URL') || '').replace(/\/+$/, ''), key = p.getProperty('ADMIN_KEY');
  if (!url || !key) throw new Error('Set Script properties DASHBOARD_URL and ADMIN_KEY (Project Settings → Script properties)');
  var body = Utilities.gzip(Utilities.newBlob(JSON.stringify({ columns: CONFIG.OUT_COLS, rows: rows, from: from, to: to, summary: summary }), 'application/json')).getBytes();
  var r = UrlFetchApp.fetch(url + '/admin/ingest-sales?key=' + encodeURIComponent(key), { method: 'post', contentType: 'application/octet-stream', payload: body, muteHttpExceptions: true });
  var ack = {}; try { ack = JSON.parse(r.getContentText()); } catch (e) {}
  if (r.getResponseCode() !== 200 || !ack.ok) throw new Error('Dashboard rejected the upload (' + r.getResponseCode() + '): ' + (ack.error || r.getContentText().slice(0, 300)));
  return ack;
}

// ---------- category rules (mirror of src/categories.js — myfrido.com shop categories) ----------
var CATEGORY_OVERRIDES = { '3D Foot Scan': 'Services' };
var CATEGORY_RULES = [
  ['Combos', [/\bcombo\b/, /\bbundle\b/, /\bduo\b/, /\bkit\b/]], ['Maternity', [/maternity/, /pregnan/]], ['Barefoot', [/barefoot/]],
  ['Workspace', [/\bdesk\b/, /monitor arm/, /footrest/, /laptop/, /keyboard/, /\bmouse\b/]], ['Chairs', [/\bchair\b/, /\bstool\b/]],
  ['Mattress', [/mattress/, /topper/]], ['Pillows', [/pillow/]], ['Cushions', [/cushion/, /\bwedge\b/, /backrest/, /coccyx/, /seat\b/]],
  ['Insoles', [/insole/]], ['Socks', [/\bsocks?\b/]], ['Footwear', [/sandal/, /slipper/, /slides?\b/, /shoes?\b/, /sneaker/, /flip/, /clog/, /chappal/]],
  ['Masks', [/\bmask\b/]], ['Personal Care', [/therapy/, /nasal/, /massag/, /bath/]],
  ['Orthotics', [/orthotic/, /orthopaedic/, /orthopedic/, /posture corrector/, /\bknee\b/, /brace/, /heel protector/, /toe separator/, /\bbelt\b/, /wrist/, /elbow/, /\btape\b/, /gloves/]]
];
function categoryOf_(name) {
  var n = str_(name); if (CATEGORY_OVERRIDES[n]) return CATEGORY_OVERRIDES[n];
  var l = n.toLowerCase();
  for (var i = 0; i < CATEGORY_RULES.length; i++) for (var j = 0; j < CATEGORY_RULES[i][1].length; j++) if (CATEGORY_RULES[i][1][j].test(l)) return CATEGORY_RULES[i][0];
  return 'Accessories';
}

// ---------- helpers ----------
function str_(v) { return v == null ? '' : String(v).trim(); }
function num_(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
function round2_(n) { return Math.round(n * 100) / 100; }
function todayIst_() { var s = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd'); return parseYmd_(s); }
function parseYmd_(s) { return new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))); }
function addDays_(d, n) { return new Date(d.getTime() + n * 86400000); }
function ymd_(d) { return d.toISOString().slice(0, 10); }
function notify_(subject, body) { try { MailApp.sendEmail(Session.getEffectiveUser().getEmail(), subject, body); } catch (e) { Logger.log('Mail failed: ' + e); } }
