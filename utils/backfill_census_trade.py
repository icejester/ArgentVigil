#!/usr/bin/env python3
"""
backfill_census_trade.py

One-time historical backfill for the census_trade table, beyond what the
app's own rolling 5-month fetch window covers. Walks month-by-month from a
start date up through (but not including) the months the regular fetch
already keeps warm, persisting via the same upsert path.

Requires CENSUS_API_KEY in the environment (.env or shell-exported) and the
backend's venv (imports backend.db and httpx — not stdlib-only, unlike
pipeline/).

Run:
    source .venv/bin/activate
    python utils/backfill_census_trade.py --start 2015-01

Paced with a delay between requests (DELAY_S) to stay well under Census's
rate limit for a large sequential pull — this is a one-time backfill, not a
tight loop, so there's no reason to hurry it.
"""

import argparse
import asyncio
import os
import sys
from datetime import date

import httpx
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()

from backend import db  # noqa: E402

CENSUS_TRADE_BASE = "https://api.census.gov/data/timeseries/intltrade"
CENSUS_TRADE_HS_CODES = {"XAG": "7106", "XAU": "7108"}
CENSUS_TRADE_FLOWS = {
    "import": {
        "path": "imports/hs",
        "commodity_param": "I_COMMODITY",
        "value_general_field": "GEN_VAL_MO",
        "value_consumption_field": "CON_VAL_MO",
        "qty_field": "GEN_QY1_MO",
    },
    "export": {
        "path": "exports/hs",
        "commodity_param": "E_COMMODITY",
        "value_general_field": "ALL_VAL_MO",
        "value_consumption_field": None,
        "qty_field": "QTY_1_MO",
    },
}
DELAY_S = 0.5  # pace between requests — a one-time backfill, no reason to hurry


def _months_between(start: str, end_exclusive: str) -> list[str]:
    """'YYYY-MM' strings from start up to (not including) end_exclusive."""
    y, m = int(start[:4]), int(start[5:7])
    end_y, end_m = int(end_exclusive[:4]), int(end_exclusive[5:7])
    months = []
    while (y, m) < (end_y, end_m):
        months.append(f"{y:04d}-{m:02d}")
        m += 1
        if m == 13:
            m, y = 1, y + 1
    return months


async def fetch_month(client: httpx.AsyncClient, api_key: str, metal: str, hs_code: str,
                       flow: str, spec: dict, month: str) -> list[dict]:
    get_fields = ["CTY_CODE", "CTY_NAME", spec["value_general_field"]]
    if spec["value_consumption_field"]:
        get_fields.append(spec["value_consumption_field"])
    get_fields += [spec["qty_field"], "UNIT_QY1"]

    resp = await client.get(
        f"{CENSUS_TRADE_BASE}/{spec['path']}",
        params={
            "get": ",".join(get_fields),
            spec["commodity_param"]: hs_code,
            "time": month,
            "key": api_key,
        },
        timeout=30,
    )
    resp.raise_for_status()
    if resp.status_code == 204 or not resp.content:
        return []

    payload = resp.json()
    header, *data_rows = payload
    col_idx = {name: i for i, name in enumerate(header)}

    rows = []
    for r in data_rows:
        qty_raw = r[col_idx[spec["qty_field"]]]
        unit_raw = r[col_idx["UNIT_QY1"]]
        qty = None if qty_raw in (None, "0", "-") else float(qty_raw)
        qty_unit = None if unit_raw in (None, "-") else unit_raw
        con_val = None
        if spec["value_consumption_field"]:
            con_val = int(r[col_idx[spec["value_consumption_field"]]])
        rows.append({
            "metal": metal,
            "flow": flow,
            "hs_code": hs_code,
            "cty_code": r[col_idx["CTY_CODE"]],
            "cty_name": r[col_idx["CTY_NAME"]],
            "year": int(month[:4]),
            "month": int(month[5:7]),
            "value_general_usd": int(r[col_idx[spec["value_general_field"]]]),
            "value_consumption_usd": con_val,
            "qty": qty,
            "qty_unit": qty_unit,
        })
    return rows


async def main(start: str, end_exclusive: str):
    if "CENSUS_API_KEY" not in os.environ:
        print("CENSUS_API_KEY not set — aborting.", file=sys.stderr)
        sys.exit(1)
    api_key = os.environ["CENSUS_API_KEY"]

    db.init_db()
    months = _months_between(start, end_exclusive)
    total_calls = len(months) * len(CENSUS_TRADE_HS_CODES) * len(CENSUS_TRADE_FLOWS)
    print(f"Backfilling {start} through {end_exclusive} (exclusive) — "
          f"{len(months)} months x 2 metals x 2 flows = {total_calls} requests, "
          f"paced {DELAY_S}s apart (~{total_calls * DELAY_S / 60:.1f} min).")

    persisted, empty, errors = 0, 0, 0
    async with httpx.AsyncClient() as client:
        for month in months:
            for metal, hs_code in CENSUS_TRADE_HS_CODES.items():
                for flow, spec in CENSUS_TRADE_FLOWS.items():
                    try:
                        rows = await fetch_month(client, api_key, metal, hs_code, flow, spec, month)
                    except httpx.HTTPError as e:
                        print(f"  [error] {metal} {flow} {month}: {e}", file=sys.stderr)
                        errors += 1
                        await asyncio.sleep(DELAY_S)
                        continue
                    if rows:
                        db.upsert_census_trade_rows(rows)
                        persisted += len(rows)
                    else:
                        empty += 1
                    await asyncio.sleep(DELAY_S)
            print(f"  {month}: done ({persisted} rows persisted so far, {empty} empty, {errors} errors)")

    print(f"\nBackfill complete: {persisted} rows persisted, {empty} empty responses, {errors} errors.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", default="2015-01", help="First month to backfill, YYYY-MM (default: 2015-01)")
    parser.add_argument("--end-exclusive", default=None,
                         help="Stop before this month, YYYY-MM (default: earliest month already persisted, or today)")
    args = parser.parse_args()

    end_exclusive = args.end_exclusive
    if end_exclusive is None:
        earliest_persisted = None
        db.init_db()
        with db.get_conn() as conn:
            row = conn.execute("SELECT MIN(year * 100 + month) AS ym FROM census_trade").fetchone()
            ym = row["ym"] if row else None
            if ym is not None:
                earliest_persisted = f"{ym // 100:04d}-{ym % 100:02d}"
        end_exclusive = earliest_persisted or date.today().strftime("%Y-%m")

    asyncio.run(main(args.start, end_exclusive))
