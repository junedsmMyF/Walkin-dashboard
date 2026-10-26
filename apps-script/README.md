# Daily sales sync — Google Apps Script (no service account)

Runs as **you**, with the BigQuery access you already use in the console. Free (Apps Script + your BigQuery query quota).

## One-time setup (about 10 minutes)
1. Go to **script.google.com** → **New project**. Name it `Walk-in dashboard · sales sync`.
2. **Project Settings** (gear) → tick **Show "appsscript.json" manifest file in editor**.
3. In the editor, replace the contents of `appsscript.json` with this folder's `appsscript.json`, and of `Code.gs` with `SalesToDashboard.gs`. Save.
4. **Project Settings → Script properties → Add**:
   * `DASHBOARD_URL` = `https://fo-dashboard.frido-stf.workers.dev`
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

## When the dashboard is behind Cloudflare Access
1. Cloudflare → Zero Trust → Access controls → **Service credentials** → **Create service token** (name: `apps-script-sales-sync`). Copy the **Client ID** and **Client Secret** (the secret is shown once).
2. In the walk-in Access application → **Policies** → **Add a policy**: Action **Service Auth**, Include **Service Token** → `apps-script-sales-sync`. Save.
3. Apps Script → Project Settings → Script properties: add `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.
4. Run `runDaily` once to confirm it still syncs.

## Mailer for dashboard sign-in codes (Mailer.gs)
1. In this same Apps Script project: **+ (Add a file) → Script**, name it `Mailer`, paste `Mailer.gs`. Replace `appsscript.json` with the new one. Save.
2. **Project Settings → Script properties → Add** `MAILER_SECRET` = a long random string (keep a copy).
3. Run **testMailer** once and approve the permission prompt — you get a test email.
4. **Deploy → New deployment → ⚙ Web app** · Execute as **Me** · Who has access **Anyone** → **Deploy** → copy the **Web app URL**.
5. Cloudflare → Worker → Settings → Variables and Secrets → add **Secret** `MAILER_SECRET` (same value). In `wrangler.toml` set `MAILER_URL` to the web app URL.
If you edit Mailer.gs later: Deploy → Manage deployments → edit → Version: New version (the URL stays the same).
