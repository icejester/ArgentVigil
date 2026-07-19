import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Awaitable, Callable

import httpx
from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

load_dotenv()

from . import catcor
from . import catcor_research
from . import db
from . import delivery_behavior
from .mc_token import authed_headers
from pipeline import run as pipeline_run
from pipeline.compute import compute_from_series, compute_signal_track_record
from pipeline.config import (
    FRED_FETCH_YEARS,
    FRED_M2_YOY_LOOKBACK,
    FRED_SERIES_CPI,
    FRED_SERIES_M2,
    FRED_SERIES_RRPONTSYD,
    FRED_SERIES_WALCL,
    FRED_SERIES_WLCFLPCL,
    FRED_SERIES_WRESBAL,
    FRED_SERIES_WSHOMCB,
    FRED_SERIES_WSHOTSL,
    FRED_WALCL_YOY_LOOKBACK,
    METAL_PRICE_FETCH_YEARS,
    XAG_SERIES_ID,
    XAG_TICKER,
    XAU_SERIES_ID,
    XAU_TICKER,
)

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

METALCHARTS = "https://metalcharts.org"
MARKET_BALANCE_PATH = os.path.join(_REPO_ROOT, "seed_data", "silver_market_balance.json")
FRED_BASE = "https://api.stlouisfed.org/fred/series/observations"
YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"
CENSUS_TRADE_BASE = "https://api.census.gov/data/timeseries/intltrade"
# HS 7106 (silver, unwrought/semi-manufactured/powder) / HS 7108 (gold,
# non-monetary — comparison-only per CLAUDE.md's "gold as context" rule).
CENSUS_TRADE_HS_CODES = {"XAG": "7106", "XAU": "7108"}
# Confirmed live (2025-01, 2024-06, both flows, both metals): imports and
# exports use different field names for quantity — GEN_QY1_MO/CON_QY1_MO
# (imports) vs. QTY_1_MO (exports) — sharing UNIT_QY1 for the unit code.
# Both are always "0"/"-" today (Census reports no qty for these HS codes).
CENSUS_TRADE_FLOWS = {
    "import": {
        "path": "imports/hs",
        "commodity_param": "I_COMMODITY",
        "value_general_field": "GEN_VAL_MO",
        "value_consumption_field": "CON_VAL_MO",
        "qty_field": "GEN_QY1_MO",
    },
    "export": {
        "path": "exports/hs",
        "commodity_param": "E_COMMODITY",
        "value_general_field": "ALL_VAL_MO",
        "value_consumption_field": None,
        "qty_field": "QTY_1_MO",
    },
}
CENSUS_TRADE_MONTHS_PER_FETCH = 3  # cheap self-heal against late revisions between gate-interval runs
METAL_PRICE_TICKERS = {XAG_SERIES_ID: XAG_TICKER, XAU_SERIES_ID: XAU_TICKER}

# Recoverable stock = Investment (coins/bars) + ETF/Exchange Vaults + Central
# Bank reserves only. Excludes industrial (unrecoverable) and jewelry/silverware
# (partially recoverable, illiquid) per SPEC.MD's Open Questions resolution.
RECOVERABLE_STOCK_LOW_OZ = 12_500_000_000
RECOVERABLE_STOCK_HIGH_OZ = 17_000_000_000

_client: httpx.AsyncClient | None = None

# Tiered background refresh: fast tier = genuinely intraday data (spot prices);
# slow tier = everything else main.py manages (moves at most daily upstream).
# Fast tier defaults ON at 60s (spot prices are cheap and genuinely move
# intraday); slow tier defaults OFF — startup does one fetch to populate the
# DB either way, then slow tier's recurring loop stays idle until the user
# opts in (or hits Force update). Interval/enabled state is in-memory only —
# a restart re-triggers the one-time startup refresh anyway.
_refresh_settings = {
    "fast_interval_s": 60,
    "slow_interval_s": 1200,
    "fast_enabled": True,
    "slow_enabled": False,
}
_refresh_tasks: list[asyncio.Task] = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _client
    db.init_db()
    _client = httpx.AsyncClient()
    asyncio.create_task(_backfill_if_needed())
    asyncio.create_task(_refresh_fast_tier())
    asyncio.create_task(_refresh_slow_tier())
    asyncio.create_task(_lbma_fix_startup())
    asyncio.create_task(_census_trade_startup())
    asyncio.create_task(_catcor_startup())
    _refresh_tasks.append(asyncio.create_task(_fast_tier_loop()))
    _refresh_tasks.append(asyncio.create_task(_slow_tier_loop()))
    _refresh_tasks.append(asyncio.create_task(_event_tier_loop()))
    _refresh_tasks.append(asyncio.create_task(_consensus_tier_loop()))
    yield
    for t in _refresh_tasks:
        t.cancel()
    await _client.aclose()


async def _lbma_fix_startup():
    """LBMA fix updates 1-2x/day (per metal) — too slow for either tiered
    loop, so per the price-spec decision this is startup-only plus manual
    force-refresh via the Data tab's per-source button (lbma_fix is in
    _ON_DEMAND_REGISTRY, not either tier), not a third recurring loop.
    Silently skips if GAPI_API_KEY isn't set, same as CATCOR's ALFRED calls
    silently degrade without FRED_API_KEY — this is a nice-to-have layer,
    not a hard requirement to boot the app."""
    if "GAPI_API_KEY" not in os.environ:
        print("[lbma] GAPI_API_KEY not set — skipping LBMA fix fetch")
        return
    try:
        await _fetch_and_persist_lbma_fix()
        db.record_fetch_attempt("lbma_fix", success=True)
    except Exception as e:
        print(f"[lbma] warning: {e}")
        db.record_fetch_attempt("lbma_fix", success=False, error=str(e))


async def _catcor_startup():
    """One-shot on every startup: reseed the event calendar, pull Yahoo
    intraday ticks, and backfill any missing reactions. Cheap on repeat
    runs — backfill_reactions/capture_snapshot are idempotent (skip
    windows that already have a reaction row), so this is safe whether
    the app was offline 14 minutes or 14 days."""
    try:
        n = catcor.seed_events()
        print(f"[catcor] seeded {n} events")
    except Exception as e:
        print(f"[catcor] warning: seed_events failed: {e}")
        return

    try:
        await catcor.backfill_intraday_ticks(_client)
    except Exception as e:
        print(f"[catcor] warning: backfill_intraday_ticks failed: {e}")

    try:
        await catcor.backfill_daily_closes(_client)
    except Exception as e:
        print(f"[catcor] warning: backfill_daily_closes failed: {e}")

    try:
        # Fetch consensus first: fetch_and_persist_actuals computes
        # surprise_delta immediately if consensus is already on the row.
        await catcor.fetch_and_persist_consensus(_client)
    except Exception as e:
        print(f"[catcor] warning: fetch_and_persist_consensus failed: {e}")

    try:
        await catcor.fetch_and_persist_actuals(_client)
    except Exception as e:
        print(f"[catcor] warning: fetch_and_persist_actuals failed: {e}")

    try:
        catcor.backfill_reactions()
    except Exception as e:
        print(f"[catcor] warning: backfill_reactions failed: {e}")


CATCOR_CONSENSUS_INTERVAL_S = 1800  # how often to re-check for newly-in-window events; catcor.py caches the actual ForexFactory fetch per calendar week, so most of these ticks do zero network I/O


async def _event_tier_loop():
    """Snapshot capture needs a tight interval (real T+5m precision
    requires it) — always on, not gated by an enabled flag, since a missed
    snapshot window is a real, permanent data loss (no tick existed at
    that instant), unlike fast/slow tier data which is always
    re-fetchable on the next cycle."""
    while True:
        await asyncio.sleep(60)
        try:
            for event_id, window in catcor.due_snapshots():
                catcor.capture_snapshot(event_id, window)
            db.record_fetch_attempt("catcor_snapshot", success=True)
        except Exception as e:
            print(f"[catcor] warning: event tier loop: {e}")
            db.record_fetch_attempt("catcor_snapshot", success=False, error=str(e))


async def _consensus_tier_loop():
    """Separate, much slower loop for ForexFactory consensus + ALFRED
    actuals. catcor.fetch_and_persist_consensus caches the raw ForexFactory
    response per calendar week (confirmed live that repeat hits trip its
    rate limit — 429 — so the actual network fetch happens at most once a
    week; every other call here is a cache read matching already-fetched
    entries against event_calendar). ALFRED actuals are cheap/infrequent by
    nature (one real print per event per month) and share this loop rather
    than getting their own, since there's no benefit to checking more often
    than consensus does anyway."""
    while True:
        try:
            await catcor.fetch_and_persist_consensus(_client)
            await catcor.fetch_and_persist_actuals(_client)
            db.record_fetch_attempt("catcor_consensus_actuals", success=True)
        except Exception as e:
            print(f"[catcor] warning: consensus tier loop: {e}")
            db.record_fetch_attempt("catcor_consensus_actuals", success=False, error=str(e))
        await asyncio.sleep(CATCOR_CONSENSUS_INTERVAL_S)


async def _fast_tier_loop():
    while True:
        await asyncio.sleep(_refresh_settings["fast_interval_s"])
        if _refresh_settings["fast_enabled"]:
            await _refresh_fast_tier()


async def _slow_tier_loop():
    while True:
        await asyncio.sleep(_refresh_settings["slow_interval_s"])
        if _refresh_settings["slow_enabled"]:
            await _refresh_slow_tier()


# _fetch_and_persist_delivery defaults to type="mtd", but confirmed live
# against metalcharts.org that type="ytd" returns a superset (~85 days back
# to the start of the year vs. mtd's handful of days-in-month) at no extra
# cost — using ytd here means delivery_notices actually accumulates useful
# history instead of resetting to a few days every month, which is what the
# Delivery Behavior reclassification signal (backend/delivery_behavior.py)
# needs to have any real coverage. Module-level (not a closure inside
# _refresh_slow_tier) so _SOURCE_REGISTRY can reference it directly.
async def _fetch_and_persist_delivery_ytd():
    return await _fetch_and_persist_delivery(type="ytd")


async def _refresh_fast_tier() -> dict:
    succeeded, failed, errors = 0, 0, []
    for source_key, fn in _FAST_TIER_REGISTRY.items():
        try:
            await fn()
            db.record_fetch_attempt(source_key, success=True)
            succeeded += 1
        except Exception as e:
            print(f"[refresh:fast] warning ({source_key}): {e}")
            db.record_fetch_attempt(source_key, success=False, error=str(e))
            failed += 1
            errors.append(f"{source_key}: {e}")
    return {"succeeded": succeeded, "failed": failed, "errors": errors}


async def _refresh_slow_tier() -> dict:
    succeeded, failed, errors = 0, 0, []
    for source_key, fn in _SLOW_TIER_REGISTRY.items():
        try:
            await fn()
            db.record_fetch_attempt(source_key, success=True)
            succeeded += 1
        except Exception as e:
            print(f"[refresh:slow] warning ({source_key}): {e}")
            db.record_fetch_attempt(source_key, success=False, error=str(e))
            failed += 1
            errors.append(f"{source_key}: {e}")
    return {"succeeded": succeeded, "failed": failed, "errors": errors}


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


def _parse_aggregate_row(row: dict) -> dict:
    reg = row.get("registered") or None
    elig = row.get("eligible") or None
    # Zero means "not reported that day" — store as NULL so charts gap cleanly
    if reg == 0:
        reg = None
    if elig == 0:
        elig = None
    return {
        "date": row["date"],
        "total": row.get("total") or None,
        "registered": reg,
        "eligible": elig,
        "reg_eligible_ratio": (reg / elig) if (reg and elig) else None,
    }


async def _backfill_if_needed():
    if db.count_aggregate() == 0:
        try:
            hdrs = await authed_headers(_client)
            resp = await _client.get(
                f"{METALCHARTS}/api/comex/inventory",
                params={"symbol": "XAG", "range": "ALL"},
                headers=hdrs,
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            rows = [_parse_aggregate_row(r) for r in data.get("data", [])]
            db.upsert_aggregate_rows(rows)
        except Exception as e:
            print(f"[backfill] warning: {e}")
    if db.count_gold_aggregate() == 0:
        try:
            hdrs = await authed_headers(_client)
            resp = await _client.get(
                f"{METALCHARTS}/api/comex/inventory",
                params={"symbol": "XAU", "range": "ALL"},
                headers=hdrs,
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            rows = [_parse_aggregate_row(r) for r in data.get("data", [])]
            db.upsert_gold_aggregate_rows(rows)
        except Exception as e:
            print(f"[backfill] warning (gold): {e}")


async def _fetch_and_persist_silver_history(range: str = "ALL") -> list[dict]:
    hdrs = await authed_headers(_client)
    resp = await _client.get(
        f"{METALCHARTS}/api/comex/inventory",
        params={"symbol": "XAG", "range": range},
        headers=hdrs,
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    rows = [_parse_aggregate_row(r) for r in data.get("data", [])]
    db.upsert_aggregate_rows(rows)
    return rows


@app.get("/api/silver/history")
async def silver_history(range: str = Query("ALL")):
    try:
        rows = await _fetch_and_persist_silver_history(range)
        return {"success": True, "data": rows}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/silver/db/history")
async def silver_db_history():
    rows = db.get_aggregate_history()
    return {"success": True, "data": rows}


def _depository_rows(raw: list[dict]) -> list[dict]:
    today = str(date.today())
    return [
        {
            "date": today,
            "depository": r["depository"],
            "registered": r.get("registered"),
            "eligible": r.get("eligible"),
            "total": r.get("total"),
            "prev_registered": r.get("prevRegistered"),
            "prev_eligible": r.get("prevEligible"),
            "prev_total": r.get("prevTotal"),
        }
        for r in raw
    ]


async def _fetch_and_persist_silver_depositories() -> list[dict]:
    hdrs = await authed_headers(_client)
    resp = await _client.get(
        f"{METALCHARTS}/api/comex/inventory",
        params={"symbol": "XAG", "type": "depositories"},
        headers=hdrs,
        timeout=15,
    )
    resp.raise_for_status()
    raw = resp.json().get("data", [])
    db.upsert_depository_rows(_depository_rows(raw))
    return raw


@app.get("/api/silver/depositories")
async def silver_depositories():
    try:
        raw = await _fetch_and_persist_silver_depositories()
        return {"success": True, "data": raw}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/silver/db/depositories")
async def silver_db_depositories(date: str | None = Query(None)):
    rows = db.get_depositories_on_date(date) if date else db.get_latest_depositories()
    return {"success": True, "data": rows}


async def _fetch_and_persist_silver_leverage() -> dict:
    hdrs = await authed_headers(_client)
    resp = await _client.get(
        f"{METALCHARTS}/api/comex/volume-oi",
        params={"symbol": "XAG"},
        headers=hdrs,
        timeout=15,
    )
    resp.raise_for_status()
    raw = resp.json()
    row = raw.get("data") or {}
    if not isinstance(row, dict):
        row = {}
    reg_row = db.get_aggregate_history(limit=1)
    latest_reg = reg_row[0]["registered"] if reg_row else None
    oi = row.get("openInterest") or row.get("open_interest")
    vol = row.get("volume")
    # OI is in contracts (5,000 oz each); registered is in oz. Still
    # computed here for the live /api/silver/leverage debug route's own
    # response shape, but — since a 2026-07 investigation confirmed this
    # metalcharts.org OI figure runs a stable ~15% below CFTC's real
    # open_interest_all for the same contract/date, not a substitutable
    # equivalent — it's no longer persisted. Leverage math everywhere
    # else (the /db routes, the history chart) is CFTC-only now; see
    # db._leverage_backfill_from_cot's docstring for the full reasoning.
    oi_oz = oi * 5000 if oi else None
    paper_leverage = (oi_oz / latest_reg) if (oi_oz and latest_reg) else None
    enriched = {**row, "paper_leverage": paper_leverage}
    if vol:
        db.upsert_volume_oi_row({
            "date": row.get("date", str(date.today())),
            "open_interest": None,
            "volume": vol,
            "paper_leverage": None,
        })
    return {"enriched": enriched, "raw": raw}


@app.get("/api/silver/leverage")
async def silver_leverage():
    try:
        result = await _fetch_and_persist_silver_leverage()
        return {"success": True, "data": [result["enriched"]], "raw": result["raw"]}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/silver/db/leverage")
async def silver_db_leverage():
    row = db.get_latest_leverage("XAG")
    if row is None:
        return {"success": True, "data": []}
    enriched = {
        "date": row["date"],
        "openInterest": row["open_interest"] / 5000 if row["open_interest"] else None,
        "volume": row["volume"],
        "paper_leverage": row["paper_leverage"],
    }
    return {"success": True, "data": [enriched]}


@app.get("/api/silver/db/leverage/history")
async def silver_db_leverage_history():
    rows = db.get_leverage_history("XAG")
    return {
        "success": True,
        "data": [
            {
                "date": r["date"],
                "openInterest": r["open_interest"] / 5000 if r["open_interest"] else None,
                "volume": r["volume"],
                "paper_leverage": r["paper_leverage"],
            }
            for r in rows
        ],
    }


@app.get("/api/volume/db/history")
async def volume_db_history(metal: str = Query("XAG")):
    rows = db.get_volume_series(metal)
    return {"success": True, "data": rows}


async def _fetch_and_persist_gold_history(range: str = "ALL") -> list[dict]:
    hdrs = await authed_headers(_client)
    resp = await _client.get(
        f"{METALCHARTS}/api/comex/inventory",
        params={"symbol": "XAU", "range": range},
        headers=hdrs,
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    rows = [_parse_aggregate_row(r) for r in data.get("data", [])]
    db.upsert_gold_aggregate_rows(rows)
    return rows


@app.get("/api/gold/history")
async def gold_history(range: str = Query("ALL")):
    try:
        rows = await _fetch_and_persist_gold_history(range)
        return {"success": True, "data": rows}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/gold/db/history")
async def gold_db_history():
    rows = db.get_gold_aggregate_history()
    return {"success": True, "data": rows}


async def _fetch_and_persist_gold_depositories() -> list[dict]:
    hdrs = await authed_headers(_client)
    resp = await _client.get(
        f"{METALCHARTS}/api/comex/inventory",
        params={"symbol": "XAU", "type": "depositories"},
        headers=hdrs,
        timeout=15,
    )
    resp.raise_for_status()
    raw = resp.json().get("data", [])
    db.upsert_gold_depository_rows(_depository_rows(raw))
    return raw


@app.get("/api/gold/depositories")
async def gold_depositories():
    try:
        raw = await _fetch_and_persist_gold_depositories()
        return {"success": True, "data": raw}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/gold/db/depositories")
async def gold_db_depositories():
    rows = db.get_latest_gold_depositories()
    return {"success": True, "data": rows}


async def _fetch_and_persist_gold_leverage() -> dict:
    hdrs = await authed_headers(_client)
    resp = await _client.get(
        f"{METALCHARTS}/api/comex/volume-oi",
        params={"symbol": "XAU"},
        headers=hdrs,
        timeout=15,
    )
    resp.raise_for_status()
    raw = resp.json()
    row = raw.get("data") or {}
    if not isinstance(row, dict):
        row = {}
    reg_row = db.get_gold_aggregate_history(limit=1)
    latest_reg = reg_row[0]["registered"] if reg_row else None
    oi = row.get("openInterest") or row.get("open_interest")
    vol = row.get("volume")
    # OI is in contracts (100 oz each for gold); registered is in oz.
    # Still computed here for the live /api/gold/leverage debug route's
    # own response shape, but no longer persisted — see
    # _fetch_and_persist_silver_leverage's comment for the full reasoning
    # (CFTC-only leverage math now, metalcharts.org's OI confirmed ~15%
    # off from CFTC's real open_interest_all on every date checked).
    oi_oz = oi * 100 if oi else None
    paper_leverage = (oi_oz / latest_reg) if (oi_oz and latest_reg) else None
    enriched = {**row, "paper_leverage": paper_leverage}
    if vol:
        db.upsert_gold_volume_oi_row({
            "date": row.get("date", str(date.today())),
            "open_interest": None,
            "volume": vol,
            "paper_leverage": None,
        })
    return {"enriched": enriched, "raw": raw}


@app.get("/api/gold/leverage")
async def gold_leverage():
    try:
        result = await _fetch_and_persist_gold_leverage()
        return {"success": True, "data": [result["enriched"]], "raw": result["raw"]}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/gold/db/leverage")
async def gold_db_leverage():
    row = db.get_latest_leverage("XAU")
    if row is None:
        return {"success": True, "data": []}
    enriched = {
        "date": row["date"],
        "openInterest": row["open_interest"] / 100 if row["open_interest"] else None,
        "volume": row["volume"],
        "paper_leverage": row["paper_leverage"],
    }
    return {"success": True, "data": [enriched]}


@app.get("/api/gold/db/leverage/history")
async def gold_db_leverage_history():
    rows = db.get_leverage_history("XAU")
    return {
        "success": True,
        "data": [
            {
                "date": r["date"],
                "openInterest": r["open_interest"] / 100 if r["open_interest"] else None,
                "volume": r["volume"],
                "paper_leverage": r["paper_leverage"],
            }
            for r in rows
        ],
    }


async def _fetch_and_persist_delivery(type: str = "mtd") -> dict:
    hdrs = await authed_headers(_client)
    resp = await _client.get(
        f"{METALCHARTS}/api/comex/delivery-notices",
        params={"symbol": "XAG", "type": type},
        headers=hdrs,
        timeout=15,
    )
    resp.raise_for_status()
    raw = resp.json()
    data = raw.get("data") or []
    if isinstance(data, dict):
        data = [data]
    rows = [
        {
            "date": r.get("date", str(date.today())),
            "type": type,
            "daily_issued": r.get("dailyIssued"),
            "daily_stopped": r.get("dailyStopped"),
        }
        for r in data
        if isinstance(r, dict) and (r.get("dailyIssued") is not None or r.get("dailyStopped") is not None)
    ]
    if rows:
        db.upsert_delivery_rows(rows)
    return raw


@app.get("/api/silver/delivery")
async def silver_delivery(type: str = Query("mtd")):
    try:
        return await _fetch_and_persist_delivery(type)
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/silver/db/delivery")
async def silver_db_delivery(type: str = Query("mtd")):
    rows = db.get_delivery_history(type)
    return {"success": True, "data": rows}


async def _fetch_and_persist_shfe_history(range: str = "ALL") -> list[dict]:
    hdrs = await authed_headers(_client)
    resp = await _client.get(
        f"{METALCHARTS}/api/shfe/inventory",
        params={"symbol": "AG", "range": range},
        headers=hdrs,
        timeout=20,
    )
    resp.raise_for_status()
    raw = resp.json()
    rows = []
    for row in raw.get("data", []):
        kg = row.get("total")
        rows.append({
            "date": row["date"],
            "total_kg": kg,
            # SHFE silver is in kg; convert to troy oz (1 kg = 32.1507 troy oz)
            "total_oz": round(kg * 32.1507, 0) if kg else None,
        })
    db.upsert_shfe_rows(rows)
    return rows


@app.get("/api/shfe/history")
async def shfe_history(range: str = Query("ALL")):
    try:
        rows = await _fetch_and_persist_shfe_history(range)
        return {"success": True, "data": rows}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/shfe/db/history")
async def shfe_db_history():
    rows = db.get_shfe_history()
    return {"success": True, "data": rows}


async def _fetch_and_persist_shfe_warehouses() -> list[dict]:
    hdrs = await authed_headers(_client)
    resp = await _client.get(
        f"{METALCHARTS}/api/shfe/inventory",
        params={"symbol": "AG", "type": "warehouses"},
        headers=hdrs,
        timeout=15,
    )
    resp.raise_for_status()
    raw = resp.json()
    rows = raw.get("data", [])
    today = str(date.today())
    persisted = []
    enriched = []
    for r in rows:
        kg = r.get("warrant", 0)
        chg_kg = r.get("warrantChange", 0)
        enriched.append({
            **r,
            "warrant_oz": round(kg * 32.1507, 0) if kg else None,
            "warrant_change_oz": round(chg_kg * 32.1507, 0) if chg_kg else None,
        })
        persisted.append({
            "date": r.get("date", today),
            "warehouse": r["warehouse"],
            "warrant_kg": kg,
            "warrant_change_kg": chg_kg,
        })
    db.upsert_shfe_warehouse_rows(persisted)
    return enriched


@app.get("/api/shfe/warehouses")
async def shfe_warehouses():
    try:
        enriched = await _fetch_and_persist_shfe_warehouses()
        return {"success": True, "data": enriched}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/shfe/db/warehouses")
async def shfe_db_warehouses():
    rows = db.get_latest_shfe_warehouses()
    enriched = [
        {
            **r,
            "warrant_oz": round(r["warrant_kg"] * 32.1507, 0) if r["warrant_kg"] else None,
            "warrant_change_oz": round(r["warrant_change_kg"] * 32.1507, 0) if r["warrant_change_kg"] else None,
        }
        for r in rows
    ]
    return {"success": True, "data": enriched}


async def _fetch_and_persist_pslv() -> dict:
    resp = await _client.get(
        "https://sprott.com/api/FinancialData/v1/BullionCalculatorData",
        headers={"Accept": "application/json"},
        timeout=10,
    )
    resp.raise_for_status()
    entries = [e for e in resp.json() if isinstance(e, dict) and e.get("id") == 4998]
    if not entries:
        raise HTTPException(502, "PSLV entry not found in Sprott response")
    row = entries[0]
    result = {
        "fund": "PSLV",
        "custodian": "Royal Canadian Mint",
        "location": "Ottawa, Canada",
        "date": row.get("dateTimeStamp", "")[:10],
        "total_oz": row["totalOunces1"],
        "nav_per_unit": row["nav"],
        "total_nav": row["totalNav"],
        "units": row["units"],
    }
    db.upsert_pslv_row(result)
    return result


@app.get("/api/pslv")
async def pslv():
    try:
        result = await _fetch_and_persist_pslv()
        return {"success": True, **result}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/pslv/db")
async def pslv_db():
    row = db.get_latest_pslv()
    if row is None:
        return {"success": True}
    return {
        "success": True,
        "fund": "PSLV",
        "custodian": "Royal Canadian Mint",
        "location": "Ottawa, Canada",
        **row,
    }


def _runway_years(deficit_moz: float | None) -> dict | None:
    if not deficit_moz or deficit_moz <= 0:
        return None
    deficit_oz = deficit_moz * 1_000_000
    return {
        "low_years": round(RECOVERABLE_STOCK_LOW_OZ / deficit_oz, 1),
        "high_years": round(RECOVERABLE_STOCK_HIGH_OZ / deficit_oz, 1),
    }


@app.get("/api/silver/market-balance")
async def silver_market_balance():
    try:
        with open(MARKET_BALANCE_PATH) as f:
            rows = json.load(f)
    except FileNotFoundError:
        raise HTTPException(500, "silver_market_balance.json not found")

    rows = sorted(rows, key=lambda r: r["year"])

    for i, r in enumerate(rows):
        window = rows[max(0, i - 4): i + 1]
        vals = [w["net_balance_moz"] for w in window if w.get("net_balance_moz") is not None]
        r["cumulative_5y_moz"] = round(sum(vals), 1) if vals else None

    latest = rows[-1] if rows else None
    latest_deficit = (
        abs(latest["net_balance_moz"])
        if latest and latest.get("net_balance_moz") is not None and latest["net_balance_moz"] < 0
        else None
    )
    recent5 = [r["net_balance_moz"] for r in rows[-5:] if r.get("net_balance_moz") is not None]
    avg5 = (sum(recent5) / len(recent5)) if recent5 else None
    avg5_deficit = abs(avg5) if avg5 is not None and avg5 < 0 else None

    months_stale = None
    if latest:
        published = date(latest["year"] + 1, 4, 1)
        today = date.today()
        months_stale = (today.year - published.year) * 12 + (today.month - published.month)

    return {
        "success": True,
        "data": rows,
        "meta": {
            "latest_year": latest["year"] if latest else None,
            "recoverable_stock_range_oz": [RECOVERABLE_STOCK_LOW_OZ, RECOVERABLE_STOCK_HIGH_OZ],
            "runway_latest_year": _runway_years(latest_deficit),
            "runway_5y_avg_deficit": _runway_years(avg5_deficit),
            "months_since_expected_publication": months_stale,
            "stale": months_stale is not None and months_stale > 18,
        },
    }


@app.get("/api/delivery-behavior/db")
async def delivery_behavior_db(metal: str = Query("XAG")):
    metal = metal.upper()
    reclassification = delivery_behavior.compute_reclassification_signal(metal, limit=180)
    category_composition = delivery_behavior.compute_category_composition(metal, limit=104)

    try:
        with open(MARKET_BALANCE_PATH) as f:
            balance_rows = json.load(f)
    except FileNotFoundError:
        raise HTTPException(500, "silver_market_balance.json not found")
    deficit_context = delivery_behavior.compute_deficit_context(balance_rows)

    return {
        "success": True,
        "data": {
            "reclassification": reclassification,
            "category_composition": category_composition,
            "deficit_context": deficit_context,
        },
    }


def _spot_entry_fields(entry) -> tuple[float | None, float | None]:
    if isinstance(entry, dict):
        return entry.get("price"), entry.get("changePercent24h")
    return entry, None


async def _fetch_and_persist_prices() -> dict:
    hdrs = await authed_headers(_client)
    resp = await _client.get(
        f"{METALCHARTS}/api/prices",
        headers=hdrs,
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    # metalcharts.org's own top-level isStale flag (sibling of "data", not
    # per-metal) marks its underlying twelvedata-ws feed as a stale cache
    # re-serve — confirmed live over a weekend market closure that it kept
    # returning isStale=true with a live-looking "timestamp" field and a
    # cacheAge in the hours, while slowly drifting the price by rounding/
    # re-sampling jitter on their end. Skipping persistence when stale
    # (rather than writing it anyway) means the tick series/chart goes flat
    # when the real market is closed instead of showing fake movement that
    # never actually traded — but that's only the right call for a real
    # weekend closure. Confirmed live that isStale can also fire on a
    # weekday with a cacheAge of months (metalcharts.org's own upstream feed
    # stuck, not a market closure) — skipping indefinitely in that case would
    # silently flatline the chart forever with no visible signal anything's
    # wrong. So: skip only when it's currently a real weekend; on a weekday,
    # persist anyway and let a stuck upstream surface directly in the chart.
    if isinstance(data, dict) and data.get("isStale") and date.today().weekday() >= 5:
        return data
    payload = data.get("data", data) if isinstance(data, dict) else {}
    today = str(date.today())
    rows = []
    for series_id in ("XAG", "XAU"):
        entry = payload.get(series_id) if isinstance(payload, dict) else None
        price, pct = _spot_entry_fields(entry)
        if price is not None:
            rows.append({
                "series_id": series_id,
                "date": today,
                "price": price,
                "change_pct_24h": pct,
            })
    if rows:
        db.upsert_spot_price_rows(rows)
        now_iso = datetime.now(timezone.utc).isoformat()
        db.append_price_tick([
            {"series_id": r["series_id"], "ts": now_iso, "price": r["price"]}
            for r in rows
        ])
    return data


def _cot_gsr_series(gold_spot: dict, silver_spot: dict) -> list[dict]:
    common_dates = sorted(set(gold_spot) & set(silver_spot))
    series = []
    for d in common_dates:
        g = gold_spot[d]
        s = silver_spot[d]
        if s and s > 0:
            series.append({"date": d, "gsr": round(g / s, 1)})
    return series


@app.get("/api/cot/db")
async def cot_db_route():
    silver_series = db.get_silver_series()
    gold_series = db.get_gold_series()
    if not silver_series or not gold_series:
        raise HTTPException(500, "No CoT data persisted yet. Run pipeline/run.py first.")

    silver_result = compute_from_series(silver_series)
    gold_result = compute_from_series(gold_series)

    slv_prices = db.get_price_series("SLV")
    gld_prices = db.get_price_series("GLD")
    gc_prices = db.get_price_series("GC=F")
    si_prices = db.get_price_series("SI=F")

    silver_track = compute_signal_track_record(silver_result["series"], slv_prices)
    gold_track = compute_signal_track_record(gold_result["series"], gld_prices)
    gsr_series = _cot_gsr_series(gc_prices, si_prices)

    last_run_at = db.get_last_run_at()
    generated_at = None
    if last_run_at:
        # pipeline/run.py stamps this via datetime.now(timezone.utc).isoformat(),
        # which already carries a UTC offset — only naive/space-separated
        # timestamps (e.g. a legacy row, or SQLite's own datetime('now'))
        # need "+00:00" appended.
        iso_str = last_run_at.replace(" ", "T")
        has_offset = iso_str[-6] in "+-" or iso_str.endswith("Z")
        if not has_offset:
            iso_str += "+00:00"
        generated_at = datetime.fromisoformat(iso_str).isoformat()

    return {
        "success": True,
        "cot_as_of_date": silver_result["latest"]["date"],
        "generated_at": generated_at,
        "series": silver_result["series"],
        "latest": silver_result["latest"],
        "windows": silver_result["windows"],
        "signal_track_record": silver_track,
        "gold": {
            "series": gold_result["series"],
            "latest": gold_result["latest"],
            "windows": gold_result["windows"],
            "signal_track_record": gold_track,
        },
        "gsr_series": gsr_series,
    }


@app.get("/api/prices")
async def prices():
    try:
        return await _fetch_and_persist_prices()
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/prices/db")
async def prices_db():
    latest = db.get_latest_spot_prices()
    data = {
        series_id: {"price": row["price"], "changePercent24h": row["change_pct_24h"], "date": row["date"]}
        for series_id, row in latest.items()
    }
    return {"success": True, "data": data}


@app.get("/api/prices/db/ticks")
async def prices_db_ticks(series_id: str = Query("XAG"), hours: int = Query(24)):
    """Price history for the leverage panel's price chart, spanning
    windows from 6H to 12M. Stitches three resolutions (see
    db.get_price_history): real 60s spot_price_tick ticks where they exist
    (only from whenever the fast-tier refresh loop started running),
    CATCOR's daily closes further back (~120 days), and Money Supply's
    month-end closes beyond that (back to 2006) — so long windows show real,
    if coarser, history instead of a gap before the tick table existed."""
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    rows = db.get_price_history(series_id, since)
    return {"success": True, "data": rows}


GOLDAPI_BASE = "https://www.goldapi.io/api"
# GoldAPI.io's bare /api/{SYMBOL}/{CURRENCY} endpoint is a FOREXCOM spot
# feed (confirmed live) — NOT LBMA. Only the date-suffixed historical
# endpoint (/api/{SYMBOL}/{CURRENCY}/{YYYYMMDD}) returns exchange="LBMA".
# "Today's" fix is therefore fetched via that same date-suffixed path with
# today's date, not the bare endpoint. Confirmed live that gold and silver
# both come back stamped 10:30:00Z regardless of metal — that does NOT
# match silver's real fix time (LBMA Silver Price is set at 12:00 London,
# not 10:30), so the date field is treated as "which calendar day this fix
# is for," not a trustworthy per-metal fix-moment timestamp. GoldAPI.io
# also exposes only one price/day for gold — no distinct AM vs PM fix
# field — so gold's PM fix is not available from this source; gold is
# persisted as fix_type="AM" (best-effort) and silver as fix_type="daily".
_LBMA_METAL_SYMBOLS = {"XAU": "AM", "XAG": "daily"}


async def _fetch_goldapi_fix(symbol: str, api_key: str, for_date: date) -> dict:
    resp = await _client.get(
        f"{GOLDAPI_BASE}/{symbol}/USD/{for_date.strftime('%Y%m%d')}",
        headers={"x-access-token": api_key},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


async def _fetch_and_persist_lbma_fix() -> dict:
    if "GAPI_API_KEY" not in os.environ:
        raise HTTPException(500, "GAPI_API_KEY environment variable is not set")
    api_key = os.environ["GAPI_API_KEY"]
    today = date.today()
    results = {}
    for symbol, fix_type in _LBMA_METAL_SYMBOLS.items():
        # GoldAPI.io's historical endpoint confirmed live to have no data
        # for "today" until some lag later in the day (returns
        # {"error": "No data available..."} — no "price" key at all, not
        # just null) — fall back to the most recent real business day so
        # the badge/history always reflects the most recent real fix
        # instead of going empty for part of each day.
        #
        # A real bug caught live (2026-07): GoldAPI.io does NOT error for a
        # WEEKEND date the way it does for "today, not yet published" — it
        # silently returns Friday's real fix under a non-null "price" field,
        # re-timestamped as if it were Saturday's/Sunday's own fix (no LBMA
        # fix is ever actually set on a weekend). The original fallback only
        # retried once, on "price is None," which weekends never trigger —
        # so a fetch that happened to run on a Saturday/Sunday would have
        # silently persisted Friday's real number mislabeled with a
        # weekend's date. No contaminated rows were found in lbma_fix by
        # the time this was caught (pure luck of when the backend happened
        # to restart), but the bug was real and latent. Fixed by walking
        # `for_date` back to the nearest real weekday BEFORE ever calling
        # GoldAPI, not by trying to detect the silent-carry-forward after
        # the fact (which would require guessing whether two consecutive
        # real prices are "coincidentally equal" vs "the same forward-
        # filled response" — the weekday check is unambiguous, that
        # inference isn't).
        fetch_date = today
        while fetch_date.weekday() >= 5:
            fetch_date -= timedelta(days=1)
        payload = await _fetch_goldapi_fix(symbol, api_key, fetch_date)
        fetched_date = fetch_date
        if payload.get("price") is None:
            fetched_date = fetch_date - timedelta(days=1)
            while fetched_date.weekday() >= 5:
                fetched_date -= timedelta(days=1)
            payload = await _fetch_goldapi_fix(symbol, api_key, fetched_date)
        price = payload.get("price")
        if price is not None:
            db.upsert_lbma_fix_row({
                "metal": symbol,
                "fix_type": fix_type,
                "date": str(fetched_date),
                "price_usd": price,
            })
        results[symbol] = payload
    return results


@app.get("/api/lbma/db")
async def lbma_db(metal: str = Query("XAU")):
    rows = db.get_latest_lbma_fix(metal)
    return {"success": True, "data": rows}


@app.get("/api/lbma/db/history")
async def lbma_db_history(metal: str = Query("XAU"), fix_type: str = Query(None)):
    resolved_fix_type = fix_type or _LBMA_METAL_SYMBOLS.get(metal, "daily")
    rows = db.get_lbma_fix_series(metal, resolved_fix_type)
    return {"success": True, "data": rows}


# Front-month vs. next-month futures curve spread (Squeeze Context Story
# #1, see squeeze-context-spec.md). Yahoo's chart API returns a price for
# EVERY calendar-month contract symbol, including thin/illiquid ones, and
# which months are genuinely liquid does NOT match the textbook COMEX
# delivery-cycle description — confirmed live (2026-07): silver's real
# near-term depth was Sep (SIU26.CMX, vol=14,445) and Dec (SIZ26.CMX,
# vol=1,123) only, while the textbook "Mar/May/Jul/Sep/Dec" cycle's Jul
# (SIN26.CMX) showed just vol=5; gold's real depth was Aug (GCQ26.CMX,
# vol=22,196) and Dec (GCZ26.CMX, vol=1,429), while Jul/Sep/Oct/Nov were
# all <200. A hand-maintained "active months" list was tried first and
# abandoned — same reasoning delivery_behavior.py's own module docstring
# gives for why FND/LTD are computed per-month on demand rather than off a
# small fixed list: COMEX's real listed/liquid months don't fit one. This
# resolves front/next by fetching a spread of near-term candidate months
# and picking the two with the highest real reported volume, every time,
# rather than trusting a static list to stay accurate.
_FUTURES_MONTH_CODE = {
    1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M",
    7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z",
}
CURVE_SPREAD_CANDIDATE_MONTHS_AHEAD = 8   # how many upcoming calendar months to probe for liquidity
CURVE_SPREAD_CANDIDATE_MONTHS_BEHIND = 14 # >CURVE_SPREAD_FETCH_DAYS/30, so per-date backfill ranking
                                           # (see _fetch_and_persist_curve_spread) has every symbol that
                                           # could have been genuinely front/next at any date in that window
                                           # — a real gap in an earlier version, which only swept forward
                                           # from today and silently missed already-thinning contracts
                                           # (e.g. SIN26.CMX/Jul26) that were the true front month months ago.
CURVE_SPREAD_FETCH_DAYS = 370      # >1y so a fresh slow-tier row always has a full trailing year


_MONTH_CODE_TO_NUM = {v: k for k, v in _FUTURES_MONTH_CODE.items()}


def _candidate_contract_symbols(metal: str, today: date, months_ahead: int, months_behind: int) -> list[str]:
    root = "SI" if metal == "XAG" else "GC"
    symbols = []
    year, month = today.year, today.month
    for _ in range(months_behind):
        month -= 1
        if month == 0:
            month = 12
            year -= 1
    for _ in range(months_ahead + months_behind):
        symbols.append(f"{root}{_FUTURES_MONTH_CODE[month]}{year % 100:02d}.CMX")
        month += 1
        if month == 13:
            month = 1
            year += 1
    return symbols


def _delivery_sort_key(symbol: str) -> tuple[int, int]:
    """(year, month) parsed from a Yahoo .CMX futures symbol, e.g.
    'SIN26.CMX' -> (2026, 7) — lets ranking enforce real delivery order,
    not just raw volume rank. Assumes 2-digit years land in 2000-2099,
    fine for this codebase's near-term contract horizon."""
    month_code = symbol[2]
    year = 2000 + int(symbol[3:5])
    return (year, _MONTH_CODE_TO_NUM[month_code])


async def _fetch_yahoo_contract_daily(ticker: str, days: int) -> dict[str, tuple[float, float]]:
    """Daily (close, volume) pairs keyed by YYYY-MM-DD for a single futures
    contract symbol, sourced from the response's own per-bar arrays (NOT
    meta.regularMarketVolume, which is only today's snapshot) — real daily
    volume is what makes per-historical-date liquidity ranking possible, see
    module note above. Single retry with short backoff on 429/5xx, then
    raises — see squeeze-context-spec.md's rate-limit investigation: this
    endpoint has no published quota or rate-limit response headers
    (confirmed live), but has been hit repeatedly elsewhere in this
    codebase (catcor.py's startup backfill, Money Supply's on-demand
    refresh) with no documented 429, unlike ForexFactory's confirmed one —
    a single retry is a defensive margin, not evidence of a known problem.
    A 404 (contract symbol not yet listed / already delisted) is treated as
    "no data" rather than retried, since a retry can't fix a symbol that
    doesn't exist."""
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            resp = await _client.get(
                f"{YAHOO_CHART_BASE}/{ticker}",
                params={"interval": "1d", "range": f"{days}d"},
                headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
                timeout=30,
            )
            if resp.status_code == 404:
                return {}
            resp.raise_for_status()
            data = resp.json()
            result = data["chart"]["result"][0]
            timestamps = result["timestamp"]
            quote = result["indicators"]["quote"][0]
            closes = quote["close"]
            volumes = quote.get("volume") or [None] * len(timestamps)
            bars = {}
            for ts, close, vol in zip(timestamps, closes, volumes):
                if close is None:
                    continue
                d = datetime.fromtimestamp(ts, tz=timezone.utc).date()
                bars[d.isoformat()] = (round(close, 4), vol or 0)
            return bars
        except httpx.HTTPError as e:
            last_error = e
            if attempt == 0:
                await asyncio.sleep(2)
    raise last_error


async def _fetch_and_persist_curve_spread() -> dict:
    """Front/next-month resolution is liquidity-ranked PER HISTORICAL DATE,
    not just for today — a real mislabeling bug caught after inspecting the
    persisted data (confirmed live 2026-07): the original version ranked
    liquidity once for today, then backfilled those two symbols' entire
    trailing-year price history under that single label. Since which
    contract is genuinely front/next changes as contracts approach and pass
    their own delivery window (confirmed live: during the real January 2026
    silver squeeze, the actually-liquid front month was SIN26.CMX/Jul26,
    not SIU26.CMX/Sep26, which is what today's ranking would have wrongly
    applied retroactively), a fixed label across the whole backfill window
    was itself wrong — not the underlying Yahoo prices, which are real,
    independently-traded, and carry real daily volume. This fetches each
    candidate symbol's full daily (close, volume) history once, then re-
    ranks front/next independently for every date in that history using
    that date's own real volume."""
    today = date.today()
    results = {}
    for metal in ("XAG", "XAU"):
        candidates = _candidate_contract_symbols(
            metal, today, CURVE_SPREAD_CANDIDATE_MONTHS_AHEAD, CURVE_SPREAD_CANDIDATE_MONTHS_BEHIND
        )
        fetched: dict[str, dict[str, tuple[float, float]]] = {}
        for symbol in candidates:
            bars = await _fetch_yahoo_contract_daily(symbol, CURVE_SPREAD_FETCH_DAYS)
            if bars:
                fetched[symbol] = bars

        all_dates = sorted(set(d for bars in fetched.values() for d in bars))
        rows = []
        for d in all_dates:
            # Rank every candidate symbol with real volume on THIS date by
            # volume, highest = front. "Next" is the highest-volume REMAINING
            # candidate whose delivery month is strictly later than front's —
            # a real second bug caught during verification: pure volume
            # ranking with no delivery-order check could pair an about-to-
            # expire contract's trailing volume (e.g. SIZ25.CMX/Dec25, still
            # winding down) against a newer front month (e.g. SIN26.CMX/
            # Jul26) and call the EARLIER contract "next," producing a
            # spurious negative spread that wasn't real backwardation, just
            # a chronologically-backwards pairing.
            day_ranked = sorted(
                (
                    (symbol, bars[d][0], bars[d][1])
                    for symbol, bars in fetched.items()
                    if d in bars and bars[d][1] > 0
                ),
                key=lambda t: t[2],
                reverse=True,
            )
            if len(day_ranked) < 2:
                continue
            front_symbol, front_price, _ = day_ranked[0]
            front_delivery = _delivery_sort_key(front_symbol)
            later_candidates = [
                c for c in day_ranked[1:] if _delivery_sort_key(c[0]) > front_delivery
            ]
            if not later_candidates:
                continue
            next_symbol, next_price, _ = later_candidates[0]
            # Nulls over zeros: only compute a real spread when both legs
            # reported a real price that day (standing convention).
            spread_pct = (
                (next_price - front_price) / front_price
                if front_price and next_price else None
            )
            row = {
                "metal": metal,
                "date": d,
                "front_month_symbol": front_symbol,
                "front_month_price": front_price,
                "next_month_symbol": next_symbol,
                "next_month_price": next_price,
                "curve_spread_pct": spread_pct,
            }
            db.upsert_curve_spread_row(row)
            rows.append(row)
        results[metal] = rows
    return results


@app.get("/api/curve-spread/db")
async def curve_spread_db(metal: str = Query("XAG")):
    rows = db.get_curve_spread_series(metal)
    return {"success": True, "data": rows}


@app.get("/api/squeeze-cases/db")
async def squeeze_cases_db():
    rows = db.get_squeeze_cases()
    return {"success": True, "data": rows}


def _census_trade_months(n: int) -> list[str]:
    """Last n calendar months as 'YYYY-MM' strings, most recent first."""
    months = []
    y, m = date.today().year, date.today().month
    for _ in range(n):
        months.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    return months


async def _fetch_and_persist_census_trade() -> dict:
    if "CENSUS_API_KEY" not in os.environ:
        raise HTTPException(500, "CENSUS_API_KEY environment variable is not set")
    api_key = os.environ["CENSUS_API_KEY"]
    results = {}
    for metal, hs_code in CENSUS_TRADE_HS_CODES.items():
        for flow, spec in CENSUS_TRADE_FLOWS.items():
            get_fields = ["CTY_CODE", "CTY_NAME", spec["value_general_field"]]
            if spec["value_consumption_field"]:
                get_fields.append(spec["value_consumption_field"])
            get_fields += [spec["qty_field"], "UNIT_QY1"]
            rows_for_flow = []
            # Confirmed live: Census's publication lag is ~2 months, not 1 —
            # both the current calendar month and the immediately-prior one
            # return HTTP 204 (empty body, not an error) until released.
            # Fetch a wider window so CENSUS_TRADE_MONTHS_PER_FETCH real
            # months still land even after skipping unpublished ones.
            for month in _census_trade_months(CENSUS_TRADE_MONTHS_PER_FETCH + 2):
                resp = await _client.get(
                    f"{CENSUS_TRADE_BASE}/{spec['path']}",
                    params={
                        "get": ",".join(get_fields),
                        spec["commodity_param"]: hs_code,
                        "time": month,
                        "key": api_key,
                    },
                    timeout=15,
                )
                resp.raise_for_status()
                if resp.status_code == 204 or not resp.content:
                    continue  # not yet published for this month
                payload = resp.json()
                header, *data_rows = payload
                col_idx = {name: i for i, name in enumerate(header)}
                for r in data_rows:
                    qty_raw = r[col_idx[spec["qty_field"]]]
                    unit_raw = r[col_idx["UNIT_QY1"]]
                    # Confirmed live: HS 7106/7108 always report qty "0" /
                    # unit "-" (Census's not-applicable sentinel) — persist
                    # as NULL rather than a misleading 0/"-" pair.
                    qty = None if qty_raw in (None, "0", "-") else float(qty_raw)
                    qty_unit = None if unit_raw in (None, "-") else unit_raw
                    con_val = None
                    if spec["value_consumption_field"]:
                        con_val = int(r[col_idx[spec["value_consumption_field"]]])
                    rows_for_flow.append({
                        "metal": metal,
                        "flow": flow,
                        "hs_code": hs_code,
                        "cty_code": r[col_idx["CTY_CODE"]],
                        "cty_name": r[col_idx["CTY_NAME"]],
                        "year": int(month[:4]),
                        "month": int(month[5:7]),
                        "value_general_usd": int(r[col_idx[spec["value_general_field"]]]),
                        "value_consumption_usd": con_val,
                        "qty": qty,
                        "qty_unit": qty_unit,
                    })
            if rows_for_flow:
                db.upsert_census_trade_rows(rows_for_flow)
            results[f"{metal}_{flow}"] = len(rows_for_flow)
    return results


CENSUS_TRADE_MIN_REFRESH_DAYS = 25  # Census releases monthly — no point re-pulling more often


async def _refresh_census_trade():
    """census_trade's registry entry — a rate-limit gate wrapping the real
    fetch, same shape as _refresh_cot_pipeline. Gates on wall-clock time
    since the LAST FETCH ATTEMPT (source_health.last_attempt_at), not on
    the persisted data's own age — confirmed live that Census's real
    publication lag is ~2 months (both the current calendar month and the
    immediately-prior one return HTTP 204 until released), so "latest
    persisted month is under 25 days old" is never true in practice and
    would make the gate a permanent no-op, unlike cot_pipeline's CFTC data
    (published within ~3 days of its as-of date, so report age closely
    tracks fetch recency there). Records a 'skipped' attempt rather than a
    failure when gated. In _SELF_RECORDING_KEYS (like cot_pipeline), so this
    records its own success too — the generic health_refresh route must not
    overwrite a genuine 'skipped' with a blanket 'success' once this returns
    normally either way."""
    health = db.get_source_health("census_trade")
    if health and health.get("last_attempt_at"):
        last_attempt = datetime.fromisoformat(health["last_attempt_at"])
        days_since = (datetime.now(timezone.utc) - last_attempt).days
        if days_since < CENSUS_TRADE_MIN_REFRESH_DAYS:
            db.record_fetch_attempt(
                "census_trade",
                success=False,
                skipped=True,
                error="Last fetch attempt is less than 25 days old — skipped to respect Census's monthly release cadence.",
            )
            return
    await _fetch_and_persist_census_trade()
    db.record_fetch_attempt("census_trade", success=True)


async def _census_trade_startup():
    """Monthly, not daily — too slow for either tiered loop, so this is
    startup-only (gated) plus manual force-refresh via the Data tab's
    per-source button, same as LBMA. Silently skips if CENSUS_API_KEY isn't
    set — a nice-to-have layer, not a hard boot requirement."""
    if "CENSUS_API_KEY" not in os.environ:
        print("[census_trade] CENSUS_API_KEY not set — skipping Census trade fetch")
        return
    try:
        await _refresh_census_trade()
    except Exception as e:
        print(f"[census_trade] warning: {e}")
        db.record_fetch_attempt("census_trade", success=False, error=str(e))


@app.get("/api/census-trade/db")
async def census_trade_db(
    metal: str = Query("XAG"),
    flow: str = Query(None),
    hs_code: str = Query(None),
):
    rows = db.get_census_trade(metal, flow=flow, hs_code=hs_code)
    return {"success": True, "data": rows}


@app.get("/api/refresh/settings")
async def refresh_settings_get():
    return {"success": True, "data": _refresh_settings}


@app.post("/api/refresh/settings")
async def refresh_settings_post(body: dict = Body(...)):
    if "fast_interval_s" in body:
        _refresh_settings["fast_interval_s"] = max(5, int(body["fast_interval_s"]))
    if "slow_interval_s" in body:
        _refresh_settings["slow_interval_s"] = max(30, int(body["slow_interval_s"]))
    if "fast_enabled" in body:
        _refresh_settings["fast_enabled"] = bool(body["fast_enabled"])
    if "slow_enabled" in body:
        _refresh_settings["slow_enabled"] = bool(body["slow_enabled"])
    return {"success": True, "data": _refresh_settings}


_VALID_NAV_SECTIONS = {"cot", "moneySupply", "inventory", "catcor", "research", "data"}


@app.get("/api/ui/pinned-section")
async def ui_pinned_section_get():
    return {"success": True, "data": {"pinned_section": db.get_pinned_section()}}


@app.post("/api/ui/pinned-section")
async def ui_pinned_section_post(body: dict = Body(...)):
    section = body.get("section")
    if section is not None and section not in _VALID_NAV_SECTIONS:
        raise HTTPException(400, f"section must be one of {sorted(_VALID_NAV_SECTIONS)} or null")
    db.set_pinned_section(section)
    return {"success": True, "data": {"pinned_section": section}}


@app.post("/api/refresh/force")
async def refresh_force():
    fast_result = await _refresh_fast_tier()
    slow_result = await _refresh_slow_tier()
    total_failed = fast_result["failed"] + slow_result["failed"]
    total_succeeded = fast_result["succeeded"] + slow_result["succeeded"]
    return {
        "success": total_failed == 0,
        "fast": fast_result,
        "slow": slow_result,
        "succeeded": total_succeeded,
        "failed": total_failed,
    }


async def _fetch_fred_series(series_id: str, observation_start: str) -> list[dict]:
    api_key = os.environ["FRED_API_KEY"]
    resp = await _client.get(
        FRED_BASE,
        params={
            "series_id": series_id,
            "api_key": api_key,
            "file_type": "json",
            "observation_start": observation_start,
        },
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    rows = []
    for obs in data.get("observations", []):
        v = obs.get("value")
        rows.append({
            "date": obs["date"],
            "value": None if v == "." else float(v),
        })
    return rows


def _millions_to_trillions(rows: list[dict]) -> list[dict]:
    """WRESBAL/WSHOTSL/WSHOMCB/WLCFLPCL all report in millions of USD (same
    convention as WALCL) — confirmed live against FRED's /fred/series
    metadata. RRPONTSYD/M2SL report in billions instead; do not reuse this
    helper for those."""
    return [
        {
            "date": r["date"],
            "value_trillions": round(r["value"] / 1_000_000, 3) if r["value"] is not None else None,
        }
        for r in rows
    ]


def _compute_yoy(rows: list[dict], lookback: int) -> list[dict]:
    out = []
    for i, r in enumerate(rows):
        yoy = None
        if i >= lookback:
            prior = rows[i - lookback]["value"]
            cur = r["value"]
            if prior is not None and cur is not None and prior != 0:
                yoy = (cur - prior) / prior * 100
        out.append({**r, "yoy": round(yoy, 2) if yoy is not None else None})
    return out


@app.get("/api/fred/money-supply/refresh")
async def fred_money_supply_refresh():
    if "FRED_API_KEY" not in os.environ:
        raise HTTPException(500, "FRED_API_KEY environment variable is not set")
    try:
        observation_start = str(date.today() - timedelta(days=365 * FRED_FETCH_YEARS))
        m2_rows = await _fetch_fred_series(FRED_SERIES_M2, observation_start)
        walcl_rows = await _fetch_fred_series(FRED_SERIES_WALCL, observation_start)
        cpi_rows = await _fetch_fred_series(FRED_SERIES_CPI, observation_start)
        wresbal_rows = await _fetch_fred_series(FRED_SERIES_WRESBAL, observation_start)
        rrpontsyd_rows = await _fetch_fred_series(FRED_SERIES_RRPONTSYD, observation_start)
        wshotsl_rows = await _fetch_fred_series(FRED_SERIES_WSHOTSL, observation_start)
        wshomcb_rows = await _fetch_fred_series(FRED_SERIES_WSHOMCB, observation_start)
        wlcflpcl_rows = await _fetch_fred_series(FRED_SERIES_WLCFLPCL, observation_start)
        db.upsert_fred_observations(FRED_SERIES_M2, m2_rows)
        db.upsert_fred_observations(FRED_SERIES_WALCL, walcl_rows)
        db.upsert_fred_observations(FRED_SERIES_CPI, cpi_rows)
        db.upsert_fred_observations(FRED_SERIES_WRESBAL, wresbal_rows)
        db.upsert_fred_observations(FRED_SERIES_RRPONTSYD, rrpontsyd_rows)
        db.upsert_fred_observations(FRED_SERIES_WSHOTSL, wshotsl_rows)
        db.upsert_fred_observations(FRED_SERIES_WSHOMCB, wshomcb_rows)
        db.upsert_fred_observations(FRED_SERIES_WLCFLPCL, wlcflpcl_rows)
        db.record_fetch_attempt("money_supply", success=True)
        return {
            "success": True,
            "data": {
                FRED_SERIES_M2: m2_rows,
                FRED_SERIES_WALCL: walcl_rows,
                FRED_SERIES_CPI: cpi_rows,
                FRED_SERIES_WRESBAL: wresbal_rows,
                FRED_SERIES_RRPONTSYD: rrpontsyd_rows,
                FRED_SERIES_WSHOTSL: wshotsl_rows,
                FRED_SERIES_WSHOMCB: wshomcb_rows,
                FRED_SERIES_WLCFLPCL: wlcflpcl_rows,
            },
        }
    except httpx.HTTPError as e:
        db.record_fetch_attempt("money_supply", success=False, error=str(e))
        raise HTTPException(502, str(e))


FRED_WINDOW_YEARS = {"2y": 2, "5y": 5, "10y": 10, "20y": 20}


async def _fetch_yahoo_daily_closes(ticker: str, years: int) -> list[dict]:
    resp = await _client.get(
        f"{YAHOO_CHART_BASE}/{ticker}",
        params={"interval": "1d", "range": f"{years}y"},
        headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    result = data["chart"]["result"][0]
    timestamps = result["timestamp"]
    closes = result["indicators"]["quote"][0]["close"]

    rows = []
    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        d = datetime.fromtimestamp(ts, tz=timezone.utc).date()
        rows.append({"date": d.isoformat(), "value": round(close, 4)})
    return rows


def _resample_month_end(daily_rows: list[dict]) -> list[dict]:
    """Reduce daily closes to one row per calendar month — the last trading
    day on or before that month's end. Yahoo's own `1mo` interval bucket
    includes the current in-progress month, which isn't a true month-end
    close, so we resample from daily data instead."""
    by_month: dict[str, dict] = {}
    for row in daily_rows:
        month_key = row["date"][:7]  # YYYY-MM
        by_month[month_key] = row  # rows arrive in chronological order, so last write wins
    return [by_month[k] for k in sorted(by_month)]


@app.get("/api/metals/prices/refresh")
async def metals_prices_refresh():
    try:
        result = {}
        for series_id, ticker in METAL_PRICE_TICKERS.items():
            daily = await _fetch_yahoo_daily_closes(ticker, METAL_PRICE_FETCH_YEARS)
            monthly = _resample_month_end(daily)
            db.upsert_fred_observations(series_id, monthly)
            result[series_id] = monthly
        db.record_fetch_attempt("metals_prices", success=True)
        return {"success": True, "data": result}
    except httpx.HTTPError as e:
        db.record_fetch_attempt("metals_prices", success=False, error=str(e))
        raise HTTPException(502, str(e))


COT_MIN_REFRESH_DAYS = 7  # CFTC only publishes a new report ~weekly — no point re-pulling more often


async def _refresh_cot_pipeline():
    """cot_pipeline's registry entry — the only one that's a rate-limit gate
    wrapping a call rather than a bare fetch-and-persist function. Skips
    entirely (no CFTC request at all) if the latest persisted report is
    still within COT_MIN_REFRESH_DAYS, recording a 'skipped' attempt rather
    than a failure. Otherwise runs the real pipeline in a thread (it's a
    blocking, stdlib-only sync call) via asyncio.to_thread — run_pipeline_once
    records its own success/failure to source_health itself (see
    pipeline/run.py), so this wrapper doesn't duplicate that."""
    latest_report_date = db.get_latest_cot_report_date()
    if latest_report_date:
        days_since = (date.today() - date.fromisoformat(latest_report_date)).days
        if days_since < COT_MIN_REFRESH_DAYS:
            db.record_fetch_attempt(
                "cot_pipeline",
                success=False,
                skipped=True,
                error="Latest report is less than 7 days old — skipped to respect CFTC's publish cadence.",
            )
            return
    await asyncio.to_thread(pipeline_run.run_pipeline_once)


# Single source of truth for "what gets fetched, on which tier, under which
# source_health key" — both the tiered background loops (_refresh_fast_tier/
# _refresh_slow_tier above) and the on-demand per-source health-refresh
# route (POST /api/health/refresh/{source_key}, below) read from this
# registry rather than each owning their own hardcoded function list, so the
# two paths can't drift apart. Defined here (not near the top of the file)
# since every function it references — including the on-demand-only ones —
# must already exist as a real name by this point.
_FAST_TIER_REGISTRY: dict[str, Callable[[], Awaitable[None]]] = {
    "spot_prices": _fetch_and_persist_prices,
}
_SLOW_TIER_REGISTRY: dict[str, Callable[[], Awaitable[None]]] = {
    "comex_silver_history": _fetch_and_persist_silver_history,
    "comex_gold_history": _fetch_and_persist_gold_history,
    "comex_silver_depositories": _fetch_and_persist_silver_depositories,
    "comex_gold_depositories": _fetch_and_persist_gold_depositories,
    "silver_leverage": _fetch_and_persist_silver_leverage,
    "gold_leverage": _fetch_and_persist_gold_leverage,
    "delivery_notices": _fetch_and_persist_delivery_ytd,
    "shfe_silver_history": _fetch_and_persist_shfe_history,
    "shfe_warehouses": _fetch_and_persist_shfe_warehouses,
    "pslv": _fetch_and_persist_pslv,
    "futures_curve_spread": _fetch_and_persist_curve_spread,
}
# On-demand-only sources (not part of either recurring tier), added to the
# same registry the health-refresh route reads from, per Decision 6's "one
# generic route, not one bespoke route per source."
_ON_DEMAND_REGISTRY: dict[str, Callable[[], Awaitable[None]]] = {
    "money_supply": fred_money_supply_refresh,
    "metals_prices": metals_prices_refresh,
    "cot_pipeline": _refresh_cot_pipeline,
    "lbma_fix": _fetch_and_persist_lbma_fix,
    "census_trade": _refresh_census_trade,
}
_SOURCE_REGISTRY: dict[str, Callable[[], Awaitable[None]]] = {
    **_FAST_TIER_REGISTRY,
    **_SLOW_TIER_REGISTRY,
    **_ON_DEMAND_REGISTRY,
}
# cot_pipeline is the one entry whose self-recording health_refresh must not
# clobber: a skip is deliberately not a failure (see _refresh_cot_pipeline),
# and the real run's outcome is recorded inside run_pipeline_once itself
# (used by the CLI/cron path too, not just this route) — an outer generic
# record_fetch_attempt call here would overwrite a genuine "skipped" with a
# blanket "success" once _refresh_cot_pipeline returns normally either way.
# money_supply/metals_prices also record internally, but that's a harmless
# duplicate of the identical outcome (and skipping the record here would
# leave their FRED_API_KEY-missing pre-check, which raises before its own
# try/except, unrecorded) — only cot_pipeline is exempted. census_trade is
# exempted for the same reason as cot_pipeline: _refresh_census_trade's own
# skip branch records "skipped" itself, which the generic route must not
# overwrite with "success" once the wrapper returns normally either way.
_SELF_RECORDING_KEYS = {"cot_pipeline", "census_trade"}


@app.get("/api/health/db")
async def health_db():
    rows = {r["source_key"]: dict(r) for r in db.get_all_source_health()}
    for source_key in rows:
        rows[source_key].pop("source_key", None)
    if "cot_pipeline" in rows:
        rows["cot_pipeline"]["last_report_date"] = db.get_latest_cot_report_date()
    if "census_trade" in rows:
        rows["census_trade"]["last_period"] = db.get_latest_census_trade_period()
    return {"success": True, "sources": rows}


@app.post("/api/health/refresh/{source_key}")
async def health_refresh(source_key: str):
    fn = _SOURCE_REGISTRY.get(source_key)
    if fn is None:
        raise HTTPException(404, f"Unknown source_key: {source_key}")
    try:
        await fn()
        if source_key not in _SELF_RECORDING_KEYS:
            db.record_fetch_attempt(source_key, success=True)
        return {"success": True, "error": None}
    except Exception as e:
        if source_key not in _SELF_RECORDING_KEYS:
            db.record_fetch_attempt(source_key, success=False, error=str(e))
        return {"success": False, "error": str(e)}


def _index_to_100(rows: list[dict]) -> list[dict]:
    """Index a {date, value} series to 100 at its first non-null point, so
    series on unrelated scales (metal prices in USD/oz, a CPI-derived ratio)
    can be compared as relative change on one shared axis."""
    base = next((r["value"] for r in rows if r["value"] is not None), None)
    return [
        {
            "date": r["date"],
            "index": round(100 * (r["value"] / base), 2)
            if (base is not None and r["value"] is not None)
            else None,
        }
        for r in rows
    ]


@app.get("/api/metals/prices/db")
async def metals_prices_db(
    window: str = Query("20y"),
    start: str | None = Query(None),
    end: str | None = Query(None),
):
    # Same window="custom" + start/end convention as /api/fred/money-supply/db
    # — Money Supply's frontend fetches both routes together with the same
    # window params, so this chart's own window must stay in sync with that
    # one rather than only supporting the fixed-years presets.
    if window == "custom" and start:
        since = start
    else:
        years = FRED_WINDOW_YEARS.get(window, 20)
        since = str(date.today() - timedelta(days=365 * years))

    xag_rows = db.get_fred_observations(XAG_SERIES_ID, since)
    xau_rows = db.get_fred_observations(XAU_SERIES_ID, since)
    if end is not None:
        xag_rows = [r for r in xag_rows if r["date"] <= end]
        xau_rows = [r for r in xau_rows if r["date"] <= end]
    xag_index = _index_to_100(xag_rows)
    xau_index = _index_to_100(xau_rows)

    return {
        "success": True,
        "data": {
            "xag": [
                {"date": r["date"], "price": r["value"], "index": i["index"]}
                for r, i in zip(xag_rows, xag_index)
            ],
            "xau": [
                {"date": r["date"], "price": r["value"], "index": i["index"]}
                for r, i in zip(xau_rows, xau_index)
            ],
        },
    }


@app.get("/api/fred/money-supply/db")
async def fred_money_supply_db(
    window: str = Query("5y"),
    start: str | None = Query(None),
    end: str | None = Query(None),
):
    # window="custom" + explicit start/end (both YYYY-MM-DD) bypasses the
    # fixed years-back presets entirely — start becomes `since`, end trims
    # the fetched rows client-side-of-the-route (get_fred_observations has
    # no upper bound of its own, so this route does the trimming itself
    # rather than adding an end-date param to every caller of that helper).
    if window == "custom" and start:
        since = start
        # A real bug caught by the user ("no M2 YoY stats earlier than
        # 2021?"): fetch_since was originally just `start`, giving
        # _compute_yoy zero lookback before the requested window — YoY needs
        # 12 real prior months to diff against, so every custom-range M2/
        # WALCL YoY value came back null regardless of how far back `start`
        # was. Fetch 2 extra years before `start`, same margin the preset
        # branch below already uses, so YoY is computable from day one of a
        # custom range too.
        fetch_since = str(date.fromisoformat(start) - timedelta(days=365 * 2))
    else:
        years = FRED_WINDOW_YEARS.get(window, 5)
        since = str(date.today() - timedelta(days=365 * years))
        # Fetch extra lookback history (>1yr) so YoY is computable at the start of the window.
        fetch_since = str(date.today() - timedelta(days=365 * (years + 2)))

    def _trim(rows: list[dict]) -> list[dict]:
        return [r for r in rows if end is None or r["date"] <= end]

    m2_all = _trim(db.get_fred_observations(FRED_SERIES_M2, fetch_since))
    walcl_all = _trim(db.get_fred_observations(FRED_SERIES_WALCL, fetch_since))
    cpi_all = _trim(db.get_fred_observations(FRED_SERIES_CPI, fetch_since))
    wresbal_all = _trim(db.get_fred_observations(FRED_SERIES_WRESBAL, since))
    rrpontsyd_all = _trim(db.get_fred_observations(FRED_SERIES_RRPONTSYD, since))
    wshotsl_all = _trim(db.get_fred_observations(FRED_SERIES_WSHOTSL, since))
    wshomcb_all = _trim(db.get_fred_observations(FRED_SERIES_WSHOMCB, since))
    wlcflpcl_all = _trim(db.get_fred_observations(FRED_SERIES_WLCFLPCL, since))

    m2_yoy = [r for r in _compute_yoy(m2_all, FRED_M2_YOY_LOOKBACK) if r["date"] >= since]
    walcl_yoy = [r for r in _compute_yoy(walcl_all, FRED_WALCL_YOY_LOOKBACK) if r["date"] >= since]
    cpi_windowed = [r for r in cpi_all if r["date"] >= since]

    # Purchasing power of a dollar moves inversely to CPI. Index to 100 at the
    # first point in the requested window so the line reads as "relative
    # purchasing power since the start of this view," not an opaque raw ratio.
    cpi_base = next((r["value"] for r in cpi_windowed if r["value"] is not None), None)
    purchasing_power = [
        {
            "date": r["date"],
            "index": round(100 * (cpi_base / r["value"]), 2)
            if (cpi_base is not None and r["value"] is not None)
            else None,
        }
        for r in cpi_windowed
    ]

    return {
        "success": True,
        "data": {
            "m2": [
                {
                    "date": r["date"],
                    "value_trillions": round(r["value"] / 1000, 3) if r["value"] is not None else None,
                    "yoy": r["yoy"],
                }
                for r in m2_yoy
            ],
            "walcl": [
                {
                    "date": r["date"],
                    "value_trillions": round(r["value"] / 1_000_000, 3) if r["value"] is not None else None,
                    "yoy": r["yoy"],
                }
                for r in walcl_yoy
            ],
            "purchasing_power": purchasing_power,
            "wresbal": _millions_to_trillions(wresbal_all),
            "rrpontsyd": [
                {
                    "date": r["date"],
                    "value_trillions": round(r["value"] / 1000, 3) if r["value"] is not None else None,
                }
                for r in rrpontsyd_all
            ],
            "wshotsl": _millions_to_trillions(wshotsl_all),
            "wshomcb": _millions_to_trillions(wshomcb_all),
            "wlcflpcl": _millions_to_trillions(wlcflpcl_all),
        },
    }


@app.get("/api/catcor/events/db")
async def catcor_events_db(limit: int = Query(20)):
    return {"success": True, "data": db.get_upcoming_events(limit=limit)}


@app.get("/api/catcor/reactions/db")
async def catcor_reactions_db():
    return {"success": True, "data": db.get_event_reaction_series()}


@app.post("/api/catcor/refresh")
async def catcor_refresh():
    if "FRED_API_KEY" not in os.environ:
        raise HTTPException(500, "FRED_API_KEY environment variable is not set")
    try:
        n_seeded = catcor.seed_events()
        await catcor.backfill_intraday_ticks(_client)
        await catcor.backfill_daily_closes(_client)
        consensus_result = await catcor.fetch_and_persist_consensus(_client)
        actuals_result = await catcor.fetch_and_persist_actuals(_client)
        catcor.backfill_reactions()
        return {
            "success": True,
            "seeded": n_seeded,
            "consensus": consensus_result,
            "actuals": actuals_result,
        }
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


# CATCOR Research Pane (backend/catcor_research.py), per catcor-events-spec.md.
def _require_backend_credentials(backend: str):
    """Only Anthropic needs a key on AV's side — Forge is a local, unauthed
    LAN service. Gate on the backend actually resolved for THIS request
    (now chosen per-turn via the request body, not just the module-level
    AI_BACKEND default) — otherwise a request explicitly choosing
    "anthropic" while the server default is "forge" would sail past this
    check and fail later with a raw KeyError inside call_anthropic."""
    if backend == "anthropic" and "ANTHROPIC_API_KEY" not in os.environ:
        raise HTTPException(500, "ANTHROPIC_API_KEY environment variable is not set")


def _turn_kwargs_from_body(body: dict) -> dict:
    """Shared extraction of the five-control turn parameters (spec section
    3) from a request body — used by both session-creation and message-send
    routes so the two don't drift apart."""
    return dict(
        backend=body.get("backend", catcor_research.DEFAULT_BACKEND),
        model=body.get("model"),
        persona=body.get("persona", catcor_research.DEFAULT_PERSONA),
        context_blocks=body.get("context_blocks", []),
        memory_mode=body.get("memory_mode"),
        freeform_text=body.get("freeform_text"),
        system_prompt_override=body.get("system_prompt_override"),
        messages_override=body.get("messages_override"),
    )


@app.post("/api/catcor/research/sessions")
async def catcor_research_create_session(body: dict = Body(...)):
    """Creates the session, then immediately runs the claim text through
    send_message as the first turn — so this one call returns both a
    session_id and a real first reply, matching a chat UI's expectation
    that submitting the first message produces a response."""
    claim_text = body.get("claim_text")
    if not claim_text:
        raise HTTPException(400, "claim_text is required")
    turn_kwargs = _turn_kwargs_from_body(body)
    _require_backend_credentials(turn_kwargs["backend"])
    session_id = catcor_research.create_session(claim_text, body.get("source_url"))
    try:
        result = await catcor_research.send_message(_client, session_id, claim_text, **turn_kwargs)
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    return {"success": True, "data": {"session_id": session_id, **result}}


@app.get("/api/catcor/research/evidence/db")
async def catcor_research_evidence_dump():
    """Every evidence tool's exact output, no Anthropic call involved — all
    four tools are zero-argument reads of AV's own state, so this just runs
    them directly. Lets you see exactly what data Claude has access to
    before/without holding a conversation, at zero cost."""
    return {"success": True, "data": catcor_research.dump_all_evidence()}


@app.get("/api/catcor/research/personas")
async def catcor_research_list_personas():
    """Backs spec 3.2's dynamically-populated persona dropdown — reflects
    whatever's actually in backend/prompts/ right now, no registration step."""
    return {"success": True, "data": catcor_research.list_personas()}


@app.post("/api/catcor/research/sessions/{session_id}/preview")
async def catcor_research_preview(session_id: str, body: dict = Body(...)):
    """Spec 3.5's non-editable prompt preview — the exact assembled payload
    for the controls currently selected, computed with zero model call
    (assemble_prompt is pure). Lets the frontend show real assembled text
    before Send is clicked, rather than a client-side approximation that
    would drift from catcor_research.py's actual formatting."""
    if catcor_research.get_session_detail(session_id) is None:
        raise HTTPException(404, f"No research session with id {session_id}")
    try:
        persona_prompt = catcor_research.load_persona_prompt(
            body.get("persona", catcor_research.DEFAULT_PERSONA)
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    history = catcor_research.db.list_research_messages(session_id)
    system_prompt, messages = catcor_research.assemble_prompt(
        persona_prompt,
        body.get("context_blocks", []),
        body.get("memory_mode", "accumulating"),
        history,
        body.get("freeform_text"),
        body.get("content", ""),
    )
    return {"success": True, "data": {"system": system_prompt, "messages": messages}}


@app.get("/api/catcor/research/sessions/db")
async def catcor_research_list_sessions():
    return {"success": True, "data": catcor_research.list_sessions()}


@app.get("/api/catcor/research/sessions/{session_id}/db")
async def catcor_research_get_session(session_id: str):
    detail = catcor_research.get_session_detail(session_id)
    if detail is None:
        raise HTTPException(404, f"No research session with id {session_id}")
    return {"success": True, "data": detail}


@app.post("/api/catcor/research/sessions/{session_id}/messages")
async def catcor_research_send_message(session_id: str, body: dict = Body(...)):
    content = body.get("content")
    if not content:
        raise HTTPException(400, "content is required")
    if catcor_research.get_session_detail(session_id) is None:
        raise HTTPException(404, f"No research session with id {session_id}")
    turn_kwargs = _turn_kwargs_from_body(body)
    _require_backend_credentials(turn_kwargs["backend"])
    try:
        result = await catcor_research.send_message(_client, session_id, content, **turn_kwargs)
    except ValueError as e:
        raise HTTPException(409, str(e))
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    return {"success": True, "data": result}


@app.post("/api/catcor/research/sessions/{session_id}/read")
async def catcor_research_set_read(session_id: str, body: dict = Body(...)):
    user_read = body.get("user_read")
    if user_read not in ("bullish", "bearish", "neutral"):
        raise HTTPException(400, "user_read must be one of bullish|bearish|neutral")
    if catcor_research.get_session_detail(session_id) is None:
        raise HTTPException(404, f"No research session with id {session_id}")
    try:
        catcor_research.set_read(session_id, user_read)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"success": True, "data": catcor_research.get_session_detail(session_id)}


@app.post("/api/catcor/research/sessions/{session_id}/promote")
async def catcor_research_promote(session_id: str, body: dict = Body(...)):
    event_name = body.get("event_name")
    scheduled_time = body.get("scheduled_time")
    direction = body.get("direction")
    if not event_name or not scheduled_time or direction not in ("bullish", "bearish"):
        raise HTTPException(400, "event_name, scheduled_time, and direction (bullish|bearish) are required")
    if catcor_research.get_session_detail(session_id) is None:
        raise HTTPException(404, f"No research session with id {session_id}")
    try:
        event_id = catcor_research.promote_session(session_id, event_name, scheduled_time, direction)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"success": True, "data": {"event_id": event_id}}


@app.delete("/api/catcor/events/{event_id}")
async def catcor_delete_promoted_event(event_id: str):
    """Deletes a promoted (source_tier='discovered') event_calendar row and
    its captured reactions, reverting the originating research session back
    to 'active'. Government-seeded events (CPI/FOMC/NFP) are rejected —
    this is only for undoing a Research-panel promotion, not for editing
    AV's own seeded calendar."""
    try:
        catcor_research.delete_promoted_event(event_id)
    except ValueError as e:
        raise HTTPException(404 if "no event with id" in str(e) else 409, str(e))
    return {"success": True, "data": None}


@app.post("/api/catcor/research/sessions/{session_id}/dismiss")
async def catcor_research_dismiss(session_id: str, body: dict = Body(...)):
    reason = (body.get("reason") or "").strip()
    if not reason:
        raise HTTPException(400, "reason is required")
    if catcor_research.get_session_detail(session_id) is None:
        raise HTTPException(404, f"No research session with id {session_id}")
    try:
        catcor_research.dismiss_session(session_id, reason)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"success": True, "data": None}


@app.post("/api/catcor/research/sessions/{session_id}/discard")
async def catcor_research_discard(session_id: str):
    if catcor_research.get_session_detail(session_id) is None:
        raise HTTPException(404, f"No research session with id {session_id}")
    try:
        catcor_research.discard_session(session_id)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"success": True, "data": None}


@app.get("/api/catcor/research/forge-sessions")
async def catcor_research_forge_sessions():
    """STUB. Spec 3.4 calls for viewing/clearing amp-forge's own
    server-side session state (separate from AV's own research_sessions),
    since amp-forge may hold model-side context independent of what AV
    resends. That contract lives in forge-spec.md, in the separate amp-dev
    repo, and has not been confirmed against this codebase — call_forge
    always sends persist:false today, but nothing here queries or clears
    any amp-forge-side state. Returns a fixed "not yet available" payload
    rather than guessing at a wire call; replace once forge-spec.md's
    actual contract (if any such endpoint exists) is confirmed."""
    return {
        "success": False,
        "data": None,
        "detail": "amp-forge session visibility not yet available — forge-spec.md contract unconfirmed",
    }


# Serve built frontend; keep last so API routes take priority
try:
    app.mount("/", StaticFiles(directory=os.path.join(_REPO_ROOT, "frontend", "dist"), html=True), name="static")
except Exception:
    pass
