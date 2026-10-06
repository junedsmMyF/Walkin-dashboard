# Daily sales sync — Google Apps Script (no service account)

Runs as **you**, with the BigQuery access you already use in the console. Free (Apps Script + your BigQuery query quota).

## One-time setup (about 10 minutes)
1. Go to **script.google.com** → **New project**. Name it `Walk-in dashboard · sales sync`.
2. **Project Settings** (gear) → tick **Show "appsscript.json" manifest file in editor**.
3. In the editor, replace the contents of `appsscript.json` with this folder's `appsscript.json`, and of `Code.gs` with `SalesToDashboard.gs`. Save.
4. **Project Settings → Script properties → Add**:
   * `DASHBOARD_URL` = `https://walkin-dashboard.junedm-myfrido.workers.dev`
   * `ADMIN_KEY` = the same value as `ADMIN_KEY` in Cloudflare
5. Pick **backfill** in the function menu → **Run**. Approve the permissions prompt (BigQuery, external requests, triggers, email).
   It loads 1 Sep 2026 → yesterday, month by month (watch **Execution log**).
6. Pick **setup** → **Run**. This creates the daily trigger at **08:00 IST** (see **Triggers**, the clock icon).

## Daily
`runDaily` re-queries the **last 7 days** and sends them; the dashboard replaces only those dates.
If a check fails, nothing is sent, you get an email, and the dashboard keeps its data. Fix, then run `runDaily` by hand.

## Notes
* Each run's BigQuery usage is logged (`bytesProcessed`) and shown on the dashboard (Funnel & definitions → Data quality).
* A new store id appears as a warning — add it to `src/stores.js` (dashboard) and `CONFIG.KNOWN_STORES` here.
* Category rules here mirror `src/categories.js`; change both together.
