"""
CATCOR Iteration 1 — event/reaction spine. Seeds a static macro-event
calendar (catcor_events_seed.py), fetches ALFRED point-in-time actuals for
past events, and captures silver/gold price reactions at fixed windows
around each event's scheduled_time (T-30m/T+5m/T+30m/T+2h).

Independent of pipeline/ (which is deliberately stdlib-only) — this module
uses httpx like main.py does, and is imported by main.py the same way
db.py and mc_token.py are: functions take an httpx.AsyncClient explicitly
rather than owning global client state.
"""

import os
from datetime import datetime, timedelta, timezone

import httpx

from seed_data import catcor_events_seed as seed
from . import db
from .price_instruments import FUTURES_FRONT_BY_METAL, YAHOO_DAILY_CLOSE_BY_METAL
from .yahoo_prices import bars_to_ticks, fetch_yahoo_bars

FRED_BASE = "https://api.stlouisfed.org/fred/series/observations"
FRED_RELEASE_DATES_BASE = "https://api.stlouisfed.org/fred/release/dates"
YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"

# ALFRED release_id per event_type this module can auto-seed from
# fred/release/dates, replacing what used to be a hand-maintained,
# periodically-stale date list in catcor_events_seed.py's
# CPI_RELEASES/NFP_RELEASES. FOMC has no ALFRED release_id (the Fed's own
# meeting calendar isn't a BLS/Census "release") and stays seeded from the
# static FOMC_MEETINGS list.
ALFRED_RELEASE_ID = {
    "CPI": 10,
    "NFP": 50,
}

# ForexFactory's own free, no-key JSON calendar export — real consensus/
# forecast figures. Only a "thisweek" (current Sun-Sat calendar week)
# variant exists; nextweek/lastweek both 404 (confirmed live). So this can
# only ever capture consensus for events that have entered the current
# calendar week — anywhere from 0-6 days of advance notice depending on
# where in the week an event falls, not a full 90-day lookback.
#
# The feed content is static for a given calendar week (it's not an
# intraday-moving quote) and the endpoint rate-limits aggressively on
# repeat hits (confirmed live: a 429 after two calls a couple minutes
# apart) — so this is fetched at most once per calendar week and persisted
# to db.forexfactory_calendar (every entry, all countries, not just the
# USD/CPI/NFP subset this module currently matches against — the rest of
# a week's global economic calendar has no consumer today but is real data
# worth keeping for future CATCOR event types, per SPEC.MD's Iteration 2+).
# db.has_forexfactory_week() is the cache check; _consensus_tier_loop calls
# fetch_and_persist_consensus periodically, but that check means most of
# those calls do zero network I/O — the live endpoint is only ever hit once
# per calendar week, and once a week has passed there is no way to
# re-fetch it even if we wanted to (the endpoint only ever serves "this
# week"), so what's captured is a permanent historical record, not scratch
# state — hence append-only in SQLite, not a disposable file cache.
FOREXFACTORY_THISWEEK_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"

# ForexFactory's title strings for each event_type CATCOR tracks. NFP
# specifically means "Non-Farm Employment Change" — ForexFactory also lists
# "ADP Non-Farm Employment Change" (a different, private-sector-only
# report) which must NOT be matched here.
FOREXFACTORY_TITLE_MATCH = {
    "CPI": lambda title: title.strip().upper().startswith("CPI"),
    "NFP": lambda title: title.strip() == "Non-Farm Employment Change",
    "FOMC": lambda title: False,  # no ForexFactory consensus concept for a rate decision
}

XAG_TICKER = "SI=F"
XAU_TICKER = "GC=F"
METALS = {"XAG": XAG_TICKER, "XAU": XAU_TICKER}

# spot_price's XAG_SPOT/XAU_SPOT instruments belong exclusively to main.py's
# fast-tier metalcharts.org spot poll — a genuinely different instrument
# from Yahoo's SI=F/GC=F futures bars backfilled here, and the two used to
# collide under the same series_id before price_instruments.py's closed
# instrument set existed (real bug: futures prints running ~0.3-0.6 higher
# than spot, interleaved in the same series, producing a sawtooth in
# PriceHistoryChart). Yahoo's bars get their own instrument family
# (*_FUTURES_FRONT, price_instruments.FUTURES_FRONT_BY_METAL).
FUTURES_SERIES_ID = FUTURES_FRONT_BY_METAL

# Window offsets in minutes relative to scheduled_time.
WINDOWS = {
    "T-30m": -30,
    "T+5m": 5,
    "T+30m": 30,
    "T+2h": 120,
}
BASELINE_WINDOW = "T-30m"

TICK_TOLERANCE_S = 120          # how close a tick must be to the target instant to count
YAHOO_INTRADAY_DAYS = 60        # Yahoo's 5m interval caps at ~60-72d; request 60 to stay inside the cap


def _et_to_utc_iso(date_str: str, time_et: str) -> str:
    """Naive ET->UTC conversion (ET = UTC-5 in winter, UTC-4 in summer/DST).
    Good enough for a seed calendar of known announcement times; not meant
    to be a general timezone library."""
    dt = datetime.strptime(f"{date_str} {time_et}", "%Y-%m-%d %H:%M")
    month = dt.month
    # DST in the US runs ~mid-March to ~early November; this approximation
    # is intentionally coarse since all seeded events happen at 8:30am or
    # 2pm ET, well clear of the ~1am DST transition edge cases.
    is_dst = 3 < month < 11
    offset = 4 if is_dst else 5
    utc_dt = dt + timedelta(hours=offset)
    return utc_dt.replace(tzinfo=timezone.utc).isoformat()


def _event_id(event_type: str, date_str: str) -> str:
    return f"{event_type}_{date_str}"


def seed_events(days_back: int = 90, days_forward: int = 60):
    """Load the static seed list, upsert every event within
    [today - days_back, today + days_forward] into event_calendar."""
    today = datetime.now(timezone.utc).date()
    window_start = (today - timedelta(days=days_back)).isoformat()
    window_end = (today + timedelta(days=days_forward)).isoformat()

    rows = []
    for e in seed.EVENTS:
        if not (window_start <= e["date"] <= window_end):
            continue
        rows.append({
            "event_id": _event_id(e["event_type"], e["date"]),
            "event_name": seed.EVENT_NAMES[e["event_type"]],
            "event_type": e["event_type"],
            "scheduled_time": _et_to_utc_iso(e["date"], e["time_et"]),
            "consensus_value": None,
            "actual_value": None,
            "surprise_delta": None,
            "source_url": seed.SOURCE_URLS[e["event_type"]],
            "source_tier": seed.SOURCE_TIERS[e["event_type"]],
        })
    if rows:
        db.upsert_event_rows(rows)
    return len(rows)


async def _fetch_release_dates(client: httpx.AsyncClient, release_id: int, realtime_start: str, realtime_end: str) -> list[str]:
    """Real (not scheduled-and-later-revised) release dates for release_id
    within [realtime_start, realtime_end], as published by ALFRED's
    fred/release/dates endpoint — the same endpoint the seed file's own
    docstring says was used to hand cross-check CPI_RELEASES/NFP_RELEASES
    once, on 2026-07-04. Returns YYYY-MM-DD strings, ascending."""
    api_key = os.environ["FRED_API_KEY"]
    resp = await client.get(
        FRED_RELEASE_DATES_BASE,
        params={
            "release_id": release_id,
            "api_key": api_key,
            "file_type": "json",
            "realtime_start": realtime_start,
            "realtime_end": realtime_end,
            "sort_order": "asc",
        },
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    return [d["date"] for d in data.get("release_dates", [])]


def seed_events_from_alfred_sync(release_dates_by_type: dict[str, list[str]], days_back: int = 90, days_forward: int = 60) -> int:
    """Build and upsert event_calendar rows for CPI/NFP from already-fetched
    ALFRED release dates. Split out from seed_events_from_alfred so the
    row-building/window-filtering logic (identical in shape to
    seed_events()'s own loop over the static seed list) is testable without
    a live client. release_dates_by_type is {"CPI": [...], "NFP": [...]}."""
    today = datetime.now(timezone.utc).date()
    window_start = (today - timedelta(days=days_back)).isoformat()
    window_end = (today + timedelta(days=days_forward)).isoformat()

    rows = []
    for event_type, dates in release_dates_by_type.items():
        for date_str in dates:
            if not (window_start <= date_str <= window_end):
                continue
            rows.append({
                "event_id": _event_id(event_type, date_str),
                "event_name": seed.EVENT_NAMES[event_type],
                "event_type": event_type,
                "scheduled_time": _et_to_utc_iso(date_str, seed.RELEASE_TIME_ET),
                "consensus_value": None,
                "actual_value": None,
                "surprise_delta": None,
                "source_url": seed.SOURCE_URLS[event_type],
                "source_tier": seed.SOURCE_TIERS[event_type],
            })
    if rows:
        db.upsert_event_rows(rows)
    return len(rows)


async def seed_events_from_alfred(client: httpx.AsyncClient, days_back: int = 90, days_forward: int = 60) -> int:
    """Live replacement for catcor_events_seed.py's hand-maintained
    CPI_RELEASES/NFP_RELEASES lists — fetches real release dates from
    ALFRED's fred/release/dates for each event_type in ALFRED_RELEASE_ID
    and upserts them the same way seed_events() does for the static FOMC
    list. INSERT OR REPLACE means a row already carrying a
    research_session_id/direction/consensus_value/actual_value would be
    clobbered back to NULL by a re-seed here (same pre-existing risk
    seed_events() itself carries for FOMC/CPI/NFP rows, not new to this
    function) - acceptable because CPI/NFP event_ids are government-tier
    and never carry a research_session_id in practice, and
    consensus_value/actual_value get re-derived by
    fetch_and_persist_consensus/fetch_and_persist_actuals on the same
    startup pass right after this runs.
    Raises RuntimeError if FRED_API_KEY is unset, matching
    fetch_and_persist_actuals's convention (clean error, not a bare
    KeyError from inside the fetch)."""
    if "FRED_API_KEY" not in os.environ:
        raise RuntimeError("FRED_API_KEY environment variable is not set")

    today = datetime.now(timezone.utc).date()
    realtime_start = (today - timedelta(days=days_back)).isoformat()
    realtime_end = (today + timedelta(days=days_forward)).isoformat()

    release_dates_by_type = {}
    for event_type, release_id in ALFRED_RELEASE_ID.items():
        dates = await _fetch_release_dates(client, release_id, realtime_start, realtime_end)
        release_dates_by_type[event_type] = dates

    return seed_events_from_alfred_sync(release_dates_by_type, days_back=days_back, days_forward=days_forward)


async def _fetch_alfred_observations(client: httpx.AsyncClient, series_id: str, vintage_date: str, limit: int = 1) -> list[dict]:
    """The `limit` most recent observations of series_id as known/published
    on vintage_date (ALFRED semantics: realtime_start/realtime_end pin the
    vintage), newest first, as {"date": ..., "value": float | None} dicts.
    Used with limit=2 for month-over-month change series (NFP/CPI) so we can
    diff two consecutive vintage prints rather than compare a raw level
    against a ForexFactory change/percent figure."""
    api_key = os.environ["FRED_API_KEY"]
    resp = await client.get(
        FRED_BASE,
        params={
            "series_id": series_id,
            "api_key": api_key,
            "file_type": "json",
            "realtime_start": vintage_date,
            "realtime_end": vintage_date,
            "sort_order": "desc",
            "limit": limit,
        },
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    obs = data.get("observations", [])
    return [
        {"date": o["date"], "value": None if o.get("value") in (None, ".") else float(o["value"])}
        for o in obs
    ]


async def _fetch_alfred_value(client: httpx.AsyncClient, series_id: str, vintage_date: str) -> float | None:
    """Single most recent vintage value — used where the raw level (not a
    period-over-period change) is the right comparison, if that's ever
    needed again. Kept as a thin wrapper around _fetch_alfred_observations."""
    obs = await _fetch_alfred_observations(client, series_id, vintage_date, limit=1)
    return obs[0]["value"] if obs else None


async def _fetch_alfred_change(client: httpx.AsyncClient, series_id: str, vintage_date: str, as_percent: bool) -> float | None:
    """Month-over-month change between the two most recent vintage prints
    as of vintage_date — comparable to ForexFactory's consensus figures,
    which are always period-over-period changes (NFP: level change in
    persons; CPI: % change), never raw index/level values.
    as_percent=True computes (latest/prior - 1) * 100 (for CPIAUCSL, an
    index level where % change is the meaningful quantity); False returns
    the raw difference (for PAYEMS, already in thousands of persons, where
    ForexFactory's "K" consensus is a raw count difference, not a percent).

    Persists both raw vintage prints to fred_observations before returning
    the diff — previously these were fetched and discarded, leaving
    data_map.js's claim that PAYEMS/CPIAUCSL vintage data lives in
    fred_observations false (only the *computed* actual_value survived, on
    the event_calendar row, not the underlying observations)."""
    obs = await _fetch_alfred_observations(client, series_id, vintage_date, limit=2)
    real_obs = [o for o in obs if o["value"] is not None]
    if real_obs:
        db.upsert_fred_observations(series_id, real_obs)
    if len(obs) < 2 or obs[0]["value"] is None or obs[1]["value"] is None:
        return None
    latest, prior = obs[0]["value"], obs[1]["value"]
    if as_percent:
        if prior == 0:
            return None
        return round((latest / prior - 1) * 100, 4)
    return round(latest - prior, 4)


def _surprise_delta(actual_value: float | None, consensus_value: float | None) -> float | None:
    if actual_value is None or consensus_value is None:
        return None
    return round(actual_value - consensus_value, 4)


async def fetch_and_persist_actuals(client: httpx.AsyncClient):
    """For past events still missing an actual_value, fetch the ALFRED
    vintage actual (pinned to the day after scheduled_time, so the vintage
    reflects "as first published"). If a consensus_value is already on the
    row (from fetch_and_persist_consensus), surprise_delta is computed here
    too; if not, surprise_delta stays NULL until consensus shows up on a
    later pass (see capture_snapshot's re-check for that path).

    Raises a clean RuntimeError if FRED_API_KEY is unset, mirroring
    main.py's explicit-check-before-HTTPException pattern, so main.py can
    turn this into a clean 500 rather than an unhandled KeyError.
    """
    if "FRED_API_KEY" not in os.environ:
        raise RuntimeError("FRED_API_KEY environment variable is not set")

    succeeded, failed = 0, 0
    for ev in db.get_events_needing_actuals():
        if ev["event_type"] == "FOMC":
            # FOMC decisions aren't an ALFRED data series (no vintage actual
            # to fetch) — nothing to do here.
            continue
        series_id = _series_id_for_event_type(ev["event_type"])
        vintage_date = ev["scheduled_time"][:10]
        # NFP consensus is a raw level-change (persons); CPI consensus is a
        # % m/m change — both are period-over-period changes, never a raw
        # index/level, so actual_value must match that shape to be
        # comparable (see _fetch_alfred_change's docstring for why).
        as_percent = ev["event_type"] == "CPI"
        try:
            actual = await _fetch_alfred_change(client, series_id, vintage_date, as_percent=as_percent)
            full_ev = db.get_event(ev["event_id"])
            delta = _surprise_delta(actual, full_ev["consensus_value"])
            db.update_event_actuals(ev["event_id"], actual_value=actual, surprise_delta=delta)
            succeeded += 1
        except httpx.HTTPError as e:
            print(f"[catcor] warning: ALFRED fetch failed for {ev['event_id']}: {e}")
            failed += 1
    return {"succeeded": succeeded, "failed": failed}


def _series_id_for_event_type(event_type: str) -> str:
    return {"CPI": "CPIAUCSL", "NFP": "PAYEMS"}[event_type]


def _current_calendar_week_key() -> str:
    """Sunday's date (ISO) of the week containing today (UTC) — the same
    week boundary ForexFactory's own "thisweek" feed uses. Used as the
    cache key: the feed's content doesn't change within a calendar week,
    so a cache hit for this key never needs a re-fetch."""
    today = datetime.now(timezone.utc).date()
    # Python's weekday(): Monday=0..Sunday=6. Days since the most recent Sunday:
    days_since_sunday = (today.weekday() + 1) % 7
    sunday = today - timedelta(days=days_since_sunday)
    return sunday.isoformat()


async def fetch_and_persist_consensus(client: httpx.AsyncClient):
    """Match event_calendar rows against ForexFactory's "this week" feed by
    event_type + same UTC instant, persisting a real consensus_value where
    found. Only events that have entered the current Sun-Sat calendar week
    can possibly match — call this repeatedly (startup + event tier), not
    once, so an event isn't missed purely because the server wasn't running
    the moment it entered the window.

    The feed itself is fetched at most once per calendar week and persisted
    to db.forexfactory_calendar (every entry, not just the ones matched
    below — see the module-level comment above FOREXFACTORY_THISWEEK_URL).
    db.has_forexfactory_week() is the cache check: the feed's content
    doesn't change within a week, and the endpoint rate-limits aggressively
    on repeat hits (confirmed live), so every call beyond the first per
    week is a pure DB read, no network I/O.

    If an event already has an actual_value (i.e. fetch_and_persist_actuals
    ran first) but was missing consensus until just now, recomputes
    surprise_delta immediately rather than waiting for the next actuals
    pass — otherwise a same-week event whose print already happened could
    sit with a real actual and a freshly-arrived consensus but a stale NULL
    surprise_delta until something else touches it.
    """
    week_key = _current_calendar_week_key()
    if not db.has_forexfactory_week(week_key):
        try:
            resp = await client.get(FOREXFACTORY_THISWEEK_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
            resp.raise_for_status()
            raw_entries = resp.json()
            db.insert_forexfactory_rows([
                {
                    "week_key": week_key,
                    "title": e["title"],
                    "country": e["country"],
                    "event_date": e["date"],
                    "impact": e.get("impact"),
                    "forecast": e.get("forecast"),
                    "previous": e.get("previous"),
                }
                for e in raw_entries
            ])
        except httpx.HTTPError as e:
            print(f"[catcor] warning: ForexFactory fetch failed: {e}")
            return {"succeeded": 0, "failed": 1}

    entries = [
        {"title": r["title"], "country": r["country"], "date": r["event_date"], "forecast": r["forecast"]}
        for r in db.get_forexfactory_week(week_key)
    ]

    succeeded = 0
    with db.get_conn() as conn:
        events = conn.execute(
            "SELECT event_id, event_type, scheduled_time, actual_value, consensus_value FROM event_calendar"
        ).fetchall()

    for ev in events:
        if ev["consensus_value"] is not None:
            continue  # already have it, don't refetch/overwrite
        matcher = FOREXFACTORY_TITLE_MATCH.get(ev["event_type"])
        if matcher is None:
            continue
        event_dt = datetime.fromisoformat(ev["scheduled_time"])
        match = next(
            (e for e in entries
             if e["country"] == "USD"
             and matcher(e["title"])
             and _forexfactory_same_instant(e["date"], event_dt)),
            None,
        )
        if match is None or not match.get("forecast"):
            continue
        consensus = _parse_forexfactory_number(match["forecast"], event_type=ev["event_type"])
        if consensus is None:
            continue
        delta = _surprise_delta(ev["actual_value"], consensus)
        db.update_event_actuals(ev["event_id"], actual_value=ev["actual_value"], surprise_delta=delta)
        with db.get_conn() as conn:
            conn.execute(
                "UPDATE event_calendar SET consensus_value = ? WHERE event_id = ?",
                (consensus, ev["event_id"]),
            )
        succeeded += 1
    return {"succeeded": succeeded, "failed": 0}


def _forexfactory_same_instant(ff_date_str: str, event_dt: datetime) -> bool:
    """ForexFactory dates carry their own offset (e.g. -04:00); compare as
    absolute instants rather than string-matching, so DST doesn't matter."""
    ff_dt = datetime.fromisoformat(ff_date_str)
    return abs((ff_dt - event_dt).total_seconds()) < 60


# ForexFactory's K/M/B suffixes are raw-count magnitude markers (e.g.
# "114K" = 114,000 people). ALFRED's PAYEMS is itself already denominated
# in thousands of persons, so a ForexFactory NFP figure must be scaled DOWN
# to thousands (i.e. the "K" suffix contributes a factor of 1, not 1,000)
# to land in the same unit as actual_value — this was a real bug caught
# during testing: "114K" was parsing to 114,000 and being compared against
# an ALFRED actual already expressed in thousands (57), producing a
# nonsense ~114,000-unit "surprise." CPI has no such rescale: ForexFactory
# and _fetch_alfred_change's as_percent=True path are both already a bare
# percentage, so "%" just gets stripped, no magnitude scaling.
_FOREXFACTORY_MAGNITUDE = {"K": 1_000.0, "M": 1_000_000.0, "B": 1_000_000_000.0}
_ALFRED_NATIVE_UNIT_MAGNITUDE = {"NFP": 1_000.0}  # PAYEMS is in thousands; CPI has none (bare %)


def _parse_forexfactory_number(s: str, event_type: str) -> float | None:
    """Parse a ForexFactory forecast string into the same unit ALFRED's
    actual_value uses for this event_type (see module comment above)."""
    s = s.strip()
    if not s:
        return None
    magnitude = 1.0
    if s.endswith("%"):
        s = s[:-1]
    elif s and s[-1] in _FOREXFACTORY_MAGNITUDE:
        magnitude, s = _FOREXFACTORY_MAGNITUDE[s[-1]], s[:-1]
    try:
        value = float(s) * magnitude
    except ValueError:
        return None
    return value / _ALFRED_NATIVE_UNIT_MAGNITUDE.get(event_type, 1.0)


async def backfill_intraday_ticks(client: httpx.AsyncClient):
    """One-time-per-run pull of Yahoo 5-minute bars for both metals, so
    capture_snapshot has real intraday ticks to sample from even for
    events that predate this feature's own fast-tier tick collection.
    append_spot_price_ticks is INSERT OR IGNORE, so re-running this is
    always safe and cheap on repeat startups.

    Written under FUTURES_SERIES_ID (*_FUTURES_FRONT), NOT the *_SPOT
    instruments main.py's fast tier uses — SI=F/GC=F are futures, a
    genuinely different instrument from metalcharts.org's spot quote, and
    sharing a series_id with it produced a real sawtooth artifact in
    PriceHistoryChart (futures prints running ~0.3-0.6 higher, interleaved
    with real spot ticks on the same line) before price_instruments.py's
    closed instrument set existed."""
    for series_id, ticker in METALS.items():
        try:
            bars = await fetch_yahoo_bars(client, ticker, interval="5m", range_=f"{YAHOO_INTRADAY_DAYS}d")
        except httpx.HTTPError as e:
            print(f"[catcor] warning: Yahoo intraday fetch failed for {ticker}: {e}")
            continue
        futures_series_id = FUTURES_SERIES_ID[series_id]
        rows = [{"instrument": futures_series_id, **t} for t in bars_to_ticks(bars)]
        if rows:
            db.append_spot_price_ticks(rows)


def _target_ts(scheduled_time: str, window: str) -> str:
    dt = datetime.fromisoformat(scheduled_time)
    return (dt + timedelta(minutes=WINDOWS[window])).isoformat()


def _daily_close_fallback(series_id: str, target_ts: str) -> float | None:
    """Coarser fallback for events older than Yahoo's intraday cutoff:
    same-day close from settlement_price's real Yahoo daily close
    (XAG_YAHOO_DAILY_CLOSE/XAU_YAHOO_DAILY_CLOSE — main.py's
    _fetch_and_persist_yahoo_daily_close is what keeps this populated, on
    the same shared instrument Money Supply's purchasing-power chart reads,
    see price-architecture-spec.md's Fetch consolidation). Not a
    month-end-resampled series — this has real daily granularity."""
    instrument = YAHOO_DAILY_CLOSE_BY_METAL[series_id]
    target_date = target_ts[:10]
    rows = db.get_settlement_price_series(instrument)
    same_day = [r for r in rows if r["date"] == target_date and r["price"] is not None]
    return same_day[-1]["price"] if same_day else None


def capture_snapshot(event_id: str, window: str):
    """Idempotent: if a macro_price_reaction row already exists for every
    metal at this (event_id, window), skip entirely — no re-fetch, no
    recompute, no overwrite. This is what makes repeated calls (a normal
    restart, or a restart after any length of downtime) cheap and safe:
    only genuinely-missing windows do real work."""
    ev = db.get_event(event_id)
    if ev is None:
        return

    existing = {
        (r["metal"], r["window"])
        for r in db.get_event_reaction_series()
        if r["event_id"] == event_id
    }
    if all((m, window) in existing for m in METALS):
        return

    target_ts = _target_ts(ev["scheduled_time"], window)
    baseline_ts = _target_ts(ev["scheduled_time"], BASELINE_WINDOW) if window != BASELINE_WINDOW else target_ts

    rows = []
    for series_id in METALS:
        if (series_id, window) in existing:
            continue

        # Queries FUTURES_SERIES_ID, not the bare series_id — CATCOR's
        # intraday-precision reactions are (and always have been) sourced
        # from Yahoo's SI=F/GC=F futures bars (backfill_intraday_ticks),
        # never from main.py's fast-tier spot ticks. Keeping this explicit
        # preserves existing snapshot coverage after spot_price_tick's
        # "XAG"/"XAU" keys were reserved exclusively for real spot ticks.
        futures_series_id = FUTURES_SERIES_ID[series_id]
        tick = db.get_spot_price_near(futures_series_id, target_ts, TICK_TOLERANCE_S)
        price = tick["price"] if tick else _daily_close_fallback(series_id, target_ts)

        baseline_tick = db.get_spot_price_near(futures_series_id, baseline_ts, TICK_TOLERANCE_S)
        baseline_price = baseline_tick["price"] if baseline_tick else _daily_close_fallback(series_id, baseline_ts)

        price_delta_pct = None
        if price is not None and baseline_price not in (None, 0):
            price_delta_pct = round((price - baseline_price) / baseline_price * 100, 4)

        rows.append({
            "event_id": event_id,
            "metal": series_id,
            "window": window,
            "price": price,
            "price_delta_pct": price_delta_pct,
            "surprise_magnitude": abs(ev["surprise_delta"]) if ev["surprise_delta"] is not None else None,
        })

    if rows:
        db.upsert_price_reaction_rows(rows)


def _captured_metals_by_event_window() -> dict[tuple[str, str], set[str]]:
    """(event_id, window) -> set of metals already captured, built in one
    pass over macro_price_reaction rather than re-querying per event."""
    captured: dict[tuple[str, str], set[str]] = {}
    for r in db.get_event_reaction_series():
        captured.setdefault((r["event_id"], r["window"]), set()).add(r["metal"])
    return captured


def due_snapshots() -> list[tuple[str, str]]:
    """(event_id, window) pairs whose window boundary has passed but at
    least one metal is still missing a reaction row. Feeds the polling
    loop's "is anything due" check; capture_snapshot re-checks existence
    itself, so it's also safe to call directly (e.g. from
    backfill_reactions) without going through this filter first."""
    now_iso = datetime.now(timezone.utc).isoformat()
    with db.get_conn() as conn:
        events = conn.execute(
            "SELECT event_id, scheduled_time FROM event_calendar"
        ).fetchall()
    captured = _captured_metals_by_event_window()

    pairs = []
    for ev in events:
        for window in WINDOWS:
            if _target_ts(ev["scheduled_time"], window) > now_iso:
                continue
            if len(captured.get((ev["event_id"], window), set())) < len(METALS):
                pairs.append((ev["event_id"], window))
    return pairs


def backfill_reactions():
    """Called unconditionally on every startup. Iterates every event in
    the seeded window and calls capture_snapshot for all 4 windows;
    capture_snapshot's own skip-if-exists check means only genuinely
    missing windows do real work, so this is cheap whether the app was
    offline for 14 minutes or 14 days."""
    with db.get_conn() as conn:
        events = conn.execute("SELECT event_id, scheduled_time FROM event_calendar").fetchall()
    now = datetime.now(timezone.utc).isoformat()
    for ev in events:
        for window in WINDOWS:
            if _target_ts(ev["scheduled_time"], window) <= now:
                capture_snapshot(ev["event_id"], window)
