"""Upstream failure modes and response quirks, replayed against mocked
transports (respx) — no live API is ever called here. Each test pins a
behavior CLAUDE.md documents as confirmed-live: the weekend spot-skip,
Census's 204-means-unpublished, GoldAPI's silent weekend carry-forward,
Yahoo's 429 retry margin, and curve spread's two front/next ranking bugs."""

import asyncio
from datetime import date

import httpx
import pytest
import respx
from helpers import make_fake_date, yahoo_chart_payload

from backend import main as main_module
from backend.catcor import _parse_forexfactory_number


async def _no_headers(_client):
    return {}


async def _no_sleep(_seconds):
    return None


PRICES_URL = f"{main_module.METALCHARTS}/api/prices"


def _prices_payload(is_stale: bool) -> dict:
    return {
        "isStale": is_stale,
        "cacheAge": 7200,
        "data": {
            "XAG": {"price": 39.5, "changePercent24h": 1.2},
            "XAU": {"price": 3350.0, "changePercent24h": 0.4},
        },
    }


# --- Spot prices: weekend persist-skip (Standing rules) -------------------


async def test_stale_spot_feed_on_weekend_is_not_persisted(tmp_db, upstream_client, monkeypatch):
    monkeypatch.setattr(main_module, "authed_headers", _no_headers)
    monkeypatch.setattr(main_module, "date", make_fake_date(date(2026, 7, 18)))  # Saturday
    with respx.mock:
        respx.get(PRICES_URL).mock(return_value=httpx.Response(200, json=_prices_payload(True)))
        await main_module._fetch_and_persist_prices()
    assert tmp_db.get_latest_spot_prices() == {}


async def test_stale_spot_feed_on_weekday_is_persisted_anyway(tmp_db, upstream_client, monkeypatch):
    """Confirmed live: isStale can fire on a weekday with cacheAge in the
    months (stuck upstream, not a market closure) — skipping would silently
    flatline the chart forever, so a stuck weekday feed must surface."""
    monkeypatch.setattr(main_module, "authed_headers", _no_headers)
    monkeypatch.setattr(main_module, "date", make_fake_date(date(2026, 7, 20)))  # Monday
    with respx.mock:
        respx.get(PRICES_URL).mock(return_value=httpx.Response(200, json=_prices_payload(True)))
        await main_module._fetch_and_persist_prices()
    latest = tmp_db.get_latest_spot_prices()
    assert latest["XAG"]["price"] == 39.5
    assert latest["XAU"]["price"] == 3350.0


async def test_fresh_spot_feed_on_weekend_is_persisted(tmp_db, upstream_client, monkeypatch):
    """The skip needs BOTH conditions — a genuinely fresh weekend response
    (isStale false) still persists."""
    monkeypatch.setattr(main_module, "authed_headers", _no_headers)
    monkeypatch.setattr(main_module, "date", make_fake_date(date(2026, 7, 18)))  # Saturday
    with respx.mock:
        respx.get(PRICES_URL).mock(return_value=httpx.Response(200, json=_prices_payload(False)))
        await main_module._fetch_and_persist_prices()
    assert tmp_db.get_latest_spot_prices()["XAG"]["price"] == 39.5


# --- Census: 204-means-unpublished + qty sentinel -> NULL -----------------


def _census_callback(request: httpx.Request) -> httpx.Response:
    params = dict(request.url.params)
    month = params["time"]
    # Real publication lag: current + prior month unpublished -> 204 empty.
    if month in ("2026-07", "2026-06"):
        return httpx.Response(204)
    fields = params["get"].split(",")
    row = []
    for f in fields:
        if f == "CTY_CODE":
            row.append("1220")
        elif f == "CTY_NAME":
            row.append("CANADA")
        elif f == "UNIT_QY1":
            row.append("-")  # Census's not-applicable sentinel
        elif "QY1" in f or f == "QTY_1_MO":
            row.append("0")  # confirmed-live: always "0" for HS 7106/7108
        else:
            row.append("123456")  # any value field
    return httpx.Response(200, json=[fields, row])


async def test_census_skips_unpublished_months_and_nulls_qty(tmp_db, upstream_client, monkeypatch):
    monkeypatch.setenv("CENSUS_API_KEY", "test-key")
    monkeypatch.setattr(main_module, "date", make_fake_date(date(2026, 7, 20)))
    with respx.mock:
        respx.get(url__startswith=main_module.CENSUS_TRADE_BASE).mock(side_effect=_census_callback)
        await main_module._fetch_and_persist_census_trade()

    rows = tmp_db.get_census_trade("XAG", flow="import")
    months = {(r["year"], r["month"]) for r in rows}
    # 5-month window minus the two unpublished -> 2026-03/04/05 land.
    assert months == {(2026, 3), (2026, 4), (2026, 5)}
    for r in rows:
        assert r["value_general_usd"] == 123456
        # Nulls over zeros: the "0"/"-" sentinel pair persists as NULL.
        assert r["qty"] is None
        assert r["qty_unit"] is None


# --- LBMA fix: weekend walk-back BEFORE calling GoldAPI -------------------


async def test_lbma_weekend_fetch_walks_back_to_friday(tmp_db, upstream_client, monkeypatch):
    """The real latent bug (CLAUDE.md, Tab: CoT): GoldAPI silently returns
    Friday's fix for a weekend date instead of erroring, so the fetch date
    must be walked back to a weekday before the call ever goes out."""
    monkeypatch.setenv("GAPI_API_KEY", "test-key")
    monkeypatch.setattr(main_module, "date", make_fake_date(date(2026, 7, 19)))  # Sunday
    requested_dates: list[str] = []

    def _goldapi_callback(request: httpx.Request) -> httpx.Response:
        requested_dates.append(request.url.path.rsplit("/", 1)[-1])
        return httpx.Response(200, json={"price": 3350.25, "currency": "USD"})

    with respx.mock:
        respx.get(url__startswith=main_module.GOLDAPI_BASE).mock(side_effect=_goldapi_callback)
        await main_module._fetch_and_persist_lbma_fix()

    # Every outbound request asked for Friday 2026-07-17 — never the weekend.
    assert requested_dates and all(d == "20260717" for d in requested_dates)
    for instrument in (main_module.LBMA_BY_METAL["XAU"], main_module.LBMA_BY_METAL["XAG"]):
        rows = tmp_db.get_latest_settlement_price(instrument)
        assert rows and rows[0]["date"] == "2026-07-17"


# --- Yahoo chart API: 429 retry margin + 404-means-no-data ----------------


async def test_yahoo_daily_retries_once_on_429_then_succeeds(upstream_client, monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", _no_sleep)
    payload = yahoo_chart_payload({"2026-07-15": (30.0, 1000)})
    with respx.mock:
        respx.get(url__startswith=main_module.YAHOO_CHART_BASE).mock(
            side_effect=[httpx.Response(429), httpx.Response(200, json=payload)]
        )
        bars = await main_module._fetch_yahoo_contract_daily("SIU26.CMX", days=370)
    assert bars == {"2026-07-15": (30.0, 1000)}


async def test_yahoo_daily_raises_after_second_429(upstream_client, monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", _no_sleep)
    with respx.mock:
        respx.get(url__startswith=main_module.YAHOO_CHART_BASE).mock(
            side_effect=[httpx.Response(429), httpx.Response(429)]
        )
        with pytest.raises(httpx.HTTPStatusError):
            await main_module._fetch_yahoo_contract_daily("SIU26.CMX", days=370)


async def test_yahoo_daily_404_means_no_data_not_retry(upstream_client):
    with respx.mock:
        route = respx.get(url__startswith=main_module.YAHOO_CHART_BASE).mock(
            return_value=httpx.Response(404)
        )
        bars = await main_module._fetch_yahoo_contract_daily("SIQ99.CMX", days=370)
    assert bars == {}
    assert route.call_count == 1


# --- Yahoo daily close: consolidated fetcher writes settlement_price -----


async def test_yahoo_daily_close_fetcher_writes_settlement_price_both_metals(
    tmp_db, upstream_client
):
    """price-architecture-spec.md's Fetch consolidation: one fetch now
    serves what used to be three separate call sites (Money Supply's
    monthly close, CATCOR's 120-day daily fallback, the leverage panel's
    price chart) — confirms it persists real daily closes for both metals
    under the shared XAG_YAHOO_DAILY_CLOSE/XAU_YAHOO_DAILY_CLOSE instruments."""
    fixtures = {
        "SI=F": yahoo_chart_payload({"2026-07-17": (39.5, 1000), "2026-07-18": (39.8, 1200)}),
        "GC=F": yahoo_chart_payload({"2026-07-17": (3350.0, 500), "2026-07-18": (3360.0, 600)}),
    }

    def _yahoo_callback(request: httpx.Request) -> httpx.Response:
        ticker = request.url.path.rsplit("/", 1)[-1]
        return httpx.Response(200, json=fixtures[ticker])

    with respx.mock:
        respx.get(url__startswith=main_module.YAHOO_CHART_BASE).mock(side_effect=_yahoo_callback)
        await main_module._fetch_and_persist_yahoo_daily_close()

    xag_rows = tmp_db.get_settlement_price_series("XAG_YAHOO_DAILY_CLOSE")
    xau_rows = tmp_db.get_settlement_price_series("XAU_YAHOO_DAILY_CLOSE")
    assert [(r["date"], r["price"]) for r in xag_rows] == [("2026-07-17", 39.5), ("2026-07-18", 39.8)]
    assert [(r["date"], r["price"]) for r in xau_rows] == [("2026-07-17", 3350.0), ("2026-07-18", 3360.0)]


# --- Curve spread: per-date ranking + delivery-order enforcement ----------


def test_delivery_sort_key_parses_symbols():
    assert main_module._delivery_sort_key("SIN26.CMX") == (2026, 7)
    assert main_module._delivery_sort_key("SIZ25.CMX") == (2025, 12)
    assert main_module._delivery_sort_key("GCQ26.CMX") == (2026, 8)


async def test_curve_spread_next_must_be_strictly_later_delivery_month(
    tmp_db, upstream_client, monkeypatch
):
    """Bug 2's regression (CLAUDE.md, Squeeze Context): an expiring
    contract's residual volume (SIZ25, second-highest here) must never be
    picked as 'next' against a later front month — the highest-volume
    STRICTLY-LATER candidate (SIU26) wins instead, even at lower volume."""
    monkeypatch.setattr(asyncio, "sleep", _no_sleep)
    monkeypatch.setattr(main_module, "date", make_fake_date(date(2026, 7, 20)))
    fixtures = {
        "SIN26.CMX": yahoo_chart_payload({"2026-07-15": (30.0, 1000)}),   # front: top volume
        "SIZ25.CMX": yahoo_chart_payload({"2026-07-15": (29.0, 500)}),    # the Bug-2 trap: earlier month
        "SIU26.CMX": yahoo_chart_payload({"2026-07-15": (30.5, 200)}),    # real next: later month
    }

    def _yahoo_callback(request: httpx.Request) -> httpx.Response:
        ticker = request.url.path.rsplit("/", 1)[-1]
        if ticker in fixtures:
            return httpx.Response(200, json=fixtures[ticker])
        return httpx.Response(404)

    with respx.mock:
        respx.get(url__startswith=main_module.YAHOO_CHART_BASE).mock(side_effect=_yahoo_callback)
        await main_module._fetch_and_persist_curve_spread()

    rows = tmp_db.get_curve_spread_series("XAG")
    assert len(rows) == 1
    row = rows[0]
    assert row["front_month_symbol"] == "SIN26.CMX"
    assert row["next_month_symbol"] == "SIU26.CMX"  # NOT SIZ25.CMX
    assert row["curve_spread_pct"] == pytest.approx((30.5 - 30.0) / 30.0)
    assert tmp_db.get_curve_spread_series("XAU") == []


# --- ForexFactory: "K"-suffix unit scaling (real bug caught in build) -----


def test_forexfactory_nfp_k_suffix_scales_to_payems_thousands():
    # "114K" = 114,000 people = 114 in PAYEMS's native thousands.
    assert _parse_forexfactory_number("114K", event_type="NFP") == 114.0


def test_forexfactory_cpi_percent_strips_without_scaling():
    assert _parse_forexfactory_number("3.2%", event_type="CPI") == 3.2


def test_forexfactory_unparseable_returns_none():
    assert _parse_forexfactory_number("", event_type="NFP") is None
    assert _parse_forexfactory_number("abc", event_type="NFP") is None


# --- Treasury MTS: fiscal-year-block month reconstruction (fed-spend-spec.md Story #0) --


def _mts1_row(classification_desc, sequence_number_cd, record_fiscal_year, rcpt, outly, dfct):
    return {
        "classification_desc": classification_desc,
        "sequence_number_cd": sequence_number_cd,
        "record_fiscal_year": str(record_fiscal_year),
        "current_month_gross_rcpt_amt": str(rcpt) if rcpt is not None else "null",
        "current_month_gross_outly_amt": str(outly) if outly is not None else "null",
        "current_month_dfct_sur_amt": str(dfct) if dfct is not None else "null",
    }


def test_mts_fiscal_month_prior_year_block():
    # "1.x" on a report whose own record_fiscal_year is 2015 = prior FY,
    # i.e. FY2014 (Oct 2013 - Sep 2014) — confirmed live against the real
    # 2026-06-30 publication (report FY 2026, "1.1"="October" = FY2025 =
    # calendar 2024-10, since FY2025 is the block's own FY = report_fy - 1).
    # Scaled down to FY2015/FY2014 here for round test numbers.
    assert main_module._mts_fiscal_month_to_calendar("October", "1.1", "2015") == (2013, 10)
    assert main_module._mts_fiscal_month_to_calendar("December", "1.3", "2015") == (2013, 12)
    # January-September of FY2014 (still "1.x") are calendar 2014.
    assert main_module._mts_fiscal_month_to_calendar("January", "1.4", "2015") == (2014, 1)
    assert main_module._mts_fiscal_month_to_calendar("September", "1.12", "2015") == (2014, 9)


def test_mts_fiscal_month_current_year_block():
    # "2.x" = the report's own current FY (record_fiscal_year itself, no -1).
    assert main_module._mts_fiscal_month_to_calendar("October", "2.1", "2015") == (2014, 10)
    assert main_module._mts_fiscal_month_to_calendar("March", "2.6", "2015") == (2015, 3)


def test_mts_fiscal_month_unrecognized_classification_returns_none():
    # Table 1 also carries subtotal/label rows (e.g. "FY 2014", "Year-to-Date")
    # even under record_type_cd=MTH filtering in edge cases — anything that
    # isn't a real month name must be skipped, not silently mis-parsed.
    assert main_module._mts_fiscal_month_to_calendar("Year-to-Date", "1.13", "2015") is None
    assert main_module._mts_fiscal_month_to_calendar("FY 2014", "1.0", "2015") is None


def test_mts_amount_parses_null_sentinel_string_as_none():
    # MTS uses the literal string "null" (not JSON null) for an absent value.
    assert main_module._mts_amount("null") is None
    assert main_module._mts_amount(None) is None
    assert main_module._mts_amount("123.45") == 123.45


TREASURY_MTS_TABLE1_URL = f"{main_module.TREASURY_MTS_BASE}/mts_table_1"
TREASURY_MTS_TABLE5_URL = f"{main_module.TREASURY_MTS_BASE}/mts_table_5"


def _mts_table1_payload() -> dict:
    return {
        # "1.1"/report FY2015 -> prior FY2014 -> calendar 2013-10.
        # "2.1"/report FY2016 -> current FY2016 -> calendar 2015-10.
        "data": [
            _mts1_row("October", "1.1", "2015", 300e9, 580e9, 280e9),
            _mts1_row("Year-to-Date", "1.13", "2015", None, None, None),  # non-month row, must be skipped
            _mts1_row("October", "2.1", "2016", 320e9, 600e9, 280e9),
        ]
    }


def _mts_table5_payload() -> dict:
    return {
        "data": [
            {"record_date": "2013-10-31", "classification_desc": main_module.TREASURY_INTEREST_CLASSIFICATION, "current_month_net_outly_amt": "30000000000.0"},
            {"record_date": "2015-10-31", "classification_desc": main_module.TREASURY_INTEREST_CLASSIFICATION, "current_month_net_outly_amt": "32000000000.0"},
        ]
    }


async def test_treasury_outlays_merges_table1_and_table5_by_month(tmp_db, upstream_client):
    with respx.mock:
        respx.get(TREASURY_MTS_TABLE1_URL).mock(return_value=httpx.Response(200, json=_mts_table1_payload()))
        respx.get(TREASURY_MTS_TABLE5_URL).mock(return_value=httpx.Response(200, json=_mts_table5_payload()))
        n = await main_module._fetch_and_persist_treasury_outlays()

    # Table 1 contributed 2 real months (the Year-to-Date row was skipped);
    # both happen to already have a Table 5 interest match at the same
    # (year, month) via record_date, so no extra bare-interest-only rows.
    assert n == 2
    rows = tmp_db.get_treasury_outlays()
    by_month = {(r["year"], r["month"]): r for r in rows}
    assert (2013, 10) in by_month and (2015, 10) in by_month

    oct2013 = by_month[(2013, 10)]
    assert oct2013["receipts_usd"] == pytest.approx(300e9)
    assert oct2013["outlays_usd"] == pytest.approx(580e9)
    assert oct2013["deficit_usd"] == pytest.approx(280e9)
    assert oct2013["interest_usd"] == pytest.approx(30e9)
    assert oct2013["date"] == "2013-10-01"

    oct2015 = by_month[(2015, 10)]
    assert oct2015["receipts_usd"] == pytest.approx(320e9)
    assert oct2015["interest_usd"] == pytest.approx(32e9)


async def test_treasury_outlays_upsert_overwrites_prior_publication(tmp_db, upstream_client):
    """MTS restates a month on every later release — a second fetch's value
    for an already-persisted (year, month) must win, matching census_trade's
    upsert convention (later publication is more current, not append-only)."""
    with respx.mock:
        respx.get(TREASURY_MTS_TABLE1_URL).mock(return_value=httpx.Response(200, json=_mts_table1_payload()))
        respx.get(TREASURY_MTS_TABLE5_URL).mock(return_value=httpx.Response(200, json=_mts_table5_payload()))
        await main_module._fetch_and_persist_treasury_outlays()

    revised_payload = {"data": [_mts1_row("October", "1.1", "2015", 999e9, 580e9, 280e9)]}
    with respx.mock:
        respx.get(TREASURY_MTS_TABLE1_URL).mock(return_value=httpx.Response(200, json=revised_payload))
        respx.get(TREASURY_MTS_TABLE5_URL).mock(return_value=httpx.Response(200, json={"data": []}))
        await main_module._fetch_and_persist_treasury_outlays()

    rows = {(r["year"], r["month"]): r for r in tmp_db.get_treasury_outlays()}
    assert rows[(2013, 10)]["receipts_usd"] == pytest.approx(999e9)
    # interest_usd came from the FIRST fetch only (the second fetch's Table 5
    # response was empty) — the merge-forward-against-existing logic must
    # preserve that previously-persisted real value rather than nulling it
    # out just because this particular fetch's Table 5 response omitted it.
    assert rows[(2013, 10)]["interest_usd"] == pytest.approx(30e9)


# --- Treasury MTS: per-agency breakdown (fed-spend-spec.md Story #0 Tier 2) --


def _mts5_agency_payload(record_date: str, agencies: dict[str, float]) -> dict:
    """Real-shaped Table 5 response for one record_date: each agency gets a
    level-1 'C' header row (null value) plus a direct child 'Total--<agency>'
    'C' row carrying the real figure — same parent_id/classification_id
    linkage confirmed live."""
    data = []
    next_id = 1
    for agency, amount in agencies.items():
        header_id = str(next_id)
        total_id = str(next_id + 1)
        next_id += 2
        data.append({
            "record_date": record_date, "parent_id": "0", "classification_id": header_id,
            "classification_desc": f"{agency}:", "record_type_cd": "C", "sequence_level_nbr": "1",
            "current_month_net_outly_amt": "null",
        })
        data.append({
            "record_date": record_date, "parent_id": header_id, "classification_id": total_id,
            "classification_desc": f"Total--{agency}", "record_type_cd": "C", "sequence_level_nbr": "2",
            "current_month_net_outly_amt": str(amount),
        })
    # A non-"C" / non-department-total child row, to confirm it's correctly
    # ignored rather than mistaken for the real total.
    data.append({
        "record_date": record_date, "parent_id": "1", "classification_id": "999",
        "classification_desc": "Some Bureau:", "record_type_cd": "B", "sequence_level_nbr": "2",
        "current_month_net_outly_amt": "999999.0",
    })
    return {"data": data}


async def test_treasury_outlays_by_agency_extracts_department_totals(tmp_db, upstream_client):
    # treasury_outlays_by_agency depends on treasury_outlays already having
    # persisted the real (year, month) set — seed it directly rather than
    # re-fetching Table 1.
    tmp_db.upsert_treasury_outlays_rows([
        {"year": 2026, "month": 6, "receipts_usd": 1.0, "outlays_usd": 2.0, "deficit_usd": 1.0, "interest_usd": None},
    ])
    payload = _mts5_agency_payload("2026-06-30", {
        "Department of Defense--Military Programs": 78329784246.77,
        "Social Security Administration": 152111028019.48,
    })
    with respx.mock:
        respx.get(TREASURY_MTS_TABLE5_URL).mock(return_value=httpx.Response(200, json=payload))
        n = await main_module._fetch_and_persist_treasury_outlays_by_agency()

    assert n == 2
    rows = {r["agency"]: r for r in tmp_db.get_treasury_outlays_by_agency()}
    assert rows["Department of Defense--Military Programs"]["outlay_usd"] == pytest.approx(78329784246.77)
    assert rows["Social Security Administration"]["outlay_usd"] == pytest.approx(152111028019.48)
    # The stray Bureau-level ("B") row must not leak in as a fake "agency".
    assert "Some Bureau" not in rows


async def test_treasury_outlays_by_agency_skips_already_persisted_months(tmp_db, upstream_client):
    """Bounded-window fetch must not re-request a month it already has —
    real cost control against ~1 request/month with no documented upstream
    rate limit."""
    tmp_db.upsert_treasury_outlays_rows([
        {"year": 2026, "month": 6, "receipts_usd": 1.0, "outlays_usd": 2.0, "deficit_usd": 1.0, "interest_usd": None},
    ])
    tmp_db.upsert_treasury_outlays_by_agency_rows([
        {"year": 2026, "month": 6, "agency": "Department of Justice", "outlay_usd": 111.0},
    ])
    call_count = 0

    def _callback(request):
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json=_mts5_agency_payload("2026-06-30", {"Department of Justice": 999.0}))

    with respx.mock:
        respx.get(url__startswith=TREASURY_MTS_TABLE5_URL).mock(side_effect=_callback)
        n = await main_module._fetch_and_persist_treasury_outlays_by_agency()

    assert call_count == 0
    assert n == 0
    rows = tmp_db.get_treasury_outlays_by_agency()
    assert rows[0]["outlay_usd"] == pytest.approx(111.0)  # untouched, not overwritten with 999
