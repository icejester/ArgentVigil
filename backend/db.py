import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

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

CREATE TABLE IF NOT EXISTS spot_price_snapshot (
    series_id TEXT NOT NULL,
    date TEXT NOT NULL,
    price REAL,
    change_pct_24h REAL,
    PRIMARY KEY (series_id, date)
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

CREATE TABLE IF NOT EXISTS spot_price_tick (
    series_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    price REAL,
    PRIMARY KEY (series_id, ts)
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

CREATE TABLE IF NOT EXISTS cot_prices (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    price REAL,
    PRIMARY KEY (ticker, date)
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


def upsert_spot_price_rows(rows: list[dict]):
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR REPLACE INTO spot_price_snapshot (series_id, date, price, change_pct_24h)
               VALUES (:series_id, :date, :price, :change_pct_24h)""",
            rows,
        )


def get_latest_spot_prices() -> dict[str, dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT series_id, date, price, change_pct_24h FROM spot_price_snapshot s1
               WHERE date = (SELECT MAX(date) FROM spot_price_snapshot s2 WHERE s2.series_id = s1.series_id)"""
        ).fetchall()
        return {r["series_id"]: dict(r) for r in rows}


def get_fred_observations(series_id: str, since: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT date, value FROM fred_observations
               WHERE series_id = ? AND date >= ?
               ORDER BY date ASC""",
            (series_id, since),
        ).fetchall()
        return [dict(r) for r in rows]


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


def append_price_tick(rows: list[dict]):
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO spot_price_tick (series_id, ts, price)
               VALUES (:series_id, :ts, :price)""",
            rows,
        )


def get_ticks_since(series_id: str, since_ts: str) -> list[dict]:
    """Full intraday tick history for series_id at/after since_ts, ordered
    oldest-first — for a 24h price chart, not a nearest-tick lookup like
    get_ticks_near (CATCOR's use case). Ticks only exist from whenever the
    fast-tier refresh loop started actually running at its 60s cadence; a
    freshly-enabled instance will have a short/empty history until it
    accumulates.

    Note: spot_price_tick holds more than one series_id family — "XAG"/
    "XAU" are main.py's real metalcharts.org spot quotes (60s cadence);
    "XAG_FUTURES"/"XAU_FUTURES" are catcor.py's Yahoo SI=F/GC=F futures
    bars (5m cadence, used for event-reaction snapshots, NOT the live spot
    price). These two used to collide under the same "XAG"/"XAU" keys —
    a real bug that sawtoothed PriceHistoryChart with futures prints
    running ~0.3-0.6 higher than spot, interleaved on the same line. Pass
    the series_id family that matches what you actually want."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT ts, price FROM spot_price_tick
               WHERE series_id = ? AND ts >= ?
               ORDER BY ts ASC""",
            (series_id, since_ts),
        ).fetchall()
        return [dict(r) for r in rows]


def get_price_history(series_id: str, since_ts: str) -> list[dict]:
    """Tiered price history for a lookback window, stitching three
    resolutions since none alone covers every window the frontend offers
    (6H..12M): real spot_price_tick ticks (60s resolution, but only exist
    from whenever the fast-tier refresh loop actually started running —
    see get_ticks_since), then CATCOR's XAG_DAILY_CLOSE/XAU_DAILY_CLOSE
    (daily, ~120 days back — catcor.DAILY_CLOSE_FETCH_DAYS), then the
    month-end-resampled XAG_CLOSE/XAU_CLOSE used by Money Supply (monthly,
    back to 2006). Each tier only contributes points strictly older than
    the tier above it already covers, so the stitched series never has two
    sources double-covering the same date. Returned oldest-first, each row
    {"ts": <ISO string>, "price": <float>}.

    Callers should pass "XAG"/"XAU" here (the real spot series) — never
    "XAG_FUTURES"/"XAU_FUTURES" (catcor.py's Yahoo futures backfill, a
    different instrument used only for CATCOR's own event-reaction
    snapshots, see get_ticks_since's note)."""
    daily_series_id = f"{series_id}_DAILY_CLOSE"
    monthly_series_id = f"{series_id}_CLOSE"

    ticks = get_ticks_since(series_id, since_ts)
    earliest_tick_date = ticks[0]["ts"][:10] if ticks else None

    daily_cutoff = earliest_tick_date or datetime.now(timezone.utc).date().isoformat()
    daily_rows = [
        r for r in get_fred_observations(daily_series_id, since=since_ts[:10])
        if r["value"] is not None and r["date"] < daily_cutoff
    ]
    earliest_daily_date = daily_rows[0]["date"] if daily_rows else daily_cutoff

    monthly_rows = [
        r for r in get_fred_observations(monthly_series_id, since=since_ts[:10])
        if r["value"] is not None and r["date"] < earliest_daily_date
    ]

    combined = (
        [{"ts": r["date"], "price": r["value"]} for r in monthly_rows]
        + [{"ts": r["date"], "price": r["value"]} for r in daily_rows]
        + [{"ts": t["ts"], "price": t["price"]} for t in ticks]
    )
    return combined


def get_ticks_near(series_id: str, ts: str, tolerance_s: int) -> dict | None:
    """Nearest spot_price_tick row to ts within tolerance_s, or None.
    CATCOR's capture_snapshot passes "XAG_FUTURES"/"XAU_FUTURES" here (see
    get_ticks_since's note) — this function itself is series-id-agnostic,
    it just finds whichever row is closest under whatever key you pass."""
    with get_conn() as conn:
        row = conn.execute(
            """SELECT series_id, ts, price FROM spot_price_tick
               WHERE series_id = ?
                 AND ABS(strftime('%s', ts) - strftime('%s', ?)) <= ?
               ORDER BY ABS(strftime('%s', ts) - strftime('%s', ?)) ASC
               LIMIT 1""",
            (series_id, ts, tolerance_s, ts),
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


def upsert_prices(ticker: str, prices: dict[str, float]):
    with get_conn() as conn:
        conn.executemany(
            "INSERT OR REPLACE INTO cot_prices (ticker, date, price) VALUES (?, ?, ?)",
            [(ticker, date, price) for date, price in prices.items()],
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
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT date, price FROM cot_prices WHERE ticker = ? ORDER BY date", (ticker,)
        ).fetchall()
        return {r["date"]: r["price"] for r in rows}


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
