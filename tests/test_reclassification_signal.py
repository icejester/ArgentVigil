"""backend/delivery_behavior.py's compute_reclassification_signal — the
Delivery Behavior tab's "Reclassification vs. Real Inflow" chart data.

Covers the 2026-07 rework (CLAUDE.md, Tab: Inventory / Delivery Behavior):
bi-directional flag_type (reclassification vs. deregistration), every-day
emission (not just candidate days), the issued-not-issued+stopped
double-count fix, gold support with its own contract size, and
coverage_start_date."""

from backend import db
from backend.delivery_behavior import compute_reclassification_signal
from backend.units import GOLD_CONTRACT_OZ, SILVER_CONTRACT_OZ


def _agg_row(date, total, registered, eligible=None):
    return {
        "date": date,
        "total": total,
        "registered": registered,
        "eligible": eligible if eligible is not None else total - registered,
        "reg_eligible_ratio": None,
    }


def _delivery_row(date, issued, stopped, type_="ytd"):
    return {"date": date, "type": type_, "daily_issued": issued, "daily_stopped": stopped}


def _by_date(days):
    return {d["date"]: d for d in days}


def test_unsupported_metal_is_unavailable(tmp_db):
    result = compute_reclassification_signal("XPT")
    assert result["available"] is False
    assert result["days"] == []


def test_every_real_day_is_emitted_not_just_candidates(tmp_db):
    """The original design skipped any day that wasn't a registered increase
    with delivery coverage — this was changed so the chart can show
    anomalies in the context of the whole series, not just isolated flagged
    days."""
    db.upsert_aggregate_rows([
        _agg_row("2026-07-01", total=100_000, registered=50_000),
        _agg_row("2026-07-02", total=100_000, registered=50_000),  # flat day
        _agg_row("2026-07-03", total=90_000, registered=40_000),   # real drop
    ])
    result = compute_reclassification_signal("XAG")
    assert result["available"] is True
    dates = [d["date"] for d in result["days"]]
    assert dates == ["2026-07-01", "2026-07-02", "2026-07-03"]
    # First row has no prior value to diff against.
    assert result["days"][0]["registered_delta"] is None
    # Flat day: a real zero delta, not omitted.
    assert result["days"][1]["registered_delta"] == 0
    assert result["days"][1]["flag_type"] is None


def test_reclassification_flag_on_low_coverage_increase(tmp_db):
    """Registered rises 500,000 oz; delivery volume (1 contract * 5,000 oz)
    covers 1% of that — well under the 10% threshold, so this looks like
    reclassification of existing eligible stock, not fresh metal."""
    db.upsert_aggregate_rows([
        _agg_row("2026-07-01", total=1_000_000, registered=500_000),
        _agg_row("2026-07-02", total=1_500_000, registered=1_000_000),
    ])
    db.upsert_delivery_rows([_delivery_row("2026-07-02", issued=1, stopped=1)])

    result = compute_reclassification_signal("XAG")
    day = _by_date(result["days"])["2026-07-02"]
    assert day["registered_delta"] == 500_000
    assert day["delivery_volume_oz"] == SILVER_CONTRACT_OZ  # 1 contract
    assert day["flag_type"] == "reclassification"
    assert day["flagged"] is True


def test_deregistration_flag_on_low_coverage_decrease(tmp_db):
    """The mirror case: registered FALLS with low matching delivery volume
    — looks like registered stock reclassified back to eligible, not metal
    actually leaving COMEX custody."""
    db.upsert_aggregate_rows([
        _agg_row("2026-07-01", total=1_000_000, registered=1_000_000),
        _agg_row("2026-07-02", total=500_000, registered=500_000),
    ])
    db.upsert_delivery_rows([_delivery_row("2026-07-02", issued=1, stopped=1)])

    result = compute_reclassification_signal("XAG")
    day = _by_date(result["days"])["2026-07-02"]
    assert day["registered_delta"] == -500_000
    assert day["flag_type"] == "deregistration"
    assert day["flagged"] is True


def test_normal_move_when_delivery_covers_at_least_ten_percent(tmp_db):
    """Registered rises 50,000 oz; delivery volume covers 100% of it —
    a real, well-explained increase, not flagged."""
    db.upsert_aggregate_rows([
        _agg_row("2026-07-01", total=1_000_000, registered=500_000),
        _agg_row("2026-07-02", total=1_050_000, registered=550_000),
    ])
    db.upsert_delivery_rows([_delivery_row("2026-07-02", issued=10, stopped=10)])  # 50,000 oz

    result = compute_reclassification_signal("XAG")
    day = _by_date(result["days"])["2026-07-02"]
    assert day["flag_type"] is None
    assert day["flagged"] is False


def test_delivery_volume_uses_issued_alone_not_issued_plus_stopped(tmp_db):
    """Regression test for the 2026-07-22 double-count bug: issued and
    stopped are the two sides of the SAME clearing notice (always equal on
    CME's own report), so summing them double-counted every notice and made
    the 10% threshold twice as lenient as intended. delivery_volume_oz must
    equal issued * contract_oz, not (issued + stopped) * contract_oz."""
    db.upsert_aggregate_rows([
        _agg_row("2026-07-01", total=1_000_000, registered=500_000),
        _agg_row("2026-07-02", total=1_100_000, registered=600_000),
    ])
    db.upsert_delivery_rows([_delivery_row("2026-07-02", issued=4, stopped=4)])  # 20,000 oz, not 40,000

    result = compute_reclassification_signal("XAG")
    day = _by_date(result["days"])["2026-07-02"]
    assert day["delivery_volume_oz"] == 4 * SILVER_CONTRACT_OZ
    # 20,000 / 100,000 = 20% coverage — real, above the 10% threshold, so
    # this must NOT be flagged. The pre-fix (issued+stopped) formula would
    # have doubled this to 40,000 oz / 40% coverage — same conclusion here,
    # so the exact delivery_volume_oz assertion above is what actually
    # catches a regression, not this flag check alone.
    assert day["flag_type"] is None


def test_no_delivery_coverage_for_date_leaves_flag_type_none(tmp_db):
    """A day with a real registered move but no delivery_notices row at all
    for that date is a data-coverage gap, not evidence of zero delivery
    activity — must not be flagged (that would conflate 'no data' with 'no
    match')."""
    db.upsert_aggregate_rows([
        _agg_row("2026-07-01", total=1_000_000, registered=500_000),
        _agg_row("2026-07-02", total=1_500_000, registered=1_000_000),
    ])
    # No delivery_notices row for 2026-07-02 at all.

    result = compute_reclassification_signal("XAG")
    day = _by_date(result["days"])["2026-07-02"]
    assert day["delivery_volume_oz"] is None
    assert day["flag_type"] is None
    assert day["flagged"] is False


def test_gold_uses_gold_contract_size_not_silver(tmp_db):
    """Gold contracts are 100 oz, not silver's 5,000 — using the wrong
    constant would silently mis-scale delivery_volume_oz and the 10%
    threshold check for gold."""
    db.upsert_gold_aggregate_rows([
        _agg_row("2026-07-01", total=100_000, registered=50_000),
        _agg_row("2026-07-02", total=110_000, registered=60_000),
    ])
    db.upsert_gold_delivery_rows([_delivery_row("2026-07-02", issued=50, stopped=50)])  # 5,000 oz

    result = compute_reclassification_signal("XAU")
    assert result["available"] is True
    day = _by_date(result["days"])["2026-07-02"]
    assert day["delivery_volume_oz"] == 50 * GOLD_CONTRACT_OZ
    # 5,000 / 10,000 = 50% coverage, real, not flagged.
    assert day["flag_type"] is None


def test_gold_and_silver_are_independent_series(tmp_db):
    """Confirms XAU reads gold_inventory_aggregate/gold_delivery_notices,
    not silver's tables — a real bug class if the metal branch were wired
    wrong (e.g. gold requests silently returning silver's numbers)."""
    db.upsert_aggregate_rows([_agg_row("2026-07-01", total=999_999, registered=1)])
    db.upsert_gold_aggregate_rows([_agg_row("2026-07-01", total=1_234, registered=1)])

    silver_days = compute_reclassification_signal("XAG")["days"]
    gold_days = compute_reclassification_signal("XAU")["days"]
    assert silver_days[0]["total_oz"] == 999_999
    assert gold_days[0]["total_oz"] == 1_234


def test_coverage_start_date_is_earliest_real_delivery_notice_date(tmp_db):
    db.upsert_aggregate_rows([
        _agg_row("2026-06-01", total=100, registered=50),
        _agg_row("2026-07-01", total=200, registered=100),
    ])
    db.upsert_delivery_rows([
        _delivery_row("2026-07-01", issued=1, stopped=1),
        _delivery_row("2026-06-15", issued=1, stopped=1),
    ])

    result = compute_reclassification_signal("XAG")
    assert result["coverage_start_date"] == "2026-06-15"


def test_coverage_start_date_is_none_with_no_delivery_notices(tmp_db):
    db.upsert_aggregate_rows([_agg_row("2026-07-01", total=100, registered=50)])
    result = compute_reclassification_signal("XAG")
    assert result["coverage_start_date"] is None
