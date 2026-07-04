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
