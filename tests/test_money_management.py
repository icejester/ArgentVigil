"""Money Management tab (money-management-spec.md): FDIC registry mapping +
paginated sync, FOMC rotation math, governance seed/drift check, the three
read routes, and the CATCOR/Research nav merge. No live upstreams — respx
synthetic fixtures shaped like the real responses confirmed 2026-09-23."""

import httpx
import pytest
import respx

from backend import collector, db, fed_structure

# --- FDIC mapping ------------------------------------------------------------

def _fdic(cert, name="Test Bank", fed="01", active=1, bkclass="SM", **kw):
    row = {"CERT": cert, "NAME": name, "FED": fed, "ACTIVE": active, "BKCLASS": bkclass,
           "REGAGNT": "FED", "FED_RSSD": str(1000 + cert), "CITY": "Sanford", "STALP": "ME",
           "ENDEFYMD": "12/31/9999" if active else "07/01/1981"}
    row.update(kw)
    return row


def test_map_fdic_row_active_member():
    r = fed_structure.map_fdic_row(_fdic(10, fed="08", NAMEHCR="ARVEST BANK GROUP INC", RSSDHCR="1095674"), "t")
    assert r["cert"] == 10 and r["fed_district"] == 8 and r["active"] == 1
    assert r["inactive_date"] is None  # 9999 sentinel never persisted
    assert r["holding_company"] == "ARVEST BANK GROUP INC"


def test_map_fdic_row_inactive_gets_real_end_date():
    r = fed_structure.map_fdic_row(_fdic(11, active=0), "t")
    assert r["active"] == 0 and r["inactive_date"] == "1981-07-01"


@pytest.mark.parametrize("fed", [None, "", "00", "13", "xx"])
def test_map_fdic_row_bad_district_is_null_never_zero(fed):
    assert fed_structure.map_fdic_row(_fdic(12, fed=fed), "t")["fed_district"] is None


def test_map_fdic_row_without_cert_or_name_is_skipped():
    assert fed_structure.map_fdic_row({"NAME": "x"}, "t") is None
    assert fed_structure.map_fdic_row({"CERT": 1, "NAME": "  "}, "t") is None


def test_fed_member_is_derived_at_read_time(tmp_db):
    db.upsert_bank_registry([
        fed_structure.map_fdic_row(_fdic(1, name="Alpha National", bkclass="N"), "t"),
        fed_structure.map_fdic_row(_fdic(2, name="Alpha State Member", bkclass="SM"), "t"),
        fed_structure.map_fdic_row(_fdic(3, name="Alpha Nonmember", bkclass="NM"), "t"),
        fed_structure.map_fdic_row(_fdic(4, name="Alpha Unknown", bkclass=None), "t"),
    ])
    by_name = {b["name"]: b for b in db.search_bank_registry("Alpha")}
    assert by_name["Alpha National"]["fed_member"] is True
    assert by_name["Alpha State Member"]["fed_member"] is True
    assert by_name["Alpha Nonmember"]["fed_member"] is False
    assert by_name["Alpha Unknown"]["fed_member"] is None
    with db.get_conn() as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(bank_registry)")}
    assert "fed_member" not in cols


# --- FDIC paginated sync -----------------------------------------------------

async def test_bank_registry_sync_pages_and_upserts(tmp_db, upstream_client, monkeypatch):
    monkeypatch.setattr(collector, "BANK_REGISTRY_PAGE_PAUSE_S", 0)
    monkeypatch.setattr(fed_structure, "FDIC_PAGE_SIZE", 2)
    pages = {
        0: [_fdic(1, name="One"), _fdic(2, name="Two")],
        2: [_fdic(3, name="Three", active=0)],
    }
    seen_offsets = []

    def _cb(request):
        offset = int(request.url.params["offset"])
        seen_offsets.append(offset)
        # full history: the sync must never filter to active-only
        assert "filters" not in request.url.params
        return httpx.Response(200, json={
            "meta": {"total": 3},
            "data": [{"data": d, "score": 1} for d in pages.get(offset, [])],
        })

    with respx.mock:
        respx.get(url__startswith=fed_structure.FDIC_INSTITUTIONS_URL).mock(side_effect=_cb)
        n = await collector._fetch_and_persist_bank_registry()
    assert n == 3 and seen_offsets == [0, 2]
    assert db.get_bank_registry_count() == 3

    # re-sync revises in place (upsert keyed on CERT), never duplicates
    pages[0][0]["NAME"] = "One Renamed"
    with respx.mock:
        respx.get(url__startswith=fed_structure.FDIC_INSTITUTIONS_URL).mock(side_effect=_cb)
        await collector._fetch_and_persist_bank_registry()
    assert db.get_bank_registry_count() == 3
    assert db.search_bank_registry("Renamed")[0]["cert"] == 1


# --- FOMC rotation ------------------------------------------------------------

@pytest.mark.parametrize("year,expected", [
    # Confirmed against federalreserve.gov/monetarypolicy/fomc.htm, 2026-09-23
    (2026, {3, 4, 11, 9}),   # Philadelphia, Cleveland, Dallas, Minneapolis
    (2027, {5, 7, 6, 12}),   # Richmond, Chicago, Atlanta, San Francisco
    (2028, {1, 4, 8, 10}),   # Boston, Cleveland, St. Louis, Kansas City
    (2029, {3, 7, 11, 9}),   # Philadelphia, Chicago, Dallas, Minneapolis
])
def test_fomc_rotation_matches_published_schedule(year, expected):
    rotation = fed_structure.load_seed()["fomc_rotation"]
    voters = fed_structure.fomc_voting_districts(rotation, year)
    assert voters["permanent"] == 2
    assert set(voters["rotating"]) == expected


def test_seed_is_internally_consistent():
    seed = fed_structure.load_seed()
    assert len(seed["board"]) == 7
    assert sorted(b["district"] for b in seed["reserve_banks"]) == list(range(1, 13))
    assert sum(1 for b in seed["board"] if b["role"] == "Chair") == 1


# --- Governance seed + drift check --------------------------------------------

def test_governance_seed_load_is_idempotent(tmp_db):
    fed_structure.persist_seed()
    fed_structure.persist_seed()
    gov = db.get_fed_governance()
    assert len(gov["board"]) == 7 and len(gov["reserve_banks"]) == 12


BOARD_HTML = "".join(
    f'<a href="/aboutthefed/bios/board/{slug}.htm" class="list-group-item" title="">{name}</a>'
    for slug, name in [
        ("warsh", "Kevin Warsh, Chairman"), ("jefferson", "Philip N. Jefferson, Vice Chair"),
        ("bowman", "Michelle W. Bowman, Vice Chair for Supervision"), ("barr", "Michael S. Barr"),
        ("cook", "Lisa D. Cook"), ("powell", "Jerome H. Powell"), ("waller", "Christopher J. Waller"),
        ("boardmembership", "Board of Governors Members, 1914-Present"),
    ]
)


def test_parse_board_roster_excludes_history_page():
    live = fed_structure.parse_board_roster(BOARD_HTML)
    assert [m["slug"] for m in live][:1] == ["warsh"]
    assert len(live) == 7
    assert live[0]["name"] == "Kevin Warsh"


async def test_governance_check_passes_when_roster_matches(tmp_db, upstream_client):
    with respx.mock:
        respx.get(fed_structure.FED_BOARD_URL).mock(return_value=httpx.Response(200, text=BOARD_HTML))
        result = await collector._fetch_and_persist_fed_governance_check()
    assert result == {"members": 7}
    assert db.get_fed_governance() is not None  # seed loaded as part of the run


async def test_governance_check_raises_on_drift_and_keeps_seed(tmp_db, upstream_client):
    drifted = BOARD_HTML.replace("powell.htm", "newgov.htm").replace("Jerome H. Powell", "New Governor")
    with respx.mock:
        respx.get(fed_structure.FED_BOARD_URL).mock(return_value=httpx.Response(200, text=drifted))
        with pytest.raises(RuntimeError, match="differs from seed"):
            await collector._fetch_and_persist_fed_governance_check()
    names = {b["name"] for b in db.get_fed_governance()["board"]}
    assert "Jerome H. Powell" in names  # never rewritten from the scrape


async def test_governance_check_raises_on_empty_parse(tmp_db, upstream_client):
    with respx.mock:
        respx.get(fed_structure.FED_BOARD_URL).mock(return_value=httpx.Response(200, text="<html></html>"))
        with pytest.raises(RuntimeError, match="zero members"):
            await collector._fetch_and_persist_fed_governance_check()


# --- Transmission fetch --------------------------------------------------------

async def test_fed_transmission_fetches_every_configured_series(tmp_db, upstream_client, monkeypatch):
    from pipeline.config import FRED_SERIES_SLOOS, FRED_SERIES_TRANSMISSION

    monkeypatch.setenv("FRED_API_KEY", "x")
    requested = []

    def _cb(request):
        requested.append(request.url.params["series_id"])
        return httpx.Response(200, json={"observations": [
            {"date": "2026-01-01", "value": "4.40"}, {"date": "2026-01-02", "value": "."},
        ]})

    with respx.mock:
        respx.get(url__startswith=collector.FRED_BASE).mock(side_effect=_cb)
        await collector._fetch_and_persist_fed_transmission()
    expected = set(FRED_SERIES_TRANSMISSION.values()) | set(FRED_SERIES_SLOOS.values())
    assert set(requested) == expected
    assert "WLCFLPCL" not in requested  # money_supply's job, read not re-fetched
    rows = db.get_fred_observations("IORB", "2000-01-01")
    assert [r["value"] for r in rows] == [4.4, None]  # FRED "." -> NULL, never 0


async def test_fed_transmission_requires_key(tmp_db, monkeypatch):
    monkeypatch.delenv("FRED_API_KEY", raising=False)
    with pytest.raises(RuntimeError):
        await collector._fetch_and_persist_fed_transmission()


# --- Routes -------------------------------------------------------------------

async def test_transmission_route_window_and_units(tmp_db, client):
    db.upsert_fred_observations("EFFR", [{"date": "2010-01-01", "value": 0.1}, {"date": "2026-01-01", "value": 4.3}])
    db.upsert_fred_observations("WLCFLPCL", [{"date": "2026-01-07", "value": 5000.0}])  # millions
    db.upsert_fred_observations("DRTSCILM", [{"date": "2026-01-01", "value": -5.2}])
    resp = await client.get("/api/v1/fred/transmission/db", params={"window": "2y"})
    data = resp.json()["data"]
    assert [r["date"] for r in data["series"]["EFFR"]] == ["2026-01-01"]
    assert data["series"]["WLCFLPCL_BILLIONS"][0]["value"] == 5.0
    assert data["sloos"]["C&I — large/middle firms"][0]["value"] == -5.2

    resp = await client.get("/api/v1/fred/transmission/db",
                            params={"window": "custom", "start": "2009-01-01", "end": "2011-01-01"})
    assert [r["date"] for r in resp.json()["data"]["series"]["EFFR"]] == ["2010-01-01"]


async def test_bank_registry_route_search(tmp_db, client):
    db.upsert_bank_registry([
        fed_structure.map_fdic_row(_fdic(1, name="JPMorgan Chase Bank", fed="02", bkclass="N"), "t"),
        fed_structure.map_fdic_row(_fdic(2, name="Chase Manhattan Old", fed="02", active=0), "t"),
        fed_structure.map_fdic_row(_fdic(3, name="Other Bank", fed="12"), "t"),
    ])
    resp = await client.get("/api/v1/bank-registry/db", params={"q": "chase"})
    body = resp.json()
    assert [b["name"] for b in body["data"]] == ["JPMorgan Chase Bank"]
    assert body["total_registry_rows"] == 3

    resp = await client.get("/api/v1/bank-registry/db", params={"q": "chase", "active_only": "false"})
    assert len(resp.json()["data"]) == 2

    resp = await client.get("/api/v1/bank-registry/db", params={"q": "c"})  # too short
    assert resp.json()["data"] == []

    resp = await client.get("/api/v1/bank-registry/db/district-counts")
    counts = resp.json()["data"]
    assert counts["2"]["active"] == 1 and counts["2"]["all_time"] == 2


async def test_governance_route_self_seeds_and_joins_registry(tmp_db, client):
    db.upsert_bank_registry([fed_structure.map_fdic_row(_fdic(1, fed="03", bkclass="N"), "t")])
    resp = await client.get("/api/v1/fed-governance/db", params={"year": 2026})
    data = resp.json()["data"]
    assert data["fomc"]["permanent_district"] == 2
    phila = next(b for b in data["reserve_banks"] if b["district"] == 3)
    assert phila["fomc_voter"] and phila["registry"]["active_members"] == 1
    boston = next(b for b in data["reserve_banks"] if b["district"] == 1)
    assert not boston["fomc_voter"] and boston["registry"] is None  # no rows -> null, not 0


# --- Nav: Money Management added, Research folded into CATCOR -----------------

async def test_money_management_tab_is_pinnable(client):
    resp = await client.post("/api/ui/pinned-section", json={"section": "moneyManagement"})
    assert resp.status_code == 200


async def test_research_is_no_longer_a_nav_section(client):
    resp = await client.post("/api/ui/pinned-section", json={"section": "research"})
    assert resp.status_code == 400


async def test_bank_registry_route_district_browse_without_query(tmp_db, client):
    """Governance's click-a-district drilldown: district set, no name query."""
    db.upsert_bank_registry([
        fed_structure.map_fdic_row(_fdic(1, name="Zeta Bank", fed="05"), "t"),
        fed_structure.map_fdic_row(_fdic(2, name="Alpha Bank", fed="05"), "t"),
        fed_structure.map_fdic_row(_fdic(3, name="Gone Bank", fed="05", active=0), "t"),
        fed_structure.map_fdic_row(_fdic(4, name="Elsewhere", fed="06"), "t"),
    ])
    resp = await client.get("/api/v1/bank-registry/db", params={"district": 5, "limit": 5000})
    assert [b["name"] for b in resp.json()["data"]] == ["Alpha Bank", "Zeta Bank"]
    resp = await client.get("/api/v1/bank-registry/db", params={"district": 5, "active_only": "false", "limit": 5000})
    assert len(resp.json()["data"]) == 3
    # a bare, district-less short query still returns nothing
    resp = await client.get("/api/v1/bank-registry/db", params={"q": ""})
    assert resp.json()["data"] == []


# --- Bank size + Reserve Bank balance sheet -----------------------------------

def test_size_fields_map_and_convert_thousands_to_usd_at_read(tmp_db):
    raw = _fdic(1, name="Big Bank", bkclass="N", ASSET=4091315000, DEP=2820284000, EQ="341580000", REPDTE="06/30/2026")
    row = fed_structure.map_fdic_row(raw, "t")
    assert row["total_assets_k"] == 4091315000 and row["equity_k"] == 341580000  # EQ arrives as a string
    assert row["financials_as_of"] == "2026-06-30"
    db.upsert_bank_registry([row, fed_structure.map_fdic_row(_fdic(2, name="Big Unsized"), "t")])
    by_name = {b["name"]: b for b in db.search_bank_registry("Big")}
    assert by_name["Big Bank"]["total_assets"] == 4091315000 * 1000  # USD
    assert "total_assets_k" not in by_name["Big Bank"]
    assert by_name["Big Unsized"]["total_assets"] is None  # never 0


def test_district_counts_sum_active_sized_banks_only(tmp_db):
    db.upsert_bank_registry([fed_structure.map_fdic_row(r, "t") for r in [
        _fdic(1, fed="09", bkclass="N", ASSET=100, EQ="10"),
        _fdic(2, fed="09", bkclass="NM", ASSET=50, EQ="5"),
        _fdic(3, fed="09", bkclass="SM", ASSET=None),         # active, unsized
        _fdic(4, fed="09", bkclass="N", ASSET=999, active=0),  # inactive: last filing, excluded
    ]])
    c = db.get_bank_registry_district_counts()[9]
    assert c["active_assets"] == 150_000 and c["member_assets"] == 100_000
    assert c["member_equity"] == 10_000 and c["sized_count"] == 2


def test_governance_view_joins_latest_reserve_bank_balance_sheet(tmp_db):
    from datetime import date, timedelta
    recent = str(date.today() - timedelta(days=7))
    older = str(date.today() - timedelta(days=14))
    db.upsert_fred_observations("D2WATAL", [{"date": older, "value": 1.0}, {"date": recent, "value": 3568005.0}])
    db.upsert_fred_observations("H41RESPPLLDEF02NWW", [{"date": recent, "value": None}, {"date": older, "value": 900000.0}])
    view = fed_structure.governance_view(2026)
    ny = next(b for b in view["reserve_banks"] if b["district"] == 2)
    assert ny["balance_sheet"]["total_assets"] == 3568005.0 * 1e6
    assert ny["balance_sheet"]["depository_deposits"] == 900000.0 * 1e6  # latest NON-null
    assert ny["balance_sheet"]["capital_paid_in"] is None
    assert ny["balance_sheet"]["as_of"] == recent
    boston = next(b for b in view["reserve_banks"] if b["district"] == 1)
    assert boston["balance_sheet"] is None


async def test_reserve_bank_h41_fetches_60_series(tmp_db, upstream_client, monkeypatch):
    monkeypatch.setenv("FRED_API_KEY", "x")
    requested = []

    def _cb(request):
        requested.append(request.url.params["series_id"])
        return httpx.Response(200, json={"observations": [{"date": "2026-09-16", "value": "12.5"}]})

    with respx.mock:
        respx.get(url__startswith=collector.FRED_BASE).mock(side_effect=_cb)
        assert await collector._fetch_and_persist_reserve_bank_h41() == 60
    assert "D12WATAL" in requested and "H41RESPPLLDEF01NWW" in requested and len(set(requested)) == 60


# --- Bank screen route -------------------------------------------------------------

async def test_bank_route_rank_share_peers_and_reserve_bank(tmp_db, client):
    db.upsert_bank_registry([fed_structure.map_fdic_row(r, "t") for r in [
        _fdic(1, name="Big", fed="05", bkclass="N", ASSET=300, RSSDHCR="77", NAMEHCR="HC"),
        _fdic(2, name="Mid", fed="05", ASSET=200, RSSDHCR="77", NAMEHCR="HC"),
        _fdic(3, name="Small", fed="05", ASSET=100),
        _fdic(4, name="Dead", fed="05", ASSET=999, active=0, RSSDHCR="77"),
        _fdic(5, name="Unsized", fed="05"),
    ]])
    resp = await client.get("/api/v1/bank-registry/db/bank/2")
    data = resp.json()["data"]
    bank = data["bank"]
    assert bank["district_rank"] == 2 and bank["district_active_sized_count"] == 3
    assert bank["district_active_assets"] == 600_000
    assert [p["name"] for p in bank["holding_company_peers"]] == ["Big"]  # active peers only
    assert data["reserve_bank"]["district"] == 5 and data["reserve_bank"]["city"] == "Richmond"

    # inactive / unsized banks get NO manufactured rank
    assert (await client.get("/api/v1/bank-registry/db/bank/4")).json()["data"]["bank"]["district_rank"] is None
    assert (await client.get("/api/v1/bank-registry/db/bank/5")).json()["data"]["bank"]["district_rank"] is None
    assert (await client.get("/api/v1/bank-registry/db/bank/999")).status_code == 404


# --- Quarterly history (bank_financials, 2002+) ---------------------------------

def test_quarter_ends_stop_at_today():
    from datetime import date
    qs = fed_structure.quarter_ends(2002, date(2003, 5, 1))
    assert qs == ["20020331", "20020630", "20020930", "20021231", "20030331"]


def test_map_financials_row_keeps_as_of_district():
    r = fed_structure.map_fdic_financials_row(
        {"CERT": 7213, "REPDTE": "20180331", "FED": 9, "ASSET": 1406778000, "DEP": None, "EQ": "5"}, "t")
    assert r == {"cert": 7213, "repdte": "2018-03-31", "fed_district": 9, "total_assets_k": 1406778000.0,
                 "deposits_k": None, "equity_k": 5.0, "fetched_at": "t"}
    assert fed_structure.map_fdic_financials_row({"CERT": 1, "REPDTE": "20180331", "FED": 0}, "t")["fed_district"] is None
    assert fed_structure.map_fdic_financials_row({"CERT": 1}, "t") is None


def _fin(cert, repdte, fed, asset):
    return {"CERT": cert, "REPDTE": repdte, "FED": fed, "ASSET": asset, "DEP": None, "EQ": None}


async def test_bank_financials_sync_skips_old_quarters_refreshes_latest_two(tmp_db, upstream_client, monkeypatch):
    from datetime import date as real_date
    from tests.helpers import make_fake_date
    monkeypatch.setattr(collector, "BANK_REGISTRY_PAGE_PAUSE_S", 0)
    monkeypatch.setattr(fed_structure, "BANK_FINANCIALS_START_YEAR", 2025)
    monkeypatch.setattr(collector, "date", make_fake_date(real_date(2025, 10, 15)))
    # already persisted: Q1..Q3 2025 -> Q1 skipped, Q2/Q3 (latest two) re-fetched
    db.upsert_bank_financials([fed_structure.map_fdic_financials_row(_fin(1, q, 5, 1), "old")
                               for q in ("20250331", "20250630", "20250930")])
    requested = []

    def _cb(request):
        q = request.url.params["filters"].split(":")[1]
        requested.append(q)
        return httpx.Response(200, json={"meta": {"total": 1}, "data": [{"data": _fin(1, q, 5, 2)}]})

    with respx.mock:
        respx.get(url__startswith=fed_structure.FDIC_FINANCIALS_URL).mock(side_effect=_cb)
        result = await collector._bank_financials_sync()
    assert requested == ["20250630", "20250930"]
    assert result == {"quarters": 2, "rows": 2}
    assert db.get_source_health("bank_financials")["last_attempt_status"] == "success"


async def test_bank_financials_fetch_fn_detaches(tmp_db, monkeypatch):
    started = []

    async def _fake_sync():
        started.append(True)

    monkeypatch.setattr(collector, "_bank_financials_task", None)
    monkeypatch.setattr(collector, "_bank_financials_sync", _fake_sync)
    assert await collector._fetch_and_persist_bank_financials() == "started"
    await collector._bank_financials_task
    assert started == [True]


def _seed_history():
    rows = []
    # District 9: a small local bank all along; "Citi" (cert 7213) arrives in 2016Q4
    for q, citi_d in (("2016-09-30", 2), ("2016-12-31", 9)):
        rows += [
            {"cert": 7213, "repdte": q, "fed_district": citi_d, "total_assets_k": 1000.0},
            {"cert": 50, "repdte": q, "fed_district": 9, "total_assets_k": 100.0},
            {"cert": 60, "repdte": q, "fed_district": 2, "total_assets_k": 300.0},
        ]
    db.upsert_bank_financials([{**r, "deposits_k": None, "equity_k": None, "fetched_at": "t"} for r in rows])
    db.upsert_bank_registry([fed_structure.map_fdic_row(_fdic(7213, name="Citibank", fed="09", bkclass="N"), "t")])


def test_bank_history_ranks_and_shares_use_as_of_district(tmp_db):
    _seed_history()
    h = db.get_bank_history(7213)
    assert [r["fed_district"] for r in h] == [2, 9]
    assert h[0]["district_assets"] == 1_300_000 and h[0]["district_rank"] == 1
    assert h[1]["district_assets"] == 1_100_000 and h[1]["district_rank"] == 1
    assert h[1]["us_assets"] == 1_400_000 and h[1]["us_rank"] == 1


def test_district_history_top_bank_share_is_zero_before_it_moved_in(tmp_db):
    _seed_history()
    from datetime import date, timedelta
    db.upsert_fred_observations("D9WATAL", [{"date": "2016-12-28", "value": 99.0}, {"date": "2017-01-04", "value": 5.0}])
    h = fed_structure.district_history(9)
    assert [b["cert"] for b in h["top_banks"]] == [7213, 50]
    q3, q4 = h["series"]
    assert q3["shares"]["7213"] == 0 and q3["shares"]["50"] == 1.0
    assert abs(q4["shares"]["7213"] - 1000 / 1100) < 1e-9
    assert q3["reserve_bank_assets"] is None               # before the series' first obs: NULL, no fill
    assert q4["reserve_bank_assets"] == 99.0 * 1e6         # as-of: latest Wednesday ON/BEFORE 12-31
    assert q4["top10_share"] == 1.0
    assert abs(q4["us_bank_share"] - 1100 / 1400) < 1e-9  # district's share of U.S. bank assets
    assert q4["system_share"] is None                     # needs all 12 Reserve Banks


def test_districts_history_shares(tmp_db):
    _seed_history()
    h = fed_structure.districts_history()
    d9 = h["districts"][9]
    assert d9[0]["bank_share"] == 100 / 1400 and abs(d9[1]["bank_share"] - 1100 / 1400) < 1e-9
    assert d9[1]["reserve_bank_share"] is None  # needs all 12 Reserve Banks that quarter


async def test_history_routes(tmp_db, client):
    _seed_history()
    assert len((await client.get("/api/v1/bank-registry/db/bank/7213/history")).json()["data"]) == 2
    assert (await client.get("/api/v1/fed-districts/db/history/9")).json()["data"]["district"] == 9
    assert (await client.get("/api/v1/fed-districts/db/history/13")).status_code == 404


async def test_top_banks_route_members_vs_all(tmp_db, client):
    db.upsert_bank_registry([fed_structure.map_fdic_row(r, "t") for r in [
        _fdic(1, name="Nat", bkclass="N", ASSET=500),
        _fdic(2, name="StateMember", bkclass="SM", ASSET=300),
        _fdic(3, name="NonMember", bkclass="NM", ASSET=400),
        _fdic(4, name="Closed", bkclass="N", ASSET=900, active=0),
        _fdic(5, name="Unsized", bkclass="N"),
    ]])
    d = (await client.get("/api/v1/bank-registry/db/top", params={"n": 1})).json()["data"]
    assert [b["name"] for b in d["banks"]] == ["Nat"]
    assert d["population_count"] == 2 and d["population_assets"] == 800_000
    d = (await client.get("/api/v1/bank-registry/db/top", params={"members_only": "false"})).json()["data"]
    assert [b["name"] for b in d["banks"]] == ["Nat", "NonMember", "StateMember"]
    assert d["population_assets"] == 1_200_000


# --- Repo/reverse-repo net daily (2026-09 follow-up to soma-bank-growth) ---

def _repo_op(operation_id, operation_date, operation_type, total_amt_accepted, **kw):
    row = {
        "operation_id": operation_id, "operation_date": operation_date, "operation_type": operation_type,
        "term": "Overnight", "term_calendar_days": 1, "settlement_date": operation_date,
        "maturity_date": operation_date, "total_amt_submitted": total_amt_accepted,
        "total_amt_accepted": total_amt_accepted, "award_rate": None, "offering_rate": None,
    }
    row.update(kw)
    return row


def test_repo_net_daily_nets_repo_minus_reverse_repo_same_day(tmp_db):
    db.insert_fed_repo_operations_rows([
        _repo_op("RP1", "2024-01-05", "Repo", 100.0),
        _repo_op("RRP1", "2024-01-05", "Reverse Repo", 30.0),
    ])
    rows = db.get_fed_repo_net_daily()
    assert rows == [{"date": "2024-01-05", "net_repo": 70.0}]


def test_repo_net_daily_reverse_repo_only_day_is_negative(tmp_db):
    db.insert_fed_repo_operations_rows([_repo_op("RRP2", "2024-01-06", "Reverse Repo", 500.0)])
    rows = db.get_fed_repo_net_daily()
    assert rows == [{"date": "2024-01-06", "net_repo": -500.0}]


def test_repo_net_daily_skips_null_amounts(tmp_db):
    db.insert_fed_repo_operations_rows([_repo_op("RP2", "2024-01-07", "Repo", None)])
    assert db.get_fed_repo_net_daily() == []


async def test_repo_net_daily_route(tmp_db, client):
    db.insert_fed_repo_operations_rows([
        _repo_op("RP3", "2024-02-01", "Repo", 10.0),
        _repo_op("RRP3", "2024-02-01", "Reverse Repo", 4.0),
    ])
    r = await client.get("/api/v1/fed-operational-flow/db/repo-net-daily")
    assert r.status_code == 200
    assert r.json()["data"] == [{"date": "2024-02-01", "net_repo": 6.0}]


# --- Story A: bank growth vs. SOMA growth (soma-bank-growth-spec.md) --------

def _bf_row(cert, repdte, assets_k):
    return {"cert": cert, "repdte": repdte, "fed_district": 1, "total_assets_k": assets_k,
            "deposits_k": None, "equity_k": None, "fetched_at": "t"}


def test_bank_growth_vs_soma_growth_sums_every_real_filing_per_quarter(tmp_db):
    db.upsert_bank_financials([
        _bf_row(1, "2020-03-31", 1000.0), _bf_row(2, "2020-03-31", 500.0),
        _bf_row(1, "2020-06-30", 1100.0), _bf_row(2, "2020-06-30", None),  # unsized bank contributes nothing
        _bf_row(3, "2020-06-30", 200.0),  # a bank that didn't file in Q1 shows up honestly, no manufactured Q1 row
    ])
    rows = db.get_bank_growth_vs_soma_growth()
    assert [r["quarter"] for r in rows] == ["2020-03-31", "2020-06-30"]
    assert rows[0]["total_bank_assets"] == 1_500_000
    assert rows[0]["bank_assets_qoq_change"] is None  # first quarter: no prior quarter to diff against
    assert rows[1]["total_bank_assets"] == 1_300_000
    assert rows[1]["bank_assets_qoq_change"] == -200_000


def _soma_row(as_of_date, total):
    return {"as_of_date": as_of_date, "total": total, "bills": None, "notesbonds": None, "tips": None,
            "tips_inflation_compensation": None, "frn": None, "mbs": None, "cmbs": None, "agencies": None}


def test_bank_growth_vs_soma_growth_resamples_soma_as_of_quarter_end(tmp_db):
    db.upsert_bank_financials([_bf_row(1, "2020-03-31", 1000.0), _bf_row(1, "2020-06-30", 1000.0)])
    db.upsert_fed_soma_holdings_rows([
        _soma_row("2020-01-08", 4_000_000_000.0),
        _soma_row("2020-03-25", 4_100_000_000.0),  # latest real reading on/before 03-31
        _soma_row("2020-07-01", 4_500_000_000.0),  # AFTER 06-30, must not be used for that quarter
    ])
    rows = db.get_bank_growth_vs_soma_growth()
    assert rows[0]["soma_holdings"] == 4_100_000_000.0
    assert rows[0]["soma_qoq_change"] is None
    assert rows[1]["soma_holdings"] == 4_100_000_000.0  # 06-30's on/before reading is still the 03-25 one
    assert rows[1]["soma_qoq_change"] == 0.0


async def test_bank_growth_vs_soma_growth_route(tmp_db, client):
    db.upsert_bank_financials([_bf_row(1, "2021-12-31", 2000.0)])
    r = await client.get("/api/v1/fed-money-creation-vs-bank-growth/db")
    assert r.status_code == 200
    assert r.json()["data"] == [{
        "quarter": "2021-12-31", "total_bank_assets": 2_000_000.0,
        "bank_assets_qoq_change": None, "soma_holdings": None, "soma_qoq_change": None,
    }]


# --- Story B: top-N cohort growth distribution (soma-bank-growth-spec.md) --

def test_bank_growth_distribution_cohort_is_fixed_by_latest_size(tmp_db):
    db.upsert_bank_financials([
        # Q1: bank 2 is bigger than bank 1. Q2: bank 1 overtakes bank 2 and is now the latest-quarter
        # #1 by size — the cohort should be picked from Q2 (latest), not Q1.
        _bf_row(1, "2020-03-31", 100.0), _bf_row(2, "2020-03-31", 200.0),
        _bf_row(1, "2020-06-30", 500.0), _bf_row(2, "2020-06-30", 200.0),
    ])
    d = db.get_bank_growth_distribution(n=1)
    assert [c["cert"] for c in d["cohort"]] == [1]  # latest-quarter #1 by size, not Q1's #1
    # the fixed cohort (bank 1) still contributes its OWN Q1 total_assets_k, even though it
    # wasn't the top bank that quarter — the cohort is fixed by size, tracked across all quarters.
    assert d["series"][0]["top_n_total"] == 100_000.0
    assert d["series"][1]["top_n_total"] == 500_000.0


def test_bank_growth_distribution_share_is_against_net_system_growth(tmp_db):
    db.upsert_bank_financials([
        _bf_row(1, "2020-03-31", 1000.0), _bf_row(2, "2020-03-31", 1000.0),
        _bf_row(1, "2020-06-30", 1200.0), _bf_row(2, "2020-06-30", 1000.0),
    ])
    d = db.get_bank_growth_distribution(n=1)
    q2 = d["series"][1]
    # system grew by 200k (2200k - 2000k); cohort (bank 1 alone) grew by 200k too -> share 1.0
    assert q2["system_qoq_change"] == 200_000.0
    assert q2["top_n_qoq_change"] == 200_000.0
    assert q2["top_n_growth_share"] == 1.0


def test_bank_growth_distribution_share_is_none_when_denominator_is_zero_or_null(tmp_db):
    db.upsert_bank_financials([
        _bf_row(1, "2020-03-31", 1000.0),
        _bf_row(1, "2020-06-30", 1000.0),  # no change quarter-over-quarter -> system_qoq_change == 0
    ])
    d = db.get_bank_growth_distribution(n=1)
    assert d["series"][0]["top_n_growth_share"] is None  # first quarter: no prior to diff
    assert d["series"][1]["system_qoq_change"] == 0.0
    assert d["series"][1]["top_n_growth_share"] is None  # never divide by zero


async def test_bank_growth_distribution_route(tmp_db, client):
    db.upsert_bank_financials([_bf_row(1, "2022-03-31", 900.0)])
    r = await client.get("/api/v1/fed-bank-growth-distribution/db", params={"n": 1})
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["cohort"] == [{"cert": 1, "name": "FDIC cert 1", "total_assets_k": 900.0}]
    assert d["series"][0]["quarter"] == "2022-03-31"


# --- CUSIP-level per-operation drill-down (soma-bank-growth-spec.md precursor #1) ---

def _soma_txn(operation_id, operation_date, direction="P", detail_json=None, **kw):
    row = {
        "operation_id": operation_id, "operation_date": operation_date, "security_type": "Treasury",
        "operation_type": "Purchase", "direction": direction, "settlement_date": operation_date,
        "total_amt_submitted": 100.0, "total_amt_accepted": 100.0, "detail_json": detail_json,
    }
    row.update(kw)
    return row


def test_get_fed_soma_transaction_detail_parses_raw_details_verbatim(tmp_db):
    db.insert_fed_soma_transactions_rows([
        _soma_txn("RP 092526 25", "2025-09-26", detail_json='{"cusip": "912828XG8", "parAmount": 1000}'),
    ])
    d = db.get_fed_soma_transaction_detail("RP 092526 25")
    assert d["operation_id"] == "RP 092526 25"
    assert d["raw_details"] == {"cusip": "912828XG8", "parAmount": 1000}


def test_get_fed_soma_transaction_detail_null_detail_json_is_not_an_error(tmp_db):
    db.insert_fed_soma_transactions_rows([_soma_txn("RP1", "2025-01-01", detail_json=None)])
    d = db.get_fed_soma_transaction_detail("RP1")
    assert d is not None
    assert d["raw_details"] is None


def test_get_fed_soma_transaction_detail_missing_operation_is_none(tmp_db):
    assert db.get_fed_soma_transaction_detail("NOPE") is None


async def test_fed_soma_transaction_detail_route(tmp_db, client):
    db.insert_fed_soma_transactions_rows([
        _soma_txn("RP2", "2025-02-02", detail_json='{"cusip": "912828AB1"}'),
    ])
    r = await client.get("/api/v1/fed-operational-flow/db/transactions/RP2/detail")
    assert r.status_code == 200
    assert r.json()["data"]["raw_details"] == {"cusip": "912828AB1"}

    r404 = await client.get("/api/v1/fed-operational-flow/db/transactions/NOPE/detail")
    assert r404.status_code == 404
