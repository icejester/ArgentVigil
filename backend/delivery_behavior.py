"""
Delivery Behavior layer. See deliveryBehavior-spec.md for the full spec and
story list.

Phase A (reclassification + deficit-context signals) is pure computation over
data AV already persists (inventory_aggregate/gold_inventory_aggregate,
delivery_notices/gold_delivery_notices, silver_market_balance.json) — no new
upstream fetch, no new tables beyond gold_delivery_notices itself. Both
metals have delivery-notices/inventory-aggregate coverage as of 2026-07-22
(main.py's delivery-notices routes cover symbol=XAG and symbol=XAU — gold was
originally never wired up, not because metalcharts.org's endpoint doesn't
support it; confirmed live it does, matching CME's own official
MetalsIssuesAndStopsReport.pdf for a spot-checked date). A metal outside
RECLASSIFICATION_SUPPORTED_METALS still gets a documented "unavailable"
result rather than silently returning empty/misleading data.

Phase B adds disaggregated CoT category composition (story #2), fetched via
pipeline/fetch.py + persisted to cot_disaggregated (both metals — CFTC's
Disaggregated Futures-Only Socrata dataset covers XAG and XAU, unlike
delivery_notices/inventory_aggregate above). contract_month_oi and the
seasonal-baseline/OI-decay signal (story #1) and price lead/lag (story #5)
are OUT OF SCOPE, permanently, not deferred: CME's real per-contract-month
OI/settlement data is a paid Market Data Platform product
(cmegroup.com/market-data/market-data-api.html, tiered pricing from
$0.50/GB), not a free scrapeable source — confirmed live, this isn't a
reverse-engineering gap like metalcharts.org/ForexFactory turned out to be.

First Notice Day / Last Trade Day are computed on the fly, not seeded from a
table — no fnd_calendar exists. Last Trade Day is confirmed directly against
CME's own COMEX rulebook (Chapters 112/113, PDFs saved to seed_data/cme/ for
reference) and contract-specs pages: third-last business day of the delivery
month, identical rule for both silver and gold. First Notice Day is NOT
stated by that term in Chapters 112/113 (they only describe the delivery/
settlement window, a related but distinct concept from FND) — the rule used
here (FND = last business day of the month BEFORE the delivery month) is
confirmed instead against a real, verifiable example: COMEX's May 2026 silver
contract's First Notice Day was reported as April 30, 2026 (a Thursday, the
last business day of April) — an earlier draft of this module incorrectly
inferred FND = first business day of the delivery month itself from
Chapter 112's settlement-window text, which the April 30 example disproves.
Both metals list monthly contracts on a rolling basis (silver: 26 consecutive
months + Jul/Dec out to 60 months; gold: 26 consecutive months + Jun/Dec out
to 72 months) — i.e. effectively every calendar month trades, not a small
fixed set of "active" months as originally assumed in
deliveryBehavior-spec.md. That rolling-every-month reality is exactly why
this is computed per-month on demand rather than seeded: there's no small
static list to maintain, just a pure date rule. "business day" here means
weekday only (Mon-Fri) — deliberately NOT holiday-aware (no Thanksgiving/
Christmas/etc. adjustment), so a real FND/LTD can be off by up to a day or
two in months containing a market holiday near the start/end of the month.
Acceptable for this signal's purpose (an approximate seasonal-timing marker),
not meant as an exact trading-calendar reference.
"""

from datetime import date, timedelta

from . import db
from .units import SILVER_CONTRACT_OZ, GOLD_CONTRACT_OZ


def _is_weekday(d: date) -> bool:
    return d.weekday() < 5


def _prev_month(year: int, month: int) -> tuple[int, int]:
    return (year - 1, 12) if month == 1 else (year, month - 1)


def last_business_day(year: int, month: int) -> date:
    """Last weekday of the given month."""
    if month == 12:
        next_month_first = date(year + 1, 1, 1)
    else:
        next_month_first = date(year, month + 1, 1)
    d = next_month_first - timedelta(days=1)
    while not _is_weekday(d):
        d -= timedelta(days=1)
    return d


def first_notice_day(year: int, month: int) -> date:
    """First Notice Day for the given delivery month: last business day of the
    PRECEDING month (confirmed against COMEX's real May 2026 silver contract,
    FND=2026-04-30 — see module docstring)."""
    prev_year, prev_month = _prev_month(year, month)
    return last_business_day(prev_year, prev_month)


def last_trade_day(year: int, month: int) -> date:
    """Third-last weekday of the given delivery month (confirmed directly
    against COMEX rulebook Chapters 112/113's Termination of Trading rule)."""
    if month == 12:
        next_month_first = date(year + 1, 1, 1)
    else:
        next_month_first = date(year, month + 1, 1)
    d = next_month_first - timedelta(days=1)
    weekdays_seen = 0
    while True:
        if _is_weekday(d):
            weekdays_seen += 1
            if weekdays_seen == 3:
                return d
        d -= timedelta(days=1)


def days_to_fnd(report_date: date) -> int:
    """Days from report_date to the NEXT upcoming First Notice Day (which, per
    the FND rule above, is always the last business day of report_date's own
    calendar month — the FND for next month's delivery contract). Non-negative
    as long as report_date itself falls on a weekday within that month (true
    for every current caller — CFTC reports are always dated a business day);
    passing a weekend date or a date past that month's own last business day
    would need report_date's calendar month reinterpreted, which this function
    does not attempt. Note this is a calendar-position marker only, not a claim
    about which contract month any specific position is actually in — see
    compute_category_composition's docstring."""
    fnd = last_business_day(report_date.year, report_date.month)
    return (fnd - report_date).days

RECLASSIFICATION_SUPPORTED_METALS = {"XAG", "XAU"}

DISAGGREGATED_CATEGORIES = ("producer_merchant", "swap_dealer", "managed_money", "other_reportable")


def compute_reclassification_signal(metal: str, limit: int | None = None) -> dict:
    """
    Returns one row per day with real inventory_aggregate history (not just
    registered-increase days — this is also the data source for the "Reclassification
    vs. Real Inflow" chart's full physical-stack view, per the user's 2026-07-22
    request to see anomalous days in the context of the whole series, not in isolation).
    Each day carries both registered_delta and total_delta unconditionally.

    `flag_type` is bi-directional, per the user's 2026-07-22 observation that a
    multi-month registered drawdown deserved the same scrutiny as a registered
    increase, not just a one-directional "is this reclassification" check:
      - "reclassification": registered ROSE and that day's delivery-notice volume
        (delivery_notices, ytd type — confirmed live against metalcharts.org that
        type="ytd" returns ~85 days back to start-of-year vs. type="mtd"'s
        days-in-month-so-far, at no extra fetch cost; dailyIssued/dailyStopped are
        the working fields on both, see CLAUDE.md's documented mtdCumulative/
        ytdCumulative gap, which doesn't affect these fields) covered less than 10%
        of the increase — consistent with existing eligible stock being
        re-designated registered rather than fresh metal arriving (spec story #3).
      - "deregistration": the mirror case — registered FELL and that day's delivery
        volume covered less than 10% of the drop — consistent with registered stock
        being re-designated back to eligible (still in the vault, never left) rather
        than physically withdrawn from COMEX custody.
    Neither direction is evidence of wrongdoing — both are normal, legal vault-operator
    actions; the flag only distinguishes "this registered move looks like a status
    change" from "this looks like metal actually crossing COMEX's door." `flagged`
    (bool) is kept as a derived convenience for any caller that only cares whether
    either flag fired, not which direction. Every day without a qualifying delta or
    without delivery-notice coverage that day is a real row with flag_type=None, not
    omitted — omitting non-candidate days was the original design but made the signal
    unreadable in context (only ever showing 5-ish flagged days with no sense of the
    normal day-to-day baseline around them).
    """
    if metal not in RECLASSIFICATION_SUPPORTED_METALS:
        return {
            "available": False,
            "reason": f"No delivery-notices/inventory-aggregate history persisted for {metal}.",
            "days": [],
        }

    if metal == "XAU":
        agg = db.get_gold_aggregate_history()
        delivery_by_date = {row["date"]: row for row in db.get_gold_delivery_history("ytd")}
        contract_oz = GOLD_CONTRACT_OZ
    else:
        agg = db.get_aggregate_history()
        delivery_by_date = {row["date"]: row for row in db.get_delivery_history("ytd")}
        contract_oz = SILVER_CONTRACT_OZ

    days = []
    prev_registered = None
    prev_had_registered = False
    prev_total = None
    for row in agg:
        registered = row["registered"]
        total = row["total"]
        # A None `registered` (metalcharts.org's "not reported" convention, see
        # CLAUDE.md's "Nulls over zeros") breaks the day-over-day chain: the next
        # real value's delta would span an unknown number of days, not one, and
        # can't be fairly compared against a single day's delivery-notice volume.
        # Reset the carry rather than bridge over the gap.
        if registered is None:
            prev_had_registered = False
            prev_total = total
            continue

        delta = (registered - prev_registered) if prev_had_registered else None
        total_delta = (total - prev_total) if (total is not None and prev_total is not None) else None
        prev_registered = registered
        prev_had_registered = True
        prev_total = total

        if delta is None:
            # First real row after a reset/gap has no prior value to diff against —
            # a real row still worth showing (total_oz on its own is meaningful),
            # just with no delta yet.
            days.append({
                "date": row["date"],
                "registered_delta": None,
                "delivery_volume_oz": None,
                "total_oz": total,
                "prev_total_oz": None,
                "total_delta": None,
                "flag_type": None,
                "flagged": False,
            })
            continue

        flag_type = None
        delivery_volume_oz = None
        if delta != 0:
            delivery_row = delivery_by_date.get(row["date"])
            # No delivery-notice row persisted for this date at all is a data-coverage
            # gap (delivery_notices only has history from whenever the mtd fetch
            # started), not evidence of zero delivery activity — leaves flag_type=None
            # rather than guessing, since flagging here would conflate "no data" with
            # "no match."
            if delivery_row is not None:
                issued = delivery_row["daily_issued"]
                stopped = delivery_row["daily_stopped"]
                if issued is not None or stopped is not None:
                    # daily_issued/daily_stopped are COMEX contract counts (5,000 oz/
                    # contract for silver, 100 oz/contract for gold, see CLAUDE.md's
                    # Units convention — contract_oz selected above per metal);
                    # registered_delta is raw troy oz from inventory_aggregate — must
                    # convert to the same unit before comparing, or every real delivery
                    # day looks like a reclassification. issued and stopped are the two
                    # sides of the same clearing notice (a seller's issue is always
                    # paired with a buyer's stop that same day) and are therefore always
                    # equal on CME's own daily report — confirmed 2026-07-22 against
                    # CME's real MetalsIssuesAndStopsReport.pdf, which shows TOTAL
                    # ISSUED == TOTAL STOPPED for gold/silver/copper alike. Summing them
                    # double-counts every notice; real daily delivery volume is just one
                    # side (they're interchangeable when equal, but `issued` is used for
                    # clarity since it's the "metal nominated for delivery" side this
                    # signal actually cares about).
                    delivery_volume_oz = (issued or stopped or 0) * contract_oz
                    if abs(delivery_volume_oz) < abs(delta) * 0.1:
                        flag_type = "reclassification" if delta > 0 else "deregistration"

        days.append({
            "date": row["date"],
            "registered_delta": round(delta, 2),
            "delivery_volume_oz": delivery_volume_oz,
            "total_oz": total,
            "prev_total_oz": total - total_delta if total_delta is not None else None,
            "total_delta": round(total_delta, 2) if total_delta is not None else None,
            "flag_type": flag_type,
            "flagged": flag_type is not None,
        })

    if limit:
        days = days[-limit:]

    return {
        "available": True,
        "reason": None,
        "days": days,
        "days_with_coverage": len(delivery_by_date),
        # Earliest real delivery_notices date — the frontend uses this to default
        # the chart's window to the span where flagging was actually possible,
        # rather than a hardcoded day count that silently drifts as delivery_notices'
        # own coverage grows forward (see CLAUDE.md's Delivery Notices note — this
        # table has no upstream backfill, so its start date only ever moves earlier
        # if a future feature adds one).
        "coverage_start_date": min(delivery_by_date) if delivery_by_date else None,
    }


def compute_category_composition(metal: str, limit: int | None = None) -> dict:
    """
    Disaggregated CoT category composition over time (spec story #2): what
    share of long open interest belongs to producer/merchant (routine
    commercial hedging) vs. swap dealers vs. managed money vs. other
    reportables (both typically speculative).

    Each week also carries days_to_fnd — an APPROXIMATE marker only, not a
    precision claim: the disaggregated CoT report aggregates positions across
    every open contract month for the commodity, so there is no way to know
    from this data whether a given category's long positions actually sit in
    the front (soon-to-deliver) month or a far-dated month. days_to_fnd here
    is computed from report_date's own calendar month's First Notice Day
    (first_notice_day/days_to_fnd below), purely as a directional "how close
    is this week to a delivery-month rollover" signal — it is NOT the "whose
    OI is persisting into delivery" cross-reference story #2 ultimately wants
    (that needs contract-month-level OI, which is paid-API-gated — see this
    module's docstring).
    """
    rows = db.get_disaggregated_series(metal)
    if not rows:
        return {"available": False, "reason": f"No disaggregated CoT data persisted for {metal}.", "weeks": []}

    by_date: dict[str, dict[str, dict]] = {}
    for row in rows:
        by_date.setdefault(row["report_date"], {})[row["category"]] = row

    weeks = []
    for report_date in sorted(by_date):
        cats = by_date[report_date]
        # All 4 categories are always inserted together from one shared CFTC
        # report row (see pipeline/run.py's _disaggregated_rows_for_db) and
        # carry an identical open_interest value — but insert_disaggregated_rows
        # is INSERT OR IGNORE per (date, metal, category), so a partial insert
        # (e.g. process killed mid-executemany) could leave some categories
        # missing for a date. Rather than trust one specific category's row to
        # always be present, take open_interest from whichever category rows
        # exist (they agree by construction) and flag incompleteness instead
        # of silently computing shares over a partial total.
        present = [c for c in DISAGGREGATED_CATEGORIES if c in cats]
        if len(present) < len(DISAGGREGATED_CATEGORIES):
            continue
        total_long = sum((cats[c]["long"] or 0) for c in present)
        if total_long <= 0:
            continue
        shares = {c: round((cats[c]["long"] or 0) / total_long * 100, 2) for c in present}
        weeks.append({
            "report_date": report_date,
            "open_interest": cats[present[0]]["open_interest"],
            "long_share_pct": shares,
            "days_to_fnd_approx": days_to_fnd(date.fromisoformat(report_date)),
        })

    if limit:
        weeks = weeks[-limit:]

    return {"available": True, "reason": None, "weeks": weeks}


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
