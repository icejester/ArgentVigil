"""
Fetches silver and gold price history from Yahoo Finance (SLV/GLD ETF as spot proxy).
ETF tracking error (~0.50%/yr) is immaterial for the directional analysis used here.
Standard library only.
"""

import json
import urllib.request
import urllib.parse
from datetime import datetime, timedelta, timezone

_YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"


def _fetch_prices(ticker: str, years: int) -> dict[str, float]:
    """Returns {YYYY-MM-DD: price_usd} at weekly frequency for the given Yahoo ticker."""
    url = _YAHOO_CHART.format(ticker=ticker) + "?" + urllib.parse.urlencode(
        {"interval": "1wk", "range": f"{years}y"}
    )
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())

    result = data["chart"]["result"][0]
    timestamps = result["timestamp"]
    closes = result["indicators"]["quote"][0]["close"]

    prices = {}
    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        date_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
        prices[date_str] = round(close, 4)

    return prices


def fetch_silver_prices(years: int = 8) -> dict[str, float]:
    return _fetch_prices("SLV", years)


def fetch_gold_prices(years: int = 8) -> dict[str, float]:
    return _fetch_prices("GLD", years)


def fetch_spot_prices(ticker: str, years: int = 8) -> dict[str, float]:
    """Fetch weekly spot/futures prices by ticker (e.g. 'GC=F', 'SI=F')."""
    return _fetch_prices(ticker, years)


def align_price_to_cot_week(cot_date: str, prices: dict[str, float]) -> float | None:
    """
    CoT report dates are Tuesdays. Find the closest available price within
    a 7-day window on or before the given date.
    """
    target = datetime.strptime(cot_date, "%Y-%m-%d")
    for offset in range(7):
        candidate = (target - timedelta(days=offset)).strftime("%Y-%m-%d")
        if candidate in prices:
            return prices[candidate]
    return None
