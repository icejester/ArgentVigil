"""
Central configuration — tune thresholds here without touching pipeline logic.
"""

# CFTC Socrata API
CFTC_API_BASE = "https://publicreporting.cftc.gov/resource/jun7-fc8e.json"
SILVER_CONTRACT_CODE = "084691"

# How many years of history to pull (need >5yr to have a full 5yr window from day one)
FETCH_YEARS = 7

# Lookback windows for percentile calculation (in weeks)
WINDOW_2YR = 104   # ~2 years of weekly data
WINDOW_5YR = 260   # ~5 years of weekly data

# Signal bucket thresholds (percentile, 0–100)
CROWDED_THRESHOLD = 90    # top decile → specs crowded long
CAPITULATED_THRESHOLD = 10  # bottom decile → specs capitulated

# Cache file location (relative to repo root)
CACHE_FILE = "pipeline/cache/cot_data.json"
