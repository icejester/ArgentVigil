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
# SOMA's own Treasury-only holdings — a subset of WSHOTSL's own total, not a
# duplicate/competing figure: WSHOTSL is the Fed's overall "Treasuries held
# outright" H.4.1 line, WSHOSHO is specifically the System Open Market
# Account's Treasury holdings (the same H.4.1 family, weekly, confirmed live
# 2002-12-18 through present). Added for the Treasuries picture expansion,
# not part of the original 5-series Composition group.
FRED_SERIES_WSHOSHO = "WSHOSHO"        # SOMA Treasury securities held outright

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
# Added to round out the curve beyond the original 2yr/10yr/real-10yr/spread
# set — confirmed live, all real FRED series, daily, % units, no divisor,
# same as the four above. DGS3MO (constant-maturity, bond-equivalent basis)
# was deliberately chosen over DTB3 (secondary-market discount-basis 3-month
# bill rate) despite DTB3's longer real history (1954 vs. 1981) — DGS3MO is
# methodologically consistent with DGS2/DGS10/DGS30's own constant-maturity
# convention; DTB3's extra decades of history aren't relevant against this
# panel's 2Y–20Y window options anyway. The classic recession-inversion pair
# most commonly cited (3-month vs. 10-year) needs DGS3MO specifically, not
# T10Y2Y's 10Y-2Y spread — a second, real spread AV didn't have before.
FRED_SERIES_DGS3MO = "DGS3MO"    # 3-Month Treasury Constant Maturity yield
FRED_SERIES_DGS5 = "DGS5"        # 5-Year Treasury Constant Maturity yield
FRED_SERIES_DGS30 = "DGS30"      # 30-Year Treasury Constant Maturity yield

# Foreign holdings of U.S. long-term Treasury securities (Treasuries-picture
# expansion) — FRED's own ingestion of TIC (Treasury International Capital)
# data, confirmed live via fredgraph.csv for every series below. Units:
# millions of USD, monthly, real coverage starting 1984-12-01 (varies by
# country — Belgium/Luxembourg/Cayman Islands only start ~2001, per a real
# TIC reporting-category change that year; see this dict's own docstring in
# main.py for the cross-check). The numeric suffix is TIC's own 5-digit
# country code — NOT derivable from ISO country codes (confirmed: e.g.
# Japan=42609, China=41408, no arithmetic relationship) — sourced from
# Treasury's own published lookup table (ticdata.treasury.gov/Publish/
# cntrysec.txt) rather than guessed. IMPORTANT: this "LT" (long-term) family
# EXCLUDES T-bills — confirmed live that FRED's Grand Total
# (FORLTTREASPOS99996, ~$7.92T as of 2026-05) is meaningfully smaller than
# Treasury's own bills-inclusive Major Foreign Holders Grand Total (~$9.37T
# same month) — these two numbers must never be shown as if interchangeable.
# Cayman Islands (FORLTTREASPOS36137) is a REAL SUBSET of Total Caribbean
# (FORLTTREASPOS34401), not a duplicate or an alternative — confirmed live
# the two differ substantially for the same month ($312B vs. $469B) —
# summing both into one total would double-count.
FRED_SERIES_TIC_COUNTRIES = {
    "Japan": "FORLTTREASPOS42609",
    "China": "FORLTTREASPOS41408",
    "United Kingdom": "FORLTTREASPOS13005",
    "Belgium": "FORLTTREASPOS10251",
    "Luxembourg": "FORLTTREASPOS11703",
    "Switzerland": "FORLTTREASPOS12688",
    "Cayman Islands": "FORLTTREASPOS36137",
    "Ireland": "FORLTTREASPOS11401",
    "Taiwan": "FORLTTREASPOS46302",
    "India": "FORLTTREASPOS42102",
    "Canada": "FORLTTREASPOS29998",
    "Hong Kong": "FORLTTREASPOS42005",
    "Turkey": "FORLTTREASPOS12807",
    "Total Caribbean": "FORLTTREASPOS34401",
}
FRED_SERIES_TIC_GRAND_TOTAL = "FORLTTREASPOS99996"  # all countries, LT Treasuries only (excludes bills)
