import os
import sqlite3
from bisect import bisect_right
from contextlib import contextmanager
from datetime import datetime, timezone

from .price_instruments import GC_F_WEEKLY, GLD_CLOSE, SESSION_DAILY, SI_F_WEEKLY, SLV_CLOSE
from .units import GOLD_CONTRACT_OZ, SILVER_CONTRACT_OZ

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(_REPO_ROOT, "runtime", "argentvigil.db")
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)  # sqlite3.connect does not create parent dirs

DDL = """
CREATE TABLE IF NOT EXISTS inventory_aggregate (
    date TEXT PRIMARY KEY,
    total REAL,
    registered REAL,
    eligible REAL,
    reg_eligible_ratio REAL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory_depository (
    date TEXT,
    depository TEXT,
    registered REAL,
    eligible REAL,
    total REAL,
    prev_registered REAL,
    prev_eligible REAL,
    prev_total REAL,
    PRIMARY KEY (date, depository)
);

CREATE TABLE IF NOT EXISTS gold_inventory_aggregate (
    date TEXT PRIMARY KEY,
    total REAL,
    registered REAL,
    eligible REAL,
    reg_eligible_ratio REAL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gold_inventory_depository (
    date TEXT,
    depository TEXT,
    registered REAL,
    eligible REAL,
    total REAL,
    prev_registered REAL,
    prev_eligible REAL,
    prev_total REAL,
    PRIMARY KEY (date, depository)
);

CREATE TABLE IF NOT EXISTS gold_volume_oi (
    date TEXT PRIMARY KEY,
    open_interest REAL,
    volume REAL,
    paper_leverage REAL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shfe_inventory (
    date TEXT PRIMARY KEY,
    total_kg REAL,
    total_oz REAL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS volume_oi (
    date TEXT PRIMARY KEY,
    open_interest REAL,
    volume REAL,
    paper_leverage REAL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fred_observations (
    series_id TEXT NOT NULL,
    date      TEXT NOT NULL,
    value     REAL,
    PRIMARY KEY (series_id, date)
);

CREATE TABLE IF NOT EXISTS delivery_notices (
    date TEXT,
    type TEXT,
    daily_issued REAL,
    daily_stopped REAL,
    PRIMARY KEY (date, type)
);

CREATE TABLE IF NOT EXISTS shfe_warehouse (
    date TEXT,
    warehouse TEXT,
    warrant_kg REAL,
    warrant_change_kg REAL,
    PRIMARY KEY (date, warehouse)
);

CREATE TABLE IF NOT EXISTS pslv_snapshot (
    date TEXT PRIMARY KEY,
    total_oz REAL,
    nav_per_unit REAL,
    total_nav REAL,
    units REAL
);

-- Tick-resolution spot price, per price-architecture-spec.md. instrument
-- is a closed set (see backend/price_instruments.py) — real metalcharts.org
-- spot quotes (*_SPOT, ~60s cadence) and Yahoo front-month-continuous
-- futures bars (*_FUTURES_FRONT, 5-min cadence) are DIFFERENT instruments
-- that must never share a key: an earlier design shared "XAG"/"XAU" between
-- the two and produced a real sawtooth artifact (futures prints running
-- ~0.3-0.6 higher than spot, interleaved on the same series). Append-only —
-- a real tick is never revised.
CREATE TABLE IF NOT EXISTS spot_price (
    instrument TEXT NOT NULL,
    ts TEXT NOT NULL,
    price REAL,
    change_pct_24h REAL,
    PRIMARY KEY (instrument, ts)
);

-- Daily-or-coarser settlement/reference prices, per price-architecture-
-- spec.md: Yahoo real daily closes, GoldAPI.io LBMA AM/PM/daily fixes, and
-- ETF/COT-week closes all live here as different `instrument` values
-- instead of three separately-shaped tables (the old lbma_fix table plus
-- assorted fred_observations series_id keys plus cot_prices). Upsert, not
-- append-only — LBMA/Yahoo closes can both be legitimately re-fetched.
-- `session` is a real string column ('AM'|'PM'|'daily'), not NULL, since
-- NULL in a composite PRIMARY KEY behaves unintuitively for SQLite's
-- ON CONFLICT upserts — matches lbma_fix's prior fix_type convention.
CREATE TABLE IF NOT EXISTS settlement_price (
    instrument TEXT NOT NULL,
    date TEXT NOT NULL,
    session TEXT NOT NULL,
    price REAL,
    high REAL,
    low REAL,
    fetched_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (instrument, date, session)
);

-- U.S. Census Bureau International Trade API, HS 7106 (silver) / HS 7108
-- (gold, comparison-only) monthly imports/exports by country. Revised
-- annually every April (unlike CFTC's immutable-once-published reports),
-- so this is upsert, not append-only. Confirmed live (2025-01, 2024-06,
-- both flows, both metals): Census reports no quantity/weight for either
-- HS code — GEN_QY1_MO/CON_QY1_MO/QTY_1_MO are always "0" and UNIT_QY1 is
-- always "-" (Census's own not-applicable sentinel). qty/qty_unit persist
-- as NULL until Census ever starts reporting a real figure.
CREATE TABLE IF NOT EXISTS census_trade (
    metal TEXT NOT NULL,
    flow TEXT NOT NULL,
    hs_code TEXT NOT NULL,
    cty_code TEXT NOT NULL,
    cty_name TEXT,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    value_general_usd INTEGER,
    value_consumption_usd INTEGER,
    qty REAL,
    qty_unit TEXT,
    fetched_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (metal, flow, hs_code, cty_code, year, month)
);

-- Front-month vs. next-month COMEX futures settlement spread (Squeeze
-- Context Story #1, see squeeze-context-spec.md). Sourced from Yahoo
-- Finance's chart API against real deferred-month contract symbols (e.g.
-- SIU26.CMX), resolved daily via a hand-maintained active-delivery-months
-- list per metal + delivery_behavior.last_trade_day for rollover timing —
-- see main.py's _resolve_front_next_contracts. curve_spread_pct is NULL
-- (not 0) on any day either leg has no real price, per the standing
-- nulls-over-zeros convention.
CREATE TABLE IF NOT EXISTS futures_curve_spread (
    metal TEXT NOT NULL,
    date TEXT NOT NULL,
    front_month_symbol TEXT,
    front_month_price REAL,
    next_month_symbol TEXT,
    next_month_price REAL,
    curve_spread_pct REAL,
    fetched_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (metal, date)
);

-- Hand-maintained historical squeeze/dislocation case log (Squeeze Context
-- Story #3). Flat reference data, not a fetched table — no upstream source,
-- rows are entered by hand/script. curve_reading_snapshot is nullable since
-- curve spread backfill for cases predating this feature's ingestion start
-- is best-effort, not guaranteed.
CREATE TABLE IF NOT EXISTS squeeze_case_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_name TEXT NOT NULL,
    metal TEXT NOT NULL,
    date_range_start TEXT NOT NULL,
    date_range_end TEXT NOT NULL,
    cot_reading_snapshot TEXT,
    curve_reading_snapshot TEXT,
    mechanism_tag TEXT,
    outcome_notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_calendar (
    event_id TEXT PRIMARY KEY,
    event_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    scheduled_time TEXT NOT NULL,
    consensus_value REAL,
    actual_value REAL,
    surprise_delta REAL,
    source_url TEXT,
    source_tier TEXT
);

CREATE TABLE IF NOT EXISTS macro_price_reaction (
    event_id TEXT NOT NULL,
    metal TEXT NOT NULL,
    window TEXT NOT NULL,
    price REAL,
    price_delta_pct REAL,
    surprise_magnitude REAL,
    PRIMARY KEY (event_id, metal, window)
);

CREATE TABLE IF NOT EXISTS cot_silver (
    report_date TEXT PRIMARY KEY,
    noncomm_long REAL,
    noncomm_short REAL,
    open_interest REAL,
    net_long REAL,
    net_long_pct_oi REAL,
    fetched_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cot_gold (
    report_date TEXT PRIMARY KEY,
    noncomm_long REAL,
    noncomm_short REAL,
    open_interest REAL,
    net_long REAL,
    net_long_pct_oi REAL,
    fetched_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    ran_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_health (
    source_key          TEXT PRIMARY KEY,
    last_attempt_at     TEXT,
    last_attempt_status TEXT,
    last_success_at     TEXT,
    last_error          TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS interval_overrides (
    source_key       TEXT PRIMARY KEY,
    interval_seconds INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cot_disaggregated (
    report_date TEXT NOT NULL,
    metal TEXT NOT NULL,
    category TEXT NOT NULL,
    long REAL,
    short REAL,
    spreading REAL,
    open_interest REAL,
    PRIMARY KEY (report_date, metal, category)
);

CREATE TABLE IF NOT EXISTS forexfactory_calendar (
    week_key TEXT NOT NULL,
    title TEXT NOT NULL,
    country TEXT NOT NULL,
    event_date TEXT NOT NULL,
    impact TEXT,
    forecast TEXT,
    previous TEXT,
    PRIMARY KEY (week_key, title, country, event_date)
);

CREATE TABLE IF NOT EXISTS research_sessions (
    session_id TEXT PRIMARY KEY,
    claim_text TEXT NOT NULL,
    source_url TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    user_read TEXT,
    memory_mode TEXT NOT NULL DEFAULT 'accumulating',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    backend TEXT,
    model TEXT,
    persona TEXT,
    context_blocks TEXT,
    memory_mode TEXT,
    memory_changed INTEGER NOT NULL DEFAULT 0,
    assembled_prompt TEXT
);

CREATE TABLE IF NOT EXISTS research_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    claim_text TEXT NOT NULL,
    source_url TEXT,
    user_read TEXT NOT NULL,
    dismissed_at TEXT NOT NULL,
    dismiss_reason TEXT NOT NULL DEFAULT '',
    validation_status TEXT
);

CREATE TABLE IF NOT EXISTS ui_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pinned_section TEXT
);
"""


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_conn() as conn:
        conn.executescript(DDL)
        # CREATE TABLE IF NOT EXISTS doesn't retroactively add columns to an
        # already-existing table — source_tier was added to event_calendar
        # after that table was already deployed, so a plain ALTER TABLE
        # (guarded, since SQLite has no ADD COLUMN IF NOT EXISTS) is needed
        # for databases created before this column existed. No-op on a
        # fresh DB, where the DDL above already includes the column.
        try:
            conn.execute("ALTER TABLE event_calendar ADD COLUMN source_tier TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists
        # research_session_id: set only when source_tier = "discovered" (a
        # promoted research session), NULL for government-seeded events —
        # the backlink from a promoted catalyst to the session that produced it.
        try:
            conn.execute("ALTER TABLE event_calendar ADD COLUMN research_session_id TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists
        # direction: expected market direction of a promoted catalyst (e.g.
        # "bullish"/"bearish" for silver/gold), distinct from a research
        # session's own user_read (credibility of the claim, not the
        # catalyst's expected price effect). Always NULL for government-seeded
        # events.
        try:
            conn.execute("ALTER TABLE event_calendar ADD COLUMN direction TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists
        # Research Pane rebuild (catcor-events-spec.md) — memory_mode tracks
        # a session's current Stateless/Accumulating setting so the UI can
        # default the toggle to wherever it was last left, rather than
        # always resetting to one fixed value.
        try:
            conn.execute(
                "ALTER TABLE research_sessions ADD COLUMN memory_mode TEXT NOT NULL DEFAULT 'accumulating'"
            )
        except sqlite3.OperationalError:
            pass  # column already exists
        # research_messages: new per-turn metadata, split across user-row vs
        # assistant-row fields (a "turn" is a user/assistant row pair, same
        # as before this change) — see catcor_research.py's send_message for
        # which role writes which column.
        for stmt in (
            "ALTER TABLE research_messages ADD COLUMN backend TEXT",
            "ALTER TABLE research_messages ADD COLUMN model TEXT",
            "ALTER TABLE research_messages ADD COLUMN persona TEXT",
            "ALTER TABLE research_messages ADD COLUMN context_blocks TEXT",
            "ALTER TABLE research_messages ADD COLUMN memory_mode TEXT",
            "ALTER TABLE research_messages ADD COLUMN memory_changed INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE research_messages ADD COLUMN assembled_prompt TEXT",
        ):
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError:
                pass  # column already exists
        # research_log: dismissal reason, required by dismiss_research_session
        # going forward but backfilled empty for any pre-existing rows.
        try:
            conn.execute(
                "ALTER TABLE research_log ADD COLUMN dismiss_reason TEXT NOT NULL DEFAULT ''"
            )
        except sqlite3.OperationalError:
            pass  # column already exists
        # settlement_price: high/low, added for the Paper Games leverage
        # chart's day-range price series — Yahoo's daily chart-API response
        # already carries these fields (see yahoo_prices.fetch_yahoo_bars),
        # previously discarded. NULL for any instrument with no real
        # intraday-range concept (LBMA fix, ETF/weekly closes — a single
        # fixed print per period, never a range).
        for stmt in (
            "ALTER TABLE settlement_price ADD COLUMN high REAL",
            "ALTER TABLE settlement_price ADD COLUMN low REAL",
        ):
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError:
                pass  # column already exists


def upsert_aggregate_rows(rows: list[dict]):
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR REPLACE INTO inventory_aggregate
               (date, total, registered, eligible, reg_eligible_ratio)
               VALUES (:date, :total, :registered, :eligible, :reg_eligible_ratio)""",
            rows,
        )


def upsert_depository_rows(rows: list[dict]):
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR REPLACE INTO inventory_depository
               (date, depository, registered, eligible, total,
                prev_registered, prev_eligible, prev_total)
               VALUES (:date, :depository, :registered, :eligible, :total,
                       :prev_registered, :prev_eligible, :prev_total)""",
            rows,
        )


def upsert_gold_aggregate_rows(rows: list[dict]):
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR REPLACE INTO gold_inventory_aggregate
               (date, total, registered, eligible, reg_eligible_ratio)
               VALUES (:date, :total, :registered, :eligible, :reg_eligible_ratio)""",
            rows,
        )


def upsert_gold_depository_rows(rows: list[dict]):
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR REPLACE INTO gold_inventory_depository
               (date, depository, registered, eligible, total,
                prev_registered, prev_eligible, prev_total)
               VALUES (:date, :depository, :registered, :eligible, :total,
                       :prev_registered, :prev_eligible, :prev_total)""",
            rows,
        )


def get_gold_aggregate_history(limit: int | None = None) -> list[dict]:
    with get_conn() as conn:
        q = "SELECT date, total, registered, eligible, reg_eligible_ratio FROM gold_inventory_aggregate ORDER BY date"
        if limit:
            q += f" DESC LIMIT {limit}"
        rows = conn.execute(q).fetchall()
        result = [dict(r) for r in rows]
        if limit:
            result.reverse()
        return result


def count_gold_aggregate() -> int:
    with get_conn() as conn:
        return conn.execute("SELECT COUNT(*) FROM gold_inventory_aggregate").fetchone()[0]


def upsert_gold_volume_oi_row(row: dict):
    with get_conn() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO gold_volume_oi
               (date, open_interest, volume, paper_leverage)
               VALUES (:date, :open_interest, :volume, :paper_leverage)""",
            row,
        )


def upsert_shfe_rows(rows: list[dict]):
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR REPLACE INTO shfe_inventory (date, total_kg, total_oz)
               VALUES (:date, :total_kg, :total_oz)""",
            rows,
        )


def get_shfe_history() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT date, total_kg, total_oz FROM shfe_inventory ORDER BY date"
        ).fetchall()
        return [dict(r) for r in rows]


def upsert_volume_oi_row(row: dict):
    with get_conn() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO volume_oi
               (date, open_interest, volume, paper_leverage)
               VALUES (:date, :open_interest, :volume, :paper_leverage)""",
            row,
        )


def get_aggregate_history(limit: int | None = None) -> list[dict]:
    with get_conn() as conn:
        q = "SELECT date, total, registered, eligible, reg_eligible_ratio FROM inventory_aggregate ORDER BY date"
        if limit:
            q += f" DESC LIMIT {limit}"
        rows = conn.execute(q).fetchall()
        result = [dict(r) for r in rows]
        if limit:
            result.reverse()
        return result


def has_date_aggregate(date: str) -> bool:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM inventory_aggregate WHERE date = ?", (date,)
        ).fetchone()
        return row is not None


def count_aggregate() -> int:
    with get_conn() as conn:
        return conn.execute("SELECT COUNT(*) FROM inventory_aggregate").fetchone()[0]


def upsert_fred_observations(series_id: str, rows: list[dict]):
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR REPLACE INTO fred_observations (series_id, date, value)
               VALUES (?, ?, ?)""",
            [(series_id, r["date"], r["value"]) for r in rows],
        )


def get_latest_depositories() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT date, depository, registered, eligible, total,
                      prev_registered, prev_eligible, prev_total
               FROM inventory_depository
               WHERE date = (SELECT MAX(date) FROM inventory_depository)"""
        ).fetchall()
        return [dict(r) for r in rows]


def get_depositories_on_date(date: str) -> list[dict]:
    """Per-depository snapshot for an exact persisted date, or [] if none was
    ever persisted for it (inventory_depository only accumulates from whenever
    the depositories fetch first ran, no historical backfill)."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT date, depository, registered, eligible, total,
                      prev_registered, prev_eligible, prev_total
               FROM inventory_depository
               WHERE date = ?""",
            (date,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_latest_gold_depositories() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT date, depository, registered, eligible, total,
                      prev_registered, prev_eligible, prev_total
               FROM gold_inventory_depository
               WHERE date = (SELECT MAX(date) FROM gold_inventory_depository)"""
        ).fetchall()
        return [dict(r) for r in rows]


def get_latest_volume_oi() -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT date, open_interest, volume, paper_leverage FROM volume_oi ORDER BY date DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None


def get_latest_gold_volume_oi() -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT date, open_interest, volume, paper_leverage FROM gold_volume_oi ORDER BY date DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None


def get_volume_series(metal: str) -> list[dict]:
    """Real daily volume history — metalcharts.org's only field this
    codebase still trusts from volume_oi/gold_volume_oi (see
    _leverage_backfill_from_cot's docstring: open_interest/paper_leverage
    from this table were dropped from every leverage computation after a
    2026-07 investigation confirmed metalcharts.org's OI figure runs
    ~15% below CFTC's real open_interest_all; volume has no CFTC
    equivalent at all, so it's still the only source). Only accumulates
    forward from whenever the slow tier first started polling — no
    historical backfill exists or is possible (metalcharts.org's own
    volume-oi endpoint has no range/date param support, confirmed live)."""
    table = "volume_oi" if metal == "XAG" else "gold_volume_oi"
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT date, volume FROM {table} WHERE volume IS NOT NULL ORDER BY date"
        ).fetchall()
        return [dict(r) for r in rows]


def _leverage_backfill_from_cot(cot_table: str, aggregate_table: str, contract_oz: int) -> list[dict]:
    """Computes the real paper_leverage series from two tables AV already
    ingests for unrelated reasons: cot_{silver,gold}'s weekly open_interest
    (CFTC's own open_interest_all field — total OI across every reportable
    and non-reportable position, real weekly history back to 2011, the
    government's own documented figure for the contract) joined against
    {inventory,gold_inventory}_aggregate's daily registered oz.

    This is now the ONLY source get_leverage_history uses for the OI side
    of the ratio — metalcharts.org's own volume-oi endpoint used to supply
    a second, daily-resolution OI figure for recent dates, stitched in
    ahead of this backfill. That was removed after a real investigation
    (2026-07) found the two sources do NOT measure the same thing: on
    every date checked where both existed, metalcharts.org's openInterest
    ran a stable ~15% below CFTC's open_interest_all for the same contract
    (e.g. 2026-06-30: metalcharts.org 108,964 contracts vs. CFTC's real
    127,000) — not noise, a consistent gap, most plausibly metalcharts.org
    excluding some category CFTC's total includes (spread positions,
    non-reportable small traders — unconfirmed which). Splicing two
    non-equivalent OI numbers together produced a real, visible
    discontinuity in the leverage chart right at the CoT-backfill/real-
    daily-data seam (open interest and the derived ratio both stepped
    sharply at the boundary even though neither underlying input actually
    moved that much week over week) — a data-source bug, not a math bug.
    CFTC-only removes the seam entirely: one source, one weekly-resolution
    series, no boundary to disagree with itself. volume_oi/gold_volume_oi
    still exist and are still fetched, but only for the `volume` figure
    now (a real quantity CFTC doesn't report at all) — their own
    open_interest/paper_leverage columns are no longer populated.

    Real ceiling is set by `registered` specifically, NOT by `total`
    (which does go back to 1992 for both metals) or by CoT's 2011 OI
    coverage — metalcharts.org's registered/eligible split is a real
    upstream gap confirmed live: NULL before 2020-01-02 for silver, NULL
    before 2026-02-17 for gold (gold's registered/eligible breakdown is
    only a few months old upstream; this backfill effectively does
    nothing for gold beyond that). Silver backfills to 2020-01-02, not
    2019 and not CoT's full 2011 range, because that's where registered
    itself actually starts being reported, not a query-side limitation.

    Weekly resolution throughout (CoT's own publish cadence) — the whole
    series, not just an early segment; there is no longer a denser daily
    tail to hand off to."""
    with get_conn() as conn:
        cot_rows = conn.execute(
            f"SELECT report_date AS date, open_interest FROM {cot_table} "
            f"WHERE open_interest IS NOT NULL ORDER BY report_date"
        ).fetchall()
        agg_rows = conn.execute(
            f"SELECT date, registered FROM {aggregate_table} "
            f"WHERE registered IS NOT NULL ORDER BY date"
        ).fetchall()

    agg_dates = [r["date"] for r in agg_rows]
    agg_by_date = {r["date"]: r["registered"] for r in agg_rows}

    out = []
    for r in cot_rows:
        report_date = r["date"]
        oi = r["open_interest"]
        # Registered inventory isn't always reported exactly on a CoT
        # Tuesday (weekends/holidays/gaps) — use the nearest available
        # date on or before it, same "as-of" convention VaultSnapshotPanel
        # already uses for pinned-date lookups.
        idx = bisect_right(agg_dates, report_date) - 1
        if idx < 0:
            continue
        registered = agg_by_date[agg_dates[idx]]
        if not oi or not registered:
            continue
        out.append({
            "date": report_date,
            "open_interest": oi * contract_oz,
            "volume": None,
            "paper_leverage": (oi * contract_oz) / registered,
        })
    return out


def get_leverage_history(metal: str) -> list[dict]:
    """The real paper_leverage series, CFTC-only (see
    _leverage_backfill_from_cot for the full reasoning) — weekly
    resolution throughout, no metalcharts.org OI stitched on top. Each
    row's `volume` is always None here (CFTC's CoT report has no volume
    field); callers that want a same-week volume figure should look it up
    separately from volume_oi/gold_volume_oi (see get_latest_leverage)."""
    if metal == "XAG":
        return _leverage_backfill_from_cot("cot_silver", "inventory_aggregate", SILVER_CONTRACT_OZ)
    return _leverage_backfill_from_cot("cot_gold", "gold_inventory_aggregate", GOLD_CONTRACT_OZ)


def get_latest_leverage(metal: str) -> dict | None:
    """Current paper_leverage reading: CFTC's latest weekly OI ÷ latest
    registered inventory (same computation as get_leverage_history's own
    rows, just the single most recent one) — replaces the old
    get_latest_volume_oi/get_latest_gold_volume_oi as the leverage
    current-value source, per the same CFTC-only fix. `volume` is looked
    up separately from volume_oi/gold_volume_oi's own latest row (still
    metalcharts.org-sourced — CFTC has no volume field at all) since it's
    a real, useful, genuinely-daily figure with no CFTC equivalent; a
    volume reading one or two days older than the OI reading is expected
    and not a bug, since the two now come from sources with different
    natural cadences (weekly CoT vs. metalcharts.org's own daily poll)."""
    history = get_leverage_history(metal)
    if not history:
        return None
    latest = history[-1]
    vol_row = get_latest_volume_oi() if metal == "XAG" else get_latest_gold_volume_oi()
    return {
        "date": latest["date"],
        "open_interest": latest["open_interest"],
        "volume": vol_row["volume"] if vol_row else None,
        "paper_leverage": latest["paper_leverage"],
    }


def upsert_settlement_price_rows(instrument: str, rows: list[dict]):
    """Upsert into settlement_price, keyed (instrument, date, session).
    Each row needs 'date'/'price'/'session' (session defaults to
    price_instruments.SESSION_DAILY if omitted — most instruments only
    ever have one print/day; LBMA gold's 'AM' is the one caller that
    passes it explicitly). 'high'/'low' are optional (only the Yahoo
    daily-close instruments carry them — a single-print instrument like
    LBMA/ETF closes has no range concept, so those rows simply omit the
    keys and persist NULL).

    Diffs against what's already persisted before writing (per
    price-architecture-spec.md's resolution to Q3): a row whose
    price/high/low are all unchanged from the currently-stored values at
    that (date, session) is skipped entirely, so re-fetching a full
    multi-year range on every cadence tick doesn't rewrite years of
    already-correct history — only genuinely new or revised rows hit the
    upsert."""
    if not rows:
        return
    with get_conn() as conn:
        existing = {
            (r["date"], r["session"]): (r["price"], r["high"], r["low"])
            for r in conn.execute(
                "SELECT date, session, price, high, low FROM settlement_price WHERE instrument = ?",
                (instrument,),
            ).fetchall()
        }
        to_write = []
        for row in rows:
            session = row.get("session", SESSION_DAILY)
            high = row.get("high")
            low = row.get("low")
            key = (row["date"], session)
            if existing.get(key) == (row["price"], high, low):
                continue
            to_write.append({
                "instrument": instrument,
                "date": row["date"],
                "session": session,
                "price": row["price"],
                "high": high,
                "low": low,
            })
        if to_write:
            conn.executemany(
                """INSERT INTO settlement_price (instrument, date, session, price, high, low)
                   VALUES (:instrument, :date, :session, :price, :high, :low)
                   ON CONFLICT (instrument, date, session) DO UPDATE SET
                       price = excluded.price,
                       high = excluded.high,
                       low = excluded.low,
                       fetched_at = datetime('now')""",
                to_write,
            )


def get_latest_settlement_price(instrument: str) -> list[dict]:
    """Latest row per session for an instrument (gold LBMA has 'AM' only
    via GoldAPI.io; silver LBMA has 'daily' only) — a list since an
    instrument could in principle carry more than one session."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT instrument, date, session, price FROM settlement_price AS outer_row
               WHERE instrument = ? AND date = (
                   SELECT MAX(date) FROM settlement_price
                   WHERE instrument = outer_row.instrument AND session = outer_row.session
               )""",
            (instrument,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_settlement_price_series(instrument: str, session: str | None = None) -> list[dict]:
    query = "SELECT date, session, price, high, low FROM settlement_price WHERE instrument = ?"
    params: list = [instrument]
    if session is not None:
        query += " AND session = ?"
        params.append(session)
    query += " ORDER BY date"
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]


def get_daily_price_range(metal: str, since: str) -> list[dict]:
    """Real daily high/low/close for a metal since `since` (YYYY-MM-DD),
    for the Paper Games leverage chart's day-range price series — NOT
    tick-resolution (that's spot_price/get_price_backfill's job). Reads
    settlement_price's XAG_YAHOO_DAILY_CLOSE/XAU_YAHOO_DAILY_CLOSE
    instrument, which already carries real Yahoo daily high/low (captured
    by yahoo_prices.fetch_yahoo_bars, persisted by
    _fetch_and_persist_yahoo_daily_close — no separate fetch needed).
    Rows with no real high/low (pre-migration rows fetched before this
    column existed, or a genuinely missing bar) are skipped rather than
    rendered as a zero-width range."""
    instrument = f"{metal}_YAHOO_DAILY_CLOSE"
    rows = get_settlement_price_series(instrument)
    return [
        {"date": r["date"], "close": r["price"], "high": r["high"], "low": r["low"]}
        for r in rows
        if r["date"] >= since and r["high"] is not None and r["low"] is not None
    ]


def get_settlement_price_by_month(instrument: str, session: str = SESSION_DAILY) -> dict[str, float]:
    """{'YYYY-MM': last real price that month} — month-end-style lookup for
    a daily-or-coarser settlement series, computed at read time from
    whatever daily rows exist (replaces the old month-end-resampled
    XAG_CLOSE/XAU_CLOSE fred_observations series, which baked the
    resampling into the write path instead)."""
    rows = get_settlement_price_series(instrument, session=session)
    by_month: dict[str, float] = {}
    for row in rows:
        if row["price"] is None:
            continue
        by_month[row["date"][:7]] = row["price"]  # rows arrive date-ascending, last write wins
    return by_month


def upsert_census_trade_rows(rows: list[dict]):
    """Partial-column upsert (not INSERT OR REPLACE) since Census revises
    only specific value/qty columns for a given period on its annual April
    release, while fetched_at should still refresh to 'now' — mirrors
    upsert_lbma_fix_row's ON CONFLICT DO UPDATE shape."""
    with get_conn() as conn:
        conn.executemany(
            """INSERT INTO census_trade
                   (metal, flow, hs_code, cty_code, cty_name, year, month,
                    value_general_usd, value_consumption_usd, qty, qty_unit)
               VALUES (:metal, :flow, :hs_code, :cty_code, :cty_name, :year, :month,
                       :value_general_usd, :value_consumption_usd, :qty, :qty_unit)
               ON CONFLICT (metal, flow, hs_code, cty_code, year, month) DO UPDATE SET
                   cty_name = excluded.cty_name,
                   value_general_usd = excluded.value_general_usd,
                   value_consumption_usd = excluded.value_consumption_usd,
                   qty = excluded.qty,
                   qty_unit = excluded.qty_unit,
                   fetched_at = datetime('now')""",
            rows,
        )


def get_census_trade(metal: str, flow: str | None = None, hs_code: str | None = None) -> list[dict]:
    query = "SELECT * FROM census_trade WHERE metal = ?"
    params: list = [metal]
    if flow is not None:
        query += " AND flow = ?"
        params.append(flow)
    if hs_code is not None:
        query += " AND hs_code = ?"
        params.append(hs_code)
    query += " ORDER BY year, month"
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        result = [dict(r) for r in rows]

    spot_instrument = f"{metal}_YAHOO_DAILY_CLOSE"
    spot_by_month = get_settlement_price_by_month(spot_instrument)
    for row in result:
        month_key = f"{row['year']:04d}-{row['month']:02d}"
        spot = spot_by_month.get(month_key)
        if spot and row["value_general_usd"] is not None:
            row["implied_qty_oz"] = round(row["value_general_usd"] / spot, 4)
        else:
            row["implied_qty_oz"] = None
    return result


def get_latest_census_trade_period() -> str | None:
    """Latest persisted (year, month) as 'YYYY-MM', across every metal/flow/
    country row — used by the ~25-day rate-limit gate to decide whether a
    re-fetch is due yet. None if census_trade is still empty."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT MAX(year * 100 + month) AS ym FROM census_trade"
        ).fetchone()
        ym = row["ym"] if row else None
        if ym is None:
            return None
        return f"{ym // 100:04d}-{ym % 100:02d}"


def upsert_curve_spread_row(row: dict):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO futures_curve_spread
                   (metal, date, front_month_symbol, front_month_price,
                    next_month_symbol, next_month_price, curve_spread_pct)
               VALUES (:metal, :date, :front_month_symbol, :front_month_price,
                       :next_month_symbol, :next_month_price, :curve_spread_pct)
               ON CONFLICT (metal, date) DO UPDATE SET
                   front_month_symbol = excluded.front_month_symbol,
                   front_month_price = excluded.front_month_price,
                   next_month_symbol = excluded.next_month_symbol,
                   next_month_price = excluded.next_month_price,
                   curve_spread_pct = excluded.curve_spread_pct,
                   fetched_at = datetime('now')""",
            row,
        )


def get_curve_spread_series(metal: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT date, front_month_symbol, front_month_price,
                      next_month_symbol, next_month_price, curve_spread_pct
               FROM futures_curve_spread
               WHERE metal = ? ORDER BY date""",
            (metal,),
        ).fetchall()
        return [dict(r) for r in rows]


def insert_squeeze_case(row: dict):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO squeeze_case_log
                   (event_name, metal, date_range_start, date_range_end,
                    cot_reading_snapshot, curve_reading_snapshot,
                    mechanism_tag, outcome_notes)
               VALUES (:event_name, :metal, :date_range_start, :date_range_end,
                       :cot_reading_snapshot, :curve_reading_snapshot,
                       :mechanism_tag, :outcome_notes)""",
            row,
        )


def get_squeeze_cases() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM squeeze_case_log ORDER BY date_range_start"
        ).fetchall()
        return [dict(r) for r in rows]


def upsert_delivery_rows(rows: list[dict]):
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR REPLACE INTO delivery_notices (date, type, daily_issued, daily_stopped)
               VALUES (:date, :type, :daily_issued, :daily_stopped)""",
            rows,
        )


def get_delivery_history(type: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT date, type, daily_issued, daily_stopped FROM delivery_notices WHERE type = ? ORDER BY date",
            (type,),
        ).fetchall()
        return [dict(r) for r in rows]


def upsert_shfe_warehouse_rows(rows: list[dict]):
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR REPLACE INTO shfe_warehouse (date, warehouse, warrant_kg, warrant_change_kg)
               VALUES (:date, :warehouse, :warrant_kg, :warrant_change_kg)""",
            rows,
        )


def get_latest_shfe_warehouses() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT date, warehouse, warrant_kg, warrant_change_kg
               FROM shfe_warehouse
               WHERE date = (SELECT MAX(date) FROM shfe_warehouse)"""
        ).fetchall()
        return [dict(r) for r in rows]


def upsert_pslv_row(row: dict):
    with get_conn() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO pslv_snapshot (date, total_oz, nav_per_unit, total_nav, units)
               VALUES (:date, :total_oz, :nav_per_unit, :total_nav, :units)""",
            row,
        )


def get_latest_pslv() -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT date, total_oz, nav_per_unit, total_nav, units FROM pslv_snapshot ORDER BY date DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None


def append_spot_price_ticks(rows: list[dict]):
    """Append-only real spot ticks — a published tick is never revised.
    Each row: {'instrument', 'ts', 'price', 'change_pct_24h'} — the latter
    nullable, only ever populated for *_SPOT instruments (metalcharts.org
    supplies it for free on every poll; Yahoo futures bars don't carry an
    equivalent field). Replaces the old spot_price_snapshot (one row/day,
    overwritten) + append_price_tick (no change_pct_24h column) split —
    spot_price now serves both "latest snapshot" and "tick history" off
    one append-only table."""
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO spot_price (instrument, ts, price, change_pct_24h)
               VALUES (:instrument, :ts, :price, :change_pct_24h)""",
            [{**row, "change_pct_24h": row.get("change_pct_24h")} for row in rows],
        )


def get_latest_spot_prices() -> dict[str, dict]:
    """Latest tick per *_SPOT instrument — 'date' key kept in the return
    shape (derived from 'ts') since /api/prices/db's existing response
    shape is unchanged by this migration."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT instrument, ts, price, change_pct_24h FROM spot_price s1
               WHERE instrument IN ('XAG_SPOT', 'XAU_SPOT')
                 AND ts = (SELECT MAX(ts) FROM spot_price s2 WHERE s2.instrument = s1.instrument)"""
        ).fetchall()
        return {
            r["instrument"].removesuffix("_SPOT"): {
                "date": r["ts"][:10], "price": r["price"], "change_pct_24h": r["change_pct_24h"],
            }
            for r in rows
        }


def get_fred_observations(series_id: str, since: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT date, value FROM fred_observations
               WHERE series_id = ? AND date >= ?
               ORDER BY date ASC""",
            (series_id, since),
        ).fetchall()
        return [dict(r) for r in rows]


def get_fred_observations_by_month(series_id: str) -> dict[str, float]:
    """{'YYYY-MM': value} for a month-end-resampled series like XAG_CLOSE/XAU_CLOSE,
    keyed off the real trading-day date's first 7 chars (safe since those series always
    hold true YYYY-MM-DD dates, one row per calendar month)."""
    rows = get_fred_observations(series_id, since="1900-01-01")
    return {r["date"][:7]: r["value"] for r in rows}


def upsert_event_rows(rows: list[dict]):
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR REPLACE INTO event_calendar
               (event_id, event_name, event_type, scheduled_time,
                consensus_value, actual_value, surprise_delta, source_url, source_tier)
               VALUES (:event_id, :event_name, :event_type, :scheduled_time,
                       :consensus_value, :actual_value, :surprise_delta, :source_url, :source_tier)""",
            rows,
        )


def update_event_actuals(event_id: str, actual_value: float | None, surprise_delta: float | None):
    with get_conn() as conn:
        conn.execute(
            """UPDATE event_calendar SET actual_value = ?, surprise_delta = ?
               WHERE event_id = ?""",
            (actual_value, surprise_delta, event_id),
        )


def get_upcoming_events(limit: int = 20) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT event_id, event_name, event_type, scheduled_time,
                      consensus_value, actual_value, surprise_delta, source_url, source_tier,
                      research_session_id, direction
               FROM event_calendar
               WHERE scheduled_time >= datetime('now')
               ORDER BY scheduled_time ASC
               LIMIT ?""",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_event(event_id: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            """SELECT event_id, event_name, event_type, scheduled_time,
                      consensus_value, actual_value, surprise_delta, source_url, source_tier,
                      research_session_id, direction
               FROM event_calendar WHERE event_id = ?""",
            (event_id,),
        ).fetchone()
        return dict(row) if row else None


def get_event_for_session(session_id: str) -> dict | None:
    """Reverse lookup of get_event's research_session_id backlink — the
    Research panel's session view needs the promoted event_id to offer a
    Demote action, but a session only knows its own fields, not which
    event it produced."""
    with get_conn() as conn:
        row = conn.execute(
            """SELECT event_id, event_name, scheduled_time, direction
               FROM event_calendar WHERE research_session_id = ?""",
            (session_id,),
        ).fetchone()
        return dict(row) if row else None


def get_events_needing_actuals() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT event_id, event_name, event_type, scheduled_time, source_url
               FROM event_calendar
               WHERE scheduled_time < datetime('now') AND actual_value IS NULL"""
        ).fetchall()
        return [dict(r) for r in rows]


def upsert_price_reaction_rows(rows: list[dict]):
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR REPLACE INTO macro_price_reaction
               (event_id, metal, window, price, price_delta_pct, surprise_magnitude)
               VALUES (:event_id, :metal, :window, :price, :price_delta_pct, :surprise_magnitude)""",
            rows,
        )


def get_event_reaction_series() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT e.event_id, e.event_name, e.event_type, e.scheduled_time,
                      e.surprise_delta, e.research_session_id, e.direction,
                      r.metal, r.window, r.price, r.price_delta_pct,
                      r.surprise_magnitude
               FROM event_calendar e
               JOIN macro_price_reaction r ON r.event_id = e.event_id
               ORDER BY e.scheduled_time ASC"""
        ).fetchall()
        return [dict(r) for r in rows]


def get_spot_price_ticks_since(instrument: str, since_ts: str) -> list[dict]:
    """Full tick history for instrument at/after since_ts, ordered
    oldest-first — for a 24h price chart, not a nearest-tick lookup like
    get_spot_price_near (CATCOR's use case). Ticks only exist from whenever
    the fast-tier refresh loop started actually running at its 60s cadence
    (for *_SPOT) or CATCOR's intraday backfill last ran (for
    *_FUTURES_FRONT); a freshly-enabled instance will have a short/empty
    history until it accumulates. Pass a real price_instruments constant —
    *_SPOT and *_FUTURES_FRONT are deliberately different instruments (see
    price_instruments.py's module docstring for the sawtooth bug this
    schema exists to make impossible)."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT ts, price FROM spot_price
               WHERE instrument = ? AND ts >= ?
               ORDER BY ts ASC""",
            (instrument, since_ts),
        ).fetchall()
        return [dict(r) for r in rows]


def get_price_backfill(metal: str, since_ts: str) -> list[dict]:
    """Tiered price history for a lookback window, per
    price-architecture-spec.md's get_price_backfill: real spot_price ticks
    (60s resolution, but only exist from whenever the fast-tier refresh
    loop actually started running) stitched with settlement_price's real
    Yahoo daily closes (back to whatever range Yahoo retains, confirmed
    ~1yr+) for anything older. The old 3-tier stitch (ticks / CATCOR's
    XAG_DAILY_CLOSE / Money Supply's month-end XAG_CLOSE) collapses to 2
    tiers now that both former daily-close series are the same
    XAG_YAHOO_DAILY_CLOSE settlement_price instrument. Each tier only
    contributes points strictly older than the tier above it already
    covers, so the stitched series never double-covers a date. Returned
    oldest-first, each row {"ts": <ISO string or date string>, "price": <float>}.

    metal is "XAG"/"XAU" — resolves to price_instruments' *_SPOT and
    *_YAHOO_DAILY_CLOSE instruments internally."""
    spot_instrument = f"{metal}_SPOT"
    daily_instrument = f"{metal}_YAHOO_DAILY_CLOSE"

    ticks = get_spot_price_ticks_since(spot_instrument, since_ts)
    earliest_tick_date = ticks[0]["ts"][:10] if ticks else None
    daily_cutoff = earliest_tick_date or datetime.now(timezone.utc).date().isoformat()

    daily_rows = [
        r for r in get_settlement_price_series(daily_instrument)
        if r["price"] is not None and since_ts[:10] <= r["date"] < daily_cutoff
    ]

    combined = (
        [{"ts": r["date"], "price": r["price"]} for r in daily_rows]
        + [{"ts": t["ts"], "price": t["price"]} for t in ticks]
    )
    return combined


def get_spot_price_near(instrument: str, ts: str, tolerance_s: int) -> dict | None:
    """Nearest spot_price row to ts within tolerance_s, or None. CATCOR's
    capture_snapshot passes *_FUTURES_FRONT instruments here — this
    function itself is instrument-agnostic, it just finds whichever row is
    closest under whatever key you pass."""
    with get_conn() as conn:
        row = conn.execute(
            """SELECT instrument, ts, price FROM spot_price
               WHERE instrument = ?
                 AND ABS(strftime('%s', ts) - strftime('%s', ?)) <= ?
               ORDER BY ABS(strftime('%s', ts) - strftime('%s', ?)) ASC
               LIMIT 1""",
            (instrument, ts, tolerance_s, ts),
        ).fetchone()
        return dict(row) if row else None


def insert_silver_rows(rows: list[dict]):
    """Append-only: a CFTC report for a given date is never overwritten."""
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO cot_silver
               (report_date, noncomm_long, noncomm_short, open_interest, net_long, net_long_pct_oi)
               VALUES (:report_date, :noncomm_long, :noncomm_short, :open_interest, :net_long, :net_long_pct_oi)""",
            rows,
        )


def insert_gold_rows(rows: list[dict]):
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO cot_gold
               (report_date, noncomm_long, noncomm_short, open_interest, net_long, net_long_pct_oi)
               VALUES (:report_date, :noncomm_long, :noncomm_short, :open_interest, :net_long, :net_long_pct_oi)""",
            rows,
        )


def insert_disaggregated_rows(rows: list[dict]):
    """Append-only: a CFTC report for a given (date, metal, category) is never
    overwritten, same convention as insert_silver_rows/insert_gold_rows."""
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO cot_disaggregated
               (report_date, metal, category, long, short, spreading, open_interest)
               VALUES (:report_date, :metal, :category, :long, :short, :spreading, :open_interest)""",
            rows,
        )


def get_disaggregated_series(metal: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT report_date, category, long, short, spreading, open_interest
               FROM cot_disaggregated WHERE metal = ? ORDER BY report_date""",
            (metal,),
        ).fetchall()
        return [dict(r) for r in rows]


def insert_forexfactory_rows(rows: list[dict]):
    """Append-only: ForexFactory's "this week" feed for a given calendar week
    is a historical fact once fetched (the live endpoint only ever serves the
    CURRENT week, so once a week_key has passed there's no way to re-fetch it
    even if we wanted to — capture it once and keep it)."""
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO forexfactory_calendar
               (week_key, title, country, event_date, impact, forecast, previous)
               VALUES (:week_key, :title, :country, :event_date, :impact, :forecast, :previous)""",
            rows,
        )


def has_forexfactory_week(week_key: str) -> bool:
    """Whether the feed has already been fetched for this calendar week —
    used to decide whether fetch_and_persist_consensus needs to hit
    ForexFactory's rate-limited endpoint at all."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM forexfactory_calendar WHERE week_key = ? LIMIT 1", (week_key,)
        ).fetchone()
        return row is not None


def get_forexfactory_week(week_key: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT title, country, event_date, impact, forecast, previous
               FROM forexfactory_calendar WHERE week_key = ?""",
            (week_key,),
        ).fetchall()
        return [dict(r) for r in rows]


_COT_PRICE_TICKER_TO_INSTRUMENT = {
    "SLV": SLV_CLOSE, "GLD": GLD_CLOSE, "SI=F": SI_F_WEEKLY, "GC=F": GC_F_WEEKLY,
}


def upsert_prices(ticker: str, prices: dict[str, float]):
    """pipeline/run.py's weekly CoT-aligned price writer — 'ticker' is one
    of SLV/GLD/SI=F/GC=F, mapped to its settlement_price instrument.
    Replaces the old dedicated cot_prices table; pipeline/ stays
    stdlib-only, this import is the same backend.db import it already
    relies on (price_instruments.py is stdlib-free like units.py)."""
    upsert_settlement_price_rows(
        _COT_PRICE_TICKER_TO_INSTRUMENT[ticker],
        [{"date": d, "price": p} for d, p in prices.items()],
    )


def get_silver_series() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT report_date AS date, noncomm_long, noncomm_short, open_interest, "
            "net_long, net_long_pct_oi FROM cot_silver ORDER BY report_date"
        ).fetchall()
        return [dict(r) for r in rows]


def get_gold_series() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT report_date AS date, noncomm_long, noncomm_short, open_interest, "
            "net_long, net_long_pct_oi FROM cot_gold ORDER BY report_date"
        ).fetchall()
        return [dict(r) for r in rows]


def get_price_series(ticker: str) -> dict[str, float]:
    instrument = _COT_PRICE_TICKER_TO_INSTRUMENT[ticker]
    rows = get_settlement_price_series(instrument)
    return {r["date"]: r["price"] for r in rows if r["price"] is not None}


def record_pipeline_run(ran_at: str):
    """Stamps the single 'last pipeline run' row, regardless of whether any
    new CoT report rows were actually inserted this run."""
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO pipeline_runs (id, ran_at) VALUES (1, ?) "
            "ON CONFLICT(id) DO UPDATE SET ran_at = excluded.ran_at",
            (ran_at,),
        )


def get_last_run_at() -> str | None:
    """When pipeline/run.py last completed, independent of whether that run
    inserted any new CoT rows (CFTC only publishes ~weekly, so most runs are
    no-ops on cot_silver/cot_gold)."""
    with get_conn() as conn:
        row = conn.execute("SELECT ran_at FROM pipeline_runs WHERE id = 1").fetchone()
        return row["ran_at"] if row else None


def set_pinned_section(section: str | None):
    """Single shared 'which nav tab opens by default' setting — same
    single-row-upsert convention as pipeline_runs above. section=None
    un-pins (falls back to the frontend's own "cot" default)."""
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO ui_settings (id, pinned_section) VALUES (1, ?) "
            "ON CONFLICT(id) DO UPDATE SET pinned_section = excluded.pinned_section",
            (section,),
        )


def get_pinned_section() -> str | None:
    with get_conn() as conn:
        row = conn.execute("SELECT pinned_section FROM ui_settings WHERE id = 1").fetchone()
        return row["pinned_section"] if row else None


def record_fetch_attempt(source_key: str, success: bool, error: str | None = None, skipped: bool = False):
    """Upserts source_health's current-state row for source_key. A skip
    (rate-limit gate declined to even attempt the fetch) only touches
    last_attempt_at/last_attempt_status — it is neither a success nor a
    failure, so consecutive_failures and last_success_at are left alone."""
    with get_conn() as conn:
        now = datetime.now(timezone.utc).isoformat()
        if skipped:
            conn.execute(
                """INSERT INTO source_health (source_key, last_attempt_at, last_attempt_status)
                   VALUES (?, ?, 'skipped')
                   ON CONFLICT(source_key) DO UPDATE SET
                       last_attempt_at = excluded.last_attempt_at,
                       last_attempt_status = 'skipped'""",
                (source_key, now),
            )
        elif success:
            conn.execute(
                """INSERT INTO source_health
                       (source_key, last_attempt_at, last_attempt_status, last_success_at, last_error, consecutive_failures)
                   VALUES (?, ?, 'success', ?, NULL, 0)
                   ON CONFLICT(source_key) DO UPDATE SET
                       last_attempt_at = excluded.last_attempt_at,
                       last_attempt_status = 'success',
                       last_success_at = excluded.last_success_at,
                       last_error = NULL,
                       consecutive_failures = 0""",
                (source_key, now, now),
            )
        else:
            conn.execute(
                """INSERT INTO source_health
                       (source_key, last_attempt_at, last_attempt_status, last_error, consecutive_failures)
                   VALUES (?, ?, 'error', ?, 1)
                   ON CONFLICT(source_key) DO UPDATE SET
                       last_attempt_at = excluded.last_attempt_at,
                       last_attempt_status = 'error',
                       last_error = excluded.last_error,
                       consecutive_failures = source_health.consecutive_failures + 1""",
                (source_key, now, error),
            )


def get_all_source_health() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM source_health").fetchall()
        return [dict(r) for r in rows]


def get_source_health(source_key: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM source_health WHERE source_key = ?", (source_key,)
        ).fetchone()
        return dict(row) if row else None


def get_interval_overrides() -> dict[str, int]:
    """Full-table read, called once at boot to seed main.py's in-memory
    _interval_overrides side-table — a deliberate per-source cadence
    override should survive a backend restart, unlike the blanket
    fast_interval_s/slow_interval_s tier settings, which are in-memory
    only and reset on restart (a single admin toggling both tiers is a
    cheap decision to redo; an admin who specifically slowed down one
    noisy/rate-limited source made a more considered, source-specific
    judgment that's more costly and more surprising to lose silently)."""
    with get_conn() as conn:
        rows = conn.execute("SELECT source_key, interval_seconds FROM interval_overrides").fetchall()
        return {r["source_key"]: r["interval_seconds"] for r in rows}


def set_interval_override(source_key: str, interval_seconds: int):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO interval_overrides (source_key, interval_seconds) VALUES (?, ?) "
            "ON CONFLICT(source_key) DO UPDATE SET interval_seconds = excluded.interval_seconds",
            (source_key, interval_seconds),
        )


def get_latest_cot_report_date() -> str | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT MAX(report_date) AS d FROM (SELECT report_date FROM cot_silver "
            "UNION ALL SELECT report_date FROM cot_gold)"
        ).fetchone()
        return row["d"] if row else None


def create_research_session(session_id: str, claim_text: str, source_url: str | None, now_iso: str):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO research_sessions
               (session_id, claim_text, source_url, status, user_read, created_at, updated_at)
               VALUES (?, ?, ?, 'active', NULL, ?, ?)""",
            (session_id, claim_text, source_url, now_iso, now_iso),
        )


def list_research_sessions() -> list[dict]:
    """Widened beyond the original session_id/claim_text/status/updated_at
    to include user_read/source_url — the Phase 2 session-list view needs
    read/disposition context per row without a separate detail fetch.
    LEFT JOINs event_calendar for promoted_event_id — the list's bulk
    demote action needs an event_id per promoted row without a separate
    per-row lookup; NULL for active/dismissed rows."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT s.session_id, s.claim_text, s.source_url, s.status, s.user_read, s.updated_at,
                      e.event_id AS promoted_event_id
               FROM research_sessions s
               LEFT JOIN event_calendar e ON e.research_session_id = s.session_id
               ORDER BY s.updated_at DESC"""
        ).fetchall()
        return [dict(r) for r in rows]


def get_research_session(session_id: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            """SELECT session_id, claim_text, source_url, status, user_read,
                      memory_mode, created_at, updated_at
               FROM research_sessions WHERE session_id = ?""",
            (session_id,),
        ).fetchone()
        return dict(row) if row else None


def list_research_messages(session_id: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT id, session_id, role, content, created_at,
                      backend, model, persona, context_blocks, memory_mode,
                      memory_changed, assembled_prompt
               FROM research_messages WHERE session_id = ? ORDER BY id ASC""",
            (session_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_research_message_count(session_id: str) -> int:
    """Backs dismiss_session's >=1-turn gate (catcor-events-spec.md section
    5.2 — a session with zero turns has nothing to reason about, so it can
    only be discarded, never dismissed-with-reason)."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM research_messages WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        return row["n"]


def append_research_message(
    session_id: str,
    role: str,
    content: str,
    now_iso: str,
    backend: str | None = None,
    model: str | None = None,
    persona: str | None = None,
    context_blocks: str | None = None,
    memory_mode: str | None = None,
    memory_changed: int = 0,
    assembled_prompt: str | None = None,
):
    """Appends a turn and bumps the parent session's updated_at in the same
    connection block — no triggers, matching this module's existing
    multi-statement-per-block style (e.g. catcor.py's
    fetch_and_persist_consensus updates a child row then touches the parent).

    The new metadata columns are optional/nullable since a "turn" is a
    user-row/assistant-row pair: backend/model/persona describe what
    answered (assistant rows), context_blocks/memory_mode/memory_changed/
    assembled_prompt describe what was sent (user rows) — callers only pass
    the subset relevant to the role being inserted."""
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO research_messages
               (session_id, role, content, created_at, backend, model, persona,
                context_blocks, memory_mode, memory_changed, assembled_prompt)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                session_id, role, content, now_iso, backend, model, persona,
                context_blocks, memory_mode, memory_changed, assembled_prompt,
            ),
        )
        conn.execute(
            "UPDATE research_sessions SET updated_at = ? WHERE session_id = ?",
            (now_iso, session_id),
        )


def touch_research_session(session_id: str, now_iso: str):
    with get_conn() as conn:
        conn.execute(
            "UPDATE research_sessions SET updated_at = ? WHERE session_id = ?",
            (now_iso, session_id),
        )


def set_research_memory_mode(session_id: str, mode: str, now_iso: str):
    with get_conn() as conn:
        conn.execute(
            "UPDATE research_sessions SET memory_mode = ?, updated_at = ? WHERE session_id = ?",
            (mode, now_iso, session_id),
        )


def set_research_read(session_id: str, user_read: str, now_iso: str):
    with get_conn() as conn:
        conn.execute(
            "UPDATE research_sessions SET user_read = ?, updated_at = ? WHERE session_id = ?",
            (user_read, now_iso, session_id),
        )


def promote_research_session(session_id: str, event_row: dict, now_iso: str):
    """Inserts the new Observed-origin event_calendar row and flips the
    session to 'promoted' in one connection block, so the two writes are
    atomic — either both land or neither does. event_row must supply
    event_id/event_name/event_type/scheduled_time/source_url/source_tier/
    research_session_id/direction; consensus_value/actual_value/
    surprise_delta are not applicable to an Observed event and are left
    NULL by the caller."""
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO event_calendar
               (event_id, event_name, event_type, scheduled_time, consensus_value,
                actual_value, surprise_delta, source_url, source_tier,
                research_session_id, direction)
               VALUES (:event_id, :event_name, :event_type, :scheduled_time, NULL,
                       NULL, NULL, :source_url, :source_tier,
                       :research_session_id, :direction)""",
            event_row,
        )
        conn.execute(
            "UPDATE research_sessions SET status = 'promoted', updated_at = ? WHERE session_id = ?",
            (now_iso, session_id),
        )


def delete_promoted_event(event_id: str, session_id: str | None, now_iso: str):
    """Reverses promote_research_session: deletes the event_calendar row and
    its macro_price_reaction rows, and — if the event still has a live
    research_session_id backlink — reverts that session to 'active' so it
    can be edited/re-promoted/dismissed/discarded again. Symmetric with
    promote's own atomic write, same single-block rationale (an event
    deleted but a session left dangling as 'promoted', or vice versa, would
    both be inconsistent states)."""
    with get_conn() as conn:
        conn.execute("DELETE FROM macro_price_reaction WHERE event_id = ?", (event_id,))
        conn.execute("DELETE FROM event_calendar WHERE event_id = ?", (event_id,))
        if session_id is not None:
            conn.execute(
                "UPDATE research_sessions SET status = 'active', updated_at = ? WHERE session_id = ?",
                (now_iso, session_id),
            )


def dismiss_research_session(
    session_id: str,
    claim_text: str,
    source_url: str | None,
    user_read: str,
    reason: str,
    now_iso: str,
):
    """Inserts the research_log row and flips the session to 'dismissed' in
    one connection block, same atomicity rationale as promote_research_session."""
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO research_log
               (session_id, claim_text, source_url, user_read, dismissed_at, dismiss_reason)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (session_id, claim_text, source_url, user_read, now_iso, reason),
        )
        conn.execute(
            "UPDATE research_sessions SET status = 'dismissed', updated_at = ? WHERE session_id = ?",
            (now_iso, session_id),
        )


def discard_research_session(session_id: str):
    """Hard-deletes a session and its turns — no read-only record kept
    anywhere, per catcor-events-spec.md section 2 ("Discarded... purged
    entirely, not kept anywhere"). Children before parent."""
    with get_conn() as conn:
        conn.execute("DELETE FROM research_messages WHERE session_id = ?", (session_id,))
        conn.execute("DELETE FROM research_sessions WHERE session_id = ?", (session_id,))
