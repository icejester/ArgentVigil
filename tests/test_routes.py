"""/db read routes against a seeded tmp database — response shapes, unit
round-trips, and the custom-window YoY regression. No lifespan, no
upstream calls (see conftest.client)."""

from helpers import cot_row, monthly_fred_rows

from backend.units import SILVER_CONTRACT_OZ


async def test_cot_db_empty_database_returns_clean_500(client):
    resp = await client.get("/api/cot/db")
    assert resp.status_code == 500
    assert "pipeline" in resp.json()["detail"]


async def test_silver_leverage_route_round_trips_contracts(tmp_db, client):
    tmp_db.upsert_aggregate_rows([
        {"date": "2026-07-14", "total": 300e6, "registered": 95_000_000, "eligible": 205e6, "reg_eligible_ratio": 0.46},
    ])
    tmp_db.insert_silver_rows([cot_row("2026-07-14", oi=124065)])

    resp = await client.get("/api/silver/db/leverage")
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    row = body["data"][0]
    # Stored in oz, served back in contracts — the SILVER_CONTRACT_OZ
    # round-trip must be lossless.
    assert row["openInterest"] == 124065
    assert row["paper_leverage"] == (124065 * SILVER_CONTRACT_OZ) / 95_000_000
    assert row["date"] == "2026-07-14"


async def test_census_trade_route_includes_implied_qty_oz(tmp_db, client):
    tmp_db.upsert_fred_observations("XAG_CLOSE", [{"date": "2026-04-30", "value": 40.0}])
    tmp_db.upsert_census_trade_rows([{
        "metal": "XAG", "flow": "import", "hs_code": "7106",
        "cty_code": "-", "cty_name": "TOTAL FOR ALL COUNTRIES",
        "year": 2026, "month": 4,
        "value_general_usd": 400_000, "value_consumption_usd": None,
        "qty": None, "qty_unit": None,
    }])
    resp = await client.get("/api/census-trade/db?metal=XAG")
    assert resp.status_code == 200
    row = resp.json()["data"][0]
    assert row["implied_qty_oz"] == 10_000.0
    assert row["qty"] is None  # confirmed-live upstream gap stays NULL


async def test_health_db_ships_derived_interval_and_tier(tmp_db, client):
    """/api/health/db stays a thin read of source_health plus two fields
    derived at read time from the registry (expected_interval_s, tier) —
    the frontend computes status, the backend ships the threshold."""
    tmp_db.record_fetch_attempt("spot_prices", success=True)
    resp = await client.get("/api/health/db")
    assert resp.status_code == 200
    spot = resp.json()["sources"]["spot_prices"]
    assert spot["tier"] == "fast"
    assert isinstance(spot["expected_interval_s"], int)
    assert spot["last_attempt_status"] == "success"


async def test_money_supply_custom_window_yoy_regression(tmp_db, client):
    """The real bug the user caught ('no M2 YoY stats earlier than 2021?'):
    the custom branch originally fetched from `start` with zero lookback,
    so _compute_yoy had no trailing 12 months and every custom-range YoY
    was null. Guard: with 2 years of pre-start data seeded, YoY must be
    real from the very first row of the custom window."""
    tmp_db.upsert_fred_observations(
        "M2SL", monthly_fred_rows("2005-01", months=72, start_value=6000, step=25)
    )
    resp = await client.get(
        "/api/fred/money-supply/db",
        params={"window": "custom", "start": "2007-01-01", "end": "2010-12-31"},
    )
    assert resp.status_code == 200
    m2 = resp.json()["data"]["m2"]
    assert m2, "custom window returned no M2 rows"
    # Window bounds respected: nothing before start, nothing after end.
    assert m2[0]["date"] == "2007-01-01"
    assert all("2007-01-01" <= r["date"] <= "2010-12-31" for r in m2)
    # The regression itself: YoY real from row one of the window.
    assert m2[0]["yoy"] is not None
    assert all(r["yoy"] is not None for r in m2)
