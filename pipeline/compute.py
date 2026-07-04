"""
Transforms raw CoT API rows into net_long_pct_oi time series, computes
trailing percentiles, and joins price data to produce signal hit-rate stats.
"""

try:
    from .config import WINDOW_2YR, WINDOW_5YR, CROWDED_THRESHOLD, CAPITULATED_THRESHOLD
except ImportError:
    from config import WINDOW_2YR, WINDOW_5YR, CROWDED_THRESHOLD, CAPITULATED_THRESHOLD

LOOKAHEAD_WEEKS = [4, 8]
MIN_SAMPLE_FOR_CONCLUSIONS = 5


def _percentile_rank(series: list[float], value: float) -> float:
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
    series = []
    for row in rows:
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
        net_long_pct_oi = round(net_long / oi * 100, 4)

        series.append({
            "date": date_str,
            "net_long": net_long,
            "open_interest": oi,
            "net_long_pct_oi": net_long_pct_oi,
        })

    if not series:
        raise ValueError("No usable rows returned from CFTC API.")

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
    windows["disagree"] = (
        windows["2yr"]["classification"] != windows["5yr"]["classification"]
    )

    return {
        "series": series,
        "latest": latest,
        "windows": windows,
    }


def compute_from_series(series: list[dict]) -> dict:
    """
    Same percentile/window/classification logic as parse_and_compute, but for
    a series already normalized to {date, net_long, open_interest,
    net_long_pct_oi} (e.g. read back from SQLite) rather than raw CFTC rows.
    """
    if not series:
        raise ValueError("No usable rows in series.")

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
    windows["disagree"] = (
        windows["2yr"]["classification"] != windows["5yr"]["classification"]
    )

    return {
        "series": series,
        "latest": latest,
        "windows": windows,
    }


def compute_signal_track_record(series: list[dict], prices: dict[str, float]) -> dict:
    """
    Joins CoT series with price data and computes historical hit rates for
    crowded-long and capitulated signal zones.

    For each week in the series, computes the rolling 5yr percentile at that
    point in time (so we don't look ahead into history the signal wouldn't
    have had). Then for weeks that crossed into a signal zone, measures whether
    price moved in the "expected" direction at +4w and +8w.

    Crowded signal "correct" = price lower at +Nw (downside flush materialized).
    Capitulated signal "correct" = price higher at +Nw (recovery materialized).
    """
    try:
        from .price_fetch import align_price_to_cot_week
    except ImportError:
        from price_fetch import align_price_to_cot_week

    n = len(series)
    results = {"crowded": {}, "capitulated": {}, "thin_sample_warning": False}

    for zone in ("crowded", "capitulated"):
        events = []  # each: {date, price_at_signal, price_4w, price_8w, pct_chg_4w, pct_chg_8w}

        for i in range(WINDOW_5YR, n):
            # Rolling 5yr percentile using only data available at week i
            window = [r["net_long_pct_oi"] for r in series[max(0, i - WINDOW_5YR):i]]
            current = series[i]["net_long_pct_oi"]
            pct = _percentile_rank(window, current)

            in_zone = (
                pct >= CROWDED_THRESHOLD if zone == "crowded"
                else pct <= CAPITULATED_THRESHOLD
            )
            if not in_zone:
                continue

            # Need forward price data at +4w and +8w
            max_lookahead = max(LOOKAHEAD_WEEKS)
            if i + max_lookahead >= n:
                continue  # not enough future history yet

            signal_date = series[i]["date"]
            price_now = align_price_to_cot_week(signal_date, prices)
            if price_now is None:
                continue

            forward_prices = {}
            for weeks in LOOKAHEAD_WEEKS:
                future_date = series[i + weeks]["date"]
                p = align_price_to_cot_week(future_date, prices)
                forward_prices[weeks] = p

            if any(v is None for v in forward_prices.values()):
                continue

            event = {
                "date": signal_date,
                "percentile": round(pct, 1),
                "price_at_signal": round(price_now, 4),
            }
            for weeks in LOOKAHEAD_WEEKS:
                p_fwd = forward_prices[weeks]
                pct_chg = round((p_fwd - price_now) / price_now * 100, 2)
                event[f"price_{weeks}w"] = round(p_fwd, 4)
                event[f"pct_chg_{weeks}w"] = pct_chg
            events.append(event)

        lookahead_stats = {}
        for weeks in LOOKAHEAD_WEEKS:
            chg_key = f"pct_chg_{weeks}w"
            changes = [e[chg_key] for e in events]
            if not changes:
                lookahead_stats[f"{weeks}w"] = None
                continue

            if zone == "crowded":
                # Signal "correct" = price fell (negative change)
                correct = sum(1 for c in changes if c < 0)
            else:
                # Signal "correct" = price rose (positive change)
                correct = sum(1 for c in changes if c > 0)

            sorted_changes = sorted(changes)
            mid = len(sorted_changes) // 2
            median = (
                sorted_changes[mid]
                if len(sorted_changes) % 2 == 1
                else round((sorted_changes[mid - 1] + sorted_changes[mid]) / 2, 2)
            )

            lookahead_stats[f"{weeks}w"] = {
                "hit_rate_pct": round(correct / len(changes) * 100, 1),
                "correct": correct,
                "total": len(changes),
                "median_price_chg_pct": median,
                "min_price_chg_pct": round(min(changes), 2),
                "max_price_chg_pct": round(max(changes), 2),
            }

        sample_count = len(events)
        results[zone] = {
            "sample_count": sample_count,
            "thin_sample": sample_count < MIN_SAMPLE_FOR_CONCLUSIONS,
            "events": events,
            "lookahead": lookahead_stats,
        }

        if sample_count < MIN_SAMPLE_FOR_CONCLUSIONS:
            results["thin_sample_warning"] = True

    return results
