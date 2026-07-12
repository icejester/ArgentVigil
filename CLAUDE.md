# ArgentVigil v1.0.0

Silver speculative-positioning monitor with gold as comparative context. Framing is **"selling dollars, not buying metals"** — is the speculative futures crowd genuinely capitulated, or just pulling back. Not a trading system: no price targets, no prediction framing, no risk-tolerance commentary. See `SPEC.MD` (gitignored, local-only — do not assume it exists in fresh clones) for the full Stock & Flow panel spec and CATCOR feature map, `deliveryBehavior-spec.md` (also gitignored, local-only) for the Delivery Behavior layer's full spec and story list, `dataHealth-spec.md` (gitignored, local-only) for the Data Health/Fetch Status spec, and `README.md` for the user-facing feature/data-source overview.

This doc is organized **by app tab** — the six sections below match `frontend/src/App.jsx`'s nav bar exactly (`SECTIONS`, in order: CoT, Money Supply, Inventory, CATCOR, Research, Data). Each section covers that tab's frontend component(s), the backend routes/modules feeding it, its SQLite tables, and its known gaps/scope boundaries together, so you don't have to cross-reference three different doc sections to understand one panel end-to-end. Cross-cutting stuff that doesn't belong to one tab (repo layout, conventions, running the app) lives in its own sections at the end.

## Standing architectural rules (apply to every tab below)

- **Persist-on-fetch**: every route that talks to an upstream source has a `_fetch_and_persist_*` function that fetches, reshapes, and writes to SQLite; a paired `/db`-suffixed route reads the same data straight back out with no upstream call. **The frontend calls only `/db`-suffixed (or `/api/cot/db`, `/api/prices/db`) routes — it never triggers a live upstream fetch itself.** See `SPEC.MD`'s Persist-on-Fetch Re-architecture for the full rationale (CATCOR's and Delivery Behavior's cross-check features assume AV's database is already the real record, not a pass-through).
- **One shared database**: `runtime/argentvigil.db` (gitignored), owned by `backend/db.py`, `DB_PATH` computed `__file__`-relative (two directories up from `backend/db.py`, into `runtime/`). Every tab's tables live here — there is no per-tab or per-layer database file. `runtime/` contains nothing else (an earlier flat-file cache for CATCOR's ForexFactory feed was migrated into a table — see CATCOR section below).
- **Backend package layout**: `backend/` is a real package (`backend/__init__.py`, empty, enables `from . import db` and `uvicorn backend.main:app`). `seed_data/` (manually-maintained static content) and `runtime/` (gitignored generated state) are namespace packages / non-packages sitting alongside it, not nested inside it.
- **Tiered background refresh** (`main.py`'s `lifespan`): two independent `asyncio` loops keep SQLite warm without the frontend ever calling upstream. **Fast tier** = spot prices only (the one genuinely intraday-moving figure). **Slow tier** = the other ~10 exchange-inventory sources (all move at most daily upstream). Both run once, unconditionally, at server startup, then default to **disabled** — each tier only repeats on its interval if explicitly turned on via `GET`/`POST /api/refresh/settings`. `POST /api/refresh/force` runs both tiers once immediately regardless of enabled state, returns real per-tier `{"succeeded","failed","errors"}` counts, and — only if at least one source actually succeeded — dispatches a `FORCE_REFRESH_EVENT` window `CustomEvent` that Inventory/CoT/CATCOR panels listen for to re-read their `/db` data immediately. CoT and Research are excluded from force-update (CoT stays pipeline-only; Research is on-demand chat, nothing to force-refresh).
- **Nulls over zeros**: metalcharts.org sometimes reports `0` to mean "not reported that day" — `_parse_aggregate_row` in `main.py` converts those to `None` so charts gap instead of showing false dips. Apply the same treatment to any new fields with this failure mode.
- **Stale spot feed over weekends/closures**: `/api/prices`'s underlying `twelvedata-ws` feed doesn't pause when COMEX/LBMA silver/gold trading is actually closed — confirmed live over a weekend that it kept returning a top-level `isStale: true` flag (sibling of `data`, not per-metal) alongside a `cacheAge` in the hours, while still stamping each entry with a live-looking `timestamp` and slowly drifting the price via rounding/re-sampling jitter on metalcharts.org's own end. `_fetch_and_persist_prices` (`main.py`) checks `isStale` and skips persisting entirely when true — no new `spot_price_snapshot`/`spot_price_tick` row is written, so `PriceHistoryChart` goes flat at the last real print instead of showing fake weekend movement that never actually traded. Apply the same check to any other route that reads `/api/prices`' response.
- **The Data tab (`frontend/src/data_map.js` + `data_panel.jsx`) MUST be updated whenever app data changes — this is a strict requirement, not a nice-to-have.** Any change that adds/removes/renames a SQLite table or column, adds/removes/changes an upstream source or its fetch shape, or changes a source's fetch cadence/rate-limit posture must land a matching edit to `data_map.js` in the same change. Treat a data-shape change without a Data-tab update as incomplete, the same as a migration without a schema update.
- **Pinned default tab**: a 📌 icon on each of `App.jsx`'s six nav buttons lets the user designate which tab opens by default on load, instead of always defaulting to CoT. Persisted server-side (`ui_settings` table, single-row upsert — same convention as `pipeline_runs` — via `GET`/`POST /api/ui/pinned-section`), **not** `localStorage` (the app has no client-only persistence anywhere; a shared setting like this belongs in the same SQLite database as everything else). `App.jsx` fetches the pinned section on mount and opens it if valid; falls back to `"cot"` if nothing's pinned or the fetch fails.

---

## Tab: CoT

**Frontend**: `frontend/src/silver_cot_tracker.jsx`. **Backend**: `pipeline/` (fetch + compute) + `backend/main.py`'s `/api/cot/db` route + `backend/delivery_behavior.py`'s category-composition compute (see below — this content is CoT-derived, not Stock & Flow, so it lives in this tab despite being part of the Delivery Behavior module).

### CoT: what it does

Fetches CFTC Commitment of Traders data for COMEX Silver (084691) and COMEX Gold (088691), computes a normalized positioning metric (`net_long_pct_oi` = (non-commercial longs − non-commercial shorts) ÷ total open interest × 100), and ranks it against rolling 2-year and 5-year historical windows. Normalizing by OI makes readings from 2011 and 2024 directly comparable.

**Signal zones** (configurable in `pipeline/config.py`): ≥90th percentile → specs crowded long (caution); ≤10th percentile → specs capitulated (back-up-the-truck zone); between → normal range, no signal. Both windows computed side-by-side; the UI flags disagreement explicitly.

### Panel contents (top to bottom)

- **Combined CoT chart** — silver + gold net long % of OI, 5-year view, custom hand-rolled legend (click to toggle a line independently); when only one metal is visible, 10th/90th percentile reference lines appear.
- **Gold/Silver Ratio** — inverted right axis (lower GSR = silver outperforming = line goes up), computed from COMEX futures spot (GC=F ÷ SI=F), not ETF prices.
- **Who's Holding Long Positions** (`CategoryCompositionPanel`, collapsible, **defaults open**) — disaggregated CoT category share-of-long-OI over time, both metals, own metal toggle, own fetch of `/api/delivery-behavior/db`. Backed by `compute_category_composition` in `backend/delivery_behavior.py` (see "Category composition" below).
- **Silver / Gold sections** (collapsible, **default closed** — a deliberate flip from earlier open-by-default), each containing that metal's `PaperLeveragePanel`, `SignalBanner` (current percentile + classification, both windows), and `SignalTrackRecord` (historical +4wk/+8wk hit-rate description, explicitly not prediction, thin samples flagged). `PaperLeveragePanel`'s internal render order (top to bottom, a deliberate layout, not incidental): `LbmaFixBadge` (settlement reference) → leverage ratio value + OI/volume meta → `LeverageHistoryChart` (from `/api/silver|gold/db/leverage/history`, **default window 6M**) → `LeverageSpotBadge` (the moving spot quote, deliberately placed between the two charts rather than up top) → `PriceHistoryChart` (from `/api/prices/db`/`/api/prices/db/ticks`, **default window 24H**). Leverage itself is `open interest × contract size ÷ registered inventory`, 5,000oz silver contracts / 100oz gold. A per-metal **"Live"** checkbox (defaults **off**) in the panel header polls both the spot badge and the price chart every 60s (`PRICE_LIVE_POLL_MS`, matching the backend fast tier's own write cadence — polling faster wouldn't surface data any sooner) while checked; unchecked, both only refresh on mount or Force Refresh, same as before this control existed.
  - **Leverage history** (`price-spec.md` Section 1): `volume_oi`/`gold_volume_oi` were already a real daily time series (`INSERT OR REPLACE` keyed by date, one row per slow-tier cycle landing on a new date) but only ever exposed as a latest-row snapshot, and — confirmed live — metalcharts.org's `volume-oi` endpoint has **no historical range support at all** (a `range`/date param is silently ignored, always returns only today's single snapshot), so this table can only ever accumulate forward from whenever the slow-tier refresh first ran. `db.get_leverage_history(metal)` (`GET /api/silver|gold/db/leverage/history`) stitches a real backfill in ahead of that: `cot_{silver,gold}.open_interest` (CFTC's `open_interest_all`, i.e. total OI — the same quantity `volume-oi`'s `openInterest` represents) joined against `{inventory,gold_inventory}_aggregate.registered` as-of each CoT report date (nearest date on/before, same convention `VaultSnapshotPanel` uses for pinned-date lookups), weekly resolution (CoT's own cadence) for any date before the real daily series begins. **Real backfill ceiling is set by `registered` itself, not by CoT's 2011 coverage or `total`'s 1992 coverage**: metalcharts.org's registered/eligible split is NULL before **2020-01-02 for silver** and **2026-02-17 for gold** (confirmed live — an upstream reporting-format gap, not a fetch bug), so silver backfills to 2020-01-02 and gold's backfill contributes almost nothing today. `LeverageHistoryChart` in `PaperLeveragePanel` renders the stitched series with 1W/1M/6M/1Y/All window buttons (mirrors `PriceHistoryChart`'s window-button pattern).
  - **LBMA fix** (`price-spec.md` Section 2): `lbma_fix` table + `_fetch_and_persist_lbma_fix()` (`backend/main.py`) sources gold's AM fix and silver's daily fix from GoldAPI.io's free tier (`GAPI_API_KEY` env var, 500 req/month), via `GET https://www.goldapi.io/api/{XAU|XAG}/USD/{YYYYMMDD}` — the **date-suffixed historical endpoint specifically**; GoldAPI.io's bare `/api/{SYMBOL}/USD` current-price endpoint is a FOREXCOM spot feed (confirmed live), not LBMA, and is never called. Confirmed live against a real key that GoldAPI.io has **no data for "today"** until some lag later in the day — `_fetch_and_persist_lbma_fix` tries today's date first, falls back to yesterday if empty, so the badge/history never goes blank mid-day. Also confirmed live that GoldAPI.io stamps both metals' historical rows with an identical `10:30:00Z` timestamp regardless of metal — real LBMA fix times are gold AM 10:30 UTC / PM 15:00 UTC, silver 12:00 UTC (winter), so silver's stamp does **not** match its real fix time; the `date` field is treated as "which calendar day this fix is for," not a verified fix-moment timestamp. GoldAPI.io also exposes only one price/day for gold — no AM/PM-distinct field — so **gold's PM fix is not available from this source**; persisted as `fix_type="AM"` (best-effort) for gold, `fix_type="daily"` for silver. `price_usd` has not been independently cross-checked against LBMA's own official print (that requires a paid IBA license — see `price-spec.md` Section 2). Cadence: **startup-only + manual force-refresh** (`lbma_fix` is in `_ON_DEMAND_REGISTRY`, deliberately excluded from both tiered loops and from `POST /api/refresh/force`, since a 1-2x/day source doesn't fit either tier's daily-or-faster assumption) — reachable via the Data tab's per-source "Re-run now" button. `GET /api/lbma/db?metal=` / `GET /api/lbma/db/history?metal=&fix_type=` are the paired read routes; `LbmaFixBadge` in `PaperLeveragePanel` is the frontend consumer.
- **Staleness label** (inline in the "Positioning Extremes" `<summary>` row, right-justified) — "CoT data as of ... · published ~..." only; no longer takes a `generatedAt` prop or renders a "pipeline run" clause (that's tracked backend-side via `pipeline_runs`/`get_last_run_at()` but no longer surfaced here).

No "Macro Watchlist" section exists anymore (removed; `/api/cot/db` drops `macro_watchlist` entirely).

### CoT: data flow

`pipeline/run.py` → parses CFTC rows (via `pipeline/fetch.py`, stdlib-only Socrata client) → persists append-only to `cot_silver`/`cot_gold` (`INSERT OR IGNORE` keyed by `report_date` — a published report is never overwritten) + upserts `cot_prices` (ticker+date, weekly, via `pipeline/price_fetch.py`, Yahoo Finance) → stamps `pipeline_runs` (single-row, `id=1`) with completion time, unconditionally, even if no new CoT rows landed → also writes `pipeline/cache/cot_data.json` unchanged (standalone-CLI usability only; frontend never reads it). Persistence goes through `from backend import db` (shared `backend/db.py`, itself pure `sqlite3`/`os`/`contextlib`, no `fastapi`/`httpx`, so importing it doesn't need the venv) — `pipeline/` no longer owns a separate database file.

`GET /api/cot/db` reads `cot_silver`/`cot_gold`/`cot_prices` directly via `db.get_silver_series`/`get_gold_series`/`get_price_series` and recomputes percentiles/track-record/GSR server-side on each request (cheap, ~1,560 rows/metal) using `pipeline/compute.py`'s `compute_from_series`/`compute_signal_track_record` (`compute_from_series` is an additive twin of `parse_and_compute` that takes already-normalized SQLite rows instead of raw CFTC rows). **`/api/cot/db` never triggers a live Socrata fetch** — CoT refresh stays external (`python3 pipeline/run.py`, manual or cron), a deliberate asymmetry from every other tab's `/refresh`+`/db` pattern, since a 15-year Socrata pull is too slow to trigger from an HTTP request. `POST /api/refresh/force` does not touch CoT or `pipeline_runs` either.

As of the Data Health work (see Data tab below), `cot_pipeline` also has its own registry entry (`_refresh_cot_pipeline` in `main.py`) — a rate-limit gate (skips, `last_attempt_status="skipped"`, if the latest persisted report is under 7 days old) wrapping `asyncio.to_thread(pipeline_run.run_pipeline_once)`. This is the first in-app trigger CoT has ever had, reachable via the Data tab's per-source "Re-run now" button; it does not change the fact that `/api/cot/db` itself stays read-only.

### Category composition (disaggregated CoT — powers "Who's Holding Long Positions")

`compute_category_composition` in `backend/delivery_behavior.py`: shares of long OI by CFTC Disaggregated category (`producer_merchant`/`swap_dealer`/`managed_money`/`other_reportable`) per `report_date`, both metals, reading the `cot_disaggregated` table (fetched by `pipeline/run.py` via `pipeline/fetch.py`'s `fetch_disaggregated_cot_data`/`fetch_gold_disaggregated_cot_data`, CFTC's Disaggregated Futures-Only Socrata dataset `72hh-3qpy` — a different dataset ID from Legacy's `jun7-fc8e`; both silver `084691`/gold `088691` codes work against it, same codes as Legacy). `producer_merchant` has no spread field in CFTC's schema, so its `spreading` is always `None` by design, not a data gap. Requires all 4 categories present for a `report_date` before computing shares (skips the week otherwise) rather than silently normalizing over an incomplete total — a code-review finding caught before shipping (an earlier version always sourced `open_interest` from `producer_merchant`'s row specifically and could understate `total_long` if any single category's `INSERT OR IGNORE` failed to land).

Also carries an approximate `days_to_fnd_approx` per week from Delivery Behavior's First Notice Day rule engine (see Inventory tab below) — explicitly documented as a directional marker only, not a claim about which contract month any category's OI actually sits in (the Disaggregated report aggregates across every open contract month; AV has no contract-month-level OI to disambiguate — see "Permanently out of scope" under Inventory).

### CoT: known gaps

- 📌 None currently open beyond the FND-approximation caveat above (inherited from Delivery Behavior's permanent contract-month-OI gap).
- 📌 LBMA fix (see Silver/Gold sections above): gold's PM fix (15:00 London) is not available from GoldAPI.io's free tier at all — only AM. `lbma_fix.price_usd` is not independently cross-checked against LBMA's own official print (paid IBA license required). GoldAPI.io's per-metal fix-moment timestamp is not trustworthy (confirmed live — both metals stamped identically regardless of real differing fix times).
- 📌 Leverage history backfill (see Silver/Gold sections above): silver's real ceiling is 2020-01-02, gold's is 2026-02-17 — both set by when metalcharts.org's registered/eligible split itself starts being reported, not by CoT's 2011 coverage or `total`'s 1992 coverage. Gold's backfill is close to a no-op today as a result. No known path to extend either further back — this is an upstream data gap, not a fetch-shape problem.

---

## Tab: Money Supply

**Frontend**: `frontend/src/money_supply.jsx` (imported directly into `App.jsx`, not nested under another panel). **Backend**: `main.py`'s FRED routes.

### Money Supply: what it does

Tracks the supply of the thing being debased, as monetary context for the metals panels.

- **M2 Money Stock / Fed Balance Sheet** — trillions USD, M2 YoY % change on a secondary axis. Sourced from FRED (M2SL, WALCL).
- **Dollars vs Silver vs Gold as Purchasing Power** — four series (Fiat $100 nominal / Gold XAU / Silver XAG month-end closes since 2006 / CPI-derived Purchasing Power) as relative return % against a user-selected baseline. Click a legend label to set baseline (Purchasing Power can't be baseline — "not a holdable asset"); checkbox toggles visibility. Click-and-hold a chart point to see "since that date to latest" return in the tooltip (green/red vs. baseline), without redrawing the lines.

### Money Supply: data flow

`GET /api/fred/money-supply/refresh` fetches M2SL/WALCL/CPIAUCSL from FRED, upserts `fred_observations` (generic `(series_id, date, value)` store, not FRED-exclusive — also holds Yahoo-sourced metal closes, see below). `GET /api/fred/money-supply/db?window=2y|5y|10y|20y` reads it back, computes YoY + CPI-derived purchasing-power index server-side, returns trillions/percent/index (never raw FRED units). Requires `FRED_API_KEY` in the environment (`.env` via `python-dotenv`, or shell-exported); `refresh` raises a clean `500` if unset.

**Metal price history** (for the purchasing-power chart): `/api/metals/prices/refresh` fetches DAILY closes from Yahoo Finance (`SI=F`/`GC=F`, httpx directly in `main.py` — a separate code path from `pipeline/price_fetch.py`, which is a stdlib-only weekly-interval helper for the CoT pipeline specifically), resamples to one row per calendar month (last trading day on/before month-end, avoiding Yahoo's `1mo` bucket which includes the current in-progress month), upserts into `fred_observations` under `XAG_CLOSE`/`XAU_CLOSE` keys. `/api/metals/prices/db?window=...` returns raw price + index-to-100-at-window-start; the frontend does its own further client-side rebasing against the user-selected baseline.

### Money Supply: known gaps

None currently tracked.

---

## Tab: Inventory ("Stock & Flow" + Delivery Behavior)

**Frontend**: `frontend/src/comex_inventory.jsx` (top-level `ComexInventoryDashboard`) + `frontend/src/delivery_behavior_panel.jsx` (nested inside it) + `frontend/src/market_balance.jsx`. **Backend**: `backend/main.py`'s exchange-inventory routes + `backend/delivery_behavior.py`.

Structured as nested collapsible `<details>` panes: top-level "Stock & Flow" contains `CrossExchangePanel`, then separate collapsible sections for "COMEX — New York", "SHFE — Shanghai", "Market Demand", "Demand Composition Over Time", and "Global Context" (the latter three are siblings directly under Stock & Flow, not nested inside either exchange). `fetchAll()` calls only `/db`-suffixed routes — upstream refresh happens server-side via the tiered background loops (see Standing rules above), not on panel mount.

### COMEX — New York

- **Per-Vault Snapshot** (`VaultSnapshotPanel`) — today's registered/eligible/total by depository with day-over-day deltas + interactive pie chart. Supports being "pinned" to a past date (via hovering a row in Delivery Behavior's reclassification table below, wired through `handleHoverDate`) — reads `/api/silver/db/depositories?date=...` instead of latest-only, showing that date's real per-vault breakdown where history exists (accumulates only going forward from whenever the depositories fetch first ran — no upstream backfill exists for this specific route, unlike delivery notices' `ytd` trick below). The panel keeps its previous content mounted during a pinned-date fetch (never swaps to a shorter loading/empty tree, with a `min-height` lock + absolutely-positioned "no snapshot" overlay) — swapping the whole subtree caused Recharts' `ResponsiveContainer` to remount and briefly measure 0×0, collapsing the pie chart and knocking the mouse off the very row being hovered, canceling the pin.
- **Delivery Behavior** (nested collapsible, sibling of the snapshot — see full subsection below)
- **Registered vs Eligible** (nested, collapsible) — distinguishes warranted (deliverable) metal from eligible (stored, not warranted); sharp registered drops are a delivery-pressure signal. Includes a registered/eligible ratio series; spikes indicate metal being warranted for delivery.
- **Delivery Notices** (nested, collapsible) — daily issued/stopped, tabular. `mtdCumulative`/`ytdCumulative` omitted — always `0` in metalcharts.org's response (confirmed Feb–Jul, never populated); `dailyIssued`/`dailyStopped` are the real, working fields.

### SHFE — Shanghai

- **SHFE Warehouse Snapshot** — current warranted silver by approved warehouse, delta column, pie chart.
- **SHFE Silver Inventory** (nested, collapsible) — time-series, kg → troy oz (1 kg = 32.1507 oz).

### Cross-exchange overlay

- **COMEX vs SHFE Physical Exchange Inventories** — dual-axis (COMEX left, SHFE right, independent scale), PSLV/Sprott as reference line; proportional bar shows COMEX ~12× SHFE in absolute terms.
- **PSLV (Sprott Physical Silver Trust)** — live custodial oz from the Royal Canadian Mint, Ottawa, fetched directly from Sprott's API.

### Market Demand / Demand Composition (`market_balance.jsx`)

- **Annual Market Balance** (`MarketBalancePanel`) — Silver Institute annual supply/demand balance, deficit/surplus by year, 5yr cumulative, recoverable-stock runway estimates under stated assumptions (not a prediction). Reads `seed_data/silver_market_balance.json` directly (no DB, no external fetch) via a `__file__`-relative path; derived metrics computed on each request.
- **Demand Composition Over Time** (`DemandCompositionPanel`, separate export from the same file so it's independently collapsible) — stacked share of Industrial, Jewelry & Silverware, Physical Investment, ETF Net Flow demand by year.

### Global Context

- **Estimated Above-Ground Silver Stock** — proportional bar by category (Jewelry & Silverware, Investment/coins & bars, Industrial/unrecoverable, ETF & Exchange Vaults, Central Bank/Govt Reserves) from Silver Institute WSS 2024 / USGS / CPM Group, plus a live-computed bar for the AV-tracked exchange subset. All figures carry an explicit ±20% uncertainty qualifier. Staleness flag if survey >18mo old.
- **Stack Calculator** — personal troy oz holdings expressed as % of estimated above-ground stock, COMEX registered, and total tracked exchange inventory (COMEX + SHFE). Lives inside `GlobalSilverPanel`, which computes the live tracked total against the static above-ground total on every render (no hardcoded ratio).

### Delivery Behavior (`backend/delivery_behavior.py`, `frontend/src/delivery_behavior_panel.jsx`)

A cross-check layer on top of data the other tabs already persist (registered/eligible inventory, delivery notices, disaggregated CoT) — computes derived anomaly signals rather than owning new upstream fetches, except one (disaggregated CoT, described under the CoT tab above). Route: `GET /api/delivery-behavior/db?metal=XAG|XAU` (no `/refresh` — everything it reads comes from another tab's tiered refresh or from `pipeline/run.py`). Returns `{"reclassification": ..., "category_composition": ..., "deficit_context": ...}`.

- **Reclassification vs. Real Inflow** (`compute_reclassification_signal`, silver-only — `delivery_notices`/`inventory_aggregate` have no gold equivalent): walks `inventory_aggregate`'s day-over-day `registered` deltas, skips any day whose delta spans a `None`-registered gap or has no matching `delivery_notices` row for that exact date, flags a day if same-day delivery volume (`daily_issued + daily_stopped`, converted from COMEX contracts to troy oz — 5,000 oz/contract, a real unit-mismatch bug caught during build) covers less than 10% of the registered increase. Reads `delivery_notices` with `type="ytd"` (~85 days of history) not the `"mtd"` default (a handful of days-in-month) — confirmed live against metalcharts.org, so `main.py`'s slow tier specifically calls `_fetch_and_persist_delivery(type="ytd")` for this signal's coverage. Each flagged day also carries `total_oz`/`prev_total_oz`/`total_delta` (total vault holdings, not just registered — the two can move in opposite directions on the same day) so the UI table doesn't read as inconsistent against the aggregate chart above it.
- **Short-Term Anomaly vs. Structural Deficit** (`compute_deficit_context`) — repackages the annual Silver Institute balance series alongside the short-term reclassification window, so a short-term blip isn't mistaken for evidence about the multi-year structural deficit or vice versa.
- **Category Composition** — computed here (`compute_category_composition`) but rendered in the CoT tab, not this one, since it's CoT-derived data (see CoT tab above for full detail).
- **First Notice Day / Last Trade Day** (`first_notice_day`, `last_trade_day`, `last_business_day`, `days_to_fnd`) — computed on the fly, no seed table. Confirmed live that both silver and gold list monthly contracts on a rolling basis (silver: 26 consecutive months + Jul/Dec out to 60 months; gold: 26 consecutive months + Jun/Dec out to 72 months) — effectively every calendar month trades, not the small fixed cycle `deliveryBehavior-spec.md` originally assumed, so there's no small static list worth seeding, just a pure date rule. Last Trade Day (third-last business day of the delivery month) confirmed directly against COMEX rulebook Chapters 112 (silver)/113 (gold), saved to `seed_data/cme/112.pdf`/`113.pdf` — identical rule both metals. **First Notice Day required a real correction mid-build**: those rulebook chapters never use the term "First Notice Day" at all, and an early version incorrectly inferred FND = first business day of the delivery month. A verified real example (COMEX May 2026 silver, FND reported April 30, 2026 — the *last* business day of the *prior* month) proved that wrong; the corrected rule (FND = last business day of the month preceding the delivery month) is what's implemented. "Business day" is weekday-only (Mon–Fri), deliberately not holiday-aware — fine for an approximate seasonal marker, not an exact trading-calendar reference.

**Permanently out of scope, not deferred**: `contract_month_oi` (per-contract-month open interest/settlement) and the seasonal-baseline/OI-decay + price-lead-lag signals that depend on it (`deliveryBehavior-spec.md` stories #1/#5). CME's real per-contract-month OI/settlement data is a paid Market Data Platform product (`cmegroup.com/market-data/market-data-api.html`, tiered from $0.50/GB) — confirmed live, not a reverse-engineering gap. CME's site also runs aggressive, inconsistent Akamai bot-blocking independent of the paid-API question — even the free daily-bulletin PDFs (no contract-month granularity anyway) and the delivery-notices report intermittently 403. `pdfplumber` was pip-installed during this investigation but is unused in shipped code.

**Not yet built**: story #4 (CME firm-level delivery concentration) — the free `MetalsIssuesAndStopsReport.pdf` is fetchable (confirmed live) but CME's bot-blocking makes it unreliable; would need `mc_token.py`-style reverse-engineering effort, not yet attempted.

### Inventory: known gaps

- 📌 Annual market balance series missing 2005–2013 (Silver Institute WSS PDFs located but not parsed) — documented follow-up, not a blocker.
- 📌 `VaultSnapshotPanel`'s pin-to-past-date feature only has real history from whenever `inventory_depository` first started being populated — hovering an older flagged date shows a "no snapshot persisted yet" message; coverage window only grows forward.
- 📌 Gold COMEX history/depositories are fetched+persisted every slow-tier cycle but nothing in `comex_inventory.jsx` renders them yet (only gold leverage has a frontend consumer) — a known no-op, not a bug.

---

## Tab: CATCOR (Catalyst Correlation)

**Frontend**: `frontend/src/catcor_panel.jsx`. **Backend**: `backend/catcor.py`, `seed_data/catcor_events_seed.py`.

### CATCOR: what it does

CATCOR Iteration 1's event/reaction spine — answers "did this catalyst actually move the metal" with observed data only, no interpretation layer. Tracks a macro-event calendar (FOMC, CPI, NFP), sources actual/consensus values from ALFRED/ForexFactory, captures silver/gold price reactions at fixed windows (T-30min/T+5min/T+30min/T+2hr) around each event.

### CATCOR: panel contents

Two Recharts scatter charts sharing a metal (XAG/XAU) toggle:

- **Catalyst Timeline** (top) — every captured catalyst by real calendar date, 1M/3M/6M/1Y lookback (fixed 30-day lookahead). Includes events with no known `surprise_magnitude` yet; known-future events render at reduced opacity as placeholders (never a real 0% reaction).
- **Surprise Magnitude vs. Price Reaction** (below, own T-30m/T+5m/T+30m/T+2h window toggle) — only plots events where a real `surprise_magnitude` exists.

Government-seeded events (FOMC/CPI/NFP) render as diamonds; Research-promoted (`observed`) events render as **circles** in their own amber color — event-type colored via `CATCOR_EVENT_COLORS` either way. Hovering a point in either chart doubles the size of that same event's point in the other (shared `hoveredEventId` state); clicking an `observed` point hotlinks to its originating Research session (see Tab: Research's "Research ↔ CATCOR integration" for the full mechanism — promote/demote, the hotlink wiring, and clickable legend rows all live there since they're driven by the Research tab's disposition flow, not CATCOR's own data).

### CATCOR: data flow

`main.py`'s `lifespan` runs, in order (all best-effort/independently try-excepted): `catcor.seed_events()` (loads `catcor_events_seed.py`'s static FOMC/CPI/NFP list, upserts into `event_calendar` for a 90-day-back/60-day-forward window, `event_id = f"{event_type}_{date}"` so re-seeding is idempotent; each event carries `source_tier`, currently always `"government"`) → `catcor.backfill_intraday_ticks()` + `backfill_daily_closes()` (Yahoo Finance) → `fetch_and_persist_consensus()` (ForexFactory) → `fetch_and_persist_actuals()` (ALFRED) → `backfill_reactions()`.

Three core tables: `event_calendar` (event_id PK), `macro_price_reaction` (PK event_id+metal+window), `spot_price_tick` (PK series_id+ts, **append-only** — fixes a gap `spot_price_snapshot` has: one row per calendar day, overwritten every fast-tier tick, no true intraday series; `_fetch_and_persist_prices` writes to both tables on every fast-tier poll).

**`spot_price_tick`'s series_id families — a real collision, since fixed**: `"XAG"`/`"XAU"` are exclusively `main.py`'s real metalcharts.org spot ticks (60s cadence, power the CoT tab's `PriceHistoryChart`). `"XAG_FUTURES"`/`"XAU_FUTURES"` (`FUTURES_SERIES_ID` in `catcor.py`) are Yahoo SI=F/GC=F futures bars from `backfill_intraday_ticks`, a genuinely different instrument, used only for CATCOR's own event-reaction snapshot capture below. These two used to share the bare `"XAG"`/`"XAU"` keys — futures prints running systematically ~0.3–0.6 higher than spot, interleaved on the same series, produced a real sawtooth artifact in the CoT price chart. Existing historical rows were migrated (re-keyed by a 5-minute-grid timestamp signature — Yahoo's bars land exactly on `:00`-second, no-microsecond, 5-min-multiple timestamps with zero false positives found against the real spot series) rather than discarded.

- **ALFRED actuals**: `_fetch_alfred_change` fetches two consecutive vintage prints for `CPIAUCSL`/`PAYEMS` as of the day after `scheduled_time` and diffs them — a raw ALFRED level is NOT comparable to ForexFactory's consensus (a period-over-period change), a real bug caught during build. NFP's diff is a raw count (thousands of persons); CPI's is % m/m. `surprise_delta = actual - consensus`, recomputed whenever either value is already present regardless of fetch order.
- **Consensus**: `fetch_and_persist_consensus` matches `event_calendar` against ForexFactory's free `ff_calendar_thisweek.json` feed (title + same-instant match — "Non-Farm Employment Change" specifically, not "ADP Non-Farm Employment Change"). Only a "this calendar week" variant exists (nextweek/lastweek both 404) — consensus can only ever be captured within roughly ±6 days of "now," a permanent disclosed gap. Fetched at most once per calendar week, persisted to `forexfactory_calendar` (every entry the feed returns, every country — keyed `(week_key, title, country, event_date)`) — confirmed live that repeat hits trip a 429 and can lock out an IP entirely, so never re-fetched within the same week. This replaced an earlier flat-file cache (`runtime/forexfactory_thisweek.json`) since the file was doing double duty as a second, inconsistent persistence mechanism for data with real long-term value beyond the USD/CPI/NFP subset CATCOR actually matches. A dedicated `_consensus_tier_loop` (30min interval) calls it periodically alongside `fetch_and_persist_actuals`. ForexFactory's `"K"`-suffixed NFP forecasts (e.g. `"114K"`) must be scaled ÷1000 to PAYEMS's native thousands unit — a second real unit bug caught during build.
- **Snapshot capture** (`catcor.capture_snapshot`): idempotent by construction — skips if a `macro_price_reaction` row already exists for `(event_id, metal, window)`. `due_snapshots()` finds boundary-passed-but-uncaptured pairs across **every** `event_calendar` row unconditionally (no `event_type` filter — this is what lets Research-promoted `observed` events get their reactions captured automatically, with zero code changes needed for that), polled every 60s by `_event_tier_loop` (always-on, not gated by an enabled flag, since a missed window is permanent data loss unlike re-fetchable tier data). Price lookup: `db.get_ticks_near` finds the nearest `spot_price_tick` row **under `FUTURES_SERIES_ID`'s keys specifically** (`"XAG_FUTURES"`/`"XAU_FUTURES"`, explicit as of the series-collision fix above — CATCOR's reactions were always effectively sourced from Yahoo's futures bars, not real spot ticks, this just makes that explicit rather than accidental); falls back to `backfill_daily_closes`'s dedicated `XAG_DAILY_CLOSE`/`XAU_DAILY_CLOSE` keys (NOT the Money Supply tab's `XAG_CLOSE`/`XAU_CLOSE` keys — those are month-end resampled with no daily granularity, a real bug caught during build). `backfill_intraday_ticks` pulls Yahoo 5-minute bars (capped ~72 days back; 1-minute is capped at only 8 days, too short) — so ~72 of a 90-day backfill window get real intraday-precision reactions, remaining ~18 oldest days fall back to same-day daily-close approximation.
- **Routes**: `GET /api/catcor/events/db`, `GET /api/catcor/reactions/db`, `POST /api/catcor/refresh` (manual re-seed+backfill+re-fetch, `500` if `FRED_API_KEY` unset).

### CATCOR: known gaps

- 📌 `consensus_value` only populates for events within the current Sun-Sat week — events outside it keep `actual_value` but never get `surprise_magnitude`, permanent limitation of the free source, not a bug to chase.
- 📌 Intraday-precision reactions only exist for the ~72 most recent days of the 90-day backfill window.
- 📌 Iterations 2+ beyond the Research tab (FedWatch, standing watchlists, sentiment scoring) not yet built — see `SPEC.MD`.

---

## Tab: Research (CATCOR Research Pane, per `catcor-events-spec.md`)

**Frontend**: `frontend/src/research_panel.jsx`. **Backend**: `backend/catcor_research.py`, `backend/db.py`'s research tables, `backend/prompts/*.py`.

### Research: what it does

A workbench for working a single claim/observation by hand, one turn at a time, ending in a disposition: promote it to a tracked Catalyst Event (renders on the CATCOR timeline, see below), dismiss it as noise, or discard it outright. Supersedes the original "Iteration 2" chat MVP — nothing is auto-fetched by a model deciding it's relevant; every turn is assembled from five independently-adjustable, human-set controls (spec section 3):

1. **Model** — `forge` (amp-forge, a local Ollama-backed LAN service) or `anthropic` (Claude), chosen per turn, `forge` is always the default.
2. **Persona** — dynamically listed from `backend/prompts/*.py` (see Personas below), no registration step.
3. **Context blocks** — six checkboxes (`cot_positioning`, `comex_inventory`, `money_supply`, `market_balance`, `prior_turns`, `freeform`), each folded into the prompt only if explicitly checked.
4. **Memory mode** — `stateless` or `accumulating`; a session's current mode is stored and defaults the toggle to wherever it was left.
5. **Prompt transparency** — a live, non-editable preview of the exact assembled payload (persona text + checked context blocks' real formatted data + draft input) before sending, computed server-side via `POST /sessions/{id}/preview` (calls `assemble_prompt` directly, zero model cost) rather than approximated client-side; each turn's assembled prompt is also persisted so the transcript can show exactly what was sent, after the fact.

### Session lifecycle

Four states: `active` (editable, only status that can send turns) → `promoted` | `dismissed` (both terminal/read-only) → `discarded` (hard-deleted, never a stored status value — `research_sessions`/`research_messages` rows are actually removed, not flagged). Gating rules (`catcor_research.py`):

- **Promote** (`promote_session`) — requires a read (bullish/bearish/neutral) already set. Writes a new `event_calendar` row: `event_type="observed"`, `source_tier="discovered"`, `research_session_id` backlinking to the session, `direction` = whatever was chosen in the promote form. `consensus_value`/`actual_value`/`surprise_delta` stay `NULL` (not applicable to an Observed-origin event).
- **Dismiss** (`dismiss_session`) — requires a read, a non-empty reason, and ≥1 turn already sent (a zero-turn session has nothing to reason about — it can only be discarded). Writes a `research_log` row.
- **Discard** (`discard_session`) — no gating beyond rejecting an already-terminal session (discarding a promoted/dismissed session would orphan the `event_calendar`/`research_log` row it already produced — see Demote below for the actual "undo a promotion" path). Hard-deletes the session and its messages.
- **Demote** (`delete_promoted_event`, new) — the reverse of promote: `DELETE /api/catcor/events/{event_id}` deletes the `event_calendar` row and its `macro_price_reaction` rows, then reverts the originating session back to `active` (editable again — can be re-promoted with a corrected date/name, dismissed, or discarded). Rejects government-seeded events (`source_tier != "discovered"`) — this is only for undoing a Research promotion, never for editing AV's own seeded calendar. Surfaced in the Research tab's **session list** (not the session detail view) as a bulk action: selecting one or more `promoted` rows lights up a ⬇ header button (selecting `active` rows instead lights up a 🗑 discard button; a genuinely mixed active+promoted selection leaves both buttons visibly disabled rather than guessing which action was meant).

### Personas (`backend/prompts/*.py`)

The only contract `catcor_research.list_personas()`/`load_persona_prompt()` enforce is a module-level `PROMPT` string constant — nothing else in a persona file is read by any code (headers/docstrings are human documentation only, following an established-but-unenforced convention). Personas are listed by scanning `backend/prompts/*.py` (excluding `__init__`/`__pycache__`), so a new file is selectable immediately with no registration step. Live personas:

- `word_count_v1` — trivial word-counter, the original plumbing-validation persona, still available but no longer the hardcoded default.
- `parser_v1` — the original combined decompose+match persona, built around a `TOOL_REQUEST:` plain-text protocol for a model-driven tool-use loop. **That loop no longer exists** (superseded by the human-checked context-block design above) — left in place, unwired, importable, but selecting it will produce inert `TOOL_REQUEST:` lines nothing intercepts.
- `parser_v2` — decomposition-only (supersedes `parser_v1`'s combined job, single-responsibility split): claim text in, a numbered list of testable sub-assertions out, each tagged CHECKABLE/NOT CHECKABLE. No tool references, no matching, no verdict.
- `matcher_v1` — matching-only, the other half of `parser_v1`'s old combined job: a list of sub-assertions in, each one paired with which of the four AV data types (`cot_positioning`/`comex_inventory`/`money_supply`/`market_balance` — same names the context-block checkboxes use) would test it, or `none`. Never fetches or invents real data — naming a match is separate from actually reading that data type's current value.
- `parser_v3` — currently identical behavior to `parser_v2`; created as a documented template (every available header/option/variable spelled out, since the only real option is `PROMPT` itself) rather than a behavior change.
- `analyst_v1` — contextualizing/connecting persona from the old 2-call pipeline (takes already-matched evidence, explains historical-range context, never renders a verdict); still selectable standalone now that any persona can run on any turn.

**No persona, on either backend, has real tool-calling access** — `call_anthropic`/`call_forge` are both pure text-in/text-out (no `tools` schema sent to Anthropic's API; amp-forge's payload has no tool-schema field either). This is a deliberate architecture choice, not a Claude-vs-Ollama capability gap: AV data reaches a model exclusively via the context-block mechanism (a human checks a box, Python fetches the real data and pastes formatted text into the prompt **before** the model sees the turn) — no persona ever decides what data it gets.

### Model backend layering

`call_anthropic(system_prompt, messages, model)` / `call_forge(same signature)` — one function per vendor, identical signature and return shape (`{"final_text": str}`), pure text-in/text-out. `call_ai(backend, ...)` is a thin dispatcher between them.

- **Anthropic**: raw httpx POST to `https://api.anthropic.com/v1/messages` (no SDK, same convention as every other outbound integration in this codebase), model `claude-haiku-4-5-20251001` — Haiku specifically, not Sonnet, a deliberate cost choice since this loop is exercised interactively/repeatedly during testing (confirm the exact model string against docs.claude.com if it ever needs correcting). Requires `ANTHROPIC_API_KEY`; has no mock mode — a `mock_key` passed to `call_anthropic` raises loudly rather than silently ignoring it, since this is real, billed traffic. `_require_backend_credentials` checks the *per-request* chosen backend, not just the server-wide default, so an explicit `"anthropic"` choice against a `forge`-default server still gets a clean `500` rather than a raw `KeyError`.
- **amp-forge** (`call_forge`): one POST to a local Ollama-backed LAN service's `/chat/stream` (`FORGE_URL`, default `http://amp-forge:8001/chat/stream`; see `forge-spec.md` in the amp-dev repo for the stateless/system-prompt contract), model `qwen3:8b`, accumulates SSE `token` events. Supports a `mock_key` to skip Ollama and stream back a fixed fixture instead. The `history` field in its payload is what powers Accumulating memory mode.
- **`DEFAULT_BACKEND`**, read from `AI_BACKEND` env var, **defaults to `"forge"`** — Anthropic is an explicit opt-in for real (billed) compute.

### Context assembly (`assemble_prompt`, `catcor_research.py`)

Four of the six context blocks map to the four evidence-tool functions (`_tool_get_cot_positioning`/`_tool_get_comex_inventory`/`_tool_get_money_supply`/`_tool_get_market_balance`, unchanged from the old pipeline, still also backing `GET /api/catcor/research/evidence/db`'s zero-cost debug dump) via a new dict→labeled-text formatting layer (`_fmt_cot_positioning` etc. — this formatting step didn't exist anywhere in the codebase before this rebuild). The other two (`prior_turns`, `freeform`) have no backing tool: `prior_turns` controls whether `messages` includes session history at all, `freeform` folds in caller-supplied ad hoc text.

**The one subtle piece**: prior-turn history is included only if `memory_mode == "accumulating"` **AND** `"prior_turns"` is checked — both, not either. Stateless always wins regardless of the checkbox (spec 3.4); an unchecked box means that data is absent, full stop (spec 3.3).

### Research: data flow

`POST /api/catcor/research/sessions` → `create_session` (persists session row only) → immediately followed by `send_message` with the claim as the first turn. `send_message` now takes the full five-control signature (`backend`, `model`, `persona`, `context_blocks`, `memory_mode`, `freeform_text`, plus `system_prompt_override`/`messages_override` for the prompt-preview's per-section edit bypass) — persists the user turn immediately (with `context_blocks`/`memory_mode`/`memory_changed`/`assembled_prompt` recorded on that row) → persists the assistant turn only if the model call fully resolves (with `backend`/`model`/`persona` recorded on that row). Raises if the session isn't `active` (→ route layer returns `409`).

Routes: `POST /sessions`, `GET /sessions/db`, `GET /sessions/{id}/db` (now also returns `promoted_event` — an `event_id`/`event_name`/`scheduled_time`/`direction` object whenever `status == "promoted"`, via a new `db.get_event_for_session` reverse lookup), `POST /sessions/{id}/messages`, `POST /sessions/{id}/preview`, `POST /sessions/{id}/read`, `POST /sessions/{id}/promote`, `POST /sessions/{id}/dismiss`, `POST /sessions/{id}/discard`, `DELETE /api/catcor/events/{event_id}` (demote), `GET /personas`, `GET /evidence/db`, `GET /forge-sessions` (stub, see below).

Tables: `research_sessions` (+ `memory_mode` column, tracks the session's current setting). `research_messages` (+ `backend`/`model`/`persona` — assistant rows only — and `context_blocks`/`memory_mode`/`memory_changed`/`assembled_prompt` — user rows only; a "turn" is still a user-row/assistant-row pair, fields split across the two roles rather than duplicated). `research_log` (+ `dismiss_reason`, required non-empty). `event_calendar`'s `research_session_id`/`direction` columns are now actually written (by promote) and read (by demote, and by `list_research_sessions`'s `LEFT JOIN` which surfaces `promoted_event_id` per row for the session list's bulk-demote action) — no longer dead columns.

**amp-forge session visibility** (spec 3.4) — a known, disclosed gap: amp-forge may hold its own model-side session/context independent of what AV resends, and viewing/clearing that state has no implemented mechanism. `GET /api/catcor/research/forge-sessions` is a stub returning `{"success": false, "detail": "...not yet available..."}` rather than guessing at a wire contract that lives in a separate repo's `forge-spec.md`.

### Research ↔ CATCOR integration

A promoted session's `event_calendar` row (`event_type="observed"`) renders on the CATCOR timeline exactly like a government-seeded event, with two differences: it's a **circle**, not a diamond (government events keep the diamond shape — `makeLinkedShape`'s `diamond` param is now `type !== "observed"`), and its own palette color (`CATCOR_EVENT_COLORS.observed`, amber). Both `get_upcoming_events` and `get_event_reaction_series` (backing `/api/catcor/events/db` and `/api/catcor/reactions/db`) now select `research_session_id`/`direction`, which didn't used to be exposed at all.

Clicking an `observed` point's dot in either CATCOR chart navigates straight to the Research tab and opens that point's originating session (via `App.jsx`'s `openResearchSessionId` state, threaded down to `CatcorPanel`'s `onOpenResearchSession` and `ResearchPanel`'s `openSessionId` prop) — a government-seeded point has no `research_session_id` and is a no-op on click. Both chart tooltips show a "Click to open the research record →" hint when a point has one.

The CATCOR legend is now click-to-toggle (same convention as the CoT panel's line legend): clicking any event-type row hides/shows that type on both charts simultaneously (`hiddenTypes` state, filtered before grouping into `pointsByType`/`timelineByType`); a hidden type's legend row dims but the legend itself always shows every type regardless of what's currently plotted.

**Note on reaction capture for promoted events**: `capture_snapshot`'s nearest-tick lookup already worked generically for `observed` events with zero code changes — `due_snapshots()` queries `event_calendar` unconditionally, no `event_type` filter — so promoting a session with a recent/past `scheduled_time` gets its 4 reaction windows captured automatically on the next 60s poll, same as any CPI/FOMC/NFP event.

### Research: known gaps

- 📌 amp-forge's own session-list/clear API is unconfirmed/unimplemented (see stub above) — AV's own Stateless/Accumulating toggle is fully real, but whatever amp-forge itself might be holding onto server-side is invisible.
- 📌 `parser_v1`'s `TOOL_REQUEST:` protocol is dead but the persona file/prompt text is unedited — selecting it produces inert sentinel lines nothing parses. Flagged as a low-priority cleanup, not fixed.
- 📌 Long-horizon claim verification (e.g. "this claim implied X oz/yr of demand — did COMEX/CoT data actually show that months later") is explicitly out of scope for this build — `macro_price_reaction`'s 4 fixed short windows around one instant don't fit that use case at all; a future, differently-shaped feature, not a variant of what exists today.

---

## Tab: Data

**Frontend**: `frontend/src/data_map.js` + `frontend/src/data_panel.jsx`. **Backend**: `backend/db.py`'s `source_health` table + `main.py`'s `/api/health/*` routes.

### Data: what it does

Two things layered together: a **static, hand-authored map** of every table AV persists (provenance/cadence/rate-limit/curl per upstream source — not introspectable from SQLite at runtime, so this must be kept in sync by hand, see the strict Data-tab-update rule under Standing rules above), and a **live Data Health view** (per dataHealth-spec.md) showing real-time fetch status per source.

### Data: panel contents

`DataPanel` (outer, defaults open) → `TieredLoopSummary` (fast/slow tier enabled+interval from `GET /api/refresh/settings`, plus healthy/total rollup per tier from `GET /api/health/db`) → one nested `<details>` per source (`SourceCard`): origin/cadence/rate-limit as key-value rows, one `FetchStatusRow` per `sourceKeys` entry (status dot computed client-side as ok/stale/error against that source's `expectedIntervalS`, last-success time, truncated last-error text, independent "Re-run now" button hitting `POST /api/health/refresh/{source_key}` — `cot_pipeline`'s button additionally grays out inside its 7-day rate-limit window), the `curl` block in a horizontally-scrollable `<pre><code>`, then a table per SQLite table listing every field + description.

Sources with no periodic fetch of their own (`catcor_calendar`'s static seed, `research`'s on-demand chat) simply omit `sourceKeys`/`healthMeta`.

### Data: data flow

`source_health` (source_key PK, last_attempt_at, last_attempt_status [success|error|skipped], last_success_at, last_error, consecutive_failures — upsert, current-state only, not append-only, one row per fetch-and-persist function/loop) is infrastructure describing the health of every other tab's upstream fetch — not itself a market-data table, so it has no `data_map.js` SourceCard of its own. `_FAST_TIER_REGISTRY`/`_SLOW_TIER_REGISTRY`/`_ON_DEMAND_REGISTRY` (merged into `_SOURCE_REGISTRY` in `main.py`) replace what used to be a hardcoded tuple literal — both the tiered loops and `POST /api/health/refresh/{source_key}` read from the same registry, so the two paths can't drift apart.

`GET /api/health/db` is a thin read of `source_health` — it does not compute ok/stale/error itself, since the per-source cadence threshold (`expectedIntervalS`) lives in `data_map.js`, and duplicating it server-side would create two sources of truth for the same number; the frontend computes status client-side against that value.

A small always-visible header dot (`HeaderHealthDot` in `App.jsx`) polls `/api/health/db` every 60s independent of which tab is active — red if any tracked source is erroring, yellow if any is stale with no errors, green otherwise; links nowhere, since the Data tab nav button is already one click away for drill-down.

### Data: known gaps

None currently tracked — this tab's own gaps are, by design, whatever every other tab's Known gaps sections say about their upstream fetches.

---

## Repo layout

```text
backend/
  main.py               FastAPI app: fetch+persist functions + /db read routes for every tab above, plus /api/refresh/settings + /api/refresh/force (tiered refresh control) and /api/health/* (Data Health). Serves frontend/dist. Invoked as `uvicorn backend.main:app` (package-qualified, not cwd-relative).
  db.py                 SQLite persistence (sqlite3 stdlib, no ORM) — runtime/argentvigil.db, DB_PATH computed __file__-relative, os.makedirs guard. See each tab section above for its own tables; gold has parallel tables to silver (gold_inventory_aggregate, gold_inventory_depository, gold_volume_oi) throughout.
  mc_token.py            metalcharts.org auth token fetch/cache (module-level globals, single-process only)
  catcor.py               CATCOR tab backend (see Tab: CATCOR above)
  catcor_research.py      Research tab backend (see Tab: Research above)
  delivery_behavior.py    Delivery Behavior cross-check layer, feeds both Inventory and CoT tabs (see those sections above)
  prompts/                Research tab's model personas — all live/selectable (see Tab: Research's Personas subsection): word_count_v1.py, parser_v1.py (dead TOOL_REQUEST: protocol, unwired but importable), parser_v2.py, parser_v3.py, matcher_v1.py, analyst_v1.py. Only contract: a module-level PROMPT string.
  __init__.py             Empty — makes backend/ a real package

seed_data/
  catcor_events_seed.py        Manually-maintained FOMC/CPI/NFP calendar (dates cross-checked against ALFRED + the Fed's own meeting calendar). Each event carries source_tier (currently "government" for all three types).
  silver_market_balance.json   Manually maintained annual Silver Institute balance data (Inventory tab's Market Demand section)
  cme/112.pdf, cme/113.pdf     COMEX rulebook Chapters 112 (Silver)/113 (Gold) — reference only, confirms Delivery Behavior's Last Trade Day rule

runtime/            Gitignored — generated state, not source. Just argentvigil.db.

pipeline/
  config.py         All tunable thresholds/constants for the CoT tab
  fetch.py          CFTC Socrata API (urllib, stdlib only) — both Legacy and Disaggregated datasets
  price_fetch.py    Yahoo Finance chart API (urllib, stdlib only) — CoT tab's price series only
  compute.py        net_long_pct_oi, percentile ranks, signal classification, track record (CoT tab)
  run.py            Entry point — fetch -> compute -> persist -> cache/cot_data.json
  cache/cot_data.json   Pipeline output (gitignored) — standalone-CLI usability only, not read by the frontend

frontend/
  src/App.jsx                 Top-level composition, owns activeSection tab state (SECTIONS: cot, moneySupply, inventory, catcor, research, data). All six sections mounted unconditionally with a section-hidden class toggled by activeSection — never conditionally rendered/unmounted, so switching tabs never refires mount-time fetches/listeners. Also owns pinnedSection (see Standing rules' pinned-default-tab entry) and openResearchSessionId (CATCOR-dot-click-to-Research-session hotlink state, threaded to CatcorPanel/ResearchPanel — see Tab: Research's integration subsection).
  src/silver_cot_tracker.jsx  CoT tab (see Tab: CoT above)
  src/comex_inventory.jsx     Inventory tab (see Tab: Inventory above)
  src/delivery_behavior_panel.jsx  Delivery Behavior panel, nested in comex_inventory.jsx (see Tab: Inventory above)
  src/market_balance.jsx      Market Demand / Demand Composition, nested in comex_inventory.jsx (see Tab: Inventory above)
  src/money_supply.jsx        Money Supply tab (see Tab: Money Supply above)
  src/catcor_panel.jsx        CATCOR tab (see Tab: CATCOR above)
  src/research_panel.jsx      Research tab (see Tab: Research above)
  src/data_map.js             Data tab's static source map (see Tab: Data above)
  src/data_panel.jsx           Data tab's rendering (see Tab: Data above)
  src/refresh_controls.jsx     FORCE_REFRESH_EVENT export only — the RefreshControls UI component itself is no longer rendered anywhere (its "Configuration" collapsible was removed at the user's request); file kept because 4 other files still import the event constant. Backend refresh-tier settings/force endpoints are unaffected, just no UI control for them.
  src/palette.js              Shared chart color constants (VAULT_COLORS, CATCOR_EVENT_COLORS)
  vite.config.js              publicDir points at pipeline/cache (legacy); /api proxied to :8000

utils/
  dev.sh              Boots venv, installs deps if missing, kills anything already listening on :8000/:5173, runs FastAPI + Vite together
  sniff-metal-charts.py, sniffer.sh   Tools for reverse-engineering metalcharts.org API responses
```

**Convention:** runnable scripts live in `utils/`, not the repo root.

## Conventions

- **Backend**: stdlib `sqlite3` (no ORM), `httpx.AsyncClient` for outbound calls (one shared client via FastAPI lifespan), routes are thin — fetch, reshape, upsert, return `{"success": bool, "data": ...}`. HTTP errors from upstream become `HTTPException(502, str(e))`.
- **Pipeline**: intentionally stdlib-only, no third-party deps — keep it that way. Config constants belong in `pipeline/config.py`, not scattered inline.
- **Frontend**: React 19 + Vite 5 + Recharts, no state library, no router (single page, tab-like sections via `App.jsx`). Chart colors come from `palette.js`, not ad hoc hex values.
- **Units**: COMEX figures are troy oz; SHFE is kg natively, converted via `1 kg = 32.1507 oz` (constant appears in both `main.py` and any frontend display — keep consistent). COMEX open interest contracts are 5,000 oz each.
- **AV Voice Rules** (from SPEC.MD, applies repo-wide to any user-facing copy): no "alarming"/"critical" framing on deficit trends, always show the ±20% uncertainty qualifier on above-ground stock figures, label runway/track-record figures explicitly as historical description or context — never as prediction.
- **Collapsible sections**: the established UI pattern for any collapsible pane is native `<details className="collapsible-pane"><summary className="collapsible-pane-title">…</summary><div className="collapsible-pane-body">…</div></details>` (CSS in `index.css`) — nest freely. Prefer this over a `useState` show/hide toggle unless more complex interaction state is needed.
- **Custom legends over Recharts' built-in `<Legend>`**: chart legends in this codebase are hand-rolled (`.comex-legend-list`/`.comex-legend-item`/`.comex-legend-swatch` classes), one entry per line with an inline plain-English definition. Some legend rows are also clickable via a wrapping `<button className="comex-legend-item legend-btn-row">`.
- **Custom scatter-point shapes for cross-chart consistency**: CATCOR's two charts and its legend all use the same diamond shape per event type (`.comex-legend-swatch--diamond` for the legend; a shared `makeLinkedShape` renderer for the charts themselves).

## Running it

```bash
bash utils/dev.sh          # everything (venv bootstrap + backend :8000 + frontend :5173)
python3 pipeline/run.py    # CoT pipeline only, no server needed
```

Run the pipeline at least once before the frontend, since the CoT tab reads from `/api/cot/db`, which reads `cot_silver`/`cot_gold` from `runtime/argentvigil.db` — empty tables make that route return a `500` ("No CoT data persisted yet. Run pipeline/run.py first.").

The exchange-inventory/FRED/spot-price data populates itself on first backend startup regardless (a one-time unconditional refresh runs in `main.py`'s `lifespan`) — the tiered background refresh only *repeats* on a schedule if explicitly enabled via `POST /api/refresh/settings` or forced via `POST /api/refresh/force`. CATCOR's event calendar and reaction backfill also run automatically on every startup — no manual trigger needed, though `/api/catcor/refresh` exists for an on-demand re-run. ALFRED calls need `FRED_API_KEY` set in whatever shell launches the backend — without it, the event calendar and price reactions still populate, but `actual_value`/`surprise_delta` stay `NULL`. Research's Anthropic backend needs `ANTHROPIC_API_KEY` only if `AI_BACKEND=anthropic` is explicitly set (default is `forge`, which needs no key but does need the `amp-forge` LAN service reachable). The LBMA fix (see Silver/Gold sections above) needs `GAPI_API_KEY` (GoldAPI.io, free tier) — without it, `_lbma_fix_startup` logs a skip message and the rest of the app boots normally; `lbma_fix` just stays empty and `LbmaFixBadge` renders nothing.

**Always run Python through `.venv`, never bare `python3`.** `bash utils/dev.sh` creates
`.venv` on first run and installs `requirements.txt` into it (`fastapi`, `uvicorn`, `httpx`,
`python-dotenv` — none of these are on system Python). Before running any Python command
against this repo — import checks, one-off scripts, `python -c "..."` sanity tests — run
`source .venv/bin/activate` first, or invoke `.venv/bin/python` directly. `pipeline/` is the one
exception: it's intentionally stdlib-only by design and *can* run under bare `python3`, but
`main.py`/`db.py`/anything importing `fastapi`, `httpx`, or `dotenv` cannot.

## Data sources (see README.md for full table)

CFTC PRE Socrata API (CoT — both Legacy `jun7-fc8e` and Disaggregated `72hh-3qpy` datasets), Yahoo Finance (SLV/GLD/GC=F/SI=F), metalcharts.org (COMEX/SHFE inventory, volume/OI, delivery notices, spot prices — reverse-engineered API, auth via `mc_token.py`), Sprott direct API (PSLV), Silver Institute World Silver Survey (manually transcribed, annual), ALFRED (FRED's point-in-time vintage API — CATCOR's `actual_value`s), ForexFactory (`nfs.faireconomy.media`'s free calendar export — CATCOR's `consensus_value`s, current-calendar-week only), CME Group COMEX rulebook (Chapters 112/113 — Delivery Behavior's Last Trade Day rule, `seed_data/cme/`), Anthropic Messages API / amp-forge LAN service (Research tab's chat backend). CME's Market Data Platform (per-contract-month OI/settlement, the `get_settlements` API) was investigated and confirmed **paid**, not a free source — not integrated.
