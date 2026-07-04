"""
Entry point for the ArgentVigil data pipeline.
Run with: python3 pipeline/run.py  (from repo root)
           python3 run.py           (from pipeline/ directory)
"""

import json
import os
import sys
from datetime import datetime, timezone

_PIPELINE_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_PIPELINE_DIR)
sys.path.insert(0, _PIPELINE_DIR)   # for bare `from fetch import ...` etc. (this file's own siblings)
sys.path.insert(0, _REPO_ROOT)      # for `from backend import db` — backend/ is pure-stdlib (sqlite3/os/
                                     # contextlib only), so importing it does not require fastapi/httpx/
                                     # dotenv or the venv being active; this pipeline stays runnable with
                                     # bare `python3`.

from backend import db
from fetch import fetch_cot_data, fetch_gold_cot_data
from price_fetch import fetch_silver_prices, fetch_gold_prices, fetch_spot_prices
from compute import parse_and_compute, compute_signal_track_record

_CACHE_PATH = os.path.join(_PIPELINE_DIR, "cache", "cot_data.json")


def _rows_for_db(raw_rows: list[dict]) -> list[dict]:
    out = []
    for row in raw_rows:
        try:
            date_str = row["report_date_as_yyyy_mm_dd"][:10]
            nc_long = float(row.get("noncomm_positions_long_all") or 0)
            nc_short = float(row.get("noncomm_positions_short_all") or 0)
            oi = float(row.get("open_interest_all") or 0)
        except (KeyError, ValueError):
            continue
        if oi <= 0:
            continue
        net_long = nc_long - nc_short
        out.append({
            "report_date": date_str,
            "noncomm_long": nc_long,
            "noncomm_short": nc_short,
            "open_interest": oi,
            "net_long": net_long,
            "net_long_pct_oi": round(net_long / oi * 100, 4),
        })
    return out


def _run_metal(name: str, rows_fn, prices_fn, db_insert_fn) -> tuple[dict, dict]:
    print(f"\n  [{name}] Fetching CoT data...")
    rows = rows_fn()
    print(f"  [{name}] {len(rows)} weekly records.")
    db_insert_fn(_rows_for_db(rows))

    print(f"  [{name}] Fetching price data...")
    prices = prices_fn(years=8)
    print(f"  [{name}] {len(prices)} price records.")

    result = parse_and_compute(rows)
    latest = result["latest"]
    w2 = result["windows"]["2yr"]
    w5 = result["windows"]["5yr"]
    print(f"  [{name}] Latest: {latest['date']}  net_long_pct_oi={latest['net_long_pct_oi']:.2f}%")
    print(f"  [{name}] 2yr: {w2['percentile']} → {w2['classification']}")
    print(f"  [{name}] 5yr: {w5['percentile']} → {w5['classification']}")
    if result["windows"]["disagree"]:
        print(f"  [{name}] ⚠  2yr and 5yr disagree.")

    print(f"  [{name}] Computing track record...")
    track_record = compute_signal_track_record(result["series"], prices)
    for zone in ("crowded", "capitulated"):
        z = track_record[zone]
        suffix = " (thin sample)" if z["thin_sample"] else ""
        print(f"  [{name}] {zone.capitalize()}: {z['sample_count']} events{suffix}")

    cot_data = {
        "series": result["series"],
        "latest": latest,
        "windows": result["windows"],
        "signal_track_record": track_record,
    }
    return cot_data, prices


def _compute_gsr_series(gold_spot: dict, silver_spot: dict) -> list[dict]:
    """
    Computes weekly Gold/Silver Ratio from spot price dicts (GC=F / SI=F).
    Both are USD per troy oz so the ratio is directly comparable to the
    published GSR (e.g. 80:1, 60:1).
    """
    common_dates = sorted(set(gold_spot) & set(silver_spot))
    series = []
    for date in common_dates:
        g = gold_spot[date]
        s = silver_spot[date]
        if s and s > 0:
            series.append({"date": date, "gsr": round(g / s, 1)})
    print(f"\n  [GSR] {len(series)} weekly data points computed.")
    return series


def main():
    print("ArgentVigil pipeline starting...")
    db.init_db()

    silver, silver_prices = _run_metal("Silver", fetch_cot_data, fetch_silver_prices, db.insert_silver_rows)
    gold, gold_prices = _run_metal("Gold", fetch_gold_cot_data, fetch_gold_prices, db.insert_gold_rows)
    db.upsert_prices("SLV", silver_prices)
    db.upsert_prices("GLD", gold_prices)

    print("\n  [GSR] Fetching spot prices (GC=F, SI=F)...")
    gold_spot = fetch_spot_prices("GC=F", years=8)
    silver_spot = fetch_spot_prices("SI=F", years=8)
    db.upsert_prices("GC=F", gold_spot)
    db.upsert_prices("SI=F", silver_spot)
    gsr_series = _compute_gsr_series(gold_spot, silver_spot)

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "cot_as_of_date": silver["latest"]["date"],
        # Silver (top-level keys preserved for backwards compat)
        "series": silver["series"],
        "latest": silver["latest"],
        "windows": silver["windows"],
        "signal_track_record": silver["signal_track_record"],
        # Gold
        "gold": {
            "series": gold["series"],
            "latest": gold["latest"],
            "windows": gold["windows"],
            "signal_track_record": gold["signal_track_record"],
        },
        "gsr_series": gsr_series,
        "macro_watchlist": _load_existing_watchlist(),
    }

    os.makedirs(os.path.dirname(_CACHE_PATH), exist_ok=True)
    with open(_CACHE_PATH, "w") as f:
        json.dump(output, f, indent=2)

    db.record_pipeline_run(output["generated_at"])

    print(f"\n  Cache written to {_CACHE_PATH}")


def _load_existing_watchlist() -> dict:
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
