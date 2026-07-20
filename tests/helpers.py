"""Shared test helpers — fixture data builders and date freezing.

Kept separate from conftest.py so test modules can import them explicitly
(`from helpers import make_fake_date`) instead of relying on fixture magic.
"""

from datetime import date as real_date
from datetime import datetime, timezone


def make_fake_date(fixed: real_date):
    """A datetime.date subclass whose today() is pinned. Monkeypatch it over
    `backend.main.date` (main.py does `from datetime import date`, so the
    name is module-local) to make date.today()-driven logic deterministic —
    the weekend spot-skip, the LBMA weekday walk-back, census month windows,
    and curve spread's candidate-symbol sweep all key off date.today()."""

    class _FakeDate(real_date):
        @classmethod
        def today(cls):
            return cls(fixed.year, fixed.month, fixed.day)

    return _FakeDate


def yahoo_chart_payload(bars: dict[str, tuple[float, int]]) -> dict:
    """Minimal real-shaped Yahoo chart API response: {date: (close, volume)}.
    Timestamps land at 12:00 UTC so fromtimestamp(tz=utc).date() round-trips
    to the same calendar date."""
    timestamps, closes, volumes = [], [], []
    for d, (close, vol) in sorted(bars.items()):
        dt = datetime.fromisoformat(d + "T12:00:00+00:00")
        timestamps.append(int(dt.timestamp()))
        closes.append(close)
        volumes.append(vol)
    return {
        "chart": {
            "result": [
                {
                    "timestamp": timestamps,
                    "indicators": {"quote": [{"close": closes, "volume": volumes}]},
                }
            ]
        }
    }


def cot_row(report_date: str, oi: float, nc_long: float = 60000, nc_short: float = 20000) -> dict:
    """A cot_silver/cot_gold row dict in insert_silver_rows' shape."""
    net_long = nc_long - nc_short
    return {
        "report_date": report_date,
        "noncomm_long": nc_long,
        "noncomm_short": nc_short,
        "open_interest": oi,
        "net_long": net_long,
        "net_long_pct_oi": round(net_long / oi * 100, 4),
    }


def monthly_fred_rows(series_start: str, months: int, start_value: float, step: float) -> list[dict]:
    """Monthly observations on the 1st, linearly increasing — enough shape
    for YoY math without pretending to be real M2."""
    y, m = int(series_start[:4]), int(series_start[5:7])
    rows = []
    value = start_value
    for _ in range(months):
        rows.append({"date": f"{y:04d}-{m:02d}-01", "value": round(value, 2)})
        value += step
        m += 1
        if m == 13:
            m, y = 1, y + 1
    return rows


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
