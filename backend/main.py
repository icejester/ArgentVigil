import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone

import httpx
from dotenv import load_dotenv
from fastapi import APIRouter, Body, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

load_dotenv()

from . import catcor
from . import catcor_research
from . import collector
from . import db
from . import delivery_behavior
from . import models
from . import sources
from . import stack
from . import stack_db
from .price_instruments import (
    LBMA_BY_METAL,
    LBMA_SESSION_BY_METAL,
    YAHOO_DAILY_CLOSE_BY_METAL,
)
from .units import GOLD_CONTRACT_OZ, SILVER_CONTRACT_OZ, TROY_OZ_PER_KG
from pipeline.compute import compute_from_series, compute_signal_track_record
from pipeline.config import (
    FRED_M2_YOY_LOOKBACK,
    FRED_SERIES_CPI,
    FRED_SERIES_DFII10,
    FRED_SERIES_DGS2,
    FRED_SERIES_DGS3MO,
    FRED_SERIES_DGS5,
    FRED_SERIES_DGS10,
    FRED_SERIES_DGS30,
    FRED_SERIES_M2,
    FRED_SERIES_RRPONTSYD,
    FRED_SERIES_T10Y2Y,
    FRED_SERIES_TIC_COUNTRIES,
    FRED_SERIES_TIC_GRAND_TOTAL,
    FRED_SERIES_WALCL,
    FRED_SERIES_WLCFLPCL,
    FRED_SERIES_WRESBAL,
    FRED_SERIES_WSHOMCB,
    FRED_SERIES_WSHOSHO,
    FRED_SERIES_WSHOTSL,
    FRED_WALCL_YOY_LOOKBACK,
)

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MARKET_BALANCE_PATH = os.path.join(_REPO_ROOT, "seed_data", "silver_market_balance.json")
YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"
# Table 1 (Summary of Receipts, Outlays, and the Deficit/Surplus) republishes
# every month of BOTH the prior and current fiscal year on every monthly
# release — a real month's figure is identified by classification_desc
# (a month NAME, e.g. "June") plus which fiscal-year block it's in, not a
# real calendar-date field. Confirmed live (fed-spend-spec.md Story #0):
# sequence_number_cd prefix "1." = prior fiscal year (Oct-Sep), "2." =
# current fiscal year — record_fiscal_year itself is the REPORT's own FY on
# every row regardless of block, not a per-row distinguisher.



# Recoverable stock = Investment (coins/bars) + ETF/Exchange Vaults + Central
# Bank reserves only. Excludes industrial (unrecoverable) and jewelry/silverware
# (partially recoverable, illiquid) per SPEC.MD's Open Questions resolution.
RECOVERABLE_STOCK_LOW_OZ = 12_500_000_000
RECOVERABLE_STOCK_HIGH_OZ = 17_000_000_000


_refresh_tasks: list[asyncio.Task] = []


# Stage 2 (api-split-implementation-plan.md Story 2.1): the collection side
# (_backfill_if_needed / _schedule_loop / the two one-shot tier refreshes) is
# meant to move to its own process (backend/collector.py, `python -m
# backend.collector`), independent of uvicorn/FastAPI. This flag controls
# whether the api process ALSO starts that collection work in-process —
# defaults to true so a bare `uvicorn backend.main:app` (single-process local
# dev, and every existing docker-compose service before Story 2.2 adds a
# dedicated `collector` service) keeps today's behavior unchanged. Once
# Story 2.2 lands `collector` as its own compose service, that service sets
# RUN_COLLECTOR_IN_PROCESS=false on `api` so the two don't double-fire the
# same sources. `_client` itself is always created here regardless of this
# flag — api's own on-demand routes (POST /api/refresh/force, POST
# /api/health/refresh/{key}, research chat) need it even when the collector
# runs as a separate process with its own client.
RUN_COLLECTOR_IN_PROCESS = os.environ.get("RUN_COLLECTOR_IN_PROCESS", "true").strip().lower() not in ("false", "0")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    stack_db.init_db()
    collector._interval_overrides.update(db.get_interval_overrides())
    _persisted_refresh_enabled = db.get_refresh_enabled()
    if _persisted_refresh_enabled is not None:
        collector._refresh_settings["slow_enabled"] = _persisted_refresh_enabled
    collector._client = httpx.AsyncClient()
    if RUN_COLLECTOR_IN_PROCESS:
        asyncio.create_task(collector._backfill_if_needed())
        asyncio.create_task(collector._refresh_fast_tier())
        asyncio.create_task(collector._refresh_slow_tier())
        _refresh_tasks.append(asyncio.create_task(collector._schedule_loop()))
    yield
    for t in _refresh_tasks:
        t.cancel()
    await collector._client.aclose()










app = FastAPI(lifespan=lifespan)

_cors_allowed_origins_env = os.environ.get("CORS_ALLOWED_ORIGINS", "").strip()
CORS_ALLOWED_ORIGINS = (
    [o.strip() for o in _cors_allowed_origins_env.split(",") if o.strip()]
    if _cors_allowed_origins_env
    else ["http://localhost:5173"]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)

# api-split-implementation-plan.md Story 3.1: every route below is declared
# on this one router with its path relative to /api (e.g. "/silver/db/history"),
# then mounted twice below (after every route is registered) — once at
# /api/v1 (the real, versioned path going forward) and once at bare /api (a
# temporary alias so the frontend's migration to /api/v1 doesn't have to land
# in the same change as this one). Remove the bare /api include_router call,
# and this comment, once the frontend is confirmed on /api/v1 everywhere and
# CLAUDE.md's deprecation-policy window (Story 3.3) has passed.
api_router = APIRouter()




@api_router.get("/silver/db/history")
async def silver_db_history():
    rows = db.get_aggregate_history()
    return {"success": True, "data": rows}




@api_router.get("/silver/db/depositories")
async def silver_db_depositories(date: str | None = Query(None)):
    rows = db.get_depositories_on_date(date) if date else db.get_latest_depositories()
    return {"success": True, "data": rows}


@api_router.get("/silver/db/depositories/history")
async def silver_db_depositories_history():
    rows = db.get_depository_history()
    return {"success": True, "data": rows}




@api_router.get("/silver/db/leverage")
async def silver_db_leverage():
    row = db.get_latest_leverage("XAG")
    if row is None:
        return {"success": True, "data": []}
    enriched = {
        "date": row["date"],
        "openInterest": row["open_interest"] / SILVER_CONTRACT_OZ if row["open_interest"] else None,
        "volume": row["volume"],
        "paper_leverage": row["paper_leverage"],
    }
    return {"success": True, "data": [enriched]}


@api_router.get("/silver/db/leverage/history")
async def silver_db_leverage_history():
    rows = db.get_leverage_history("XAG")
    return {
        "success": True,
        "data": [
            {
                "date": r["date"],
                "openInterest": r["open_interest"] / SILVER_CONTRACT_OZ if r["open_interest"] else None,
                "volume": r["volume"],
                "paper_leverage": r["paper_leverage"],
            }
            for r in rows
        ],
    }


@api_router.get("/volume/db/history")
async def volume_db_history(metal: str = Query("XAG")):
    rows = db.get_volume_series(metal)
    return {"success": True, "data": rows}




@api_router.get("/gold/db/history")
async def gold_db_history():
    rows = db.get_gold_aggregate_history()
    return {"success": True, "data": rows}




@api_router.get("/gold/db/depositories")
async def gold_db_depositories(date: str | None = Query(None)):
    rows = db.get_gold_depositories_on_date(date) if date else db.get_latest_gold_depositories()
    return {"success": True, "data": rows}


@api_router.get("/gold/db/depositories/history")
async def gold_db_depositories_history():
    rows = db.get_gold_depository_history()
    return {"success": True, "data": rows}




@api_router.get("/gold/db/leverage")
async def gold_db_leverage():
    row = db.get_latest_leverage("XAU")
    if row is None:
        return {"success": True, "data": []}
    enriched = {
        "date": row["date"],
        "openInterest": row["open_interest"] / GOLD_CONTRACT_OZ if row["open_interest"] else None,
        "volume": row["volume"],
        "paper_leverage": row["paper_leverage"],
    }
    return {"success": True, "data": [enriched]}


@api_router.get("/gold/db/leverage/history")
async def gold_db_leverage_history():
    rows = db.get_leverage_history("XAU")
    return {
        "success": True,
        "data": [
            {
                "date": r["date"],
                "openInterest": r["open_interest"] / GOLD_CONTRACT_OZ if r["open_interest"] else None,
                "volume": r["volume"],
                "paper_leverage": r["paper_leverage"],
            }
            for r in rows
        ],
    }




@api_router.get("/silver/db/delivery")
async def silver_db_delivery(type: str = Query("mtd")):
    rows = db.get_delivery_history(type)
    return {"success": True, "data": rows}




@api_router.get("/gold/db/delivery")
async def gold_db_delivery(type: str = Query("mtd")):
    rows = db.get_gold_delivery_history(type)
    return {"success": True, "data": rows}




@api_router.get("/shfe/db/history")
async def shfe_db_history():
    rows = db.get_shfe_history()
    return {"success": True, "data": rows}


# Mirrors _fetch_and_persist_shfe_history — confirmed live 2026-07-24 that
# metalcharts.org's SHFE endpoint fully supports symbol=AU (19 real days
# checked, same {date, total} shape as silver). Unlike the COMEX delivery-
# notices/registered-eligible gap, SHFE gold has no confirmed data-
# availability blocker — this was purely unbuilt, not unavailable.


@api_router.get("/shfe/gold/db/history")
async def shfe_gold_db_history():
    rows = db.get_shfe_gold_history()
    return {"success": True, "data": rows}




@api_router.get("/shfe/db/warehouses")
async def shfe_db_warehouses():
    rows = db.get_latest_shfe_warehouses()
    enriched = [
        {
            **r,
            "warrant_oz": round(r["warrant_kg"] * TROY_OZ_PER_KG, 0) if r["warrant_kg"] else None,
            "warrant_change_oz": round(r["warrant_change_kg"] * TROY_OZ_PER_KG, 0) if r["warrant_change_kg"] else None,
        }
        for r in rows
    ]
    return {"success": True, "data": enriched}


@api_router.get("/shfe/db/warehouses/history")
async def shfe_db_warehouses_history():
    rows = db.get_shfe_warehouse_history()
    enriched = [
        {
            **r,
            "warrant_oz": round(r["warrant_kg"] * TROY_OZ_PER_KG, 0) if r["warrant_kg"] else None,
        }
        for r in rows
    ]
    return {"success": True, "data": enriched}




@api_router.get("/shfe/gold/db/warehouses")
async def shfe_gold_db_warehouses():
    rows = db.get_latest_shfe_gold_warehouses()
    enriched = [
        {
            **r,
            "warrant_oz": round(r["warrant_kg"] * TROY_OZ_PER_KG, 0) if r["warrant_kg"] else None,
            "warrant_change_oz": round(r["warrant_change_kg"] * TROY_OZ_PER_KG, 0) if r["warrant_change_kg"] else None,
        }
        for r in rows
    ]
    return {"success": True, "data": enriched}


@api_router.get("/shfe/gold/db/warehouses/history")
async def shfe_gold_db_warehouses_history():
    rows = db.get_shfe_gold_warehouse_history()
    enriched = [
        {
            **r,
            "warrant_oz": round(r["warrant_kg"] * TROY_OZ_PER_KG, 0) if r["warrant_kg"] else None,
        }
        for r in rows
    ]
    return {"success": True, "data": enriched}




@api_router.get("/pslv/db")
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


@api_router.get("/silver/market-balance")
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


@api_router.get("/delivery-behavior/db")
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






def _cot_gsr_series(gold_spot: dict, silver_spot: dict) -> list[dict]:
    common_dates = sorted(set(gold_spot) & set(silver_spot))
    series = []
    for d in common_dates:
        g = gold_spot[d]
        s = silver_spot[d]
        if s and s > 0:
            series.append({"date": d, "gsr": round(g / s, 1)})
    return series


@api_router.get("/cot/db", response_model=models.CotDbResponse)
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


@api_router.get("/prices")
async def prices():
    try:
        return await collector._fetch_and_persist_prices()
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@api_router.get("/prices/db")
async def prices_db():
    latest = db.get_latest_spot_prices()
    data = {
        series_id: {"price": row["price"], "changePercent24h": row["change_pct_24h"], "date": row["date"]}
        for series_id, row in latest.items()
    }
    return {"success": True, "data": data}


@api_router.get("/prices/db/ticks")
async def prices_db_ticks(
    series_id: str = Query("XAG"),
    hours: int = Query(24),
    since: str | None = Query(None),
    until: str | None = Query(None),
):
    """Price history for the CoT tab's per-metal price range chart.
    Stitches two resolutions (see db.get_price_backfill): real 60s
    spot_price ticks where they exist (only from whenever the fast-tier
    refresh loop started running), then settlement_price's real Yahoo
    daily closes further back — so long windows show real, if coarser,
    history instead of a gap before the tick table existed.

    `since`/`until` (ISO datetime strings) are the real range-picker
    params and take precedence when given; `hours` is kept as a
    backward-compatible lookback-from-now shorthand for any caller that
    doesn't pass an explicit `since`. `until` is optional even when
    `since` is given — omitting it means "through now", matching the
    original hours-only behavior."""
    effective_since = since or (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    rows = db.get_price_backfill(series_id, effective_since, until)
    return {"success": True, "data": rows}




@api_router.get("/lbma/db")
async def lbma_db(metal: str = Query("XAU")):
    rows = db.get_latest_settlement_price(LBMA_BY_METAL[metal])
    return {"success": True, "data": rows}


@api_router.get("/lbma/db/history")
async def lbma_db_history(metal: str = Query("XAU"), fix_type: str = Query(None)):
    resolved_session = fix_type or LBMA_SESSION_BY_METAL.get(metal, "daily")
    rows = db.get_settlement_price_series(LBMA_BY_METAL[metal], session=resolved_session)
    return {"success": True, "data": rows}




@api_router.get("/curve-spread/db")
async def curve_spread_db(metal: str = Query("XAG")):
    rows = db.get_curve_spread_series(metal)
    return {"success": True, "data": rows}


@api_router.get("/squeeze-cases/db")
async def squeeze_cases_db():
    rows = db.get_squeeze_cases()
    return {"success": True, "data": rows}






@api_router.get("/census-trade/db")
async def census_trade_db(
    metal: str = Query("XAG"),
    flow: str = Query(None),
    hs_code: str = Query(None),
):
    rows = db.get_census_trade(metal, flow=flow, hs_code=hs_code)
    return {"success": True, "data": rows}




@api_router.get("/ofac/db", response_model=models.OfacListResponse)
async def ofac_designations_db(
    since: str = Query(None),
    until: str = Query(None),
    program: str = Query(None),
    list_source: str = Query(None),
):
    rows = db.get_ofac_designations(since=since, until=until, program=program, list_source=list_source)
    return {"success": True, "data": rows}


@api_router.get("/ofac/{ofac_uid}/db", response_model=models.OfacDetailResponse)
async def ofac_designation_detail_db(ofac_uid: str):
    designation = db.get_ofac_designation(ofac_uid)
    if designation is None:
        raise HTTPException(404, f"No OFAC designation found for uid {ofac_uid}")
    return {
        "success": True,
        "data": {
            **designation,
            "aliases": db.get_ofac_aliases(ofac_uid),
            "addresses": db.get_ofac_addresses(ofac_uid),
            "id_documents": db.get_ofac_id_documents(ofac_uid),
        },
    }




@api_router.get("/treasury-outlays-by-agency/db")
async def treasury_outlays_by_agency_db(
    window: str = Query("5y"),
    start: str | None = Query(None),
    end: str | None = Query(None),
):
    if window == "custom" and start:
        since = start
    else:
        years = FRED_WINDOW_YEARS.get(window, 5)
        since = str(date.today() - timedelta(days=365 * years))
    rows = db.get_treasury_outlays_by_agency(since=since)
    if end is not None:
        rows = [r for r in rows if r["date"] <= end]
    return {"success": True, "data": rows}


@api_router.get("/treasury-outlays/db")
async def treasury_outlays_db(
    window: str = Query("5y"),
    start: str | None = Query(None),
    end: str | None = Query(None),
):
    if window == "custom" and start:
        since = start
    else:
        years = FRED_WINDOW_YEARS.get(window, 5)
        since = str(date.today() - timedelta(days=365 * years))
    rows = db.get_treasury_outlays(since=since)
    # Same end-trim convention as /api/fred/money-supply/db — get_treasury_outlays
    # has no upper bound of its own, so this route trims client-side-of-the-route.
    if end is not None:
        rows = [r for r in rows if r["date"] <= end]
    return {"success": True, "data": rows}


@api_router.get("/treasury-auctions/db")
async def treasury_auctions_db(security_type: str | None = Query(None)):
    """No window param, unlike the other Treasury routes above — real
    persisted history is deliberately bounded to a rolling
    TREASURY_AUCTIONS_WINDOW_DAYS trailing window (see the fetch function's
    own docstring), not multi-year, so a window selector implying more
    history exists than does would be misleading. Returns whatever's
    actually on disk. security_type ('Bill'/'Note'/'Bond'/'TIPS'/'FRN')
    lets the frontend chart each security type on its own axis/series,
    since bid-to-cover and yield scales aren't comparable across types."""
    return {"success": True, "data": db.get_treasury_auctions(security_type=security_type)}


@api_router.get("/refresh/settings")
async def refresh_settings_get():
    return {"success": True, "data": collector._refresh_settings}


@api_router.post("/refresh/settings")
async def refresh_settings_post(body: dict = Body(...)):
    """slow_enabled is now the only persisted setting here — each slow-tier
    source owns its own real interval_seconds (see each SourceDefinition's
    cadence), so there's no longer a shared slow interval to accept. Persisted
    to ui_settings.refresh_enabled so the choice survives a restart, unlike
    fast_interval_s/fast_enabled, which stay in-memory-only (spot prices'
    tunable interval was never the thing going stale between restarts)."""
    if "fast_interval_s" in body:
        collector._refresh_settings["fast_interval_s"] = max(5, int(body["fast_interval_s"]))
    if "fast_enabled" in body:
        collector._refresh_settings["fast_enabled"] = bool(body["fast_enabled"])
    if "slow_enabled" in body:
        collector._refresh_settings["slow_enabled"] = bool(body["slow_enabled"])
        db.set_refresh_enabled(collector._refresh_settings["slow_enabled"])
    return {"success": True, "data": collector._refresh_settings}


_VALID_NAV_SECTIONS = {"cot", "moneySupply", "inventory", "catcor", "research", "stack", "sanctions"}
# NB: "data" was removed when the Data tab moved into the Settings view (a
# sibling of activeSection, not a nav section) — Settings is deliberately
# not a pinnable default-landing tab. This set MUST stay in lockstep with
# frontend/src/App.jsx's SECTIONS array; tests/test_conventions.py's
# test_nav_sections_match_backend_allowlist fails the suite on drift.

# Env vars AV actually reads (Settings' read-only Configuration status
# panel). Never exposes the value — presence only. `used_by` is derived
# from each source's requires_env at request time, not hand-maintained.
_CONFIG_ENV_VARS = ["FRED_API_KEY", "GAPI_API_KEY", "CENSUS_API_KEY", "ANTHROPIC_API_KEY", "AI_BACKEND"]


@api_router.get("/ui/pinned-section")
async def ui_pinned_section_get():
    return {"success": True, "data": {"pinned_section": db.get_pinned_section()}}


@api_router.post("/ui/pinned-section")
async def ui_pinned_section_post(body: dict = Body(...)):
    section = body.get("section")
    if section is not None and section not in _VALID_NAV_SECTIONS:
        raise HTTPException(400, f"section must be one of {sorted(_VALID_NAV_SECTIONS)} or null")
    db.set_pinned_section(section)
    return {"success": True, "data": {"pinned_section": section}}


@api_router.get("/config/status")
async def config_status():
    """Read-only presence check for the env vars AV uses — Settings'
    Configuration status panel. Reports set/not-set only, never the value.
    AI_BACKEND is not a secret and its effective value is meaningful to
    show, so it reports `value` too; every real key reports presence only.
    `used_by` lists the source keys that declare the var in requires_env,
    derived live from sources.SOURCE_REGISTRY rather than hand-duplicated."""
    used_by: dict[str, list[str]] = {}
    for src_key, src in sources.SOURCE_REGISTRY.items():
        for env_var in src.requires_env:
            used_by.setdefault(env_var, []).append(src_key)
    rows = []
    for var in _CONFIG_ENV_VARS:
        raw = os.environ.get(var)
        row = {
            "key": var,
            "set": bool(raw),
            "used_by": sorted(used_by.get(var, [])),
        }
        if var == "AI_BACKEND":
            # Non-secret; the effective backend (explicit or default) is
            # the useful thing to surface, matching catcor_research.py's
            # own `os.environ.get("AI_BACKEND", "forge")` default.
            row["value"] = raw or "forge"
        rows.append(row)
    return {"success": True, "data": rows}


@api_router.post("/refresh/force")
async def refresh_force():
    fast_result = await collector._refresh_fast_tier()
    slow_result = await collector._refresh_slow_tier()
    total_failed = fast_result["failed"] + slow_result["failed"]
    total_succeeded = fast_result["succeeded"] + slow_result["succeeded"]
    return {
        "success": total_failed == 0,
        "fast": fast_result,
        "slow": slow_result,
        "succeeded": total_succeeded,
        "failed": total_failed,
    }




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


@api_router.get("/fred/money-supply/refresh")
async def fred_money_supply_refresh():
    """Thin route wrapper — the real fetch logic lives in
    backend.collector._fetch_and_persist_money_supply (moved there in
    api-split-implementation-plan.md Story 2.1, since it's also this
    source's registered fetch_fn, dispatched by the scheduler). Matches
    every other fetch_fn/route pairing in this file — this route used to
    BE both the fetch function and the route handler in one; now it's
    consistent with the ~40 other sources that keep those as two separate
    functions."""
    return await collector._fetch_and_persist_money_supply()


FRED_WINDOW_YEARS = {"2y": 2, "5y": 5, "10y": 10, "20y": 20}


def _resample_month_end(daily_rows: list[dict]) -> list[dict]:
    """Reduce {'date','price'} daily rows to one row per calendar month —
    the last trading day on or before that month's end. Yahoo's own `1mo`
    interval bucket includes the current in-progress month, which isn't a
    true month-end close, so this resamples from real daily data instead.
    Now a pure read-time helper (price-architecture-spec.md) — the write
    path persists real daily closes only; Money Supply's purchasing-power
    chart, which wants monthly granularity, resamples at request time via
    db.get_settlement_price_by_month instead of a separately-fetched/
    separately-stored monthly series."""
    by_month: dict[str, dict] = {}
    for row in daily_rows:
        month_key = row["date"][:7]  # YYYY-MM
        by_month[month_key] = row  # rows arrive in chronological order, so last write wins
    return [by_month[k] for k in sorted(by_month)]




@api_router.get("/metals/prices/refresh")
async def metals_prices_refresh():
    """Thin route wrapper — see fred_money_supply_refresh's docstring
    above for why this now delegates to collector.py instead of being the
    fetch function itself."""
    return await collector._fetch_and_persist_metals_prices()


@api_router.get("/metals/prices/db/daily-range")
async def metals_prices_db_daily_range(metal: str = Query("XAG"), since: str = Query("2020-01-01")):
    """Real daily high/low/close for the Paper Games leverage chart's
    day-range price series (see db.get_daily_price_range) — reads
    settlement_price's real Yahoo daily bars, no new fetch."""
    rows = db.get_daily_price_range(metal, since)
    return {"success": True, "data": rows}




# Canonical registry population (datasources-spec.md Story #1 + #3) now
# lives in backend/collector.py's register_sources() — moved there
# 2026-09-17 after a real bug was found and fixed: this block only ran as a
# module-level side effect of importing backend.main, which
# `python -m backend.collector` (the whole point of Story 2.1 — collector
# runs standalone, with no FastAPI/main.py import) never does. Confirmed
# live: sources.SOURCE_REGISTRY was empty inside a real running Test AV
# collector container, silently making every fetch loop iterate zero
# sources — every source froze at its pre-split value with zero errors
# anywhere. See register_sources()'s own docstring in collector.py for the
# full incident writeup. api still needs the same registry populated in its
# own process (for /api/health/db, /api/data-sources/db, POST
# /api/health/refresh/{key}, POST /api/refresh/force — all read
# sources.SOURCE_REGISTRY), so it calls the same function here.
collector.register_sources()


@api_router.get("/health/db")
async def health_db():
    rows = {r["source_key"]: dict(r) for r in db.get_all_source_health()}
    for source_key, row in rows.items():
        row.pop("source_key", None)
        source = sources.SOURCE_REGISTRY.get(source_key)
        if source is not None:
            row["expected_interval_s"] = source.cadence.expected_interval_s
            row["tier"] = source.tier
    if "cot_pipeline" in rows:
        rows["cot_pipeline"]["last_report_date"] = db.get_latest_cot_report_date()
    if "census_trade" in rows:
        rows["census_trade"]["last_period"] = db.get_latest_census_trade_period()
    return {"success": True, "sources": rows}


@api_router.get("/data-sources/db")
async def data_sources_db():
    """Thin serialization of sources.SOURCE_REGISTRY — affinity_group,
    cadence, rate_limit, requires_env, curl_example for every registered
    source. Read-only, no fetch triggered. Fetched once per Data-tab
    mount (not polled like /api/health/db) to feed SourceCard's cadence/
    rate-limit display and Story #6's per-source countdown; HeaderHealthDot
    does not need this route — its numeric threshold (expected_interval_s)
    already ships in /api/health/db's own enriched payload.

    Overlays any live _interval_overrides value onto cadence.interval_seconds
    (and re-derives expected_interval_s from it) before serializing, so a
    per-source override is reflected here immediately — the frontend's
    existing op.cadence.interval_seconds read picks it up for free, no
    new response shape needed."""
    result = {}
    for k, s in sources.SOURCE_REGISTRY.items():
        serialized = sources.serialize(s)
        override = collector._interval_overrides.get(k)
        if override is not None:
            serialized["cadence"]["interval_seconds"] = override
            serialized["cadence"]["expected_interval_s"] = override
        result[k] = serialized
    return {"success": True, "sources": result}


@api_router.post("/data-sources/{source_key}/interval")
async def set_source_interval(source_key: str, body: dict = Body(...)):
    """Per-source cadence override (the next value-add after folding
    startup sources into the scheduler — all 11 "slow tier" sources used
    to share one _refresh_settings["slow_interval_s"] value, baked into
    each SourceDefinition once at registry-build time; POST
    /api/refresh/settings mutating that value afterward was already a
    no-op for already-registered sources, a real pre-existing bug this
    override mechanism fixes as a side effect, since _schedule_loop now
    checks _interval_overrides before falling back to the baked-in
    default either way). Only trigger="interval" sources are eligible —
    rejects always_on (protects catcor_snapshot: a missed reaction-
    capture window is permanent data loss, must never become skippable/
    slowable by a stray override) and manual_only (overriding a cadence
    that's never on a recurring timer in the first place is meaningless)."""
    source = sources.SOURCE_REGISTRY.get(source_key)
    if source is None:
        raise HTTPException(404, f"Unknown source_key: {source_key}")
    if source.cadence.trigger != "interval":
        raise HTTPException(400, f"{source_key} is not an interval-triggered source — cannot override its cadence.")
    try:
        interval_seconds = int(body["interval_seconds"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "interval_seconds (integer, seconds) is required")
    if interval_seconds < 1:
        raise HTTPException(400, "interval_seconds must be positive")
    collector._interval_overrides[source_key] = interval_seconds
    db.set_interval_override(source_key, interval_seconds)
    return {"success": True, "interval_seconds": interval_seconds}


@api_router.post("/health/refresh/{source_key}")
async def health_refresh(source_key: str):
    source = sources.SOURCE_REGISTRY.get(source_key)
    if source is None:
        raise HTTPException(404, f"Unknown source_key: {source_key}")
    try:
        await source.fetch_fn()
        if not source.self_recording:
            db.record_fetch_attempt(source_key, success=True)
        return {"success": True, "error": None}
    except Exception as e:
        if not source.self_recording:
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


@api_router.get("/metals/prices/db")
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

    # Real daily closes, resampled to month-end at read time (per
    # price-architecture-spec.md — the write path no longer bakes monthly
    # resampling into a separately-fetched series). {"date","price"} ->
    # {"date","value"} to match _resample_month_end/_index_to_100's shape.
    xag_daily = [
        {"date": r["date"], "value": r["price"]}
        for r in db.get_settlement_price_series(YAHOO_DAILY_CLOSE_BY_METAL["XAG"])
        if r["price"] is not None and r["date"] >= since
    ]
    xau_daily = [
        {"date": r["date"], "value": r["price"]}
        for r in db.get_settlement_price_series(YAHOO_DAILY_CLOSE_BY_METAL["XAU"])
        if r["price"] is not None and r["date"] >= since
    ]
    xag_rows = _resample_month_end(xag_daily)
    xau_rows = _resample_month_end(xau_daily)
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


@api_router.get("/fred/money-supply/db")
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
    dgs2_all = _trim(db.get_fred_observations(FRED_SERIES_DGS2, since))
    dgs10_all = _trim(db.get_fred_observations(FRED_SERIES_DGS10, since))
    dfii10_all = _trim(db.get_fred_observations(FRED_SERIES_DFII10, since))
    t10y2y_all = _trim(db.get_fred_observations(FRED_SERIES_T10Y2Y, since))
    dgs3mo_all = _trim(db.get_fred_observations(FRED_SERIES_DGS3MO, since))
    dgs5_all = _trim(db.get_fred_observations(FRED_SERIES_DGS5, since))
    dgs30_all = _trim(db.get_fred_observations(FRED_SERIES_DGS30, since))
    # SOMA's own Treasury holdings — same millions-native FRED convention as
    # WSHOTSL/WSHOMCB/WLCFLPCL (confirmed live, real values in the millions
    # of USD range), so it goes through the same _millions_to_trillions
    # conversion as those three, not the yields' passthrough.
    wshosho_all = _trim(db.get_fred_observations(FRED_SERIES_WSHOSHO, since))
    # Foreign/TIC holdings — also millions of USD (confirmed live), same
    # conversion. Keyed by country NAME (not series_id) in the response,
    # since that's what the frontend chart legend actually needs — the
    # series_id is an internal FRED/TIC implementation detail the frontend
    # has no reason to know about.
    tic_by_country = {
        country: _millions_to_trillions(_trim(db.get_fred_observations(series_id, since)))
        for country, series_id in FRED_SERIES_TIC_COUNTRIES.items()
    }
    tic_grand_total = _millions_to_trillions(_trim(db.get_fred_observations(FRED_SERIES_TIC_GRAND_TOTAL, since)))

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
            # Treasury Yields sub-panel — already % units, no divisor needed
            # (unlike the Composition series' millions/billions split above).
            "dgs2": dgs2_all,
            "dgs10": dgs10_all,
            "dfii10": dfii10_all,
            "t10y2y": t10y2y_all,
            # Added to round out the yield curve beyond 2yr/10yr/real-10yr/
            # spread — see pipeline/config.py's own comment on why DGS3MO
            # (not DTB3) was chosen for the 3-month point.
            "dgs3mo": dgs3mo_all,
            "dgs5": dgs5_all,
            "dgs30": dgs30_all,
            # SOMA Treasury holdings — a subset of wshotsl's own total (the
            # Fed's System Open Market Account specifically), not a
            # duplicate figure. Same trillions conversion as wshotsl/wshomcb.
            "wshosho": _millions_to_trillions(wshosho_all),
            # Foreign/TIC holdings of long-term U.S. Treasuries, by country.
            # IMPORTANT: this family EXCLUDES T-bills — tic_grand_total is
            # real but meaningfully smaller than Treasury's own bills-
            # inclusive Major Foreign Holders total (confirmed live, ~$7.92T
            # vs ~$9.37T same month) — see FRED_SERIES_TIC_COUNTRIES' own
            # comment in pipeline/config.py. Never compare/sum this against
            # a non-FRED "grand total" from a different source. "Cayman
            # Islands" is a real SUBSET of "Total Caribbean" (confirmed live,
            # not a duplicate) — summing both into one total double-counts.
            "tic_countries": tic_by_country,
            "tic_grand_total": tic_grand_total,
        },
    }


@api_router.get("/catcor/events/db")
async def catcor_events_db(limit: int = Query(20)):
    return {"success": True, "data": db.get_upcoming_events(limit=limit)}


@api_router.get("/catcor/reactions/db")
async def catcor_reactions_db():
    return {"success": True, "data": db.get_event_reaction_series()}


@api_router.post("/catcor/refresh")
async def catcor_refresh():
    """Deliberately NOT a call to sources.SOURCE_REGISTRY["catcor_startup"].fetch_fn()
    (i.e. _catcor_startup) — the two have genuinely incompatible contracts,
    not incidental duplication. _catcor_startup is best-effort (every step
    after the first independently try/excepted, never raises past its own
    boundary, returns nothing) since it's meant to run unattended on a
    schedule; this route is the frontend's manual "force CATCOR refresh"
    action and needs fail-fast semantics (abort + surface the real error
    on first failure) plus a real {seeded, consensus, actuals} return
    payload for its caller to display. The 6 underlying catcor.* calls
    are intentionally the same sequence as catcor_startup's — that's not
    accidental drift, it's the same real steps captured by both a
    best-effort scheduled path and a fail-fast manual path."""
    if "FRED_API_KEY" not in os.environ:
        raise HTTPException(500, "FRED_API_KEY environment variable is not set")
    try:
        n_seeded = catcor.seed_events()
        await catcor.backfill_intraday_ticks(collector._client)
        await collector._fetch_and_persist_yahoo_daily_close()
        consensus_result = await catcor.fetch_and_persist_consensus(collector._client)
        actuals_result = await catcor.fetch_and_persist_actuals(collector._client)
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


@api_router.post("/catcor/research/sessions")
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
        result = await catcor_research.send_message(collector._client, session_id, claim_text, **turn_kwargs)
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    return {"success": True, "data": {"session_id": session_id, **result}}


@api_router.get("/catcor/research/evidence/db")
async def catcor_research_evidence_dump():
    """Every evidence tool's exact output, no Anthropic call involved — all
    four tools are zero-argument reads of AV's own state, so this just runs
    them directly. Lets you see exactly what data Claude has access to
    before/without holding a conversation, at zero cost."""
    return {"success": True, "data": catcor_research.dump_all_evidence()}


@api_router.get("/catcor/research/personas")
async def catcor_research_list_personas():
    """Backs spec 3.2's dynamically-populated persona dropdown — reflects
    whatever's actually in backend/prompts/ right now, no registration step."""
    return {"success": True, "data": catcor_research.list_personas()}


@api_router.post("/catcor/research/sessions/{session_id}/preview")
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


@api_router.get("/catcor/research/sessions/db")
async def catcor_research_list_sessions():
    return {"success": True, "data": catcor_research.list_sessions()}


@api_router.get("/catcor/research/sessions/{session_id}/db")
async def catcor_research_get_session(session_id: str):
    detail = catcor_research.get_session_detail(session_id)
    if detail is None:
        raise HTTPException(404, f"No research session with id {session_id}")
    return {"success": True, "data": detail}


@api_router.post("/catcor/research/sessions/{session_id}/messages")
async def catcor_research_send_message(session_id: str, body: dict = Body(...)):
    content = body.get("content")
    if not content:
        raise HTTPException(400, "content is required")
    if catcor_research.get_session_detail(session_id) is None:
        raise HTTPException(404, f"No research session with id {session_id}")
    turn_kwargs = _turn_kwargs_from_body(body)
    _require_backend_credentials(turn_kwargs["backend"])
    try:
        result = await catcor_research.send_message(collector._client, session_id, content, **turn_kwargs)
    except ValueError as e:
        raise HTTPException(409, str(e))
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    return {"success": True, "data": result}


@api_router.post("/catcor/research/sessions/{session_id}/read")
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


@api_router.post("/catcor/research/sessions/{session_id}/promote")
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


@api_router.delete("/catcor/events/{event_id}")
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


@api_router.post("/catcor/research/sessions/{session_id}/dismiss")
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


@api_router.post("/catcor/research/sessions/{session_id}/discard")
async def catcor_research_discard(session_id: str):
    if catcor_research.get_session_detail(session_id) is None:
        raise HTTPException(404, f"No research session with id {session_id}")
    try:
        catcor_research.discard_session(session_id)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"success": True, "data": None}


@api_router.get("/catcor/research/forge-sessions")
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


# --- Stack Tracker (specs/stackTracker-spec.md) ----------------------------
# Personal CRUD inventory of physical holdings, backed entirely by
# runtime/stack.db + runtime/stack_images/ — never argentvigil.db. Only the
# GET .../db routes are upstream-shaped reads (there is no upstream here,
# they're user-owned data reads); the mutating routes are plain user CRUD,
# covered by tests/test_conventions.py's ALLOWED_NON_DB_API "/api/stack/"
# entry rather than persist-on-fetch's /db convention, since that
# convention is specifically about never letting the frontend see raw
# upstream data — Stack Tracker has no upstream to guard against.


@api_router.get("/stack/items/db", response_model=models.StackItemsListResponse)
async def stack_items_db():
    return {"success": True, "data": stack.list_items_with_valuation()}


@api_router.get("/stack/items/{item_id}/db", response_model=models.StackItemDetailResponse)
async def stack_item_detail_db(item_id: int):
    item = stack.get_item(item_id)
    if item is None:
        raise HTTPException(404, f"No stack item with id {item_id}")
    item.update(stack.compute_valuation(item))
    item["images"] = stack.list_images(item_id)
    item["reference_links"] = stack.list_links(item_id)
    return {"success": True, "data": item}


@api_router.get("/stack/summary/db", response_model=models.StackSummaryResponse)
async def stack_summary_db():
    return {"success": True, "data": stack.portfolio_summary()}


@api_router.get("/stack/series-summary/db", response_model=models.StackSeriesSummaryResponse)
async def stack_series_summary_db():
    return {"success": True, "data": stack.series_summary()}


@api_router.get("/stack/date-summary/db", response_model=models.StackDateSummaryResponse)
async def stack_date_summary_db():
    return {"success": True, "data": stack.date_summary()}


@api_router.get("/stack/timeseries/db", response_model=models.StackTimeseriesResponse)
async def stack_timeseries_db():
    return {"success": True, "data": stack.timeseries()}


@api_router.get("/stack/value-history/db", response_model=models.StackValueHistoryResponse)
async def stack_value_history_db(
    series: list[str] = Query(None),
    metal: str = Query(None),
    form: str = Query(None),
    date_from: str = Query(None),
    date_to: str = Query(None),
):
    """Real weekly melt-value-vs-cost-basis history (from real historical
    daily closes, not today's spot applied backward) — the Stack tab's
    Cost-basis chart. `series` is a repeatable query param
    (?series=A&series=B) scoping to those series-keys; `metal`
    ("silver"|"gold"), `form` ("coin"|"bar"|"round"|"other"), and
    `date_from`/`date_to` (ISO date strings, inclusive) mirror the tab's
    metal/form/date filters. All omitted = the whole dated stack."""
    return {
        "success": True,
        "data": stack.value_history(series=series, metal=metal, form=form, date_from=date_from, date_to=date_to),
    }


@api_router.post("/stack/items", response_model=models.StackCreateResponse)
async def stack_items_create(body: dict = Body(...)):
    item_id = stack.create_item(body)
    return {"success": True, "data": {"id": item_id}}


@api_router.post("/stack/items/bulk", response_model=models.StackBulkCreateResponse)
async def stack_items_create_bulk(body: dict = Body(...)):
    ids = stack.create_bulk(body)
    return {"success": True, "data": {"ids": ids, "lot_id": stack.get_item(ids[0])["lot_id"]}}


@api_router.put("/stack/items/{item_id}", response_model=models.StackNullDataResponse)
async def stack_items_update(item_id: int, body: dict = Body(...)):
    stack.update_item(item_id, body)
    return {"success": True, "data": None}


@api_router.post("/stack/items/bulk-update", response_model=models.StackBulkUpdateResponse)
async def stack_items_bulk_update(body: dict = Body(...)):
    """Group update — applies a focused field subset (series/mint_year/
    metal/unit_weight_oz/grading fields) to a caller-selected set of item
    ids, e.g. tagging all 12 rows from one order as '2013 Canadian Maple
    Leaf' at once. See stack.bulk_update_items for why this only touches
    the fields actually present in the request body, unlike the full-
    replace PUT /items/{id} route above."""
    item_ids = body.get("item_ids") or []
    fields = body.get("fields") or {}
    updated = stack.bulk_update_items(item_ids, fields)
    return {"success": True, "data": {"updated": updated}}


@api_router.delete("/stack/items/{item_id}", response_model=models.StackNullDataResponse)
async def stack_items_delete(item_id: int):
    stack.delete_item(item_id)
    return {"success": True, "data": None}


@api_router.post("/stack/items/{item_id}/photos", response_model=models.StackPhotoUploadResponse)
async def stack_photos_upload(item_id: int, file: UploadFile = File(...), caption: str | None = Form(None)):
    photo = await stack.add_photo(item_id, file, caption)
    return {"success": True, "data": photo}


@api_router.delete("/stack/photos/{photo_id}", response_model=models.StackNullDataResponse)
async def stack_photos_delete(photo_id: int):
    stack.delete_photo(photo_id)
    return {"success": True, "data": None}


@api_router.post("/stack/photos/{photo_id}/copy-to", response_model=models.StackPhotoCopyResponse)
async def stack_photos_copy_to(photo_id: int, body: dict = Body(...)):
    """Copies one existing photo onto a caller-selected set of other
    items — e.g. one shared box-shot photographed once and applied to all
    21 rows of a bulk lot, instead of re-uploading it 21 times. Each
    target gets its own real file copy + stack_item_images row (see
    stack.copy_photo_to_items) so every item's photo lifecycle stays
    independent — deleting one item's copy never removes another's."""
    item_ids = body.get("item_ids") or []
    result = stack.copy_photo_to_items(photo_id, item_ids)
    return {"success": True, "data": result}


@api_router.post("/stack/items/{item_id}/links", response_model=models.StackLinkCreateResponse)
async def stack_links_create(item_id: int, body: dict = Body(...)):
    link_id = stack.add_link(item_id, body.get("url"), body.get("label"))
    return {"success": True, "data": {"id": link_id}}


@api_router.delete("/stack/links/{link_id}", response_model=models.StackNullDataResponse)
async def stack_links_delete(link_id: int):
    stack.delete_link(link_id)
    return {"success": True, "data": None}


# api-split-implementation-plan.md Story 3.1: mount every route above at the
# real, versioned prefix, plus a temporary bare /api alias (see the comment
# by api_router's construction for the removal condition).
app.include_router(api_router, prefix="/api/v1")
app.include_router(api_router, prefix="/api")

# Photos served straight back by relative path — a LAN-only tool, no signed
# URLs needed.
os.makedirs(stack_db.IMAGES_ROOT, exist_ok=True)
app.mount("/stack_images", StaticFiles(directory=stack_db.IMAGES_ROOT), name="stack_images")

# No frontend-dist StaticFiles mount here (api-split-implementation-plan.md
# Story 1.5) — the frontend now lives entirely behind its own origin (Vite
# dev server locally, nginx in the containerized deploy per Story 1.3/1.4).
# api:8000/ has no route for "/" anymore; hitting it directly returns a 404,
# which is expected and correct.
