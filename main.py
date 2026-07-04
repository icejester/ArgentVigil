import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

load_dotenv()

import db
from mc_token import authed_headers
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

METALCHARTS = "https://metalcharts.org"
MARKET_BALANCE_PATH = "silver_market_balance.json"
FRED_BASE = "https://api.stlouisfed.org/fred/series/observations"
YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"
METAL_PRICE_TICKERS = {XAG_SERIES_ID: XAG_TICKER, XAU_SERIES_ID: XAU_TICKER}

# Recoverable stock = Investment (coins/bars) + ETF/Exchange Vaults + Central
# Bank reserves only. Excludes industrial (unrecoverable) and jewelry/silverware
# (partially recoverable, illiquid) per SPEC.MD's Open Questions resolution.
RECOVERABLE_STOCK_LOW_OZ = 12_500_000_000
RECOVERABLE_STOCK_HIGH_OZ = 17_000_000_000

_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _client
    db.init_db()
    _client = httpx.AsyncClient()
    asyncio.create_task(_backfill_if_needed())
    yield
    await _client.aclose()


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


@app.get("/api/silver/history")
async def silver_history(range: str = Query("ALL")):
    try:
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
        return {"success": True, "data": rows}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/silver/db/history")
async def silver_db_history():
    rows = db.get_aggregate_history()
    return {"success": True, "data": rows}


@app.get("/api/silver/depositories")
async def silver_depositories():
    try:
        hdrs = await authed_headers(_client)
        resp = await _client.get(
            f"{METALCHARTS}/api/comex/inventory",
            params={"symbol": "XAG", "type": "depositories"},
            headers=hdrs,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        raw = data.get("data", [])
        today = str(date.today())
        rows = [
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
        db.upsert_depository_rows(rows)
        return {"success": True, "data": raw}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/silver/leverage")
async def silver_leverage():
    try:
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
        # data is a single object, not an array
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
        return {"success": True, "data": [enriched], "raw": raw}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/gold/history")
async def gold_history(range: str = Query("ALL")):
    try:
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
        return {"success": True, "data": rows}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/gold/db/history")
async def gold_db_history():
    rows = db.get_gold_aggregate_history()
    return {"success": True, "data": rows}


@app.get("/api/gold/depositories")
async def gold_depositories():
    try:
        hdrs = await authed_headers(_client)
        resp = await _client.get(
            f"{METALCHARTS}/api/comex/inventory",
            params={"symbol": "XAU", "type": "depositories"},
            headers=hdrs,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        raw = data.get("data", [])
        today = str(date.today())
        rows = [
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
        db.upsert_gold_depository_rows(rows)
        return {"success": True, "data": raw}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/gold/leverage")
async def gold_leverage():
    try:
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
        # data is a single object, not an array
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
        return {"success": True, "data": [enriched], "raw": raw}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/silver/delivery")
async def silver_delivery(type: str = Query("mtd")):
    try:
        hdrs = await authed_headers(_client)
        resp = await _client.get(
            f"{METALCHARTS}/api/comex/delivery-notices",
            params={"symbol": "XAG", "type": type},
            headers=hdrs,
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/shfe/history")
async def shfe_history(range: str = Query("ALL")):
    try:
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
        return {"success": True, "data": rows}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/shfe/warehouses")
async def shfe_warehouses():
    try:
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
        # Convert kg to oz for each warehouse
        enriched = []
        for r in rows:
            kg = r.get("warrant", 0)
            chg_kg = r.get("warrantChange", 0)
            enriched.append({
                **r,
                "warrant_oz": round(kg * 32.1507, 0) if kg else None,
                "warrant_change_oz": round(chg_kg * 32.1507, 0) if chg_kg else None,
            })
        return {"success": True, "data": enriched}
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/pslv")
async def pslv():
    try:
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
        return {
            "success": True,
            "fund": "PSLV",
            "custodian": "Royal Canadian Mint",
            "location": "Ottawa, Canada",
            "date": row.get("dateTimeStamp", "")[:10],
            "total_oz": row["totalOunces1"],
            "nav_per_unit": row["nav"],
            "total_nav": row["totalNav"],
            "units": row["units"],
        }
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


@app.get("/api/shfe/db/history")
async def shfe_db_history():
    rows = db.get_shfe_history()
    return {"success": True, "data": rows}


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


@app.get("/api/prices")
async def prices():
    try:
        hdrs = await authed_headers(_client)
        resp = await _client.get(
            f"{METALCHARTS}/api/prices",
            headers=hdrs,
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e))


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


# Serve built frontend; keep last so API routes take priority
try:
    app.mount("/", StaticFiles(directory="frontend/dist", html=True), name="static")
except Exception:
    pass
