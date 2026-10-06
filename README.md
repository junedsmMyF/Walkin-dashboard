# Walk-in dashboard — Frido Founders Office

Live **Walk in lead management** dashboard (Retail Revenue), hosted on Cloudflare and deployed automatically from this repo.

```
GitHub (this repo) ──push to main──▶ Cloudflare Workers Builds ──▶ walkin-dashboard Worker
                                                                   ├─ /            dashboard (public/index.html)
                                                                   ├─ /api/metrics aggregated, PII-free metrics
                                                                   ├─ /api/status  source freshness + data quality
                                                                   ├─ /admin       Bigin connect / refresh (ADMIN_KEY)
                                                                   └─ cron 00:30 UTC (06:00 IST) → Bigin T-1 snapshot → KV
Sources: Bigin via MCP (daily) · Retail Sales sheet (live CSV) · DSR sheet (live CSV)
```

## One-time setup (≈15 minutes)

1. **Push this repo** to `junedsmMyF/Walkin-dashboard` (`main` branch).
2. **Storage (KV)**: nothing to do. `wrangler.toml` declares `DASH_KV` without an ID, so the first deploy creates the namespace automatically and keeps it linked. If a later deploy fails with a KV error, copy the ID from *Storage & databases → Workers KV* and add `id = "…"` under `[[kv_namespaces]]`.
3. **Connect Cloudflare to GitHub**: Cloudflare dashboard → *Workers & Pages* → *Create* → *Import a repository* → pick `junedsmMyF/Walkin-dashboard`.
   Production branch `main`, build command empty, deploy command `npx wrangler deploy`. Every push to `main` now deploys automatically.
4. **Add the admin secret**: Worker → *Settings* → *Variables and secrets* → add **secret** `ADMIN_KEY` (a long random string, e.g. `openssl rand -hex 24`). Keep it in your password manager.
5. **Connect Bigin (one click, read-only)**: open `https://<worker-url>/admin?key=<ADMIN_KEY>` → **Connect Bigin** → sign in to Zoho and approve. The first refresh runs immediately.
   *If Zoho's MCP server doesn't allow automatic client registration*, the admin page says so. Then create a read-only Bigin MCP server in Zoho's MCP console, copy its link, and set it as secret `BIGIN_MCP_URL` (it overrides the value in `wrangler.toml`), then use **Refresh Bigin now**.
6. **Check**: `https://<worker-url>/api/status` shows all three sources and any unmapped stores.

Keep both Google Sheets **published to the web as CSV** (File → Share → Publish to web). The dashboard reads them live (cached 5 minutes).

## Metric rules (agreed Sep 2026)

| Rule | Definition |
|---|---|
| Start date | 1 Sep 2026; every metric cut at yesterday (T-1) |
| Walk-ins | DSR `New Walk-ins + Other Walk-ins`, latest submission per store per date (even if zero), never summed |
| Captured leads | Unique phone per store per lead date in Bigin; excluded if that phone ordered on the same date |
| Same-day orders | Orders at the store that day whose phone has a Bigin lead that day (unique POS Order ID) |
| Capture rate | Captured ÷ (Walk-ins − Same-day orders) |
| Capture + conversion rate | (Captured + Same-day orders) ÷ Walk-ins |
| Attributed order | Order date **after** a Bigin lead date for the same phone (last 10 digits), any store, no time limit |
| Sales credit | Store that billed the order; capturing store keeps capture credit ("captured here, bought elsewhere") |
| Revenue | Net = Amount Paid − Return Amount (headline); Gross = Amount Paid; `CANCELLED` lines dropped; `FRIDO_0000` excluded |
| Store format | Mall or High street per store (`src/stores.js`); leaderboards rank each format separately |
| Leads without a store | Owner is a person and Store Location is empty → counted in totals, left out of store-level views |
| Manual overrides | Orders listed in `src/overrides.js` count as walk-in orders even without a Bigin lead; shown under Data quality |
| Pipeline | Matched order ⇒ Won; otherwise Bigin stage shown as recorded, marked unverified; hygiene checks flag mismatches |

Store mapping lives in `src/stores.js` (Sales Store ID is the key). When `/api/status` lists an unmapped DSR store or Bigin owner, add the alias there and push.

## Dashboard layout

The walk-in pages (Overview, Capture, Follow-up, Revenue, Loss analysis) follow the original design boards exactly. (The original Design flow reference tab has been removed.) Cards whose data has no source yet stay in place with an **Awaiting data source** state: 7-day action SLA, Acted-on-in-7-days node, escalation & rescue, CRM hygiene score, caller discipline, capture button used, staff capture, weighted pipeline, Unreachable stage, call/website/app channels, backend-rescued revenue.

## Sales data: BigQuery → Apps Script → dashboard (since Oct 2026)

No service account, no files, no manual steps. `apps-script/SalesToDashboard.gs` runs in Google Apps Script **as you**
(your existing BigQuery access) every day at **08:00 IST**:

1. queries BigQuery for the **last 7 days** (late edits, refunds and cancellations are picked up);
2. cleans and enriches the lines (gross = qty × price, revenue = gross − discount, 10-digit phones, order type, product category; test store removed);
3. validates (yesterday present, revenue arithmetic, no negatives; unknown stores and missing phones are warnings);
4. sends them gzip-compressed to `POST /admin/ingest-sales` (admin key). The Worker replaces just those dates inside
   compressed **monthly blocks** in KV (`sales:m:YYYY-MM`, about 230 KB per month), so the store scales to years.

A failed check stops the send and **emails you**; the dashboard keeps its data and shows a "late" pill after 30 hours.
The Worker computes the KPIs once and keeps the result (15 min, or until new sales/Bigin data arrive), so pages stay fast as data grows.
`notebooks/sales_bigquery_pipeline.ipynb` documents the same logic for on-demand profiling, KPI and reconciliation work in Google Colab with your own login.
Setup: see `apps-script/README.md`.

## Sales data standardization (legacy Google Sheet path)

All sales tabs listed in `SALES_CSV_URLS` are standardized when read (`src/standardize.js`) and combined: dates → `DD/MM/YYYY` (or `DD/MM/YYYY HH:MM`), day/month order proven per column per tab (else month-first, as the sheet publishes); phones → 10 digits; numbers plain; Yes/No and payment modes uniform; `-` and text untouched. Lines identical to one from an earlier tab are dropped. Admin download: `/admin/sales.csv?key=…`.

## Privacy

The dashboard is public. Customer names and phone numbers never leave the Worker: `/api/metrics` returns only store-by-day aggregates (tested in `tests/metrics.test.mjs`). The admin page needs `ADMIN_KEY`.

## Development

```bash
npm test          # unit tests (synthetic data only — never commit real customer rows)
npx wrangler dev  # local run; set sources in .dev.vars (git-ignored)
```
