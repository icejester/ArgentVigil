"""
Manually-maintained calendar of recurring macro catalysts CATCOR tracks —
FOMC decisions, CPI, and NFP (Employment Situation). Not scraped from ALFRED
release-calendar metadata: FOMC dates come from the Fed's published meeting
calendar, CPI/NFP dates were cross-checked against ALFRED's own
release/dates endpoint (release_id=10 for CPI, release_id=50 for Employment
Situation) as of 2026-07-04. The 2025/2026 government shutdown (lapse in
appropriations, Oct 2025-Feb 2026) shifted several BLS releases off their
usual cadence (e.g. the January 2026 jobs report slipped from Feb 6 to Feb
11) — dates below are the actual as-published schedule, not a "first
Friday of the month" assumption.

Update this file directly when new meetings/releases are scheduled;
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

# Consumer Price Index (CPIAUCSL) — 8:30am ET, per ALFRED release_id=10.
CPI_RELEASES = [
    "2026-01-13",
    "2026-02-13",
    "2026-03-11",
    "2026-04-10",
    "2026-05-12",
    "2026-06-10",
    "2026-07-14",
    "2026-08-12",
    "2026-09-11",
]

# Employment Situation / nonfarm payrolls (PAYEMS) — 8:30am ET, per ALFRED
# release_id=50. Jan 2026 release slipped from its originally-scheduled
# Feb 6 to Feb 11 due to the government shutdown lapse in appropriations.
NFP_RELEASES = [
    "2026-01-09",
    "2026-02-11",
    "2026-03-06",
    "2026-04-03",
    "2026-05-08",
    "2026-06-05",
    "2026-07-02",
    "2026-08-07",
    "2026-09-04",
]

RELEASE_TIME_ET = "08:30"

EVENTS = (
    [{"event_type": "FOMC", "date": d, "time_et": t, "alfred_series_id": None} for d, t in FOMC_MEETINGS]
    + [{"event_type": "CPI", "date": d, "time_et": RELEASE_TIME_ET, "alfred_series_id": "CPIAUCSL"} for d in CPI_RELEASES]
    + [{"event_type": "NFP", "date": d, "time_et": RELEASE_TIME_ET, "alfred_series_id": "PAYEMS"} for d in NFP_RELEASES]
)

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
