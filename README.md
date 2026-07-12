# ArgentVigil

Most silver dashboards show you a price and call it a day. ArgentVigil actually watches the market — positioning, physical inventory, delivery behavior, monetary context, event reactions, and international trade flow, all in one place, in real depth, with gold along for comparison. The governing idea is **selling dollars, not buying metals**: almost everything that looks like a silver signal is actually a dollar signal wearing a costume, and most of this dashboard exists to catch it in the act — separating "the futures crowd changed its mind" from "metal is actually moving" from "the currency itself is being debased," instead of blurring all three into one number and calling it insight.

ArgentVigil is not a trading system, and it doesn't need to be — it produces no price targets, no prediction framing, no risk-tolerance commentary. It's instrumentation built to be right about what already happened, not a system built to guess what happens next.

For full per-tab detail (panel-by-panel behavior, exact fields, known gaps), see `CLAUDE.md` — this doc stays a high-level tour.

---

## What it does

- **CoT Positioning** — CFTC Commitment of Traders for COMEX Silver/Gold, normalized (`net_long_pct_oi`) and ranked against rolling 2yr/5yr windows. Combined chart, Gold/Silver Ratio, disaggregated-category composition ("Who's Holding Long Positions"), paper leverage ratio + live spot per metal, signal banners, and historical hit-rate track record (description only, never prediction).
- **Money Supply** — M2/Fed balance sheet (FRED), and a Dollars vs. Silver vs. Gold purchasing-power comparison against a selectable baseline.
- **Inventory ("Stock & Flow")** — COMEX (New York) and SHFE (Shanghai) physical inventory, PSLV custodial holdings, annual Silver Institute supply/demand balance, and an above-ground-stock stack calculator. Nested **Delivery Behavior** cross-check layer flags reclassification-vs-real-delivery anomalies and computes First Notice Day/Last Trade Day from COMEX's contract rules.
- **CATCOR (Catalyst Correlation)** — event/reaction spine answering "did this catalyst actually move the metal," no interpretation layer. Macro-event calendar (FOMC/CPI/NFP), ALFRED/ForexFactory actual/consensus values, fixed-window (T-30m/T+5m/T+30m/T+2h) price reaction capture, two linked scatter charts.
- **Research** — a workbench for testing one claim at a time. Each turn is assembled from five human-set controls (model, persona, context blocks, memory mode, a live prompt preview) — nothing is auto-fetched by a model deciding it's relevant. A session ends in one of three dispositions: **promote** (adds an `observed` event to the CATCOR timeline, hotlinked back to the session), **dismiss** (logged as noise with a required reason), or **discard** (hard-deleted). A promoted event can be demoted later to undo it.
- **Data** — a hand-authored map of every table AV persists, paired with live fetch-health status (ok/stale/error) per upstream source and a per-source "re-run now" control.

---

## Delivery Behavior

A cross-check layer (not a new data source, beyond one: disaggregated CoT) sitting on top of what the other tabs already persist:

- **Reclassification vs. Real Inflow** (silver only) — flags days where registered inventory rose sharply but same-day delivery-notice volume covers less than 10% of the increase.
- **Short-Term Anomaly vs. Structural Deficit** — keeps a short-term inventory blip separate from the multi-year structural deficit narrative.
- First Notice Day / Last Trade Day computed on the fly from COMEX's contract-month rules (confirmed against CME rulebook Ch. 112/113), not a seed table.

**Permanently out of scope**: a seasonal open-interest-decay baseline and price lead/lag signal — both need real per-contract-month open interest, which is a paid CME Market Data Platform product, confirmed live during development.

---

## Explicit non-goals

- No price targets
- No "hidden demand" or defense/aerospace dealer estimates — not falsifiable, not tracked
- No risk-tolerance commentary
- No prediction framing — the track record section shows what happened historically, not what will happen

---

## Stack

- **Pipeline** (CoT + disaggregated CoT): Python 3 stdlib-only, no venv required. CFTC PRE Socrata API + Yahoo Finance, persists via `backend/db.py`.
- **Backend**: FastAPI + uvicorn (`backend.main:app`), httpx for async proxying (one shared `AsyncClient`), SQLite via `backend/db.py` (`runtime/argentvigil.db` — one shared database for the whole app). Authenticated metalcharts.org requests via `backend/mc_token.py`. A tiered background refresh (fast tier: spot prices; slow tier: everything else exchange-related) keeps SQLite warm — both run once unconditionally at startup, then repeat only if explicitly enabled.
- **Frontend**: React 19 + Vite 5 + Recharts, no state library, no router — single page, tab-like sections (`App.jsx`), all mounted once and toggled by visibility so switching tabs never refires fetches.

---

## Running it

**Day to day**, use `utils/vigil.sh` — a background daemon manager (PID-tracked, logs to `runtime/logs/`, survives closing the terminal):

```bash
bash utils/vigil.sh start            # backend + frontend, backgrounded
bash utils/vigil.sh status           # what's running, on which port
bash utils/vigil.sh stop             # stop both
bash utils/vigil.sh restart          # restart both
bash utils/vigil.sh start backend    # target one component (backend|frontend|all, default all)
```

**Active development**, use `bash utils/dev.sh` instead — runs both processes in the foreground with `--reload`, Ctrl-C to stop. Boots `.venv` and installs `requirements.txt`/`npm install` if missing, same as `vigil.sh`.

**CoT pipeline** (no server needed, run at least once before the frontend — the CoT tab reads from `/api/cot/db`, which reads the tables this populates):

```bash
python3 pipeline/run.py
```

On first backend start, exchange inventory, Money Supply/FRED series, and CATCOR's event calendar/reactions all backfill automatically if the local database is empty.

**Always run Python through `.venv`, never bare `python3`**, except for `pipeline/`, which is intentionally stdlib-only. Before running any other Python command against this repo, `source .venv/bin/activate` or invoke `.venv/bin/python` directly.

Required API keys (all optional at boot — the app degrades gracefully, that source's table just stays empty): `FRED_API_KEY` (Money Supply, CATCOR actuals), `GAPI_API_KEY` (LBMA fix), `CENSUS_API_KEY` (international trade), `ANTHROPIC_API_KEY` (Research tab, only if `AI_BACKEND=anthropic`). See `.env.example`.

---

## Data sources

| Data | Source | Cadence |
| --- | --- | --- |
| CFTC CoT Legacy + Disaggregated (Silver, Gold) | CFTC Public Reporting Environment Socrata API | Weekly (Friday) |
| Silver / Gold prices, GSR, purchasing-power closes | Yahoo Finance (SLV/GLD ETF, GC=F/SI=F futures) | Weekly / Monthly |
| COMEX inventory, volume/OI, delivery notices (silver + gold) | metalcharts.org proxy (CME Group vaults) | Daily (slow tier) |
| SHFE inventory / warehouses | metalcharts.org proxy (Shanghai Futures Exchange) | Daily (slow tier) |
| PSLV holdings | Sprott direct API | Daily (slow tier) |
| Spot prices (XAG / XAU) | metalcharts.org | Intraday (fast tier) |
| LBMA fix (gold AM, silver daily) | GoldAPI.io (free tier) | Startup + manual re-run |
| M2 Money Stock, Fed Balance Sheet, CPI | FRED (M2SL, WALCL, CPIAUCSL) | Monthly / Weekly |
| Macro event actuals (CPI, NFP) | ALFRED (FRED's point-in-time vintage API) | Per release |
| Macro event consensus | ForexFactory free calendar feed | Cached weekly (current Sun–Sat week only) |
| Event-window price reactions (XAG / XAU) | Yahoo Finance intraday (5-min bars) / daily close fallback | Per event |
| International trade flow, HS 7106 (silver) / 7108 (gold) | U.S. Census Bureau International Trade API | Monthly, ~25-day gated |
| Research tab chat backend | Anthropic Messages API / amp-forge LAN service | On-demand |
| COMEX rulebook (Ch. 112/113 — Last Trade Day rule) | CME Group, static reference PDFs | One-time reference |

LME (London) requires a paid subscription and is not tracked. CME's per-contract-month open interest (Market Data Platform) is also paid and not integrated.
