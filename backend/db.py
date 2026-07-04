import os
import sqlite3
from contextlib import contextmanager

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
                      consensus_value, actual_value, surprise_delta, source_url, source_tier
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
                      consensus_value, actual_value, surprise_delta, source_url, source_tier
               FROM event_calendar WHERE event_id = ?""",
            (event_id,),
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
                      e.surprise_delta, r.metal, r.window, r.price, r.price_delta_pct,
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


def get_ticks_near(series_id: str, ts: str, tolerance_s: int) -> dict | None:
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
