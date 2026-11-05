"""Trading Simulator backend (specs/margin-simulator-spec.md).

Two jobs, both small:
  - Story #5: load the hand-maintained margin seed
    (seed_data/futures_margins.json) into futures_margin_requirements and
    serve it, plus each contract's size so the frontend never hardcodes a
    unit constant.
  - Story #4: validate saved simulator setups before db.py persists them.

No HTTP client and no upstream: CME refuses automated requests, so margin
figures arrive only by a human editing the seed. All simulation math runs in
the browser; nothing here computes a participant's balance.
"""

import json
import os
from datetime import datetime, timezone

from . import db
from .units import SILVER_CONTRACT_OZ, SILVER_MICRO_CONTRACT_OZ

SEED_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "seed_data", "futures_margins.json")

# Contracts the simulator offers. oz comes from units.py so the browser
# receives it rather than duplicating the constant (CLAUDE.md's unit-constants rule).
CONTRACTS = {
    "SI": {"label": "COMEX Silver (5,000 oz)", "oz": SILVER_CONTRACT_OZ},
    "SIL": {"label": "COMEX Micro Silver (1,000 oz)", "oz": SILVER_MICRO_CONTRACT_OZ},
}

BASES = {"pct_notional", "usd"}
PRICE_SOURCE_TYPES = {"slider", "generated", "stepped", "seeded"}
SIDES = {"long", "short"}
MIN_PARTICIPANTS, MAX_PARTICIPANTS = 5, 10


def load_seed(path: str = SEED_PATH) -> dict:
    with open(path) as f:
        return json.load(f)


def persist_seed(seed: dict | None = None) -> dict:
    """Replace-all load of the margin seed. Idempotent. Rejects a malformed
    row loudly rather than loading part of the file."""
    seed = seed or load_seed()
    loaded_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = []
    for r in seed["rows"]:
        if r["contract"] not in CONTRACTS:
            raise ValueError(f"futures_margins.json: unknown contract {r['contract']!r}")
        if r["basis"] not in BASES:
            raise ValueError(f"futures_margins.json: unknown basis {r['basis']!r}")
        rows.append({**r, "loaded_at": loaded_at})
    db.replace_futures_margins(rows)
    return seed


def margins_view() -> dict:
    """Read model for GET /api/futures-margins/db. Loads the seed on first
    use so a frozen environment (no collector) still has it — the seed ships
    with the code, same as fed_structure.governance_view."""
    rows = db.get_futures_margins()
    if not rows:
        persist_seed()
        rows = db.get_futures_margins()
    seed = load_seed()
    latest = {}
    for r in rows:  # ordered by effective_date, so the last one per contract wins
        latest[r["contract"]] = r
    return {
        "contracts": {
            key: {**meta, "latest": latest.get(key)}
            for key, meta in CONTRACTS.items()
        },
        "history": rows,
        "reviewed_as_of": seed.get("reviewed_as_of"),
        "review_notes": seed.get("review_notes"),
    }


def validate_scenario(body: dict) -> dict:
    """Shape check for a saved setup; raises ValueError with a readable
    message. Returns the fields db.py persists."""
    name = (body.get("scenario_name") or "").strip()
    if not name:
        raise ValueError("scenario_name is required")
    if body.get("contract") not in CONTRACTS:
        raise ValueError(f"contract must be one of {sorted(CONTRACTS)}")
    if body.get("price_source_type") not in PRICE_SOURCE_TYPES:
        raise ValueError(f"price_source_type must be one of {sorted(PRICE_SOURCE_TYPES)}")
    participants = body.get("participants")
    if not isinstance(participants, list) or not (MIN_PARTICIPANTS <= len(participants) <= MAX_PARTICIPANTS):
        raise ValueError(f"participants must be a list of {MIN_PARTICIPANTS}-{MAX_PARTICIPANTS} entries")
    for p in participants:
        if p.get("side") not in SIDES:
            raise ValueError("each participant needs side 'long' or 'short'")
        if not isinstance(p.get("contracts"), int) or p["contracts"] < 1:
            raise ValueError("each participant needs a positive whole-number contracts count")
        # Entry is stored as an offset from the run's starting price, not an
        # absolute price, so a saved setup replays sensibly over any price
        # window (a $60 entry means nothing against a 2010 window near $18).
        off = p.get("entry_offset_pct")
        if isinstance(off, bool) or not isinstance(off, (int, float)) or not -50 <= off <= 50:
            raise ValueError("each participant needs entry_offset_pct between -50 and 50")
    if not any(p["side"] == "long" for p in participants) or not any(p["side"] == "short" for p in participants):
        raise ValueError("participants need at least one long and one short")
    return {
        "scenario_name": name,
        "contract": body["contract"],
        "participants": participants,
        "margin_rate_used": body.get("margin_rate_used"),
        "price_source_type": body["price_source_type"],
        "price_source_params": body.get("price_source_params"),
    }
