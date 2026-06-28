"""
Entry point for the ArgentVigil data pipeline.
Run with: python3 pipeline/run.py  (from repo root)
           python3 run.py           (from pipeline/ directory)
"""

import json
import os
import sys
from datetime import datetime, timezone

# Allow running from either repo root or pipeline/ directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fetch import fetch_cot_data
from compute import parse_and_compute

# Always resolve to <repo>/pipeline/cache/cot_data.json regardless of cwd
_PIPELINE_DIR = os.path.dirname(os.path.abspath(__file__))
_CACHE_PATH = os.path.join(_PIPELINE_DIR, "cache", "cot_data.json")


def main():
    print("ArgentVigil pipeline — fetching CFTC CoT data...")
    rows = fetch_cot_data()
    print(f"  Received {len(rows)} weekly records from PRE API.")

    result = parse_and_compute(rows)

    latest = result["latest"]
    w2 = result["windows"]["2yr"]
    w5 = result["windows"]["5yr"]
    disagree = result["windows"]["disagree"]

    print(f"\n  Latest report date : {latest['date']}")
    print(f"  net_long_pct_oi    : {latest['net_long_pct_oi']:.2f}%")
    print(f"  2yr percentile     : {w2['percentile']}  → {w2['classification']}")
    print(f"  5yr percentile     : {w5['percentile']}  → {w5['classification']}")
    if disagree:
        print("  ⚠  2yr and 5yr windows disagree — see both readings in the UI.")

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        # CoT data lag: as-of Tuesday, published Friday (~3 days later)
        "cot_as_of_date": latest["date"],
        "series": result["series"],
        "latest": latest,
        "windows": result["windows"],
        "macro_watchlist": _load_existing_watchlist(),
    }

    os.makedirs(os.path.dirname(_CACHE_PATH), exist_ok=True)
    with open(_CACHE_PATH, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\n  Cache written to {_CACHE_PATH}")


def _load_existing_watchlist() -> dict:
    """Preserve any manually-entered macro watchlist values across pipeline runs."""
    try:
        with open(_CACHE_PATH) as f:
            existing = json.load(f)
        return existing.get("macro_watchlist", _default_watchlist())
    except (FileNotFoundError, json.JSONDecodeError):
        return _default_watchlist()


def _default_watchlist() -> dict:
    return {
        "fed_policy_stance": "",
        "dxy": None,
        "core_pce": None,
        "fed_balance_sheet_note": "",
        "comex_registered_inventory_note": "",
        "shanghai_comex_spread_note": "",
        "gold_silver_ratio": None,
        "silver_institute_note": "",
        "_instructions": (
            "Manually update these fields after each pipeline run. "
            "They are preserved across runs so you do not lose entries."
        ),
    }


if __name__ == "__main__":
    main()
