import asyncio
import os
from contextlib import asynccontextmanager
from datetime import date

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import db
from mc_token import authed_headers

METALCHARTS = "https://metalcharts.org"

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


# Serve built frontend; keep last so API routes take priority
try:
    app.mount("/", StaticFiles(directory="frontend/dist", html=True), name="static")
except Exception:
    pass
