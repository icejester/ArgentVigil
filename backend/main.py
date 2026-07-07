import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone

import httpx
from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

load_dotenv()

from . import catcor
from . import db
from . import delivery_behavior
from .mc_token import authed_headers
from pipeline.compute import compute_from_series, compute_signal_track_record
from pipeline.config import (
    FRED_FETCH_YEARS,
    FRED_M2_YOY_LOOKBACK,
    FRED_SERIES_CPI,
    FRED_SERIES_M2,
    FRED_SERIES_WALCL,
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
METAL_PRICE_TICKERS = {XAG_SERIES_ID: XAG_TICKER, XAU_SERIES_ID: XAU_TICKER}

# Recoverable stock = Investment (coins/bars) + ETF/Exchange Vaults + Central
# Bank reserves only. Excludes industrial (unrecoverable) and jewelry/silverware
# (partially recoverable, illiquid) per SPEC.MD's Open Questions resolution.
RECOVERABLE_STOCK_LOW_OZ = 12_500_000_000
RECOVERABLE_STOCK_HIGH_OZ = 17_000_000_000

_client: httpx.AsyncClient | None = None

# Tiered background refresh: fast tier = genuinely intraday data (spot prices);
# slow tier = everything else main.py manages (moves at most daily upstream).
# Both tiers default OFF — startup does one fetch to populate the DB, then
# each tier's recurring loop stays idle until the user opts in (or hits
# Force update). Interval/enabled state is in-memory only — a restart
# re-triggers the one-time startup refresh anyway.
_refresh_settings = {
    "fast_interval_s": 60,
    "slow_interval_s": 1200,
    "fast_enabled": False,
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
    asyncio.create_task(_catcor_startup())
    _refresh_tasks.append(asyncio.create_task(_fast_tier_loop()))
    _refresh_tasks.append(asyncio.create_task(_slow_tier_loop()))
    _refresh_tasks.append(asyncio.create_task(_event_tier_loop()))
    _refresh_tasks.append(asyncio.create_task(_consensus_tier_loop()))
    yield
    for t in _refresh_tasks:
        t.cancel()
    await _client.aclose()


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
        except Exception as e:
            print(f"[catcor] warning: event tier loop: {e}")


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
        except Exception as e:
            print(f"[catcor] warning: consensus tier loop: {e}")
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


async def _refresh_fast_tier() -> dict:
    try:
        await _fetch_and_persist_prices()
        return {"succeeded": 1, "failed": 0, "errors": []}
    except Exception as e:
        print(f"[refresh:fast] warning: {e}")
        return {"succeeded": 0, "failed": 1, "errors": [str(e)]}


async def _refresh_slow_tier() -> dict:
    succeeded, failed, errors = 0, 0, []
    # _fetch_and_persist_delivery defaults to type="mtd", but confirmed live
    # against metalcharts.org that type="ytd" returns a superset (~85 days
    # back to the start of the year vs. mtd's handful of days-in-month) at
    # no extra cost — using ytd here means delivery_notices actually
    # accumulates useful history instead of resetting to a few days every
    # month, which is what the Delivery Behavior reclassification signal
    # (backend/delivery_behavior.py) needs to have any real coverage.
    async def _fetch_and_persist_delivery_ytd():
        return await _fetch_and_persist_delivery(type="ytd")

    for fn in (
        _fetch_and_persist_silver_history,
        _fetch_and_persist_gold_history,
        _fetch_and_persist_silver_depositories,
        _fetch_and_persist_gold_depositories,
        _fetch_and_persist_silver_leverage,
        _fetch_and_persist_gold_leverage,
        _fetch_and_persist_delivery_ytd,
        _fetch_and_persist_shfe_history,
        _fetch_and_persist_shfe_warehouses,
        _fetch_and_persist_pslv,
    ):
        try:
            await fn()
            succeeded += 1
        except Exception as e:
            print(f"[refresh:slow] warning ({fn.__name__}): {e}")
            failed += 1
            errors.append(f"{fn.__name__}: {e}")
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
    # OI is in contracts (5,000 oz each); registered is in oz
    oi_oz = oi * 5000 if oi else None
    paper_leverage = (oi_oz / latest_reg) if (oi_oz and latest_reg) else None
    enriched = {**row, "paper_leverage": paper_leverage}
    if oi and vol:
        db.upsert_volume_oi_row({
            "date": row.get("date", str(date.today())),
            "open_interest": oi_oz,
            "volume": vol,
            "paper_leverage": paper_leverage,
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
    row = db.get_latest_volume_oi()
    if row is None:
        return {"success": True, "data": []}
    enriched = {
        "date": row["date"],
        "openInterest": row["open_interest"] / 5000 if row["open_interest"] else None,
        "volume": row["volume"],
        "paper_leverage": row["paper_leverage"],
    }
    return {"success": True, "data": [enriched]}


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
    # OI is in contracts (100 oz each for gold); registered is in oz
    oi_oz = oi * 100 if oi else None
    paper_leverage = (oi_oz / latest_reg) if (oi_oz and latest_reg) else None
    enriched = {**row, "paper_leverage": paper_leverage}
    if oi and vol:
        db.upsert_gold_volume_oi_row({
            "date": row.get("date", str(date.today())),
            "open_interest": oi_oz,
            "volume": vol,
            "paper_leverage": paper_leverage,
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
    row = db.get_latest_gold_volume_oi()
    if row is None:
        return {"success": True, "data": []}
    enriched = {
        "date": row["date"],
        "openInterest": row["open_interest"] / 100 if row["open_interest"] else None,
        "volume": row["volume"],
        "paper_leverage": row["paper_leverage"],
    }
    return {"success": True, "data": [enriched]}


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
    generated_at = datetime.fromisoformat(last_run_at).isoformat() if last_run_at else None

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
        db.upsert_fred_observations(FRED_SERIES_M2, m2_rows)
        db.upsert_fred_observations(FRED_SERIES_WALCL, walcl_rows)
        db.upsert_fred_observations(FRED_SERIES_CPI, cpi_rows)
        return {
            "success": True,
            "data": {
                FRED_SERIES_M2: m2_rows,
                FRED_SERIES_WALCL: walcl_rows,
                FRED_SERIES_CPI: cpi_rows,
            },
        }
    except httpx.HTTPError as e:
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
        return {"success": True, "data": result}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


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
async def metals_prices_db(window: str = Query("20y")):
    years = FRED_WINDOW_YEARS.get(window, 20)
    since = str(date.today() - timedelta(days=365 * years))

    xag_rows = db.get_fred_observations(XAG_SERIES_ID, since)
    xau_rows = db.get_fred_observations(XAU_SERIES_ID, since)
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
async def fred_money_supply_db(window: str = Query("5y")):
    years = FRED_WINDOW_YEARS.get(window, 5)
    since = str(date.today() - timedelta(days=365 * years))
    # Fetch extra lookback history (>1yr) so YoY is computable at the start of the window.
    fetch_since = str(date.today() - timedelta(days=365 * (years + 2)))

    m2_all = db.get_fred_observations(FRED_SERIES_M2, fetch_since)
    walcl_all = db.get_fred_observations(FRED_SERIES_WALCL, fetch_since)
    cpi_all = db.get_fred_observations(FRED_SERIES_CPI, fetch_since)

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


# Serve built frontend; keep last so API routes take priority
try:
    app.mount("/", StaticFiles(directory=os.path.join(_REPO_ROOT, "frontend", "dist"), html=True), name="static")
except Exception:
    pass
