"""SQLite persistence semantics against a real (tmp) database — the
append-only-vs-upsert convention, the leverage as-of join, and
implied_qty_oz's computed-at-read-time derivation (CLAUDE.md:
Cross-cutting data conventions)."""

from helpers import cot_row

from backend.units import SILVER_CONTRACT_OZ


# --- Append-only vs. upsert: decided by "does the upstream revise?" ------


def test_cot_rows_are_append_only_never_overwritten(tmp_db):
    """CFTC never revises a published report — INSERT OR IGNORE keyed by
    report_date must keep the first-persisted row forever."""
    tmp_db.insert_silver_rows([cot_row("2026-07-14", oi=124065)])
    tmp_db.insert_silver_rows([cot_row("2026-07-14", oi=999999)])  # imposter
    series = tmp_db.get_silver_series()
    assert len(series) == 1
    assert series[0]["open_interest"] == 124065


def test_spot_price_ticks_are_append_only(tmp_db):
    ts = "2026-07-20T12:00:00+00:00"
    tmp_db.append_spot_price_ticks([{"instrument": "XAG_SPOT", "ts": ts, "price": 39.5, "change_pct_24h": None}])
    tmp_db.append_spot_price_ticks([{"instrument": "XAG_SPOT", "ts": ts, "price": 40.0, "change_pct_24h": None}])
    rows = tmp_db.get_spot_price_ticks_since("XAG_SPOT", "2026-07-20T00:00:00+00:00")
    assert len(rows) == 1
    assert rows[0]["price"] == 39.5


def test_spot_and_futures_front_instruments_never_collide(tmp_db):
    """price-architecture-spec.md's whole reason for a closed instrument
    enum: XAG_SPOT (metalcharts.org) and XAG_FUTURES_FRONT (Yahoo SI=F) are
    a genuinely different instrument sharing a metal code — they must never
    merge into one series, the exact sawtooth bug this schema exists to
    make structurally impossible."""
    ts = "2026-07-20T12:00:00+00:00"
    tmp_db.append_spot_price_ticks([{"instrument": "XAG_SPOT", "ts": ts, "price": 39.5, "change_pct_24h": None}])
    tmp_db.append_spot_price_ticks([{"instrument": "XAG_FUTURES_FRONT", "ts": ts, "price": 39.9, "change_pct_24h": None}])
    spot = tmp_db.get_spot_price_ticks_since("XAG_SPOT", "2026-07-20T00:00:00+00:00")
    futures = tmp_db.get_spot_price_ticks_since("XAG_FUTURES_FRONT", "2026-07-20T00:00:00+00:00")
    assert [r["price"] for r in spot] == [39.5]
    assert [r["price"] for r in futures] == [39.9]


def test_price_backfill_stitches_ticks_over_daily_closes(tmp_db):
    """get_price_backfill's two-tier stitch (replaces the old 3-tier
    get_price_history): real spot_price ticks take priority over
    settlement_price's daily closes for any date the tick table already
    covers; daily closes fill in strictly older dates only, never
    double-covering a date the tick tier already has."""
    tmp_db.upsert_settlement_price_rows("XAG_YAHOO_DAILY_CLOSE", [
        {"date": "2026-07-18", "price": 39.0},
        {"date": "2026-07-19", "price": 39.3},
    ])
    tmp_db.append_spot_price_ticks([
        {"instrument": "XAG_SPOT", "ts": "2026-07-19T12:00:00+00:00", "price": 39.6, "change_pct_24h": None},
    ])
    rows = tmp_db.get_price_backfill("XAG", "2026-07-01T00:00:00+00:00")
    assert [r["ts"] for r in rows] == ["2026-07-18", "2026-07-19T12:00:00+00:00"]
    assert [r["price"] for r in rows] == [39.0, 39.6]


def _census_row(**overrides) -> dict:
    row = {
        "metal": "XAG",
        "flow": "import",
        "hs_code": "7106",
        "cty_code": "1220",
        "cty_name": "CANADA",
        "year": 2026,
        "month": 4,
        "value_general_usd": 1_000_000,
        "value_consumption_usd": 900_000,
        "qty": None,
        "qty_unit": None,
    }
    row.update(overrides)
    return row


def test_census_trade_upserts_revisions(tmp_db):
    """Census revises annually — same PK with a new value must replace the
    old one (upsert), not be silently ignored."""
    tmp_db.upsert_census_trade_rows([_census_row()])
    tmp_db.upsert_census_trade_rows([_census_row(value_general_usd=1_100_000)])
    rows = tmp_db.get_census_trade("XAG")
    assert len(rows) == 1
    assert rows[0]["value_general_usd"] == 1_100_000


def test_settlement_price_upserts_revisions(tmp_db):
    row = {"date": "2026-07-17", "session": "daily", "price": 39.1}
    tmp_db.upsert_settlement_price_rows("XAG_LBMA", [row])
    tmp_db.upsert_settlement_price_rows("XAG_LBMA", [{**row, "price": 39.2}])
    rows = tmp_db.get_latest_settlement_price("XAG_LBMA")
    assert len(rows) == 1
    assert rows[0]["price"] == 39.2


def test_settlement_price_upsert_skips_unchanged_rows(tmp_db):
    """price-architecture-spec.md's Q3 resolution: re-upserting an
    unchanged (date, session) must not touch fetched_at — otherwise a
    routine cadence tick would rewrite years of unchanged history on every
    call."""
    row = {"date": "2026-07-17", "session": "daily", "price": 39.1}
    tmp_db.upsert_settlement_price_rows("XAG_LBMA", [row])
    with tmp_db.get_conn() as conn:
        first_fetched_at = conn.execute(
            "SELECT fetched_at FROM settlement_price WHERE instrument = 'XAG_LBMA'"
        ).fetchone()["fetched_at"]
    tmp_db.upsert_settlement_price_rows("XAG_LBMA", [row])  # identical price
    with tmp_db.get_conn() as conn:
        second_fetched_at = conn.execute(
            "SELECT fetched_at FROM settlement_price WHERE instrument = 'XAG_LBMA'"
        ).fetchone()["fetched_at"]
    assert first_fetched_at == second_fetched_at


# --- Leverage: CFTC-only, as-of registered join --------------------------


def test_leverage_join_uses_registered_on_or_before_report_date(tmp_db):
    """The as-of lookup variant of the nearest-date convention: a CoT
    Tuesday with no same-day registered reading joins against the nearest
    registered date on or before it — never a later one."""
    tmp_db.upsert_aggregate_rows([
        {"date": "2026-07-10", "total": 300e6, "registered": 100e6, "eligible": 200e6, "reg_eligible_ratio": 0.5},
        {"date": "2026-07-15", "total": 300e6, "registered": 50e6, "eligible": 250e6, "reg_eligible_ratio": 0.2},
    ])
    tmp_db.insert_silver_rows([cot_row("2026-07-14", oi=124065)])

    history = tmp_db.get_leverage_history("XAG")
    assert len(history) == 1
    row = history[0]
    # Joined against 2026-07-10's registered (on/before 07-14), not 07-15's.
    expected = (124065 * SILVER_CONTRACT_OZ) / 100e6
    assert row["paper_leverage"] == expected
    assert row["open_interest"] == 124065 * SILVER_CONTRACT_OZ
    # CFTC has no volume field — always None in this series by design.
    assert row["volume"] is None


def test_leverage_join_skips_cot_dates_before_any_registered_reading(tmp_db):
    """Real backfill ceiling is set by registered coverage (silver:
    2020-01-02 upstream) — a CoT row older than the first registered
    reading produces no leverage row rather than a fabricated one."""
    tmp_db.upsert_aggregate_rows([
        {"date": "2026-07-10", "total": 300e6, "registered": 100e6, "eligible": 200e6, "reg_eligible_ratio": 0.5},
    ])
    tmp_db.insert_silver_rows([cot_row("2019-06-04", oi=200000), cot_row("2026-07-14", oi=124065)])
    history = tmp_db.get_leverage_history("XAG")
    assert [r["date"] for r in history] == ["2026-07-14"]


# --- implied_qty_oz: computed at read time, never stored ------------------


def test_implied_qty_oz_derived_from_monthly_close(tmp_db):
    tmp_db.upsert_settlement_price_rows("XAG_YAHOO_DAILY_CLOSE", [{"date": "2026-04-30", "price": 40.0}])
    tmp_db.upsert_census_trade_rows([_census_row(year=2026, month=4, value_general_usd=400_000)])
    rows = tmp_db.get_census_trade("XAG")
    assert rows[0]["implied_qty_oz"] == 10_000.0


def test_implied_qty_oz_null_when_month_spot_missing(tmp_db):
    """Never manufacture a reading: no month-end close for that month means
    NULL, not 0 and not a neighboring month's price."""
    tmp_db.upsert_settlement_price_rows("XAG_YAHOO_DAILY_CLOSE", [{"date": "2026-03-31", "price": 38.0}])
    tmp_db.upsert_census_trade_rows([_census_row(year=2026, month=4)])
    rows = tmp_db.get_census_trade("XAG")
    assert rows[0]["implied_qty_oz"] is None


def test_implied_qty_oz_never_persisted(tmp_db):
    """The derived field must not exist as a census_trade column — it's a
    read-time computation (a formula fix must never require a migration)."""
    with tmp_db.get_conn() as conn:
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(census_trade)")]
    assert "implied_qty_oz" not in cols
