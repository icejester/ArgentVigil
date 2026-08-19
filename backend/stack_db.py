import os
import sqlite3
from contextlib import contextmanager

# Deliberately its own SQLite file, never ATTACHed to argentvigil.db — see
# specs/stackTracker-spec.md section 1: cost basis, numismatic notes, and
# photos of a real physical stack are the one category of AV data that
# should never end up in a shared/demo-able database, so the storage
# boundary is structural, not just conventional. This module's DDL is a
# separate string from backend/db.py's DDL, so tests/test_conventions.py's
# table-ownership scan (which only scans db_module.DDL) never sees these
# tables — no NON_SOURCE_TABLES entry needed, confirmed by
# tests/test_stack.py's own assertion of that fact.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(_REPO_ROOT, "runtime", "stack.db")
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)  # sqlite3.connect does not create parent dirs

IMAGES_ROOT = os.path.join(_REPO_ROOT, "runtime", "stack_images")
os.makedirs(IMAGES_ROOT, exist_ok=True)

DDL = """
CREATE TABLE IF NOT EXISTS stack_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    metal TEXT NOT NULL,
    form TEXT NOT NULL,
    silver_weight_oz REAL,
    gold_weight_oz REAL,
    unit_weight_oz REAL,
    count INTEGER NOT NULL DEFAULT 1,
    lot_id TEXT,
    purchase_date TEXT,
    purchase_price REAL,
    premium_paid REAL,
    mint_year INTEGER,
    series TEXT,
    mint_mark TEXT,
    mintage INTEGER,
    grading_service TEXT,
    grade TEXT,
    certification_number TEXT,
    numismatic_value REAL,
    numismatic_value_as_of TEXT,
    numismatic_notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stack_reference_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stack_item_id INTEGER NOT NULL REFERENCES stack_items(id),
    url TEXT NOT NULL,
    label TEXT,
    added_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stack_item_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stack_item_id INTEGER NOT NULL REFERENCES stack_items(id),
    file_path TEXT NOT NULL,
    caption TEXT,
    added_at TEXT DEFAULT (datetime('now'))
);
"""


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_conn() as conn:
        conn.executescript(DDL)
        # series: repurposes what was originally country_of_origin — a
        # fixed-but-extensible sovereign-coin series enum (American Eagle,
        # Canadian Maple Leaf, etc., validated in backend/stack.py, same
        # pattern as grading_service) rather than a free-text country
        # string. CREATE TABLE IF NOT EXISTS doesn't retroactively rename a
        # column on an already-existing table, so this is a guarded ALTER
        # for databases created before this rename (no-op on a fresh DB,
        # where the DDL above already has `series`). SQLite's RENAME COLUMN
        # (3.25+) preserves existing values — deliberately NOT backfilled
        # into the new series enum, since old country_of_origin values
        # ("Canada", "Niue", ...) aren't series names and mapping them would
        # be a fabricated guess, not a real migration.
        try:
            conn.execute("ALTER TABLE stack_items RENAME COLUMN country_of_origin TO series")
        except sqlite3.OperationalError:
            pass  # already renamed (or a fresh DB whose DDL never had the old name)
        # unit_weight_oz: the simplified-tracker weight model (per the
        # user's "regress to date/quantity/price paid" request) — oz per
        # single unit (1oz coin, 10oz bar, 0.1808oz junk-silver quarter,
        # ...), multiplied by count/quantity at read time to get real total
        # oz and melt value, rather than the user hand-computing a total
        # and typing it into silver_weight_oz/gold_weight_oz (which stay in
        # the schema, dormant, for the richer per-item-weight case if it
        # comes back later).
        try:
            conn.execute("ALTER TABLE stack_items ADD COLUMN unit_weight_oz REAL")
        except sqlite3.OperationalError:
            pass  # column already exists
