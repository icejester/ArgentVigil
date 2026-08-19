"""Stack Tracker business logic — CRUD, bulk-entry expansion, melt-value
valuation, and photo upload. See specs/stackTracker-spec.md.

Melt value crosses into argentvigil.db read-only, via backend.db's existing
spot-price getter — a Python-level import, not a second raw connection or
an ATTACH DATABASE, per the spec's "a read, not a write" framing."""

import os
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException, UploadFile

from . import db as main_db
from . import stack_db

METALS = {"silver", "gold", "bimetallic"}
FORMS = {"coin", "bar", "round", "other"}

# Fixed-but-extensible per the spec's Open Question #3 resolution — plain
# text validated against this list (not a SQL CHECK/enum), so adding a new
# grading service later is a one-line change here, never a migration.
GRADING_SERVICES = ["PCGS", "NGC", "ANACS", "Ungraded"]

# Sovereign-coin/casino-token/whatever-it-is series — SUGGESTIONS, not a
# validated allowlist. Powers the quick-pick dropdown ("Canadian Maple
# Leaf (37)" grouping) but series is genuinely freehand text underneath —
# per the user's explicit call ("this DB is mine... why not make the
# series 'Luxor'"), any non-empty string is a valid series, no 400 on an
# unrecognized value. Bars/rounds/generic items simply leave this null.
SERIES = [
    "American Eagle",
    "Canadian Maple Leaf",
    "Austrian Philharmonic",
    "British Britannia",
    "South African Krugerrand",
    "Australian Kangaroo/Kookaburra",
    "Mexican Libertad",
    "Chinese Silver Panda",
    "Ukraine Archangel Michael",
    "Niue",
    "APMEX",
    "US - Constitutional",
    "Other/Generic",
]

# Group-update: fields that are usually genuinely IDENTICAL across a
# same-purchase lot (what the item IS/says), as opposed to
# purchase_date/count, which are usually per-row-different even within one
# order — see bulk_update_items. purchase_price is included since the user
# wants to correct a whole lot's price at once (e.g. "these were actually
# $X each, not what I originally entered"), not because it's usually
# identical across a lot the way series/notes/mint_year are.
BULK_UPDATE_FIELDS = ["series", "mint_year", "numismatic_notes", "purchase_price", "purchase_date"]

MAX_PHOTOS_PER_ITEM = 5
MAX_PHOTO_BYTES = 10 * 1024 * 1024  # 10MB

_ITEM_COLUMNS = [
    "description", "metal", "form", "silver_weight_oz", "gold_weight_oz",
    "unit_weight_oz", "count", "lot_id", "purchase_date", "purchase_price", "premium_paid",
    "mint_year", "series", "mint_mark", "mintage",
    "grading_service", "grade", "certification_number", "numismatic_value",
    "numismatic_value_as_of", "numismatic_notes",
]

# Quick-pick unit weights (oz per single unit) for the simplified tracker's
# common cases — 1oz/10oz bullion, and the standard 90%-silver junk-silver
# quarter (0.1808 troy oz of actual silver content per coin). Frontend
# offers these plus a free-entry custom field; not enforced server-side
# (unit_weight_oz is a plain REAL, any positive value is valid) since real
# holdings include denominations outside this short list (dimes, halves,
# other bar sizes).
UNIT_WEIGHT_QUICK_PICKS = {
    "1 oz": 1.0,
    "10 oz": 10.0,
    "90% silver quarter": 0.1808,
}


def _validate_item_fields(fields: dict):
    metal = fields.get("metal")
    if metal not in METALS:
        raise HTTPException(400, f"metal must be one of {sorted(METALS)}")
    form = fields.get("form")
    if form not in FORMS:
        raise HTTPException(400, f"form must be one of {sorted(FORMS)}")
    grading_service = fields.get("grading_service")
    if grading_service and grading_service not in GRADING_SERVICES:
        raise HTTPException(400, f"grading_service must be one of {GRADING_SERVICES} or empty")
    # series: deliberately unvalidated — freehand text, see SERIES's docstring.
    if not fields.get("description"):
        raise HTTPException(400, "description is required")


def create_item(fields: dict) -> int:
    """Plain single-item create — count is a genuine multiplier,
    purchase_price is total-for-this-row's count. lot_id stays NULL."""
    _validate_item_fields(fields)
    row = {col: fields.get(col) for col in _ITEM_COLUMNS}
    row["count"] = row.get("count") or 1
    row["lot_id"] = None
    with stack_db.get_conn() as conn:
        cur = conn.execute(
            f"""INSERT INTO stack_items ({", ".join(_ITEM_COLUMNS)})
                VALUES ({", ".join(":" + c for c in _ITEM_COLUMNS)})""",
            row,
        )
        return cur.lastrowid


def create_bulk(fields: dict) -> list[int]:
    """Bulk-entry path: quantity separate rows, each count=1, each
    purchase_price=unit_price, all sharing one generated lot_id. Distinct
    from create_item's count-as-multiplier semantics — see spec's Bulk
    entry note. Never mutates the caller's dict (lot_id/count/purchase_price
    are overridden per generated row, the rest is shared)."""
    quantity = fields.get("quantity")
    if not quantity or quantity < 1:
        raise HTTPException(400, "quantity must be a positive integer")
    unit_price = fields.get("unit_price")

    shared = {col: fields.get(col) for col in _ITEM_COLUMNS}
    _validate_item_fields(shared)
    lot_id = uuid.uuid4().hex

    ids = []
    with stack_db.get_conn() as conn:
        for _ in range(int(quantity)):
            row = dict(shared)
            row["count"] = 1
            row["lot_id"] = lot_id
            row["purchase_price"] = unit_price
            cur = conn.execute(
                f"""INSERT INTO stack_items ({", ".join(_ITEM_COLUMNS)})
                    VALUES ({", ".join(":" + c for c in _ITEM_COLUMNS)})""",
                row,
            )
            ids.append(cur.lastrowid)
    return ids


def update_item(item_id: int, fields: dict):
    if get_item(item_id) is None:
        raise HTTPException(404, f"No stack item with id {item_id}")
    _validate_item_fields(fields)
    row = {col: fields.get(col) for col in _ITEM_COLUMNS}
    row["count"] = row.get("count") or 1
    row["id"] = item_id
    with stack_db.get_conn() as conn:
        conn.execute(
            f"""UPDATE stack_items SET {", ".join(f"{c} = :{c}" for c in _ITEM_COLUMNS)},
                updated_at = datetime('now')
                WHERE id = :id""",
            row,
        )


def bulk_update_items(item_ids: list[int], fields: dict) -> int:
    """Applies a focused subset of fields (BULK_UPDATE_FIELDS — series,
    mint_year, numismatic_notes, purchase_price, purchase_date) to every
    row in item_ids, e.g. "these 12 rows from the 1/29 order are all 2013
    Canadian Maple Leafs" or "I mis-typed this whole order's date, fix
    all 12 rows at once." Deliberately excludes count — per the user's
    own framing, quantity-per-row is inherent to how the rows were
    created (single vs. bulk-entry) and isn't a "what these items share"
    fact the way date/price/series/notes are.

    Only keys actually present with a non-None value in `fields` are
    applied — an omitted/None field is left untouched on every target row,
    not blanked out. This is a real semantic difference from update_item
    (whose PUT is a full replace) and is why this doesn't just loop
    update_item per id."""
    unknown = set(fields) - set(BULK_UPDATE_FIELDS)
    if unknown:
        raise HTTPException(400, f"bulk update only supports fields {BULK_UPDATE_FIELDS}, got unknown: {sorted(unknown)}")
    to_apply = {k: v for k, v in fields.items() if v is not None and v != ""}
    if not to_apply:
        raise HTTPException(400, "no fields to apply — every field was empty/omitted")
    if not item_ids:
        raise HTTPException(400, "item_ids must be non-empty")

    missing = [i for i in item_ids if get_item(i) is None]
    if missing:
        raise HTTPException(404, f"No stack item(s) with id(s) {missing}")

    set_clause = ", ".join(f"{k} = :{k}" for k in to_apply)
    params = dict(to_apply)
    with stack_db.get_conn() as conn:
        for item_id in item_ids:
            params["id"] = item_id
            conn.execute(
                f"UPDATE stack_items SET {set_clause}, updated_at = datetime('now') WHERE id = :id",
                params,
            )
    return len(item_ids)


def get_item(item_id: int) -> dict | None:
    with stack_db.get_conn() as conn:
        row = conn.execute("SELECT * FROM stack_items WHERE id = ?", (item_id,)).fetchone()
        return dict(row) if row else None


def list_items() -> list[dict]:
    with stack_db.get_conn() as conn:
        rows = conn.execute("SELECT * FROM stack_items ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]


def delete_item(item_id: int):
    if get_item(item_id) is None:
        raise HTTPException(404, f"No stack item with id {item_id}")
    for image in list_images(item_id):
        _delete_image_file(image["file_path"])
    with stack_db.get_conn() as conn:
        conn.execute("DELETE FROM stack_item_images WHERE stack_item_id = ?", (item_id,))
        conn.execute("DELETE FROM stack_reference_links WHERE stack_item_id = ?", (item_id,))
        conn.execute("DELETE FROM stack_items WHERE id = ?", (item_id,))


# --- Valuation (computed at read time, never persisted) --------------------


def _spot_prices() -> dict:
    """{'silver': price|None, 'gold': price|None} — read-only cross-read
    into argentvigil.db via backend.db's existing getter."""
    latest = main_db.get_latest_spot_prices()
    return {
        "silver": latest.get("XAG", {}).get("price"),
        "gold": latest.get("XAU", {}).get("price"),
    }


def _total_weight_oz(item: dict) -> tuple[float | None, float | None]:
    """(silver_oz, gold_oz) total for this item's full count. Primary path
    (simplified tracker): unit_weight_oz x count, routed to whichever
    metal `metal` names. Dormant richer path, still honored if directly
    set: explicit silver_weight_oz/gold_weight_oz (per-unit, same x count
    scaling) — kept for the per-item-weight/bimetallic case if it's used
    again later, per-item wins over unit_weight_oz if both are somehow set."""
    count = item.get("count") or 1
    silver_oz = item.get("silver_weight_oz")
    gold_oz = item.get("gold_weight_oz")
    if silver_oz is None and gold_oz is None and item.get("unit_weight_oz"):
        total = item["unit_weight_oz"] * count
        if item.get("metal") == "silver":
            return total, None
        if item.get("metal") == "gold":
            return None, total
        return None, None  # bimetallic with only unit_weight_oz has no metal split to assign
    silver_total = silver_oz * count if silver_oz else None
    gold_total = gold_oz * count if gold_oz else None
    return silver_total, gold_total


def compute_valuation(item: dict, spot: dict | None = None) -> dict:
    """melt_value, numismatic_premium, unrealized_gain($/%) for one item.
    Nulls over zeros throughout — a missing spot leg or missing
    numismatic_value never gets silently treated as 0."""
    if spot is None:
        spot = _spot_prices()

    silver_total_oz, gold_total_oz = _total_weight_oz(item)

    silver_leg = silver_total_oz * spot["silver"] if silver_total_oz and spot["silver"] is not None else None
    gold_leg = gold_total_oz * spot["gold"] if gold_total_oz and spot["gold"] is not None else None

    if silver_leg is None and gold_leg is None:
        melt_value = None
    else:
        melt_value = (silver_leg or 0) + (gold_leg or 0)

    numismatic_value = item.get("numismatic_value")
    numismatic_premium = (
        numismatic_value - melt_value if numismatic_value is not None and melt_value is not None else None
    )

    purchase_price = item.get("purchase_price")
    unrealized_gain = None
    unrealized_gain_pct = None
    if purchase_price is not None and melt_value is not None:
        current_value = melt_value + (numismatic_value or 0)
        unrealized_gain = current_value - purchase_price
        if purchase_price:
            unrealized_gain_pct = (unrealized_gain / purchase_price) * 100

    total_weight_oz = None
    if silver_total_oz is not None or gold_total_oz is not None:
        total_weight_oz = (silver_total_oz or 0) + (gold_total_oz or 0)

    return {
        "total_weight_oz": total_weight_oz,
        "melt_value": melt_value,
        "numismatic_premium": numismatic_premium,
        "unrealized_gain": unrealized_gain,
        "unrealized_gain_pct": unrealized_gain_pct,
    }


def list_items_with_valuation() -> list[dict]:
    spot = _spot_prices()
    items = list_items()
    for item in items:
        item.update(compute_valuation(item, spot))
    return items


def _summarize_group(group_items: list[dict]) -> dict:
    """Shared per-group rollup for both series_summary and date_summary —
    item_count/total_count/oz/melt/spent, everything nulls-over-zeros per
    the standing convention (a group with no real melt_value anywhere in
    it reports None, not a fabricated 0)."""
    total_count = sum(i.get("count") or 1 for i in group_items)
    total_oz = None
    any_oz = False
    total_melt = None
    any_melt = False
    total_spent = None
    any_spent = False
    for i in group_items:
        if i.get("total_weight_oz") is not None:
            total_oz = (total_oz or 0) + i["total_weight_oz"]
            any_oz = True
        if i["melt_value"] is not None:
            total_melt = (total_melt or 0) + i["melt_value"]
            any_melt = True
        if i.get("purchase_price") is not None:
            total_spent = (total_spent or 0) + i["purchase_price"]
            any_spent = True
    return {
        "item_count": len(group_items),
        "total_count": total_count,
        "total_weight_oz": total_oz if any_oz else None,
        "total_melt_value": total_melt if any_melt else None,
        "total_spent": total_spent if any_spent else None,
        "item_ids": [i["id"] for i in group_items],
    }


def series_summary() -> list[dict]:
    """Groups items by `series` for the list view's "grouped by series"
    toggle — e.g. "Canadian Maple Leaf (37)". Items with no series set
    (bars, generic rounds, anything not a recognized sovereign coin series)
    are grouped by `description` instead, so the grouped view stays usable
    for non-series holdings rather than dumping them all into one
    "ungrouped" bucket that hides real distinctions between them."""
    spot = _spot_prices()
    items = list_items()
    groups: dict[tuple[str, str | None], list[dict]] = {}
    for item in items:
        item.update(compute_valuation(item, spot))
        key = (item.get("series") or item["description"], item.get("series"))
        groups.setdefault(key, []).append(item)

    summaries = []
    for (label, series), group_items in groups.items():
        summaries.append({"label": label, "series": series, **_summarize_group(group_items)})
    summaries.sort(key=lambda g: g["label"])
    return summaries


def date_summary() -> list[dict]:
    """Groups items by `purchase_date` — the default list view per the
    user's request ("I only want to see the aggregate when I first open
    the tab"). Items with no purchase_date are grouped under a single
    "Unknown date" bucket rather than one bucket per None, so they're
    still visible instead of silently missing from every group. Sorted
    newest-first (most recent purchase date), matching list_items'
    existing created_at DESC convention."""
    spot = _spot_prices()
    items = list_items()
    groups: dict[str, list[dict]] = {}
    for item in items:
        item.update(compute_valuation(item, spot))
        key = item.get("purchase_date") or "Unknown date"
        groups.setdefault(key, []).append(item)

    summaries = [
        {"label": date, "purchase_date": date if date != "Unknown date" else None, **_summarize_group(group_items)}
        for date, group_items in groups.items()
    ]
    summaries.sort(key=lambda g: g["label"], reverse=True)
    return summaries


def timeseries() -> list[dict]:
    """Cumulative spend vs. cumulative melt value, one row per real
    purchase_date, chronological. Powers the "cost basis vs. current
    value over time" line chart — cumulative_melt_value applies TODAY's
    live spot to each date's running oz total (not a historical spot
    price AV doesn't track for this purpose), so the chart answers "what
    would everything bought up through this date be worth right now,"
    not "what was it worth on that day." Items with no purchase_date are
    excluded entirely (not bucketed, unlike date_summary) — there's no
    real position on a time axis for an unknown date.
    """
    spot = _spot_prices()
    items = [i for i in list_items() if i.get("purchase_date")]
    by_date: dict[str, list[dict]] = {}
    for item in items:
        by_date.setdefault(item["purchase_date"], []).append(item)

    cumulative_spend = 0.0
    cumulative_silver_oz = 0.0
    cumulative_gold_oz = 0.0
    rows = []
    for date in sorted(by_date):
        day_items = by_date[date]
        day_spend = sum(i["purchase_price"] for i in day_items if i.get("purchase_price") is not None)
        cumulative_spend += day_spend
        for item in day_items:
            silver_oz, gold_oz = _total_weight_oz(item)
            cumulative_silver_oz += silver_oz or 0
            cumulative_gold_oz += gold_oz or 0

        cumulative_melt_value = None
        if spot["silver"] is not None or spot["gold"] is not None:
            cumulative_melt_value = (
                cumulative_silver_oz * (spot["silver"] or 0) + cumulative_gold_oz * (spot["gold"] or 0)
            )

        rows.append({
            "date": date,
            "day_spend": day_spend,
            "cumulative_spend": cumulative_spend,
            "cumulative_silver_oz": cumulative_silver_oz,
            "cumulative_gold_oz": cumulative_gold_oz,
            "cumulative_melt_value": cumulative_melt_value,
        })
    return rows


def portfolio_summary() -> dict:
    spot = _spot_prices()
    items = list_items()
    total_spent = 0.0
    any_spent = False
    total_current_value = 0.0
    silver_oz_total = 0.0
    gold_oz_total = 0.0
    silver_value_total = 0.0
    gold_value_total = 0.0
    silver_spent_total = 0.0
    any_silver_spent = False
    gold_spent_total = 0.0
    any_gold_spent = False

    for item in items:
        valuation = compute_valuation(item, spot)
        if item.get("purchase_price") is not None:
            total_spent += item["purchase_price"]
            any_spent = True
            if item.get("metal") == "silver":
                silver_spent_total += item["purchase_price"]
                any_silver_spent = True
            elif item.get("metal") == "gold":
                gold_spent_total += item["purchase_price"]
                any_gold_spent = True
        melt_value = valuation["melt_value"]
        numismatic_value = item.get("numismatic_value")
        if melt_value is not None or numismatic_value is not None:
            total_current_value += (melt_value or 0) + (numismatic_value or 0)
        silver_total_oz, gold_total_oz = _total_weight_oz(item)
        if silver_total_oz:
            silver_oz_total += silver_total_oz
        if gold_total_oz:
            gold_oz_total += gold_total_oz
        if silver_total_oz and spot["silver"] is not None:
            silver_value_total += silver_total_oz * spot["silver"]
        if gold_total_oz and spot["gold"] is not None:
            gold_value_total += gold_total_oz * spot["gold"]

    total_gain = (total_current_value - total_spent) if any_spent else None
    total_gain_pct = (total_gain / total_spent * 100) if total_gain is not None and total_spent else None

    # Per-metal gain % — powers the "Held" summary's "(-17.2%)" annotation.
    # Compares each metal's live melt value against what was actually paid
    # for that metal, not the combined portfolio total (a silver-heavy
    # loss shouldn't be diluted by an unrelated gold gain or vice versa).
    silver_gain_pct = (
        (silver_value_total - silver_spent_total) / silver_spent_total * 100
        if any_silver_spent and silver_spent_total
        else None
    )
    gold_gain_pct = (
        (gold_value_total - gold_spent_total) / gold_spent_total * 100
        if any_gold_spent and gold_spent_total
        else None
    )

    # DCA (dollar-cost-average) — total spent on that metal / total real oz
    # held of that metal. NULL (not 0) if either side has no real data yet,
    # same nulls-over-zeros convention as every other valuation figure here.
    silver_dca = silver_spent_total / silver_oz_total if any_silver_spent and silver_oz_total else None
    gold_dca = gold_spent_total / gold_oz_total if any_gold_spent and gold_oz_total else None

    return {
        "total_spent": total_spent if any_spent else None,
        "total_current_value": total_current_value if items else None,
        "total_unrealized_gain": total_gain,
        "total_unrealized_gain_pct": total_gain_pct,
        "total_silver_oz": silver_oz_total,
        "total_gold_oz": gold_oz_total,
        "silver_gain_pct": silver_gain_pct,
        "gold_gain_pct": gold_gain_pct,
        "silver_dca": silver_dca,
        "gold_dca": gold_dca,
        "spot_silver": spot["silver"],
        "spot_gold": spot["gold"],
        "value_by_metal": {"silver": silver_value_total, "gold": gold_value_total},
    }


# --- Reference links ---------------------------------------------------


def add_link(item_id: int, url: str, label: str | None) -> int:
    if get_item(item_id) is None:
        raise HTTPException(404, f"No stack item with id {item_id}")
    if not url:
        raise HTTPException(400, "url is required")
    with stack_db.get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO stack_reference_links (stack_item_id, url, label) VALUES (?, ?, ?)",
            (item_id, url, label),
        )
        return cur.lastrowid


def list_links(item_id: int) -> list[dict]:
    with stack_db.get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM stack_reference_links WHERE stack_item_id = ? ORDER BY added_at", (item_id,)
        ).fetchall()
        return [dict(r) for r in rows]


def delete_link(link_id: int):
    with stack_db.get_conn() as conn:
        conn.execute("DELETE FROM stack_reference_links WHERE id = ?", (link_id,))


# --- Photos --------------------------------------------------------------


def list_images(item_id: int) -> list[dict]:
    with stack_db.get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM stack_item_images WHERE stack_item_id = ? ORDER BY added_at", (item_id,)
        ).fetchall()
        return [dict(r) for r in rows]


def _delete_image_file(relative_path: str):
    abs_path = os.path.join(stack_db.IMAGES_ROOT, relative_path)
    if os.path.exists(abs_path):
        os.remove(abs_path)


async def add_photo(item_id: int, upload: UploadFile, caption: str | None) -> dict:
    if get_item(item_id) is None:
        raise HTTPException(404, f"No stack item with id {item_id}")

    existing = list_images(item_id)
    if len(existing) >= MAX_PHOTOS_PER_ITEM:
        raise HTTPException(400, f"Item already has {MAX_PHOTOS_PER_ITEM} photos, the max allowed")

    contents = await upload.read()
    if len(contents) > MAX_PHOTO_BYTES:
        raise HTTPException(400, f"Photo exceeds {MAX_PHOTO_BYTES // (1024 * 1024)}MB limit")

    # UUID filename — the person never sees or chooses it, per spec section 5.
    ext = os.path.splitext(upload.filename or "")[1].lower() or ".jpg"
    filename = f"{uuid.uuid4().hex}{ext}"
    item_dir = os.path.join(stack_db.IMAGES_ROOT, str(item_id))
    os.makedirs(item_dir, exist_ok=True)
    abs_path = os.path.join(item_dir, filename)
    with open(abs_path, "wb") as f:
        f.write(contents)

    relative_path = f"{item_id}/{filename}"
    with stack_db.get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO stack_item_images (stack_item_id, file_path, caption) VALUES (?, ?, ?)",
            (item_id, relative_path, caption),
        )
        return {"id": cur.lastrowid, "stack_item_id": item_id, "file_path": relative_path, "caption": caption}


def delete_photo(photo_id: int):
    with stack_db.get_conn() as conn:
        row = conn.execute("SELECT * FROM stack_item_images WHERE id = ?", (photo_id,)).fetchone()
        if row is None:
            raise HTTPException(404, f"No photo with id {photo_id}")
        _delete_image_file(row["file_path"])
        conn.execute("DELETE FROM stack_item_images WHERE id = ?", (photo_id,))
