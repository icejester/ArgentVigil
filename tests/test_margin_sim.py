"""Trading Simulator backend (specs/margin-simulator-spec.md): the margin
seed (Story #5) and saved-setup CRUD (Story #4). Simulation math lives in
the browser, so nothing here asserts a participant balance."""

import copy

import pytest

from backend import db, margin_sim
from backend.units import SILVER_CONTRACT_OZ, SILVER_MICRO_CONTRACT_OZ


def _seed(rows):
    return {"reviewed_as_of": "2026-10-02", "review_notes": "test", "rows": rows}


def _row(**over):
    base = {
        "contract": "SI", "effective_date": "2026-02-06", "basis": "pct_notional",
        "initial_pct": 18.0, "maintenance_pct": 18.0,
        "initial_margin_usd": None, "maintenance_margin_usd": None,
        "source_note": "n", "source_url": "u",
    }
    return {**base, **over}


def test_shipped_seed_loads_and_only_carries_stated_figures(tmp_db):
    seed = margin_sim.persist_seed()
    rows = db.get_futures_margins()
    assert len(rows) == len(seed["rows"]) >= 1
    for r in rows:
        assert r["contract"] in margin_sim.CONTRACTS
        assert r["source_url"]  # every row cites where it came from
        if r["basis"] == "pct_notional":
            # dollar fields don't apply to a percent-of-value row — NULL, never 0
            assert r["initial_margin_usd"] is None and r["maintenance_margin_usd"] is None


def test_persist_seed_is_replace_all(tmp_db):
    margin_sim.persist_seed(_seed([_row(), _row(effective_date="2026-01-30", initial_pct=None, maintenance_pct=None)]))
    margin_sim.persist_seed(_seed([_row()]))
    rows = db.get_futures_margins()
    assert [r["effective_date"] for r in rows] == ["2026-02-06"]


def test_persist_seed_rejects_unknown_contract_without_partial_load(tmp_db):
    margin_sim.persist_seed(_seed([_row()]))
    with pytest.raises(ValueError):
        margin_sim.persist_seed(_seed([_row(effective_date="2026-03-01"), _row(contract="GC")]))
    assert [r["effective_date"] for r in db.get_futures_margins()] == ["2026-02-06"]


async def test_margins_route_self_seeds_and_ships_contract_sizes(client):
    resp = await client.get("/api/futures-margins/db")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["contracts"]["SI"]["oz"] == SILVER_CONTRACT_OZ
    assert data["contracts"]["SIL"]["oz"] == SILVER_MICRO_CONTRACT_OZ
    assert data["contracts"]["SI"]["latest"]["initial_pct"] is not None
    assert data["history"]


async def test_margins_route_latest_is_newest_effective_date(client, tmp_db):
    margin_sim.persist_seed(_seed([_row(effective_date="2026-02-06"), _row(effective_date="2026-01-30", initial_pct=15.0)]))
    data = (await client.get("/api/futures-margins/db")).json()["data"]
    assert data["contracts"]["SI"]["latest"]["effective_date"] == "2026-02-06"
    # no SIL row in this seed → explicit null, not a borrowed SI figure
    assert data["contracts"]["SIL"]["latest"] is None


SCENARIO = {
    "scenario_name": "five and five",
    "contract": "SI",
    "participants": [
        {"side": "long", "contracts": 3, "entry_offset_pct": 1.5},
        {"side": "long", "contracts": 1, "entry_offset_pct": -0.8},
        {"side": "long", "contracts": 7, "entry_offset_pct": 0.3},
        {"side": "short", "contracts": 2, "entry_offset_pct": 2.1},
        {"side": "short", "contracts": 5, "entry_offset_pct": -3.4},
    ],
    "margin_rate_used": {"initial_pct": 18.0, "maintenance_pct": 18.0, "user_entered": False, "effective_date": "2026-02-06"},
    "price_source_type": "seeded",
    "price_source_params": {"start": "2025-12-01", "end": "2026-02-27"},
}


async def test_scenario_crud_round_trip(client):
    created = await client.post("/api/margin-sim/scenarios", json=SCENARIO)
    assert created.status_code == 200
    sid = created.json()["data"]["id"]

    got = (await client.get(f"/api/margin-sim/scenarios/{sid}/db")).json()["data"]
    assert got["participants"] == SCENARIO["participants"]
    assert got["price_source_params"] == SCENARIO["price_source_params"]
    assert got["margin_rate_used"]["user_entered"] is False

    changed = {**SCENARIO, "scenario_name": "renamed", "price_source_type": "generated", "price_source_params": None}
    assert (await client.put(f"/api/margin-sim/scenarios/{sid}", json=changed)).status_code == 200
    listed = (await client.get("/api/margin-sim/scenarios/db")).json()["data"]
    assert [s["scenario_name"] for s in listed] == ["renamed"]
    assert listed[0]["price_source_params"] is None  # NULL, not "null" or {}

    assert (await client.delete(f"/api/margin-sim/scenarios/{sid}")).status_code == 200
    assert (await client.get(f"/api/margin-sim/scenarios/{sid}/db")).status_code == 404
    assert (await client.delete(f"/api/margin-sim/scenarios/{sid}")).status_code == 404


@pytest.mark.parametrize("mutate", [
    lambda s: s.update(scenario_name="  "),
    lambda s: s.update(contract="GC"),
    lambda s: s.update(price_source_type="replay"),
    lambda s: s.update(participants=s["participants"][:4]),  # under the 5 minimum
    lambda s: s.update(participants=[{**p, "side": "long"} for p in s["participants"]]),  # no short side
    lambda s: s["participants"][0].update(contracts=0),
    lambda s: s["participants"][0].update(entry_offset_pct=75),
    lambda s: s["participants"][0].pop("entry_offset_pct"),
])
async def test_scenario_validation_rejects_bad_input(client, mutate):
    bad = copy.deepcopy(SCENARIO)
    mutate(bad)
    resp = await client.post("/api/margin-sim/scenarios", json=bad)
    assert resp.status_code == 400


async def test_scenario_update_missing_id_is_404(client):
    assert (await client.put("/api/margin-sim/scenarios/999", json=SCENARIO)).status_code == 404
