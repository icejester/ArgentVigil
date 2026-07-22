"""Canonical Yahoo Finance chart-API caller (price-architecture-spec.md's
Fetch consolidation). Replaces four near-duplicate HTTP-call-and-parse
blocks that grew independently across main.py and catcor.py:
main.py::_fetch_yahoo_daily_closes, catcor.py's inline daily-close fetch
inside backfill_daily_closes, catcor.py::_fetch_yahoo_intraday, and
main.py::_fetch_yahoo_contract_daily (which additionally needed real daily
volume for curve spread's per-date liquidity ranking).

Every caller keeps its own SHAPING logic (5-min bars -> ticks, daily
closes -> settlement rows, contract-month bars -> curve-spread
candidates) — this module removes only the duplicate HTTP-call/parse
plumbing, not the feature-specific interpretation of the result.

The single-retry-on-429/5xx margin (previously only on the contract-month
fetcher) now applies to every caller uniformly. This endpoint has no
published quota or documented rate-limit headers (confirmed live,
squeeze-context-spec.md's investigation) — the retry is a defensive
margin, not evidence of a known recurring lockout.
"""

import asyncio
from datetime import datetime, timezone

import httpx

YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"


async def fetch_yahoo_bars(client: httpx.AsyncClient, ticker: str, interval: str, range_: str) -> list[dict]:
    """Real (ts, close, high, low, volume) bars for one Yahoo chart-API
    ticker/interval/range combination, oldest-first. volume is 0 where
    Yahoo's response has no volume array (some intraday responses omit
    it) rather than None, matching the prior contract-daily fetcher's
    behavior; high/low are None on the same condition (some intraday
    ranges/tickers omit them too) rather than fabricated from close.

    A 404 (delisted/not-yet-listed symbol) returns [] rather than
    retrying — a retry can't fix a symbol that doesn't exist. 429/5xx get
    one retry after a short backoff, then raise."""
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            resp = await client.get(
                f"{YAHOO_CHART_BASE}/{ticker}",
                params={"interval": interval, "range": range_},
                headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
                timeout=30,
            )
            if resp.status_code == 404:
                return []
            resp.raise_for_status()
            data = resp.json()
            result = data["chart"]["result"][0]
            timestamps = result["timestamp"]
            quote = result["indicators"]["quote"][0]
            closes = quote["close"]
            volumes = quote.get("volume") or [None] * len(timestamps)
            highs = quote.get("high") or [None] * len(timestamps)
            lows = quote.get("low") or [None] * len(timestamps)
            bars = []
            for ts, close, vol, high, low in zip(timestamps, closes, volumes, highs, lows):
                if close is None:
                    continue
                bars.append({
                    "ts": ts,
                    "close": round(close, 4),
                    "volume": vol or 0,
                    "high": round(high, 4) if high is not None else None,
                    "low": round(low, 4) if low is not None else None,
                })
            return bars
        except httpx.HTTPError as e:
            last_error = e
            if attempt == 0:
                await asyncio.sleep(2)
    raise last_error


def bars_to_daily_rows(bars: list[dict]) -> list[dict]:
    """Bars -> {'date': 'YYYY-MM-DD', 'price': float, 'high': float|None,
    'low': float|None} rows, for daily/intraday-range calls where only the
    calendar date matters. high/low are the real intraday range Yahoo's
    daily bars already carry — captured for the Paper Games leverage
    chart's day-range price series, not fabricated from close."""
    return [
        {
            "date": datetime.fromtimestamp(b["ts"], tz=timezone.utc).date().isoformat(),
            "price": b["close"],
            "high": b.get("high"),
            "low": b.get("low"),
        }
        for b in bars
    ]


def bars_to_ticks(bars: list[dict]) -> list[dict]:
    """Bars -> {'ts': <ISO 8601 UTC>, 'price': float} rows, for intraday
    tick storage (spot_price)."""
    return [
        {"ts": datetime.fromtimestamp(b["ts"], tz=timezone.utc).isoformat(), "price": b["close"]}
        for b in bars
    ]


def bars_to_daily_dict(bars: list[dict]) -> dict[str, tuple[float, float]]:
    """Bars -> {'YYYY-MM-DD': (close, volume)}, for curve spread's
    per-date liquidity ranking, which needs real daily volume alongside
    price. Last bar for a given calendar day wins (matches the prior
    _fetch_yahoo_contract_daily behavior)."""
    out: dict[str, tuple[float, float]] = {}
    for b in bars:
        d = datetime.fromtimestamp(b["ts"], tz=timezone.utc).date().isoformat()
        out[d] = (b["close"], b["volume"])
    return out
