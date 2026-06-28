"""
Transforms raw CoT API rows into net_long_pct_oi time series and computes
trailing percentiles for the 2yr and 5yr lookback windows.
"""

from config import WINDOW_2YR, WINDOW_5YR, CROWDED_THRESHOLD, CAPITULATED_THRESHOLD


def _percentile_rank(series: list[float], value: float) -> float:
    """
    Returns the percentile rank of `value` within `series` (0–100).
    Fraction of series values strictly less than value, times 100.
    """
    if not series:
        return float("nan")
    below = sum(1 for v in series if v < value)
    return round(below / len(series) * 100, 1)


def classify_signal(percentile: float) -> str:
    if percentile >= CROWDED_THRESHOLD:
        return "Specs crowded long — caution"
    if percentile <= CAPITULATED_THRESHOLD:
        return "Specs capitulated — back-up-the-truck zone"
    return "Normal range — no signal"


def parse_and_compute(rows: list[dict]) -> dict:
    """
    Accepts raw API rows (list of dicts), computes net_long_pct_oi for each
    week, then derives 2yr/5yr trailing percentiles for the most recent reading.

    Returns a dict with:
      - series: list of {date, net_long, open_interest, net_long_pct_oi}
      - latest: the most recent record with percentile/classification data
      - windows: {"2yr": {...}, "5yr": {...}}
    """
    series = []
    for row in rows:
        try:
            date_str = row["report_date_as_yyyy_mm_dd"][:10]  # YYYY-MM-DD
            nc_long = float(row.get("noncomm_positions_long_all") or 0)
            nc_short = float(row.get("noncomm_positions_short_all") or 0)
            oi = float(row.get("open_interest_all") or 0)
        except (KeyError, ValueError):
            continue

        if oi <= 0:
            continue

        net_long = nc_long - nc_short
        net_long_pct_oi = round(net_long / oi * 100, 4)

        series.append({
            "date": date_str,
            "net_long": net_long,
            "open_interest": oi,
            "net_long_pct_oi": net_long_pct_oi,
        })

    if not series:
        raise ValueError("No usable rows returned from CFTC API.")

    # Series is already sorted oldest-first from the API query
    pct_series = [r["net_long_pct_oi"] for r in series]
    latest = series[-1]
    current_val = latest["net_long_pct_oi"]

    def window_stats(n: int) -> dict:
        window = pct_series[-(n + 1):-1] if len(pct_series) > n else pct_series[:-1]
        pct = _percentile_rank(window, current_val)
        return {
            "percentile": pct,
            "window_size": len(window),
            "classification": classify_signal(pct),
        }

    windows = {
        "2yr": window_stats(WINDOW_2YR),
        "5yr": window_stats(WINDOW_5YR),
    }

    # Flag when the two windows disagree on classification
    windows["disagree"] = (
        windows["2yr"]["classification"] != windows["5yr"]["classification"]
    )

    return {
        "series": series,
        "latest": latest,
        "windows": windows,
    }
