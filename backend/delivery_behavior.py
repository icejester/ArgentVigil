"""
Delivery Behavior layer — Phase A (reclassification + deficit-context signals).
See deliveryBehavior-spec.md for the full spec and story list.

Phase A is pure computation over data AV already persists (inventory_aggregate,
delivery_notices, silver_market_balance.json) — no new upstream fetch, no new
tables. Only silver has delivery_notices/inventory_aggregate coverage today
(main.py's delivery-notices route is hardcoded to symbol=XAG, and there is no
gold equivalent) — gold requests get a documented "unavailable" result rather
than silently returning empty/misleading data.
"""

from . import db

RECLASSIFICATION_SUPPORTED_METALS = {"XAG"}
SILVER_CONTRACT_OZ = 5_000  # COMEX silver contract size, see CLAUDE.md's Units convention


def compute_reclassification_signal(metal: str, limit: int | None = None) -> dict:
    """
    For each day, compares that day's registered-inventory delta (inventory_aggregate)
    against that day's delivery-notice volume (delivery_notices, ytd type — confirmed
    live against metalcharts.org that type="ytd" returns ~85 days back to start-of-year
    vs. type="mtd"'s handful of days-in-month, at no extra fetch cost; dailyIssued/
    dailyStopped are the working fields on both, see CLAUDE.md's documented
    mtdCumulative/ytdCumulative gap, which doesn't affect these fields). Flags days
    where registered inventory rose with little/no matching delivery activity — a
    signal that the increase looks like reclassification of existing eligible stock
    rather than fresh metal (spec story #3).
    """
    if metal not in RECLASSIFICATION_SUPPORTED_METALS:
        return {
            "available": False,
            "reason": f"No delivery-notices/inventory-aggregate history persisted for {metal}.",
            "days": [],
        }

    agg = db.get_aggregate_history()
    delivery_by_date = {
        row["date"]: row for row in db.get_delivery_history("ytd")
    }

    days = []
    prev_registered = None
    prev_had_registered = False
    for row in agg:
        registered = row["registered"]
        # A None `registered` (metalcharts.org's "not reported" convention, see
        # CLAUDE.md's "Nulls over zeros") breaks the day-over-day chain: the next
        # real value's delta would span an unknown number of days, not one, and
        # can't be fairly compared against a single day's delivery-notice volume.
        # Reset the carry rather than bridge over the gap.
        if registered is None:
            prev_had_registered = False
            continue

        delta = (registered - prev_registered) if prev_had_registered else None
        prev_registered = registered
        prev_had_registered = True

        if delta is None or delta <= 0:
            continue

        delivery_row = delivery_by_date.get(row["date"])
        if delivery_row is None:
            # No delivery-notice row persisted for this date at all — a data-coverage
            # gap (delivery_notices only has history from whenever the mtd fetch
            # started), not evidence of zero delivery activity. Skip rather than
            # flag, since flagging here would conflate "no data" with "no match."
            continue

        issued = delivery_row["daily_issued"]
        stopped = delivery_row["daily_stopped"]
        if issued is None and stopped is None:
            continue
        # daily_issued/daily_stopped are COMEX contract counts (5,000 oz/contract
        # for silver, see CLAUDE.md's Units convention); registered_delta is raw
        # troy oz from inventory_aggregate — must convert to the same unit before
        # comparing, or every real delivery day looks like a reclassification.
        delivery_volume_oz = ((issued or 0) + (stopped or 0)) * SILVER_CONTRACT_OZ
        flagged = delivery_volume_oz < delta * 0.1
        days.append({
            "date": row["date"],
            "registered_delta": round(delta, 2),
            "delivery_volume_oz": delivery_volume_oz,
            "flagged": flagged,
        })

    if limit:
        days = days[-limit:]

    return {
        "available": True,
        "reason": None,
        "days": days,
        "days_with_coverage": len(delivery_by_date),
    }


def compute_deficit_context(market_balance_rows: list[dict]) -> dict:
    """
    Packages the existing multi-year Silver Institute deficit trend (Layer 3,
    silver_market_balance.json, read by main.py) alongside this layer's short-term
    delivery-anomaly window, so a frontend can render both on a shared timeline
    without conflating a slow structural deficit with a short-term delivery blip
    (spec story #6). Pure repackaging of an existing series — no new computation
    beyond what main.py's /api/silver/market-balance already does.
    """
    rows = sorted(market_balance_rows, key=lambda r: r["year"])
    return {
        "annual_net_balance_moz": [
            {"year": r["year"], "net_balance_moz": r.get("net_balance_moz")}
            for r in rows
        ],
    }
