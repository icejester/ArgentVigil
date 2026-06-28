# ArgentVigil

A silver and gold speculative positioning monitor built for a long-horizon physical accumulator. The framing is **selling dollars, not buying metals** — the core question is whether the speculative futures crowd has genuinely capitulated or is just experiencing a routine pullback.

ArgentVigil is not a trading system and produces no price targets. It is a positioning dashboard.

---

## What it does

The pipeline fetches CFTC Commitment of Traders (CoT) data for COMEX Silver (084691) and COMEX Gold (088691) from the CFTC Public Reporting Environment, computes a normalized positioning metric (`net_long_pct_oi`), and ranks it against rolling 2-year and 5-year historical windows. The frontend visualizes the result alongside the Gold/Silver Ratio.

**`net_long_pct_oi`** = (non-commercial longs − non-commercial shorts) ÷ total open interest × 100

Normalizing by open interest removes the noise of market size growth over time, making readings from 2011 and 2024 directly comparable.

**Signal zones** (configurable in `pipeline/config.py`):

- ≥ 90th percentile → specs crowded long — caution
- ≤ 10th percentile → specs capitulated — back-up-the-truck zone
- Between → normal range, no signal

Both a 2-year and 5-year lookback window are computed side-by-side. When they disagree, the UI flags it explicitly.

---

## What it shows

- **Combined CoT chart** — silver and gold net long % of OI on the same axis, 5-year view. Toggle each line independently. When only one metal is visible, 10th/90th percentile reference lines appear.
- **Gold/Silver Ratio** — plotted on an inverted right axis (lower GSR = silver outperforming = line goes up). Computed from COMEX futures spot prices (GC=F ÷ SI=F), not ETF prices.
- **Signal banners** — current percentile reading and classification for each metal, both windows.
- **Signal track record** — historical hit-rate analysis: when the crowd was crowded or capitulated in the past, what did price do at +4 weeks and +8 weeks? Presented as historical description only, not prediction. Sample sizes are shown; thin samples are flagged.
- **Macro watchlist** — manually maintained context panel (Fed stance, DXY, core PCE, COMEX inventory, Shanghai–COMEX spread, GSR, Silver Institute notes). Preserved across pipeline runs.

---

## Explicit non-goals

- No price targets
- No "hidden demand" or defense/aerospace dealer estimates — not falsifiable, not tracked
- No risk-tolerance commentary
- No prediction framing — the track record section shows what happened historically, not what will happen

---

## Stack

- **Pipeline** — Python 3, standard library only (no third-party dependencies). Fetches from CFTC PRE Socrata API and Yahoo Finance.
- **Frontend** — React + Vite 5 + Recharts. Served as a static site; reads a single JSON file produced by the pipeline.

---

## Running it

**Pipeline** (from repo root):

```bash
python3 pipeline/run.py
```

Output: `pipeline/cache/cot_data.json`

CoT data is as of Tuesday each week, published by the CFTC on Friday (~3-day lag). The staleness label in the UI makes this explicit.

**Frontend dev server:**

```bash
cd frontend
npm install
npm run dev
```

The dev server reads `cot_data.json` directly from `pipeline/cache/` via Vite's `publicDir` config. Run the pipeline at least once before starting the frontend.

**Update macro watchlist:**

Edit `pipeline/cache/cot_data.json` → `macro_watchlist` directly. Those fields are preserved across pipeline runs and never overwritten.
