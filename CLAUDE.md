# CLAUDE.md — Walk-in dashboard

Frido Founders Office dashboard. Owner: Abdal (AVP Founders Office). Deployed from GitHub `junedsmMyF/Walkin-dashboard` to Cloudflare Workers (Workers Builds, `main`).

- `src/index.js` — routes, admin, cron (06:00 IST). `src/bigin.js` — Bigin over MCP (Zoho `ZohoMCP_executeTool`, COQL on `Pipelines`, walk-in pipeline id `1371203000000480122`, 2,000 per page, `order by id`). `src/metrics.js` — all metric rules. `src/stores.js` — store master.
- `public/index.html` — single-file dashboard (hash routing). Reads `/api/metrics` only. Frido brand: #FFD100 / #101820, secondary #307FE2 #6CACE4 #DDE5ED #333F48, positive #80E0A7, alert #FF585D.
- Never change a metric rule without the owner's sign-off. Never send phone numbers or names to the browser. Never commit real customer data.
- Walk-in pages mirror the design boards (Design flow tab). Cards without a data source stay in place with an "Awaiting data source" state — never hide or fake them.
- The at-risk table shows Bigin lead IDs, store, owner account, product and value only — never customer names or phones.
- (Superseded) KPIs without a data source stay hidden (SLA trend, call attempts, escalations, capture point).
- Leads with no mappable store (e.g. owner is a person, Store Location empty) are kept in totals and excluded from store-level views.
- Store format: 16 Mall, 7 High street (in `src/stores.js`); rank each format separately.
- Open items: DSR names for FRIDO_0022–0025; stage-history (Bigin DealHistory) not yet used.
