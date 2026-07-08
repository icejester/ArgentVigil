"""
Fetches COMEX CoT data from the CFTC Public Reporting Environment (PRE)
Socrata API. Standard library only — no third-party deps.
"""

import json
import urllib.request
import urllib.parse
from datetime import datetime, timedelta, timezone
from config import (
    CFTC_API_BASE,
    CFTC_DISAGGREGATED_API_BASE,
    SILVER_CONTRACT_CODE,
    GOLD_CONTRACT_CODE,
    FETCH_YEARS,
)


def _fetch_cot_for_contract(api_base: str, contract_code: str, since: str | None = None) -> list[dict]:
    """
    Pull CoT records for a given contract code, from whichever Socrata
    dataset api_base points at (Legacy or Disaggregated Futures-Only — same
    query shape, different dataset/columns). Returns a list of raw API row
    dicts sorted oldest-first.

    since, if given (an already-persisted report_date, e.g. from
    db.get_latest_cot_report_date()), becomes the cutoff instead of the
    wall-clock FETCH_YEARS-back calculation — so a repeat run (including the
    on-demand health-refresh button) fetches only what's new rather than
    re-pulling the full multi-year history every time.
    """
    if since:
        cutoff_str = f"{since}T00:00:00.000"
    else:
        cutoff = datetime.now(timezone.utc) - timedelta(days=365 * FETCH_YEARS)
        cutoff_str = cutoff.strftime("%Y-%m-%dT00:00:00.000")

    # Socrata SoQL: filter by contract code and date, page through with $limit/$offset
    params = {
        "$where": (
            f"cftc_contract_market_code='{contract_code}'"
            f" AND report_date_as_yyyy_mm_dd >= '{cutoff_str}'"
        ),
        "$order": "report_date_as_yyyy_mm_dd ASC",
        "$limit": "500",
        "$offset": "0",
    }

    rows: list[dict] = []
    while True:
        url = api_base + "?" + urllib.parse.urlencode(params)
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


def fetch_cot_data(since: str | None = None) -> list[dict]:
    return _fetch_cot_for_contract(CFTC_API_BASE, SILVER_CONTRACT_CODE, since=since)


def fetch_gold_cot_data(since: str | None = None) -> list[dict]:
    return _fetch_cot_for_contract(CFTC_API_BASE, GOLD_CONTRACT_CODE, since=since)


def fetch_disaggregated_cot_data(since: str | None = None) -> list[dict]:
    return _fetch_cot_for_contract(CFTC_DISAGGREGATED_API_BASE, SILVER_CONTRACT_CODE, since=since)


def fetch_gold_disaggregated_cot_data(since: str | None = None) -> list[dict]:
    return _fetch_cot_for_contract(CFTC_DISAGGREGATED_API_BASE, GOLD_CONTRACT_CODE, since=since)
