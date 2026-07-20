"""pipeline/compute.py pure functions — percentile math, signal
classification, and the CFTC-row normalization that produces
net_long_pct_oi."""

import math

import pytest

from pipeline.compute import (
    _percentile_rank,
    classify_signal,
    compute_from_series,
    parse_and_compute,
)
from pipeline.config import CAPITULATED_THRESHOLD, CROWDED_THRESHOLD


def test_percentile_rank_empty_series_is_nan():
    assert math.isnan(_percentile_rank([], 5.0))


def test_percentile_rank_midpoint():
    # 2 of 3 values strictly below 2.5 -> 66.7
    assert _percentile_rank([1.0, 2.0, 3.0], 2.5) == 66.7


def test_percentile_rank_extremes():
    series = [1.0, 2.0, 3.0, 4.0]
    assert _percentile_rank(series, 0.5) == 0.0
    assert _percentile_rank(series, 10.0) == 100.0


def test_classify_signal_zones():
    assert "crowded" in classify_signal(CROWDED_THRESHOLD)
    assert "crowded" in classify_signal(100.0)
    assert "capitulated" in classify_signal(CAPITULATED_THRESHOLD)
    assert "capitulated" in classify_signal(0.0)
    assert "Normal" in classify_signal(50.0)
    # Boundaries are inclusive on the signal side, exclusive just inside
    assert "Normal" in classify_signal(CROWDED_THRESHOLD - 0.1)
    assert "Normal" in classify_signal(CAPITULATED_THRESHOLD + 0.1)


def _cftc_row(date: str, long_: float, short: float, oi: float) -> dict:
    return {
        "report_date_as_yyyy_mm_dd": f"{date}T00:00:00.000",
        "noncomm_positions_long_all": str(long_),
        "noncomm_positions_short_all": str(short),
        "open_interest_all": str(oi),
    }


def test_parse_and_compute_net_long_pct_oi_math():
    rows = [
        _cftc_row("2026-01-06", 60000, 20000, 130000),
        _cftc_row("2026-01-13", 55000, 25000, 125000),
    ]
    result = parse_and_compute(rows)
    assert len(result["series"]) == 2
    first = result["series"][0]
    assert first["date"] == "2026-01-06"
    assert first["net_long"] == 40000
    assert first["net_long_pct_oi"] == round(40000 / 130000 * 100, 4)
    assert result["latest"]["date"] == "2026-01-13"


def test_parse_and_compute_skips_zero_oi_and_malformed_rows():
    rows = [
        _cftc_row("2026-01-06", 60000, 20000, 130000),
        _cftc_row("2026-01-13", 55000, 25000, 0),  # zero OI -> skipped
        {"garbage": True},  # malformed -> skipped
    ]
    result = parse_and_compute(rows)
    assert [r["date"] for r in result["series"]] == ["2026-01-06"]


def test_parse_and_compute_raises_on_no_usable_rows():
    with pytest.raises(ValueError):
        parse_and_compute([{"garbage": True}])


def test_compute_from_series_matches_parse_and_compute():
    """compute_from_series is documented as an additive twin of
    parse_and_compute for already-normalized rows — same windows/latest
    output for equivalent input."""
    raw = [_cftc_row(f"2026-01-{d:02d}", 60000 + d * 100, 20000, 130000) for d in range(1, 29)]
    from_raw = parse_and_compute(raw)
    from_series = compute_from_series(from_raw["series"])
    assert from_series["latest"] == from_raw["latest"]
    assert from_series["windows"] == from_raw["windows"]


def test_compute_from_series_raises_on_empty():
    with pytest.raises(ValueError):
        compute_from_series([])
