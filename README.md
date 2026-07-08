# ArgentVigil

Most silver dashboards show you a price and call it a day. ArgentVigil actually watches the market — positioning, physical inventory, delivery behavior, monetary context, and event reactions, all in one place, in real depth, with gold along for comparison. The governing idea is **selling dollars, not buying metals**: almost everything that looks like a silver signal is actually a dollar signal wearing a costume, and most of this dashboard exists to catch it in the act — separating "the futures crowd changed its mind" from "metal is actually moving" from "the currency itself is being debased," instead of blurring all three into one number and calling it insight.

ArgentVigil is not a trading system, and it doesn't need to be — it produces no price targets, no prediction framing, no risk-tolerance commentary. It's instrumentation built to be right about what already happened, not a system built to guess what happens next.

---

## What it does

Silver doesn't have one signal — it has a positioning story, a physical-inventory story, a delivery story, and a monetary story, and half the "silver commentary" out there just picks whichever one supports the conclusion it already wanted. ArgentVigil keeps each story honest on its own terms instead of collapsing them into a single verdict for you to trust blindly. Four layers, one frontend, no hand-waving:

**CoT Positioning Pipeline** — fetches CFTC Commitment of Traders data for COMEX Silver (084691) and COMEX Gold (088691), computes a normalized positioning metric (`net_long_pct_oi`), and ranks it against rolling 2-year and 5-year historical windows. Persists to the shared SQLite database; the frontend reads it back via the FastAPI backend, never the pipeline's own JSON cache directly.

**Exchange Inventory Dashboard** — a live physical inventory view across COMEX (silver and gold), SHFE (Shanghai), and PSLV (Sprott), served by a FastAPI backend that proxies metalcharts.org/Sprott and persists results to SQLite via a tiered background refresh. The same backend also serves a Money Supply panel (M2, Fed balance sheet, CPI-derived purchasing power) sourced from FRED, and a metals-vs-purchasing-power comparison sourced from Yahoo Finance.

**CATCOR (Catalyst Correlation)** — an event/reaction spine answering "which catalysts actually move silver and gold" with observed data, no interpretation layer. Tracks a macro-event calendar (FOMC, CPI, NFP), sources actual/consensus values from ALFRED and ForexFactory, and captures price reactions at fixed windows (T-30min/T+5min/T+30min/T+2hr) around each event.

**Delivery Behavior** — a cross-check layer sitting on top of data the other three layers already persist (registered/eligible inventory, delivery notices, disaggregated CoT), computing derived anomaly signals: is registered inventory rising for reasons that look like real delivery pressure, or just reclassification with no matching notice volume; which trader categories are actually holding long positions as First Notice Day approaches.

**Data tab** — a hand-authored map of every table AV persists, paired with live fetch-health status (ok/stale/error) per upstream source and a per-source "re-run now" control. Not a feature panel in the trading sense — it's the app's own transparency/observability surface.

---

## CoT Positioning

**`net_long_pct_oi`** = (non-commercial longs − non-commercial shorts) ÷ total open interest × 100

Normalizing by open interest removes the noise of market size growth over time, making readings from 2011 and 2024 directly comparable.

**Signal zones** (configurable in `pipeline/config.py`):

- ≥ 90th percentile → specs crowded long — caution
- ≤ 10th percentile → specs capitulated — back-up-the-truck zone
- Between → normal range, no signal

Both a 2-year and 5-year lookback window are computed side-by-side. When they disagree, the UI flags it explicitly.

### What the CoT panel shows

- **Combined CoT chart** — silver and gold net long % of open interest on the same axis, 5-year view, with a legend below the chart (one metric per line, each with an inline plain-English definition). Click a legend entry to toggle that line independently. When only one metal is visible, 10th/90th percentile reference lines appear.
- **Gold/Silver Ratio** — plotted on an inverted right axis (lower GSR = silver outperforming = line goes up). Computed from COMEX futures spot prices (GC=F ÷ SI=F), not ETF prices.
- **Who's Holding Long Positions** (Category Composition, open by default) — disaggregated CoT category share of long open interest over time, both metals, by trader category (producer/merchant, swap dealer, managed money, other reportable). Includes an approximate "days to First Notice Day" marker per week as a directional-only reference, not a claim about which contract month any category actually sits in.
- **Paper Leverage Ratio (silver and gold, collapsible, closed by default)** — `open interest × contract size ÷ registered inventory` for each metal separately (5,000 oz contracts for silver, 100 oz for gold), each shown alongside that metal's live spot price and 24h change.
- **Signal banners** — current percentile reading and classification for each metal, both windows.
- **Signal track record** — historical hit-rate analysis: when the crowd was crowded or capitulated in the past, what did price do at +4 weeks and +8 weeks? Presented as historical description only, not prediction. Sample sizes are shown; thin samples are flagged.
- **Staleness label** — "CoT data as of ... · published ~..." so a stale report is never mistaken for a fresh one.

---

## Exchange Inventory Dashboard ("Stock & Flow")

A frontend tab backed by a FastAPI server that pulls data from metalcharts.org/Sprott via a tiered background refresh and caches it in SQLite. The dashboard is organized as nested collapsible sections: cross-exchange overlay at the top, then COMEX and SHFE each as their own collapsible section, then Market Demand, Demand Composition, and Global Context as sibling sections.

### COMEX — New York

- **Per-Vault Snapshot** — today's registered/eligible/total by depository with day-over-day deltas, plus an interactive pie chart filterable by metric. Supports "pinning" to a past date (hover a flagged row in Delivery Behavior below) to show that date's real per-vault breakdown, where history exists.
- **Delivery Behavior** (nested, collapsible) — see the Delivery Behavior section below.
- **Registered vs Eligible** (nested, collapsible) — distinguishes warranted (deliverable) metal from eligible (stored, not warranted); sharp registered drops are a delivery-pressure signal. Includes a registered/eligible ratio series; spikes indicate metal being warranted for delivery.
- **Delivery Notices** (nested, collapsible) — daily issued/stopped delivery notices, tabular. `mtdCumulative`/`ytdCumulative` fields are omitted — they're currently unpopulated (always zero) in metalcharts.org's response.

### SHFE — Shanghai

- **SHFE Warehouse Snapshot** — current warranted silver by approved SHFE warehouse with delta column and pie chart
- **SHFE Silver Inventory (Shanghai)** (nested, collapsible) — time-series chart of Shanghai Futures Exchange warranted silver, converted from kg to troy oz (1 kg = 32.1507 oz)

### Cross-exchange overlay

- **COMEX vs SHFE Physical Exchange Inventories** — dual-axis chart overlaying COMEX (left axis) and SHFE (right axis, independent scale) with PSLV/Sprott as a reference line. Proportional bar comparison shows relative scale (COMEX is ~12× larger than SHFE in absolute terms).
- **PSLV (Sprott Physical Silver Trust)** — live custodial oz from the Royal Canadian Mint, Ottawa, fetched directly from Sprott's API

### Market Demand / Demand Composition (collapsible sections)

- **Annual Market Balance** — Silver Institute annual supply/demand balance, deficit/surplus by year, 5-year cumulative, and recoverable-stock runway estimates under stated assumptions (not a prediction)
- **Demand Composition Over Time** — stacked share of Industrial, Jewelry & Silverware, Physical Investment, and ETF Net Flow demand by year

### Global Context (collapsible section)

- **Estimated Above-Ground Silver Stock** — proportional bar breakdown by category (Jewelry & Silverware, Investment/coins & bars, Industrial/unrecoverable, ETF & Exchange Vaults, Central Bank/Govt Reserves) from Silver Institute WSS 2024 / USGS / CPM Group, with a live-computed bar for the AV-tracked exchange subset. All figures carry an explicit ±20% uncertainty qualifier.
- **Stack Calculator** — input personal troy oz holdings and see them expressed as a percentage of estimated above-ground stock, COMEX registered, and total tracked exchange inventory (COMEX + SHFE)

---

## Delivery Behavior

A cross-check layer, not a new data source of its own (beyond one: disaggregated CoT). Answers "is this inventory move real delivery pressure, and who's actually standing for it."

- **Reclassification vs. Real Inflow** (silver only) — flags days where registered inventory rose sharply but same-day delivery-notice volume (converted from COMEX contracts to troy oz) covers less than 10% of the increase — i.e. metal was reclassified from eligible to registered, not genuinely delivered in. Each flagged row also shows total vault holdings (yesterday/today/change), since total and registered can move in opposite directions on the same day. Rows are hoverable to pin the vault snapshot above to that date.
- **Short-Term Anomaly vs. Structural Deficit** — repackages the annual Silver Institute balance series alongside the short-term reclassification window, so a short-term inventory blip isn't mistaken for evidence about the multi-year structural deficit, or vice versa.
- **Category Composition** — see "Who's Holding Long Positions" under CoT Positioning above (lives in the CoT tab, since it's CoT-derived data, not Stock & Flow).

First Notice Day / Last Trade Day are computed on the fly from COMEX's contract-month listing rules (confirmed against CME rulebook Chapters 112/113), not from a seed table — both silver and gold trade nearly every calendar month, so there's no small fixed delivery-month cycle to hardcode.

**Permanently out of scope** (not deferred): a seasonal open-interest-decay baseline and a price lead/lag signal, both of which would require real per-contract-month open interest. CME's genuine source for that is a paid Market Data Platform product, not a free scrapeable page — confirmed live during development.

---

## Money Supply

A collapsible panel (rendered above Stock & Flow) tracking the supply of the thing being debased:

- **M2 Money Stock / Fed Balance Sheet** — trillions USD, with M2 year-over-year % change on a secondary axis. Sourced from FRED (M2SL, WALCL).
- **Dollars vs Silver vs Gold as Purchasing Power** — four series (Fiat, $100 nominal; Gold XAU; Silver XAG month-end closes since 2006; CPI-derived Purchasing Power) shown as relative return % against a selectable baseline. Click a legend label to choose the baseline (Purchasing Power can't be selected as baseline — it isn't a holdable asset); use the checkbox to show/hide a line. Click and hold a point on the chart to see each series' return from that date to the latest data, relative to the current baseline, without redrawing the lines.

---

## CATCOR (Catalyst Correlation)

A frontend tab answering "did this catalyst actually move the metal" with real observed data — no sentiment, no prediction, no ingestion (that's a later iteration).

- **Event calendar** — a manually-maintained FOMC/CPI/NFP schedule (dates cross-checked against ALFRED and the Fed's own calendar), auto-seeded and kept idempotent across restarts
- **Actual values** — sourced from ALFRED (FRED's point-in-time vintage API), not today's revised numbers — a raw CPI/NFP print as it actually stood on the day it was released
- **Consensus values** — sourced from ForexFactory's free calendar feed, persisted per-calendar-week to avoid its aggressive rate limiting
- **Price reaction capture** — silver and gold price snapshots at T-30min/T+5min/T+30min/T+2hr around each event's scheduled release, backed by Yahoo Finance 5-minute intraday bars (falling back to daily closes for events older than ~72 days)
- **Catalyst Timeline** — scatter chart plotting every captured catalyst by calendar date over a selectable lookback window (1M/3M/6M/1Y, fixed 30-day lookahead); known-future events render at reduced opacity as placeholders
- **Surprise Magnitude vs. Price Reaction** — scatter chart plotting surprise (actual − consensus) against price reaction, only for events where both are known, with its own T-30m/T+5m/T+30m/T+2h window toggle; hovering a point in either chart doubles the size of that same event's point in the other

Known, disclosed limitations (not bugs): consensus values can only be captured for events within the current Sun–Sat calendar week (ForexFactory's feed has no historical or future window); intraday-precision reactions only exist for the ~72 most recent days of the backfill window (Yahoo Finance's 5-minute-interval cap).

---

## Data tab

A hand-authored map of every SQLite table AV persists, one card per upstream source (CFTC, Yahoo, metalcharts.org, Sprott, FRED/ALFRED, ForexFactory, CME). Each card shows origin, cadence, rate-limit posture, a real runnable-shape `curl` reproducing the actual upstream call, and the fields in every table it populates. Layered on top: a live Data Health view — per-source fetch status (ok/stale/error, computed client-side against each source's expected cadence), last success time, last error text, and an independent "re-run now" button per source. A tiered-loop summary shows fast/slow tier enabled state and a healthy/total rollup per tier.

This tab is meant to be the single source of truth for what data AV has, where it came from, and how fresh it is — kept in sync by hand whenever the data shape changes (see `CLAUDE.md`'s Data tab convention).

---

## Explicit non-goals

- No price targets
- No "hidden demand" or defense/aerospace dealer estimates — not falsifiable, not tracked
- No risk-tolerance commentary
- No prediction framing — the track record section shows what happened historically, not what will happen

---

## Stack

**Pipeline** (CoT + disaggregated CoT data):

- Python 3, standard library only (no third-party deps) — runnable with bare `python3`, no venv required
- Fetches from CFTC PRE Socrata API (Legacy `jun7-fc8e` + Disaggregated `72hh-3qpy`) and Yahoo Finance
- Persists to the shared SQLite database (`runtime/argentvigil.db`) via `backend/db.py` (itself pure stdlib, so importing it doesn't pull in FastAPI/httpx); also writes `pipeline/cache/cot_data.json` for standalone-CLI usability, though the frontend no longer reads that file

**Backend** (Exchange inventory, Money Supply, CATCOR, Delivery Behavior, Data Health):

- FastAPI + uvicorn, served as `backend.main:app`
- httpx for async proxying of metalcharts.org, FRED/ALFRED, ForexFactory, and Yahoo Finance (one shared `AsyncClient` via lifespan)
- SQLite via `backend/db.py` for persistence (`runtime/argentvigil.db`) — one shared database for the whole app, including the CoT pipeline's tables and CATCOR's tables
- Authenticated requests to metalcharts.org via `backend/mc_token.py`
- A tiered background refresh (fast tier: spot prices; slow tier: everything else exchange-related) keeps SQLite warm; both tiers run once unconditionally at startup, then repeat only if explicitly enabled
- Requires `FRED_API_KEY` in the environment for the Money Supply refresh endpoint and CATCOR's ALFRED actuals (`.env` file, loaded via `python-dotenv`, or shell-exported)

**Frontend**:

- React 19 + Vite 5 + Recharts, no state library, no router (single page, tab-like sections)
- Sections: CoT, Money Supply, Inventory (Stock & Flow + Delivery Behavior), CATCOR, Data — all read from `/db`-suffixed FastAPI routes, never a live upstream fetch or the pipeline's JSON cache
- Panels mount once and stay mounted; switching tabs toggles visibility only, so fetches and event listeners never refire on tab switch

---

## Running it

### CoT pipeline (no server needed)

```bash
python3 pipeline/run.py
```

Persists to `runtime/argentvigil.db` (and also writes `pipeline/cache/cot_data.json` for standalone-CLI use). Run this at least once before the frontend — the CoT tab reads from the backend's `/api/cot/db` route, which reads the tables this populates.

CoT data is as of Tuesday each week, published by the CFTC on Friday (~3-day lag). The staleness label in the UI makes this explicit.

### Everything else

```bash
bash utils/dev.sh
```

Boots `.venv` (installing `requirements.txt` if missing), kills anything already on :8000/:5173, then runs FastAPI (:8000) + Vite (:5173) together. On first backend start, exchange inventory, Money Supply/FRED series, and CATCOR's event calendar/reactions all backfill automatically if the local database is empty.

**Always run Python through `.venv`, never bare `python3`**, except for `pipeline/`, which is intentionally stdlib-only and can run under bare `python3`. Before running any other Python command against this repo, `source .venv/bin/activate` or invoke `.venv/bin/python` directly.

---

## Data sources

| Data | Source | Cadence |
| --- | --- | --- |
| CFTC CoT Legacy (Silver, Gold) | CFTC Public Reporting Environment Socrata API (`jun7-fc8e`) | Weekly (Friday) |
| CFTC CoT Disaggregated (Silver, Gold) | CFTC Public Reporting Environment Socrata API (`72hh-3qpy`) | Weekly (Friday) |
| Silver / Gold prices (for track record) | Yahoo Finance — SLV / GLD ETF, weekly | Weekly |
| GSR spot prices | Yahoo Finance — GC=F / SI=F futures | Weekly |
| Silver / Gold month-end closes (purchasing-power comparison) | Yahoo Finance — SI=F / GC=F futures, daily resampled to month-end | Monthly |
| COMEX inventory (aggregate + depositories, silver and gold) | metalcharts.org proxy (CME Group vaults) | Daily (slow tier) |
| COMEX volume / open interest (silver and gold) | metalcharts.org | Daily (slow tier) |
| COMEX delivery notices (YTD) | metalcharts.org | Daily (slow tier) |
| SHFE inventory / warehouses | metalcharts.org proxy (Shanghai Futures Exchange) | Daily (slow tier) |
| PSLV holdings | Sprott direct API | Daily (slow tier) |
| Spot prices (XAG / XAU) | metalcharts.org | Intraday (fast tier) |
| M2 Money Stock, Fed Balance Sheet, CPI | FRED (Federal Reserve Bank of St. Louis) — M2SL, WALCL, CPIAUCSL | Monthly / Weekly |
| Macro event actuals (CPI, NFP) | ALFRED (FRED's point-in-time vintage API) | Per release |
| Macro event consensus | ForexFactory free calendar feed | Cached weekly (current Sun–Sat week only) |
| Event-window price reactions (XAG / XAU) | Yahoo Finance intraday (5-min bars) / daily close fallback | Per event |
| COMEX rulebook (Ch. 112/113 — Last Trade Day rule) | CME Group, static reference PDFs | One-time reference |

LME (London) requires a paid subscription and is not tracked. CME's per-contract-month open interest (Market Data Platform) is also paid and not integrated.
