"""
Manually-maintained calendar of FOMC decisions — the one CATCOR event type
with no ALFRED release_id (the Fed's own meeting calendar isn't a BLS/
Census "release"), so it has no live-fetchable source and stays hand-
maintained. FOMC dates come from the Fed's published meeting calendar.

CPI and NFP dates are NOT maintained here anymore — as of
catcor.seed_events_from_alfred(), they're fetched live from ALFRED's
fred/release/dates endpoint (release_id=10 CPI, release_id=50 NFP) on
every CATCOR startup/weekly re-seed, which is why CPI_RELEASES/
NFP_RELEASES (this file used to hand-maintain both, and it fell behind —
see catcor.ALFRED_RELEASE_ID) were removed. RELEASE_TIME_ET/EVENT_NAMES/
SOURCE_URLS/SOURCE_TIERS below are still shared with the live-fetched
CPI/NFP path (seed_events_from_alfred_sync keys off EVENT_NAMES etc. by
event_type the same way seed_events() does), so don't remove those even
though CPI/NFP no longer have their own date lists here.

Update this file directly when new FOMC meetings are scheduled;
catcor.seed_events() re-derives event_id deterministically from
event_type + date, so re-running it after an edit here just updates the
existing row rather than duplicating it.

Times are ET (Eastern Time, America/New_York) as published; catcor.py
converts to UTC when writing scheduled_time.
"""

FOMC_MEETINGS = [
    # (announcement_date, announcement_time_et) — decision/statement day of
    # each 2-day meeting, not the first day.
    ("2026-01-28", "14:00"),
    ("2026-03-18", "14:00"),
    ("2026-04-29", "14:00"),
    ("2026-06-17", "14:00"),
    ("2026-07-29", "14:00"),
    ("2026-09-16", "14:00"),
]

# CPI (CPIAUCSL) and NFP (PAYEMS) release dates are no longer listed here —
# both are fetched live from ALFRED's fred/release/dates endpoint by
# catcor.seed_events_from_alfred() (release_id=10 CPI, release_id=50 NFP),
# 8:30am ET per that same ALFRED release metadata. RELEASE_TIME_ET stays
# here since seed_events_from_alfred_sync() still needs it.
RELEASE_TIME_ET = "08:30"

# seed_events() only ever seeds FOMC now — CPI/NFP go through
# seed_events_from_alfred() instead, which builds its own row shape
# directly from EVENT_NAMES/SOURCE_URLS/SOURCE_TIERS below rather than
# reading from this EVENTS list.
EVENTS = [{"event_type": "FOMC", "date": d, "time_et": t, "alfred_series_id": None} for d, t in FOMC_MEETINGS]

EVENT_NAMES = {
    "FOMC": "FOMC Rate Decision",
    "CPI": "Consumer Price Index",
    "NFP": "Employment Situation (Nonfarm Payrolls)",
}

SOURCE_URLS = {
    "FOMC": "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
    "CPI": "https://www.bls.gov/schedule/news_release/cpi.htm",
    "NFP": "https://www.bls.gov/schedule/news_release/empsit.htm",
}

# Coarse trust tier per SPEC.MD's Anchor Points principle: government/
# exchange-published data is trusted (same number regardless of who's
# asking); everything else CATCOR will eventually ingest (industry news,
# social media, ad-hoc commentary) is untrusted input to be tested, not a
# source of conclusions. All three current event types are government
# releases (FOMC = Federal Reserve, CPI/NFP = BLS) — this field exists so
# future non-government catalyst types have somewhere to record that
# distinction, not because today's three types need to be told apart from
# each other.
SOURCE_TIERS = {
    "FOMC": "government",
    "CPI": "government",
    "NFP": "government",
}
