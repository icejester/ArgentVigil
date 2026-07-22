"""Canonical price instrument identifiers (price-architecture-spec.md).

The closed set of `instrument` values written to spot_price/settlement_price.
Replaces the informal "series_id family" convention spot_price_tick/
fred_observations used to rely on prose comments to keep collision-free —
a real bug (the XAG/XAG_FUTURES sawtooth) came from that convention not
being enforced anywhere. Any code writing/reading spot_price or
settlement_price should reference these constants, not a bare string
literal, so a typo'd or newly-invented instrument name is caught as an
unrecognized identifier rather than silently becoming a new de facto
series.

Deliberately stdlib-free so backend/db.py and pipeline-side code can
import it without the venv, same constraint units.py carries.
"""

# spot_price instruments — tick-resolution, append-only.
XAG_SPOT = "XAG_SPOT"                    # metalcharts.org real spot quote, ~60s cadence
XAU_SPOT = "XAU_SPOT"
XAG_FUTURES_FRONT = "XAG_FUTURES_FRONT"  # Yahoo SI=F front-month-continuous futures bars, 5-min cadence
XAU_FUTURES_FRONT = "XAU_FUTURES_FRONT"  # Yahoo GC=F front-month-continuous futures bars, 5-min cadence

SPOT_INSTRUMENTS = frozenset({XAG_SPOT, XAU_SPOT, XAG_FUTURES_FRONT, XAU_FUTURES_FRONT})

# settlement_price instruments — daily-or-coarser, upsert (revisable).
XAG_YAHOO_DAILY_CLOSE = "XAG_YAHOO_DAILY_CLOSE"  # Yahoo SI=F real daily close
XAU_YAHOO_DAILY_CLOSE = "XAU_YAHOO_DAILY_CLOSE"  # Yahoo GC=F real daily close
XAG_LBMA = "XAG_LBMA"                            # GoldAPI.io LBMA silver fix (session='daily')
XAU_LBMA = "XAU_LBMA"                            # GoldAPI.io LBMA gold fix (session='AM', no PM available from this source)
SLV_CLOSE = "SLV_CLOSE"                          # Yahoo SLV ETF weekly close (CoT-week-aligned)
GLD_CLOSE = "GLD_CLOSE"                          # Yahoo GLD ETF weekly close (CoT-week-aligned)
SI_F_WEEKLY = "SI=F_WEEKLY"                      # Yahoo SI=F weekly close (CoT-week-aligned)
GC_F_WEEKLY = "GC=F_WEEKLY"                      # Yahoo GC=F weekly close (CoT-week-aligned)

SETTLEMENT_INSTRUMENTS = frozenset({
    XAG_YAHOO_DAILY_CLOSE, XAU_YAHOO_DAILY_CLOSE,
    XAG_LBMA, XAU_LBMA,
    SLV_CLOSE, GLD_CLOSE, SI_F_WEEKLY, GC_F_WEEKLY,
})

# session sentinel for settlement_price rows with only one print/day —
# a real string value (not NULL) since NULL in a composite PRIMARY KEY
# behaves unintuitively for SQLite's ON CONFLICT upserts. Matches the
# existing lbma_fix.fix_type convention rather than introducing a
# separate is_single_session boolean column (price-architecture-spec.md
# Q2, decided 2026-07-20).
SESSION_DAILY = "daily"
SESSION_AM = "AM"
SESSION_PM = "PM"

# Yahoo ticker -> spot_price instrument, for backfill_intraday_ticks-style callers.
FUTURES_FRONT_BY_METAL = {"XAG": XAG_FUTURES_FRONT, "XAU": XAU_FUTURES_FRONT}
YAHOO_DAILY_CLOSE_BY_METAL = {"XAG": XAG_YAHOO_DAILY_CLOSE, "XAU": XAU_YAHOO_DAILY_CLOSE}
LBMA_BY_METAL = {"XAG": XAG_LBMA, "XAU": XAU_LBMA}
LBMA_SESSION_BY_METAL = {"XAG": SESSION_DAILY, "XAU": SESSION_AM}
