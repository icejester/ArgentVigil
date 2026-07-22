"""
Central configuration — tune thresholds here without touching pipeline logic.
"""

# CFTC Socrata API
CFTC_API_BASE = "https://publicreporting.cftc.gov/resource/jun7-fc8e.json"  # Legacy Futures-Only
CFTC_DISAGGREGATED_API_BASE = "https://publicreporting.cftc.gov/resource/72hh-3qpy.json"  # Disaggregated Futures-Only
SILVER_CONTRACT_CODE = "084691"
GOLD_CONTRACT_CODE = "088691"

# How many years of history to pull (need >5yr to have a full 5yr window from day one)
FETCH_YEARS = 15

# Lookback windows for percentile calculation (in weeks)
WINDOW_2YR = 104   # ~2 years of weekly data
WINDOW_5YR = 260   # ~5 years of weekly data

# Signal bucket thresholds (percentile, 0–100)
CROWDED_THRESHOLD = 90    # top decile → specs crowded long
CAPITULATED_THRESHOLD = 10  # bottom decile → specs capitulated

# Cache file location (relative to repo root)
CACHE_FILE = "pipeline/cache/cot_data.json"

# FRED Money Supply
FRED_SERIES_M2 = "M2SL"
FRED_SERIES_WALCL = "WALCL"
FRED_SERIES_CPI = "CPIAUCSL"  # CPI-U, seasonally adjusted; used for purchasing power
FRED_FETCH_YEARS = 20        # how far back to fetch on refresh
FRED_M2_YOY_LOOKBACK = 12    # months
FRED_WALCL_YOY_LOOKBACK = 52  # weeks

# Fed Balance Sheet Composition (fed-balance-spec.md) — a look inside WALCL's
# top-line number. Raw value only, no YoY, per the spec's "start simplest"
# framing (WRESBAL/RRPONTSYD were floated as the two simplest candidate
# series of the five in H.4.1; WSHOTSL/WSHOMCB/WLCFLPCL are the remaining
# three, added in the same v1 shape). NOT all the same native unit:
# confirmed live against FRED's /fred/series metadata — WRESBAL, WSHOTSL,
# WSHOMCB, and WLCFLPCL all report in millions of USD (like WALCL), while
# RRPONTSYD reports in billions (like M2SL) — main.py's
# /api/fred/money-supply/db converts each accordingly.
FRED_SERIES_WRESBAL = "WRESBAL"        # bank reserves held at the Fed
FRED_SERIES_RRPONTSYD = "RRPONTSYD"    # overnight reverse repo facility
FRED_SERIES_WSHOTSL = "WSHOTSL"        # Treasuries held outright
FRED_SERIES_WSHOMCB = "WSHOMCB"        # MBS held outright
FRED_SERIES_WLCFLPCL = "WLCFLPCL"      # discount window (primary credit) lending

# Metal price history (Yahoo Finance), for the purchasing-power comparison
# chart. Settlement instrument keys (XAG_YAHOO_DAILY_CLOSE/XAU_YAHOO_DAILY_CLOSE)
# now live in backend/price_instruments.py, not here — main.py resolves the
# ticker-to-instrument mapping via price_instruments.YAHOO_DAILY_CLOSE_BY_METAL.
METAL_PRICE_FETCH_YEARS = 20
XAG_TICKER = "SI=F"  # COMEX silver futures, continuous front-month
XAU_TICKER = "GC=F"  # COMEX gold futures, continuous front-month

# Treasury Yields (Money Supply tab's Treasury Yields sub-panel) — all real
# FRED series, daily, % units already (no conversion needed, unlike the
# millions/billions divisor split the Composition series need). T10Y2Y is
# FRED's own maintained 10Y-2Y spread, fetched directly rather than computed
# from DGS10/DGS2 client-side, to avoid any rounding drift between the two.
FRED_SERIES_DGS2 = "DGS2"        # 2-Year Treasury Constant Maturity yield
FRED_SERIES_DGS10 = "DGS10"      # 10-Year Treasury Constant Maturity yield
FRED_SERIES_DFII10 = "DFII10"    # 10-Year TIPS (real, inflation-indexed) yield
FRED_SERIES_T10Y2Y = "T10Y2Y"    # 10Y minus 2Y spread — yield-curve-inversion signal
