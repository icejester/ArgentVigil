# ArgentVigil

A silver speculative positioning monitor, with gold as comparative context. The framing is **selling dollars, not buying metals** — the core question is whether the speculative futures crowd has genuinely capitulated or is just experiencing a routine pullback.

ArgentVigil is not a trading system and produces no price targets. It is a positioning dashboard.

---

## What it does

ArgentVigil has two layers:

**CoT Positioning Pipeline** — fetches CFTC Commitment of Traders data for COMEX Silver (084691) and COMEX Gold (088691), computes a normalized positioning metric (`net_long_pct_oi`), and ranks it against rolling 2-year and 5-year historical windows.

**Exchange Inventory Dashboard** — a live physical inventory view across COMEX (silver and gold), SHFE (Shanghai), and PSLV (Sprott), served by a FastAPI backend that proxies metalcharts.org and persists results to SQLite. The same backend also serves a Money Supply panel (M2, Fed balance sheet, CPI-derived purchasing power) sourced from FRED, and a metals-vs-purchasing-power comparison sourced from Yahoo Finance.

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
- **Paper Leverage Ratio (silver and gold)** — `open interest × contract size ÷ registered inventory` for each metal separately (5,000 oz contracts for silver, 100 oz for gold), each shown alongside that metal's live spot price and 24h change.
- **Signal banners** — current percentile reading and classification for each metal, both windows.
- **Signal track record** — historical hit-rate analysis: when the crowd was crowded or capitulated in the past, what did price do at +4 weeks and +8 weeks? Presented as historical description only, not prediction. Sample sizes are shown; thin samples are flagged.

---

## Exchange Inventory Dashboard

A separate frontend tab ("Stock & Flow") backed by a FastAPI server that pulls live data from metalcharts.org on demand and caches it locally in SQLite (`argentvigil.db`). The dashboard is organized as collapsible sections: the cross-exchange overlay at the top, then COMEX and SHFE each as their own collapsible section (with their vault snapshots plus nested sub-sections for history charts and delivery notices), then Market Demand, Demand Composition, and Global Context as separate collapsible sections.

### COMEX — New York

- **Per-Vault Snapshot** — today's registered/eligible/total by depository with day-over-day deltas, plus an interactive pie chart filterable by metric
- **Registered vs Eligible** (nested, collapsible) — distinguishes warranted (deliverable) metal from eligible (stored, not warranted); sharp registered drops are a delivery pressure signal. Includes a registered/eligible ratio series; spikes indicate metal being warranted for delivery.
- **Delivery Notices — Month to Date** (nested, collapsible) — daily issued/stopped delivery notices, tabular. `mtdCumulative`/`ytdCumulative` fields are omitted — they're currently unpopulated (always zero) in metalcharts.org's response.

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

## Money Supply

A separate collapsible panel (rendered above Stock & Flow) tracking the supply of the thing being debased:

- **M2 Money Stock / Fed Balance Sheet** — trillions USD, with M2 year-over-year % change on a secondary axis. Sourced from FRED (M2SL, WALCL).
- **Dollars vs Silver vs Gold as Purchasing Power** — four series (Fiat, $100 nominal; Gold XAU; Silver XAG month-end closes since 2006; CPI-derived Purchasing Power) shown as relative return % against a selectable baseline. Click a legend label to choose the baseline (Purchasing Power can't be selected as baseline — it isn't a holdable asset); use the checkbox to show/hide a line. Click and hold a point on the chart to see each series' return from that date to the latest data, relative to the current baseline, without redrawing the lines.

---

## Explicit non-goals

- No price targets
- No "hidden demand" or defense/aerospace dealer estimates — not falsifiable, not tracked
- No risk-tolerance commentary
- No prediction framing — the track record section shows what happened historically, not what will happen

---

## Stack

**Pipeline** (CoT data, no server required):

- Python 3, standard library only (no third-party deps)
- Fetches from CFTC PRE Socrata API and Yahoo Finance
- Output: `pipeline/cache/cot_data.json`

**Backend** (Exchange inventory, Money Supply, and metals-vs-purchasing-power server):

- FastAPI + uvicorn
- httpx for async proxying of metalcharts.org, FRED, and Yahoo Finance
- SQLite via `db.py` for persistence (`argentvigil.db`) — a generic `fred_observations` table stores both FRED series and resampled Yahoo Finance metal-price history
- Authenticated requests to metalcharts.org via `mc_token.py`
- Requires `FRED_API_KEY` in the environment for the Money Supply refresh endpoint (`.env` file, loaded via `python-dotenv`, or shell-exported)

**Frontend**:

- React + Vite 5 + Recharts
- Sections: CoT positioning (reads `cot_data.json`), Money Supply, and Exchange Inventory (both call the FastAPI backend)
- Auto-refresh on the inventory dashboard (configurable via `VITE_AV_REFRESH_INTERVAL`, default 60s); Money Supply and metals price history refresh on-demand via a Refresh button

---

## Running it

### CoT pipeline (no server needed)

```bash
python3 pipeline/run.py
```

Output: `pipeline/cache/cot_data.json`

CoT data is as of Tuesday each week, published by the CFTC on Friday (~3-day lag). The staleness label in the UI makes this explicit.

### Exchange inventory backend

```bash
pip install -r requirements.txt
uvicorn main:app --reload
```

The backend proxies metalcharts.org and serves from `http://localhost:8000`. On first start it backfills the full COMEX history if the local SQLite database is empty.

### Frontend dev server

```bash
cd frontend
npm install
npm run dev
```

The dev server reads `cot_data.json` from `pipeline/cache/` via Vite's `publicDir` config, and proxies `/api/*` requests to the FastAPI backend. Run the pipeline at least once and start the backend before launching the frontend.

### Convenience script

```bash
bash utils/dev.sh
```

Starts the backend and frontend dev server together.

---

## Data sources

| Data | Source | Cadence |
| --- | --- | --- |
| CFTC CoT (Silver, Gold) | CFTC Public Reporting Environment Socrata API | Weekly (Friday) |
| Silver / Gold prices (for track record) | Yahoo Finance — SLV / GLD ETF | Weekly |
| GSR spot prices | Yahoo Finance — GC=F / SI=F futures | Weekly |
| Silver / Gold month-end closes (purchasing-power comparison) | Yahoo Finance — SI=F / GC=F futures, daily resampled to month-end | Monthly |
| COMEX inventory (aggregate + depositories, silver and gold) | metalcharts.org proxy (CME Group vaults) | Daily |
| COMEX volume / open interest (silver and gold) | metalcharts.org | Daily |
| COMEX delivery notices | metalcharts.org | MTD |
| SHFE inventory | metalcharts.org proxy (Shanghai Futures Exchange) | Weekly |
| PSLV holdings | Sprott direct API | Daily |
| Spot prices (XAG / XAU) | metalcharts.org | Intraday |
| M2 Money Stock, Fed Balance Sheet, CPI | FRED (Federal Reserve Bank of St. Louis) — M2SL, WALCL, CPIAUCSL | Monthly / Weekly |

LME (London) requires a paid subscription and is not tracked.
