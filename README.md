# ArgentVigil

A silver speculative positioning monitor, with gold as comparative context. The framing is **selling dollars, not buying metals** — the core question is whether the speculative futures crowd has genuinely capitulated or is just experiencing a routine pullback.

ArgentVigil is not a trading system and produces no price targets. It is a positioning dashboard.

---

## What it does

ArgentVigil has two layers:

**CoT Positioning Pipeline** — fetches CFTC Commitment of Traders data for COMEX Silver (084691) and COMEX Gold (088691), computes a normalized positioning metric (`net_long_pct_oi`), and ranks it against rolling 2-year and 5-year historical windows.

**Exchange Inventory Dashboard** — a live physical inventory view across COMEX, SHFE (Shanghai), and PSLV (Sprott), served by a FastAPI backend that proxies metalcharts.org and persists results to SQLite.

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

- **Combined CoT chart** — silver and gold net long % of OI on the same axis, 5-year view. Toggle each line independently. When only one metal is visible, 10th/90th percentile reference lines appear.
- **Gold/Silver Ratio** — plotted on an inverted right axis (lower GSR = silver outperforming = line goes up). Computed from COMEX futures spot prices (GC=F ÷ SI=F), not ETF prices.
- **Signal banners** — current percentile reading and classification for each metal, both windows.
- **Signal track record** — historical hit-rate analysis: when the crowd was crowded or capitulated in the past, what did price do at +4 weeks and +8 weeks? Presented as historical description only, not prediction. Sample sizes are shown; thin samples are flagged.
- **Macro watchlist** — manually maintained context panel (Fed stance, DXY, core PCE, COMEX inventory, Shanghai–COMEX spread, GSR, Silver Institute notes). Preserved across pipeline runs.

---

## Exchange Inventory Dashboard

A separate frontend tab backed by a FastAPI server that pulls live data from metalcharts.org on demand and caches it locally in SQLite (`argentvigil.db`).

### COMEX panels

- **Total COMEX Silver Inventory** — time-series line chart, range-selectable (1M / 3M / 1Y / 5Y / ALL)
- **Registered vs Eligible** — distinguishes warranted (deliverable) metal from eligible (stored, not warranted); sharp registered drops are a delivery pressure signal
- **Registered / Eligible Ratio** — ratio time series; spikes indicate metal being warranted for delivery
- **Paper Leverage Ratio** — `open interest × 5,000 oz ÷ registered inventory`; above 1.0 means more paper claims than registered metal available
- **Per-Vault Snapshot** — today's registered/eligible/total by depository with day-over-day deltas, plus an interactive pie chart filterable by metric
- **Delivery Notices (MTD)** — month-to-date COMEX delivery notices

### SHFE panels

- **SHFE Silver Inventory (Shanghai)** — time-series chart of Shanghai Futures Exchange warranted silver, converted from kg to troy oz (1 kg = 32.1507 oz)
- **SHFE Warehouse Snapshot** — current warranted silver by approved SHFE warehouse with delta column and pie chart

### Cross-exchange panels

- **COMEX vs SHFE Combined Inventory** — dual-axis chart overlaying COMEX (left axis) and SHFE (right axis, independent scale) with PSLV/Sprott as a reference line. Proportional bar comparison shows relative scale (COMEX is ~12× larger than SHFE in absolute terms).
- **PSLV (Sprott Physical Silver Trust)** — live custodial oz from the Royal Canadian Mint, Ottawa, fetched directly from Sprott's API
- **Live Spot Prices** — XAG and XAU with 24h change, shown in the dashboard header

### Global context panel

- **Estimated Above-Ground Silver Stock** — proportional bar breakdown by category (Jewelry & Silverware, Investment/coins & bars, Industrial/unrecoverable, ETF & Exchange Vaults, Central Bank/Govt Reserves) from Silver Institute WSS 2024 / USGS / CPM Group, with a live-computed bar for the AV-tracked exchange subset. All figures carry an explicit ±20% uncertainty qualifier.
- **Stack Calculator** — input personal troy oz holdings and see them expressed as a percentage of estimated above-ground stock, COMEX registered, and total tracked exchange inventory (COMEX + SHFE)

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

**Backend** (Exchange inventory server):

- FastAPI + uvicorn
- httpx for async proxying of metalcharts.org
- SQLite via `db.py` for persistence (`argentvigil.db`)
- Authenticated requests to metalcharts.org via `mc_token.py`

**Frontend**:

- React + Vite 5 + Recharts
- Two tabs: CoT positioning (reads `cot_data.json`) and Exchange Inventory (calls the FastAPI backend)
- Auto-refresh on the inventory dashboard (configurable via `VITE_AV_REFRESH_INTERVAL`, default 60s)

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

### Update macro watchlist

Edit `pipeline/cache/cot_data.json` → `macro_watchlist` directly. Those fields are preserved across pipeline runs and never overwritten.

---

## Data sources

| Data | Source | Cadence |
| --- | --- | --- |
| CFTC CoT (Silver, Gold) | CFTC Public Reporting Environment Socrata API | Weekly (Friday) |
| Silver / Gold prices (for track record) | Yahoo Finance — SLV / GLD ETF | Weekly |
| GSR spot prices | Yahoo Finance — GC=F / SI=F futures | Weekly |
| COMEX inventory (aggregate + depositories) | metalcharts.org proxy (CME Group vaults) | Daily |
| COMEX volume / open interest | metalcharts.org | Daily |
| COMEX delivery notices | metalcharts.org | MTD |
| SHFE inventory | metalcharts.org proxy (Shanghai Futures Exchange) | Weekly |
| PSLV holdings | Sprott direct API | Daily |
| Spot prices (XAG / XAU) | metalcharts.org | Intraday |

LME (London) requires a paid subscription and is not tracked.
