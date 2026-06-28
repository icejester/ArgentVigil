"""
Fetches COMEX Silver CoT data from the CFTC Public Reporting Environment (PRE)
Socrata API. Standard library only — no third-party deps.
"""

import json
import urllib.request
import urllib.parse
from datetime import datetime, timedelta, timezone
from config import CFTC_API_BASE, SILVER_CONTRACT_CODE, FETCH_YEARS


def fetch_cot_data() -> list[dict]:
    """
    Pull Legacy Futures-Only CoT records for COMEX Silver (084691) going back
    FETCH_YEARS years. Returns a list of raw API row dicts sorted oldest-first.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=365 * FETCH_YEARS)
    cutoff_str = cutoff.strftime("%Y-%m-%dT00:00:00.000")

    # Socrata SoQL: filter by contract code and date, page through with $limit/$offset
    params = {
        "$where": (
            f"cftc_contract_market_code='{SILVER_CONTRACT_CODE}'"
            f" AND report_date_as_yyyy_mm_dd >= '{cutoff_str}'"
        ),
        "$order": "report_date_as_yyyy_mm_dd ASC",
        "$limit": "500",
        "$offset": "0",
    }

    rows: list[dict] = []
    while True:
        url = CFTC_API_BASE + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            page = json.loads(resp.read().decode())

        if not page:
            break

        rows.extend(page)

        if len(page) < int(params["$limit"]):
            break

        params["$offset"] = str(int(params["$offset"]) + len(page))

    return rows
