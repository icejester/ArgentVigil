import sqlite3
from contextlib import contextmanager

DB_PATH = "argentvigil.db"

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


def get_fred_observations(series_id: str, since: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT date, value FROM fred_observations
               WHERE series_id = ? AND date >= ?
               ORDER BY date ASC""",
            (series_id, since),
        ).fetchall()
        return [dict(r) for r in rows]
