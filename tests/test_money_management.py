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
