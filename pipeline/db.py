"""
SQLite persistence for the CoT pipeline. Fully independent of the repo-root
db.py / FastAPI app (no import relationship either direction) — pipeline stays
stdlib-only and standalone-runnable.
"""

import sqlite3
from contextlib import contextmanager

try:
    # Package import (e.g. `from pipeline import db`, used by main.py)
    from .config import COT_DB_PATH
except ImportError:
    # Bare-script import (run.py adds pipeline/ to sys.path directly)
    from config import COT_DB_PATH

DDL = """
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
"""


@contextmanager
def get_conn():
    conn = sqlite3.connect(COT_DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_conn() as conn:
        conn.executescript(DDL)


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


def get_last_run_at() -> str | None:
    """
    Most recent fetched_at across both metals' latest report_date rows — a
    proxy for "when did pipeline/run.py last persist new data," since rows
    are append-only and never touched again after first insert.
    """
    with get_conn() as conn:
        silver_row = conn.execute(
            "SELECT fetched_at FROM cot_silver ORDER BY report_date DESC LIMIT 1"
        ).fetchone()
        gold_row = conn.execute(
            "SELECT fetched_at FROM cot_gold ORDER BY report_date DESC LIMIT 1"
        ).fetchone()
        vals = [r["fetched_at"] for r in (silver_row, gold_row) if r is not None]
        return max(vals) if vals else None
