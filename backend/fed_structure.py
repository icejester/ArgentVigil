"""Money Management tab's pure logic (money-management-spec.md) — no HTTP
client of its own, so it imports cleanly from both `collector.py` (fetch
functions) and `main.py` (read routes) without a circular import.

- FDIC BankFind row mapping (Story #2)
- Governance seed loading + FOMC rotation math (Story #1)
- federalreserve.gov Board-roster parsing for the drift check (Story #1)
"""

import json
import os
import re
from datetime import date, datetime, timezone

from . import db
from pipeline.config import FRED_SERIES_RESERVE_BANK_H41

FDIC_INSTITUTIONS_URL = "https://api.fdic.gov/banks/institutions"
# Confirmed live 2026-09-23: banks.data.fdic.gov/api/* now 301s here. FED is a
# native field ("01".."12"), so district needs no join/derivation.
# ASSET/DEP/EQ are thousands of USD, from the institution's latest Call
# Report (REPDTE, quarterly — confirmed live 2026-09-23: 06/30/2026 for
# active banks). EQ arrives as a string, ASSET/DEP as numbers.
FDIC_FIELDS = "CERT,NAME,FED,FED_RSSD,REGAGNT,BKCLASS,NAMEHCR,RSSDHCR,CITY,STALP,ACTIVE,ENDEFYMD,ASSET,DEP,EQ,REPDTE"
FDIC_PAGE_SIZE = 10000  # FDIC's documented per-request maximum

FDIC_FINANCIALS_URL = "https://api.fdic.gov/banks/financials"
# Quarterly Call Report history. FED is reported PER FILING (confirmed live:
# Citibank cert 7213 is FED 2 in 1984, FED 9 by 2018), so each quarter keeps
# its own as-of district. 671k rows since 2002 (~9.6k banks/quarter in 2002,
# ~4.3k now) — one request per quarter fits under the 10k page max.
FDIC_FINANCIALS_FIELDS = "CERT,REPDTE,FED,ASSET,DEP,EQ"
# 2002 = the first year of FRED's per-Reserve-Bank H.4.1 series (2002-12-18),
# so every persisted quarter has Fed balance-sheet data beside it.
BANK_FINANCIALS_START_YEAR = 2002

FED_BOARD_URL = "https://www.federalreserve.gov/aboutthefed/bios/board/default.htm"
# Each governor is a list-group-item link to their own bio page, e.g.
# <a href="/aboutthefed/bios/board/warsh.htm" ...>Kevin Warsh, Chairman</a>.
# boardmembership.htm (the 1914-present history page) shares the pattern and
# is excluded explicitly.
_BOARD_LINK_RE = re.compile(r'href="/aboutthefed/bios/board/([a-z]+)\.htm"[^>]*>([^<]+)</a>')
_BOARD_NON_MEMBER_SLUGS = {"default", "boardmembership"}

SEED_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "seed_data", "fed_governance.json")


# --- FDIC BankFind ----------------------------------------------------------

def _blank_to_none(v):
    if v is None:
        return None
    v = str(v).strip()
    return v or None


def _fdic_date(v) -> str | None:
    """ENDEFYMD is MM/DD/YYYY; active institutions carry a 9999 sentinel."""
    v = _blank_to_none(v)
    if not v:
        return None
    try:
        parsed = datetime.strptime(v, "%m/%d/%Y").date()
    except ValueError:
        return None
    return None if parsed.year >= 9999 else parsed.isoformat()


def _fdic_thousands(v) -> float | None:
    v = _blank_to_none(v)
    if v is None:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def map_fdic_row(raw: dict, fetched_at: str) -> dict | None:
    """One FDIC `data` object -> a bank_registry row. None if it has no CERT
    or name (nothing to key or display — skipped rather than persisted half-
    empty)."""
    cert = raw.get("CERT")
    name = _blank_to_none(raw.get("NAME"))
    if cert is None or name is None:
        return None
    fed = _blank_to_none(raw.get("FED"))
    try:
        district = int(fed) if fed is not None else None
    except ValueError:
        district = None
    if district is not None and not 1 <= district <= 12:
        district = None  # never persist an out-of-range/0 district as if real
    active = raw.get("ACTIVE")
    return {
        "cert": int(cert),
        "name": name,
        "fed_rssd": _blank_to_none(raw.get("FED_RSSD")),
        "charter_class": _blank_to_none(raw.get("BKCLASS")),
        "regulator": _blank_to_none(raw.get("REGAGNT")),
        "fed_district": district,
        "holding_company": _blank_to_none(raw.get("NAMEHCR")),
        "holding_company_rssd": _blank_to_none(raw.get("RSSDHCR")),
        "city": _blank_to_none(raw.get("CITY")),
        "state": _blank_to_none(raw.get("STALP")),
        "active": 1 if str(active) == "1" else 0,
        "inactive_date": None if str(active) == "1" else _fdic_date(raw.get("ENDEFYMD")),
        "total_assets_k": _fdic_thousands(raw.get("ASSET")),
        "deposits_k": _fdic_thousands(raw.get("DEP")),
        "equity_k": _fdic_thousands(raw.get("EQ")),
        "financials_as_of": _fdic_date(raw.get("REPDTE")),
        "fetched_at": fetched_at,
    }


def quarter_ends(start_year: int, today: date) -> list[str]:
    """Every calendar quarter-end from start_year through the last one on or
    before `today`, as FDIC's YYYYMMDD REPDTE strings."""
    out = []
    for year in range(start_year, today.year + 1):
        for month, day in ((3, 31), (6, 30), (9, 30), (12, 31)):
            q = date(year, month, day)
            if q <= today:
                out.append(q.strftime("%Y%m%d"))
    return out


def map_fdic_financials_row(raw: dict, fetched_at: str) -> dict | None:
    cert, repdte = raw.get("CERT"), _blank_to_none(raw.get("REPDTE"))
    if cert is None or repdte is None or len(repdte) != 8:
        return None
    fed = raw.get("FED")
    try:
        district = int(fed) if fed not in (None, "") else None
    except (TypeError, ValueError):
        district = None
    if district is not None and not 1 <= district <= 12:
        district = None
    return {
        "cert": int(cert),
        "repdte": f"{repdte[:4]}-{repdte[4:6]}-{repdte[6:]}",
        "fed_district": district,
        "total_assets_k": _fdic_thousands(raw.get("ASSET")),
        "deposits_k": _fdic_thousands(raw.get("DEP")),
        "equity_k": _fdic_thousands(raw.get("EQ")),
        "fetched_at": fetched_at,
    }


# --- Governance seed + FOMC rotation ----------------------------------------

def load_seed(path: str = SEED_PATH) -> dict:
    with open(path) as f:
        return json.load(f)


def persist_seed(seed: dict | None = None) -> dict:
    """Replace-all load of the governance seed into its tables. Idempotent."""
    seed = seed or load_seed()
    board = [{**b, "sort_order": i} for i, b in enumerate(seed["board"])]
    banks = [{**b, "verified": 1 if b.get("verified") else 0} for b in seed["reserve_banks"]]
    db.replace_fed_governance(board, banks, {
        "reviewed_as_of": seed.get("reviewed_as_of"),
        "review_notes": seed.get("review_notes"),
        "rotation_json": json.dumps(seed["fomc_rotation"]),
        "loaded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })
    return seed


def fomc_voting_districts(rotation: dict, year: int) -> dict:
    """Statutory rotation, computed — never stored. Returns the permanent
    district plus one rotating district per group for `year`."""
    rotating = [int(g["by_year_mod"][str(year % g["modulus"])]) for g in rotation["groups"]]
    return {"permanent": int(rotation["permanent_district"]), "rotating": rotating}


def reserve_bank_balance_sheet(district: int) -> dict | None:
    """Latest real Wednesday level of each H.4.1 line for one Reserve Bank,
    in USD (FRED native millions x 1e6). Each line carries its own latest
    date; as_of is the latest across them. None if nothing is persisted."""
    since = str(date.today().replace(year=date.today().year - 1))
    out, as_of = {}, None
    for line, series_id in FRED_SERIES_RESERVE_BANK_H41[district].items():
        rows = [r for r in db.get_fred_observations(series_id, since) if r["value"] is not None]
        if rows:
            out[line] = rows[-1]["value"] * 1_000_000
            as_of = max(as_of or rows[-1]["date"], rows[-1]["date"])
        else:
            out[line] = None
    if as_of is None:
        return None
    out["as_of"] = as_of
    return out


def governance_view(year: int | None = None) -> dict | None:
    """Read model for GET /api/fed-governance/db. Loads the seed on first use
    so an environment whose collector hasn't run yet (UPDATE_MODE=frozen)
    still shows governance data — the seed ships with the code."""
    gov = db.get_fed_governance()
    if gov is None:
        persist_seed()
        gov = db.get_fed_governance()
    year = year or date.today().year
    rotation = json.loads(gov["meta"]["rotation_json"])
    voters = fomc_voting_districts(rotation, year)
    voting = {voters["permanent"], *voters["rotating"]}
    counts = db.get_bank_registry_district_counts()
    banks = [
        {
            **b,
            "fomc_voter": b["district"] in voting,
            "fomc_permanent": b["district"] == voters["permanent"],
            "registry": counts.get(b["district"]),
            "balance_sheet": reserve_bank_balance_sheet(b["district"]),
        }
        for b in gov["reserve_banks"]
    ]
    return {
        "year": year,
        "reviewed_as_of": gov["meta"]["reviewed_as_of"],
        "review_notes": gov["meta"]["review_notes"],
        "board": gov["board"],
        "reserve_banks": banks,
        "fomc": {
            "permanent_district": voters["permanent"],
            "rotating_districts": voters["rotating"],
            "groups": [g["label"] for g in rotation["groups"]],
        },
    }


# --- Roster drift check -----------------------------------------------------

def parse_board_roster(html: str) -> list[dict]:
    out = []
    for slug, text in _BOARD_LINK_RE.findall(html):
        if slug in _BOARD_NON_MEMBER_SLUGS:
            continue
        name = text.split(",", 1)[0].strip()
        out.append({"slug": slug, "name": name})
    return out


def roster_drift(seed_board: list[dict], live: list[dict]) -> dict:
    seed_slugs = {b["bio_slug"] for b in seed_board}
    live_slugs = {m["slug"] for m in live}
    return {
        "missing_from_live": sorted(seed_slugs - live_slugs),
        "new_on_live": sorted(live_slugs - seed_slugs),
    }



# --- Over-time views (bank Call Reports x Reserve Bank H.4.1) --------------
#
# Quarter alignment uses the AS-OF variant of the nearest-date convention:
# each quarter-end takes the latest weekly H.4.1 Wednesday on or before it.
# Quarters before a series' first real observation get NULL, never a fill.

def _asof(rows: list[dict], on: str):
    """rows sorted by date, non-null values only. Latest value on/before `on`."""
    best = None
    for r in rows:
        if r["date"] > on:
            break
        best = r["value"]
    return best


def _h41_rows(series_id: str) -> list[dict]:
    return [r for r in db.get_fred_observations(series_id, "2002-01-01") if r["value"] is not None]


def districts_history() -> dict:
    """Per quarter, each district's share of U.S. bank assets (as-of
    district) next to its Reserve Bank's share of the System's total assets
    (sum of the 12 Reserve Banks). Feeds district_history's share lines."""
    totals = db.get_district_quarter_totals()
    quarters = sorted({t["repdte"] for t in totals})
    by_q = {}
    for t in totals:
        by_q.setdefault(t["repdte"], {})[t["district"]] = t
    rb_assets = {d: _h41_rows(FRED_SERIES_RESERVE_BANK_H41[d]["total_assets"]) for d in range(1, 13)}
    out = {d: [] for d in range(1, 13)}
    for q in quarters:
        dist = by_q[q]
        us = sum(t["assets"] for t in dist.values() if t["assets"] is not None)
        rb = {d: _asof(rb_assets[d], q) for d in range(1, 13)}
        system = sum(v for v in rb.values() if v is not None) if all(v is not None for v in rb.values()) else None
        for d in range(1, 13):
            t = dist.get(d)
            out[d].append({
                "date": q,
                "bank_share": (t["assets"] / us) if (t and t["assets"] is not None and us) else None,
                "reserve_bank_share": (rb[d] / system) if (rb[d] is not None and system) else None,
                "bank_assets": t["assets"] if t else None,
                "reserve_bank_assets": rb[d] * 1_000_000 if rb[d] is not None else None,
            })
    return {"quarters": quarters, "districts": out}


def district_history(district: int, top_n: int = 8) -> dict:
    """One district over time: its banks' total assets and top-10 share, the
    Reserve Bank's total assets / reserves held / paid-in capital (as-of each
    quarter-end), and the latest quarter's top_n banks' shares of the
    district over time (0 when a bank wasn't in this district that quarter —
    a real zero share, e.g. before Citibank moved to Minneapolis)."""
    totals = [t for t in db.get_district_quarter_totals() if t["district"] == district]
    top10 = db.get_district_top_n_share(district, 10)
    lines = FRED_SERIES_RESERVE_BANK_H41[district]
    h41 = {k: _h41_rows(lines[k]) for k in ("total_assets", "depository_deposits", "capital_paid_in")}
    top = db.get_district_top_banks_latest(district, top_n)
    bank_rows = db.get_bank_assets_in_district([b["cert"] for b in top], district)
    by_bank = {}
    for r in bank_rows:
        by_bank.setdefault(r["repdte"], {})[r["cert"]] = r["assets"]
    shares_by_q = {r["date"]: r for r in districts_history()["districts"][district]}
    series = []
    for t in totals:
        q, total = t["repdte"], t["assets"]
        m = lambda v: v * 1_000_000 if v is not None else None
        row = {
            "date": q,
            "bank_assets": total,
            "bank_count": t["count"],
            "top10_share": (top10.get(q) / total) if (total and q in top10) else None,
            "reserve_bank_assets": m(_asof(h41["total_assets"], q)),
            "reserves_held": m(_asof(h41["depository_deposits"], q)),
            "capital_paid_in": m(_asof(h41["capital_paid_in"], q)),
            "us_bank_share": shares_by_q.get(q, {}).get("bank_share"),
            "system_share": shares_by_q.get(q, {}).get("reserve_bank_share"),
            "shares": {},
        }
        if total:
            named = 0.0
            for b in top:
                v = by_bank.get(q, {}).get(b["cert"], 0.0)
                row["shares"][str(b["cert"])] = v / total
                named += v
            row["shares"]["other"] = max(0.0, (total - named) / total)
        series.append(row)
    return {"district": district, "top_banks": top, "series": series}
