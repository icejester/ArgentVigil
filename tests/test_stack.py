"""Stack Tracker unit tests (specs/stackTracker-spec.md). Covers
backend/stack_db.py's schema/migration layer, backend/stack.py's CRUD,
bulk-entry expansion, valuation math, grading-service validation, photo
upload, reference links, and the route layer — plus a convention-suite
compatibility check for the ALLOWED_NON_DB_API / table-ownership guards.

Ground rules match tests/conftest.py's: no real upstream network calls, no
touching the real runtime/stack.db or runtime/stack_images/ (tmp_stack_db /
tmp_stack_images fixtures), real SQLite DDL/SQL exercised against a
throwaway file.
"""

import io
import re

import pytest

from backend import db as db_module
from backend import stack


# --- Schema / DB layer -----------------------------------------------------


def test_init_db_is_idempotent(tmp_stack_db):
    tmp_stack_db.init_db()
    tmp_stack_db.init_db()
    with tmp_stack_db.get_conn() as conn:
        tables = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
    assert {"stack_items", "stack_reference_links", "stack_item_images"} <= tables


def test_init_db_migrates_pre_rename_country_of_origin_column(tmp_stack_db, tmp_path):
    """Simulates a database created before the country_of_origin -> series
    rename: creates the old-shaped table directly, seeds a row, then
    confirms init_db()'s guarded ALTER TABLE RENAME COLUMN both succeeds
    and preserves the row's existing data under the new column name."""
    with tmp_stack_db.get_conn() as conn:
        conn.execute("ALTER TABLE stack_items RENAME COLUMN series TO country_of_origin")
        conn.execute(
            "INSERT INTO stack_items (description, metal, form, country_of_origin) "
            "VALUES ('pre-migration item', 'silver', 'coin', 'Canada')"
        )
    tmp_stack_db.init_db()
    with tmp_stack_db.get_conn() as conn:
        row = conn.execute(
            "SELECT series FROM stack_items WHERE description = 'pre-migration item'"
        ).fetchone()
    assert row["series"] == "Canada"  # preserved verbatim, not remapped into the new enum


def test_stack_tables_not_in_argentvigil_ddl():
    """The structural half of the isolation guarantee: stack.db's schema is
    a wholly separate DDL string from backend/db.py's, so
    tests/test_conventions.py's table-ownership scan (which only scans
    db_module.DDL) never needs a NON_SOURCE_TABLES entry for these tables."""
    assert "stack_items" not in db_module.DDL
    assert "stack_reference_links" not in db_module.DDL
    assert "stack_item_images" not in db_module.DDL


# --- CRUD --------------------------------------------------------------


def _base_fields(**overrides):
    fields = {
        "description": "2011 Reverse Proof Silver Maple",
        "metal": "silver",
        "form": "coin",
        "silver_weight_oz": 1.0,
        "gold_weight_oz": None,
        "count": 1,
        "purchase_date": "2024-01-01",
        "purchase_price": 30.0,
        "premium_paid": 5.0,
    }
    fields.update(overrides)
    return fields


def test_create_and_get_item_round_trip(tmp_stack_db):
    item_id = stack.create_item(_base_fields())
    item = stack.get_item(item_id)
    assert item["description"] == "2011 Reverse Proof Silver Maple"
    assert item["metal"] == "silver"
    assert item["silver_weight_oz"] == 1.0
    assert item["gold_weight_oz"] is None
    assert item["lot_id"] is None
    assert item["count"] == 1


def test_create_item_persists_every_nullable_numismatic_field(tmp_stack_db):
    item_id = stack.create_item(
        _base_fields(
            mint_year=2011,
            series="Canadian Maple Leaf",
            mint_mark=None,
            mintage=50000,
            grading_service="PCGS",
            grade="MS70",
            certification_number="12345678",
            numismatic_value=150.0,
            numismatic_value_as_of="2026-08-01",
            numismatic_notes="pop report checked",
        )
    )
    item = stack.get_item(item_id)
    assert item["mint_year"] == 2011
    assert item["series"] == "Canadian Maple Leaf"
    assert item["grading_service"] == "PCGS"
    assert item["grade"] == "MS70"
    assert item["numismatic_value"] == 150.0
    assert item["numismatic_value_as_of"] == "2026-08-01"


def test_create_item_defaults_count_to_one(tmp_stack_db):
    item_id = stack.create_item(_base_fields(count=None))
    assert stack.get_item(item_id)["count"] == 1


def test_unrated_bullion_shows_null_numismatic_value_never_zero(tmp_stack_db):
    item_id = stack.create_item(_base_fields(numismatic_value=None))
    item = stack.get_item(item_id)
    assert item["numismatic_value"] is None


def test_update_item(tmp_stack_db):
    item_id = stack.create_item(_base_fields())
    stack.update_item(item_id, _base_fields(description="Updated description", purchase_price=35.0))
    item = stack.get_item(item_id)
    assert item["description"] == "Updated description"
    assert item["purchase_price"] == 35.0


def test_update_missing_item_raises_404(tmp_stack_db):
    with pytest.raises(Exception) as exc_info:
        stack.update_item(999, _base_fields())
    assert getattr(exc_info.value, "status_code", None) == 404


def test_bulk_update_applies_only_specified_fields(tmp_stack_db):
    """The core semantic: an omitted field is untouched, not blanked —
    count (each item's own real per-unit quantity) must survive a bulk
    update to series/mint_year unchanged, and purchase_date must survive
    too when it's not one of the fields actually being updated."""
    ids = stack.create_bulk(
        _base_fields(series=None, purchase_date="2026-01-29", quantity=12, unit_price=114.87, purchase_price=None)
    )
    updated = stack.bulk_update_items(ids, {"series": "Canadian Maple Leaf", "mint_year": 2013})
    assert updated == 12
    for item_id in ids:
        item = stack.get_item(item_id)
        assert item["series"] == "Canadian Maple Leaf"
        assert item["mint_year"] == 2013
        assert item["purchase_date"] == "2026-01-29"  # untouched — not in this update's fields
        assert item["count"] == 1  # untouched


def test_bulk_update_can_apply_purchase_date(tmp_stack_db):
    """The user's real use case: mis-typed the date on a whole order,
    fixes all rows at once."""
    ids = stack.create_bulk(
        _base_fields(purchase_date="2026-01-29", quantity=12, unit_price=114.87, purchase_price=None)
    )
    stack.bulk_update_items(ids, {"purchase_date": "2026-01-30"})
    for item_id in ids:
        assert stack.get_item(item_id)["purchase_date"] == "2026-01-30"


def test_bulk_update_can_apply_notes_and_purchase_price(tmp_stack_db):
    ids = stack.create_bulk(_base_fields(quantity=3, unit_price=30.0, purchase_price=None))
    stack.bulk_update_items(ids, {"numismatic_notes": "found in wife's old collection", "purchase_price": 40.0})
    for item_id in ids:
        item = stack.get_item(item_id)
        assert item["numismatic_notes"] == "found in wife's old collection"
        assert item["purchase_price"] == 40.0


def test_bulk_update_series_accepts_freehand_text(tmp_stack_db):
    """Series is deliberately unvalidated — 'this DB is mine' per the user,
    so a casino chip or anything else not in the SERIES suggestion list is
    a perfectly valid value."""
    ids = [stack.create_item(_base_fields())]
    stack.bulk_update_items(ids, {"series": "Luxor"})
    assert stack.get_item(ids[0])["series"] == "Luxor"


def test_bulk_update_rejects_fields_outside_the_allowed_subset(tmp_stack_db):
    ids = [stack.create_item(_base_fields())]
    with pytest.raises(Exception) as exc_info:
        stack.bulk_update_items(ids, {"count": 5})
    assert getattr(exc_info.value, "status_code", None) == 400


def test_bulk_update_rejects_lot_id(tmp_stack_db):
    ids = [stack.create_item(_base_fields())]
    with pytest.raises(Exception) as exc_info:
        stack.bulk_update_items(ids, {"lot_id": "hand-forged"})
    assert getattr(exc_info.value, "status_code", None) == 400


def test_bulk_update_can_apply_grading_and_weight_fields(tmp_stack_db):
    """The field-set expansion: grading/mint-mark/weight fields, previously
    single-item-edit-only, are now bulk-updatable too."""
    ids = [stack.create_item(_base_fields()), stack.create_item(_base_fields())]
    updated = stack.bulk_update_items(ids, {
        "grading_service": "PCGS",
        "grade": "MS70",
        "certification_number": "12345",
        "mint_mark": "S",
        "mintage": 50000,
        "unit_weight_oz": 1.0,
        "premium_paid": 3.5,
    })
    assert updated == 2
    for item_id in ids:
        item = stack.get_item(item_id)
        assert item["grading_service"] == "PCGS"
        assert item["grade"] == "MS70"
        assert item["certification_number"] == "12345"
        assert item["mint_mark"] == "S"
        assert item["mintage"] == 50000
        assert item["unit_weight_oz"] == 1.0
        assert item["premium_paid"] == 3.5


def test_bulk_update_rejects_invalid_metal(tmp_stack_db):
    ids = [stack.create_item(_base_fields())]
    with pytest.raises(Exception) as exc_info:
        stack.bulk_update_items(ids, {"metal": "platinum"})
    assert getattr(exc_info.value, "status_code", None) == 400


def test_bulk_update_rejects_invalid_form(tmp_stack_db):
    ids = [stack.create_item(_base_fields())]
    with pytest.raises(Exception) as exc_info:
        stack.bulk_update_items(ids, {"form": "ingot"})
    assert getattr(exc_info.value, "status_code", None) == 400


def test_bulk_update_rejects_invalid_grading_service(tmp_stack_db):
    ids = [stack.create_item(_base_fields())]
    with pytest.raises(Exception) as exc_info:
        stack.bulk_update_items(ids, {"grading_service": "Not A Real Service"})
    assert getattr(exc_info.value, "status_code", None) == 400


def test_bulk_update_rejects_empty_fields(tmp_stack_db):
    ids = [stack.create_item(_base_fields())]
    with pytest.raises(Exception) as exc_info:
        stack.bulk_update_items(ids, {})
    assert getattr(exc_info.value, "status_code", None) == 400


def test_bulk_update_rejects_empty_item_ids(tmp_stack_db):
    with pytest.raises(Exception) as exc_info:
        stack.bulk_update_items([], {"series": "Canadian Maple Leaf"})
    assert getattr(exc_info.value, "status_code", None) == 400


def test_bulk_update_rejects_missing_item_id(tmp_stack_db):
    real_id = stack.create_item(_base_fields())
    with pytest.raises(Exception) as exc_info:
        stack.bulk_update_items([real_id, 999999], {"series": "Canadian Maple Leaf"})
    assert getattr(exc_info.value, "status_code", None) == 404
    # Nothing should have been applied to the real item either — fail before any write.
    assert stack.get_item(real_id)["series"] is None


def test_bulk_update_does_not_touch_unselected_items(tmp_stack_db):
    selected = [stack.create_item(_base_fields(series=None))]
    other = stack.create_item(_base_fields(series=None))
    stack.bulk_update_items(selected, {"series": "American Eagle"})
    assert stack.get_item(other)["series"] is None


def test_list_items(tmp_stack_db):
    stack.create_item(_base_fields(description="A"))
    stack.create_item(_base_fields(description="B"))
    items = stack.list_items()
    assert {i["description"] for i in items} == {"A", "B"}


def test_delete_item_removes_links_and_images(tmp_stack_db, tmp_stack_images):
    item_id = stack.create_item(_base_fields())
    stack.add_link(item_id, "https://numista.com/x", "Numista listing")
    stack.delete_item(item_id)
    assert stack.get_item(item_id) is None
    assert stack.list_links(item_id) == []
    assert stack.list_images(item_id) == []


def test_delete_missing_item_raises_404(tmp_stack_db):
    with pytest.raises(Exception) as exc_info:
        stack.delete_item(999)
    assert getattr(exc_info.value, "status_code", None) == 404


# --- Validation ----------------------------------------------------------


def test_create_item_rejects_invalid_metal(tmp_stack_db):
    with pytest.raises(Exception) as exc_info:
        stack.create_item(_base_fields(metal="platinum"))
    assert getattr(exc_info.value, "status_code", None) == 400


def test_create_item_rejects_invalid_form(tmp_stack_db):
    with pytest.raises(Exception) as exc_info:
        stack.create_item(_base_fields(form="ingot"))
    assert getattr(exc_info.value, "status_code", None) == 400


def test_create_item_rejects_empty_description(tmp_stack_db):
    with pytest.raises(Exception) as exc_info:
        stack.create_item(_base_fields(description=""))
    assert getattr(exc_info.value, "status_code", None) == 400


@pytest.mark.parametrize("service", stack.GRADING_SERVICES)
def test_grading_service_allowlist_accepts_known_values(tmp_stack_db, service):
    item_id = stack.create_item(_base_fields(grading_service=service))
    assert stack.get_item(item_id)["grading_service"] == service


def test_grading_service_rejects_unknown_value(tmp_stack_db):
    with pytest.raises(Exception) as exc_info:
        stack.create_item(_base_fields(grading_service="Some Random Service"))
    assert getattr(exc_info.value, "status_code", None) == 400


def test_grading_service_none_is_accepted(tmp_stack_db):
    item_id = stack.create_item(_base_fields(grading_service=None))
    assert stack.get_item(item_id)["grading_service"] is None


@pytest.mark.parametrize("series", stack.SERIES)
def test_series_quick_picks_are_all_accepted(tmp_stack_db, series):
    item_id = stack.create_item(_base_fields(series=series))
    assert stack.get_item(item_id)["series"] == series


def test_series_accepts_freehand_text_not_in_quick_picks(tmp_stack_db):
    """Series is deliberately unvalidated (per the user's 'this DB is
    mine' framing) — a casino chip's series, or anything else not in the
    SERIES suggestion list, is a legitimate value, not a 400."""
    item_id = stack.create_item(_base_fields(series="Luxor"))
    assert stack.get_item(item_id)["series"] == "Luxor"


def test_series_none_is_accepted_for_bars_and_generic_rounds(tmp_stack_db):
    item_id = stack.create_item(_base_fields(form="bar", series=None))
    assert stack.get_item(item_id)["series"] is None


# --- Bulk entry ------------------------------------------------------------


def test_bulk_entry_creates_n_rows_each_count_one_shared_lot_id(tmp_stack_db):
    ids = stack.create_bulk(_base_fields(quantity=14, unit_price=72.0, purchase_price=None))
    assert len(ids) == 14
    items = [stack.get_item(i) for i in ids]
    assert all(i["count"] == 1 for i in items)
    assert all(i["purchase_price"] == 72.0 for i in items)
    lot_ids = {i["lot_id"] for i in items}
    assert len(lot_ids) == 1
    assert None not in lot_ids


def test_bulk_entry_rejects_non_positive_quantity(tmp_stack_db):
    with pytest.raises(Exception) as exc_info:
        stack.create_bulk(_base_fields(quantity=0, unit_price=72.0))
    assert getattr(exc_info.value, "status_code", None) == 400


def test_plain_single_item_create_leaves_lot_id_null(tmp_stack_db):
    item_id = stack.create_item(_base_fields())
    assert stack.get_item(item_id)["lot_id"] is None


def test_deleting_one_bulk_row_leaves_lotmates_untouched(tmp_stack_db, tmp_stack_images):
    ids = stack.create_bulk(_base_fields(quantity=3, unit_price=10.0, purchase_price=None))
    stack.delete_item(ids[0])
    remaining = [stack.get_item(i) for i in ids[1:]]
    assert all(i is not None for i in remaining)
    assert stack.get_item(ids[0]) is None


# --- Valuation math --------------------------------------------------------


def _spot(silver=None, gold=None):
    return {"silver": silver, "gold": gold}


def test_melt_value_silver_only(tmp_stack_db):
    item = stack.get_item(stack.create_item(_base_fields(silver_weight_oz=2.0, gold_weight_oz=None, count=1)))
    valuation = stack.compute_valuation(item, _spot(silver=30.0, gold=2000.0))
    assert valuation["melt_value"] == pytest.approx(60.0)


def test_melt_value_gold_only(tmp_stack_db):
    item = stack.get_item(
        stack.create_item(
            _base_fields(metal="gold", silver_weight_oz=None, gold_weight_oz=1.0, count=1)
        )
    )
    valuation = stack.compute_valuation(item, _spot(silver=30.0, gold=2000.0))
    assert valuation["melt_value"] == pytest.approx(2000.0)


def test_melt_value_bimetallic(tmp_stack_db):
    item = stack.get_item(
        stack.create_item(
            _base_fields(metal="bimetallic", silver_weight_oz=1.0, gold_weight_oz=0.5, count=1)
        )
    )
    valuation = stack.compute_valuation(item, _spot(silver=30.0, gold=2000.0))
    assert valuation["melt_value"] == pytest.approx(30.0 + 1000.0)


def test_melt_value_from_unit_weight_oz_junk_silver_quarters(tmp_stack_db):
    """The user's real use case: 14 quarters at 0.1808 oz actual silver
    content each -> 2.5312 oz total, computed by AV rather than
    hand-multiplied and typed in as a pre-computed total."""
    item = stack.get_item(
        stack.create_item(
            _base_fields(
                silver_weight_oz=None, gold_weight_oz=None,
                unit_weight_oz=0.1808, count=14,
            )
        )
    )
    valuation = stack.compute_valuation(item, _spot(silver=30.0, gold=None))
    assert valuation["total_weight_oz"] == pytest.approx(0.1808 * 14)
    assert valuation["melt_value"] == pytest.approx(0.1808 * 14 * 30.0)


def test_unit_weight_oz_routes_to_gold_for_gold_metal(tmp_stack_db):
    item = stack.get_item(
        stack.create_item(
            _base_fields(
                metal="gold", silver_weight_oz=None, gold_weight_oz=None,
                unit_weight_oz=1.0, count=2,
            )
        )
    )
    valuation = stack.compute_valuation(item, _spot(silver=30.0, gold=2000.0))
    assert valuation["total_weight_oz"] == pytest.approx(2.0)
    assert valuation["melt_value"] == pytest.approx(4000.0)


def test_explicit_silver_weight_oz_wins_over_unit_weight_oz_if_both_set(tmp_stack_db):
    """The dormant per-item-weight path takes priority — unit_weight_oz is
    only consulted when silver_weight_oz/gold_weight_oz are both unset."""
    item = stack.get_item(
        stack.create_item(
            _base_fields(silver_weight_oz=5.0, gold_weight_oz=None, unit_weight_oz=1.0, count=1)
        )
    )
    valuation = stack.compute_valuation(item, _spot(silver=30.0, gold=None))
    assert valuation["total_weight_oz"] == pytest.approx(5.0)


def test_melt_value_scales_with_count(tmp_stack_db):
    item = stack.get_item(
        stack.create_item(_base_fields(silver_weight_oz=1.0, gold_weight_oz=None, count=3))
    )
    valuation = stack.compute_valuation(item, _spot(silver=30.0, gold=None))
    assert valuation["melt_value"] == pytest.approx(90.0)


def test_melt_value_null_when_spot_missing_never_falls_back_to_zero_or_stale(tmp_stack_db):
    item = stack.get_item(
        stack.create_item(_base_fields(silver_weight_oz=1.0, gold_weight_oz=None, count=1))
    )
    valuation = stack.compute_valuation(item, _spot(silver=None, gold=None))
    assert valuation["melt_value"] is None


def test_melt_value_uses_real_argentvigil_spot_read(tmp_db, tmp_stack_db):
    """End-to-end through the real cross-read into argentvigil.db, not just
    the mockable compute_valuation(spot=...) path."""
    db_module.append_spot_price_ticks(
        [{"instrument": "XAG_SPOT", "ts": "2026-08-01T00:00:00Z", "price": 30.0, "change_pct_24h": None}]
    )
    item = stack.get_item(
        stack.create_item(_base_fields(silver_weight_oz=1.0, gold_weight_oz=None, count=1))
    )
    valuation = stack.compute_valuation(item)  # spot=None -> real read
    assert valuation["melt_value"] == pytest.approx(30.0)


def test_numismatic_premium_only_when_numismatic_value_set(tmp_stack_db):
    item = stack.get_item(
        stack.create_item(_base_fields(silver_weight_oz=1.0, numismatic_value=150.0))
    )
    valuation = stack.compute_valuation(item, _spot(silver=30.0, gold=None))
    assert valuation["numismatic_premium"] == pytest.approx(120.0)

    item_no_num = stack.get_item(stack.create_item(_base_fields(silver_weight_oz=1.0, numismatic_value=None)))
    valuation_no_num = stack.compute_valuation(item_no_num, _spot(silver=30.0, gold=None))
    assert valuation_no_num["numismatic_premium"] is None


def test_unrealized_gain_bullion_only_not_zeroed_by_null_numismatic(tmp_stack_db):
    item = stack.get_item(
        stack.create_item(
            _base_fields(silver_weight_oz=1.0, numismatic_value=None, purchase_price=20.0)
        )
    )
    valuation = stack.compute_valuation(item, _spot(silver=30.0, gold=None))
    assert valuation["unrealized_gain"] == pytest.approx(10.0)
    assert valuation["unrealized_gain_pct"] == pytest.approx(50.0)


def test_unrealized_gain_folds_in_numismatic_value_when_present(tmp_stack_db):
    item = stack.get_item(
        stack.create_item(
            _base_fields(silver_weight_oz=1.0, numismatic_value=50.0, purchase_price=20.0)
        )
    )
    valuation = stack.compute_valuation(item, _spot(silver=30.0, gold=None))
    # melt 30 + numismatic 50 - purchase 20 = 60
    assert valuation["unrealized_gain"] == pytest.approx(60.0)


def test_portfolio_summary_rollup(tmp_db, tmp_stack_db):
    stack.create_item(_base_fields(silver_weight_oz=1.0, gold_weight_oz=None, count=1, purchase_price=25.0))
    stack.create_item(
        _base_fields(
            metal="gold", silver_weight_oz=None, gold_weight_oz=1.0, count=1, purchase_price=1900.0
        )
    )
    summary = stack.portfolio_summary()
    assert summary["total_spent"] == pytest.approx(25.0 + 1900.0)
    assert summary["total_silver_oz"] == pytest.approx(1.0)
    assert summary["total_gold_oz"] == pytest.approx(1.0)
    # No live spot in tmp_db here -> value_by_metal legs are 0 (no matching prices),
    # total_current_value only counts melt (None-safe) + numismatic (None) -> 0
    assert summary["value_by_metal"]["silver"] == pytest.approx(0.0)
    assert summary["value_by_metal"]["gold"] == pytest.approx(0.0)


def test_portfolio_summary_per_metal_gain_pct(tmp_db, tmp_stack_db):
    """Powers the 'Held' summary's (-17.2%) annotation — each metal's gain
    % compares that metal's live melt value against what was actually paid
    for that metal specifically, not the combined portfolio total."""
    db_module.append_spot_price_ticks([
        {"instrument": "XAG_SPOT", "ts": "2026-08-01T00:00:00Z", "price": 25.0, "change_pct_24h": None},
        {"instrument": "XAU_SPOT", "ts": "2026-08-01T00:00:00Z", "price": 2200.0, "change_pct_24h": None},
    ])
    # 1oz silver bought for $30, now worth $25 -> -16.67%
    stack.create_item(_base_fields(metal="silver", unit_weight_oz=1.0, count=1, purchase_price=30.0))
    # 1oz gold bought for $2000, now worth $2200 -> +10%
    stack.create_item(
        _base_fields(metal="gold", silver_weight_oz=None, gold_weight_oz=None, unit_weight_oz=1.0, count=1, purchase_price=2000.0)
    )
    summary = stack.portfolio_summary()
    assert summary["silver_gain_pct"] == pytest.approx((25.0 - 30.0) / 30.0 * 100)
    assert summary["gold_gain_pct"] == pytest.approx((2200.0 - 2000.0) / 2000.0 * 100)


def test_portfolio_summary_per_metal_gain_pct_null_when_no_spend_in_that_metal(tmp_db, tmp_stack_db):
    stack.create_item(_base_fields(metal="silver", unit_weight_oz=1.0, count=1, purchase_price=30.0))
    summary = stack.portfolio_summary()
    assert summary["gold_gain_pct"] is None


def test_portfolio_summary_dca_per_metal(tmp_db, tmp_stack_db):
    """DCA = total spent on that metal / total real oz held of that metal —
    independent of gain %, and independent of the other metal's DCA."""
    db_module.append_spot_price_ticks([
        {"instrument": "XAG_SPOT", "ts": "2026-08-01T00:00:00Z", "price": 25.0, "change_pct_24h": None},
        {"instrument": "XAU_SPOT", "ts": "2026-08-01T00:00:00Z", "price": 2200.0, "change_pct_24h": None},
    ])
    # 2oz silver total: 1oz@$30 + 1oz@$20 -> $50 / 2oz = $25/oz DCA
    stack.create_item(_base_fields(metal="silver", unit_weight_oz=1.0, count=1, purchase_price=30.0))
    stack.create_item(_base_fields(metal="silver", unit_weight_oz=1.0, count=1, purchase_price=20.0))
    stack.create_item(
        _base_fields(metal="gold", silver_weight_oz=None, gold_weight_oz=None, unit_weight_oz=1.0, count=1, purchase_price=2000.0)
    )
    summary = stack.portfolio_summary()
    assert summary["silver_dca"] == pytest.approx(25.0)
    assert summary["gold_dca"] == pytest.approx(2000.0)
    assert summary["spot_silver"] == pytest.approx(25.0)
    assert summary["spot_gold"] == pytest.approx(2200.0)


def test_portfolio_summary_dca_null_when_no_spend_in_that_metal(tmp_db, tmp_stack_db):
    stack.create_item(_base_fields(metal="silver", unit_weight_oz=1.0, count=1, purchase_price=30.0))
    summary = stack.portfolio_summary()
    assert summary["gold_dca"] is None


def test_portfolio_summary_empty_portfolio(tmp_db, tmp_stack_db):
    summary = stack.portfolio_summary()
    assert summary["total_spent"] is None
    assert summary["silver_gain_pct"] is None
    assert summary["gold_gain_pct"] is None
    assert summary["silver_dca"] is None
    assert summary["gold_dca"] is None
    assert summary["total_current_value"] is None


def test_series_summary_groups_by_series(tmp_db, tmp_stack_db):
    stack.create_bulk(
        _base_fields(series="Canadian Maple Leaf", quantity=37, unit_price=30.0, purchase_price=None)
    )
    stack.create_item(_base_fields(series="American Eagle", purchase_price=35.0))
    summary = stack.series_summary()
    labels = {g["label"]: g for g in summary}
    assert labels["Canadian Maple Leaf"]["item_count"] == 37
    assert labels["Canadian Maple Leaf"]["total_count"] == 37
    assert labels["American Eagle"]["item_count"] == 1


def test_series_summary_groups_unseriesed_items_by_description(tmp_db, tmp_stack_db):
    stack.create_item(_base_fields(description="10oz generic bar", form="bar", series=None))
    stack.create_item(_base_fields(description="10oz generic bar", form="bar", series=None))
    summary = stack.series_summary()
    labels = {g["label"]: g for g in summary}
    assert labels["10oz generic bar"]["item_count"] == 2
    assert labels["10oz generic bar"]["series"] is None


def test_series_summary_empty_portfolio(tmp_db, tmp_stack_db):
    assert stack.series_summary() == []


def test_series_summary_includes_total_weight_oz(tmp_db, tmp_stack_db):
    stack.create_item(_base_fields(series="American Eagle", unit_weight_oz=1.0, count=3, purchase_price=None))
    summary = stack.series_summary()
    labels = {g["label"]: g for g in summary}
    assert labels["American Eagle"]["total_weight_oz"] == pytest.approx(3.0)


def test_date_summary_groups_by_purchase_date(tmp_db, tmp_stack_db):
    stack.create_bulk(
        _base_fields(purchase_date="2026-01-30", quantity=3, unit_price=30.0, purchase_price=None)
    )
    stack.create_item(_base_fields(purchase_date="2026-02-01", purchase_price=35.0))
    summary = stack.date_summary()
    labels = {g["label"]: g for g in summary}
    assert labels["2026-01-30"]["item_count"] == 3
    assert labels["2026-01-30"]["purchase_date"] == "2026-01-30"
    assert labels["2026-02-01"]["item_count"] == 1


def test_date_summary_sorted_newest_first(tmp_db, tmp_stack_db):
    stack.create_item(_base_fields(purchase_date="2026-01-01", purchase_price=10.0))
    stack.create_item(_base_fields(purchase_date="2026-06-01", purchase_price=10.0))
    stack.create_item(_base_fields(purchase_date="2026-03-01", purchase_price=10.0))
    summary = stack.date_summary()
    assert [g["label"] for g in summary] == ["2026-06-01", "2026-03-01", "2026-01-01"]


def test_date_summary_groups_missing_dates_into_one_unknown_bucket(tmp_db, tmp_stack_db):
    stack.create_item(_base_fields(purchase_date=None, purchase_price=10.0))
    stack.create_item(_base_fields(purchase_date=None, purchase_price=10.0))
    summary = stack.date_summary()
    labels = {g["label"]: g for g in summary}
    assert labels["Unknown date"]["item_count"] == 2
    assert labels["Unknown date"]["purchase_date"] is None


def test_date_summary_includes_oz_and_melt_totals(tmp_db, tmp_stack_db):
    stack.create_item(
        _base_fields(purchase_date="2026-01-30", unit_weight_oz=1.0, count=2, purchase_price=60.0)
    )
    db_module.append_spot_price_ticks(
        [{"instrument": "XAG_SPOT", "ts": "2026-08-01T00:00:00Z", "price": 30.0, "change_pct_24h": None}]
    )
    summary = stack.date_summary()
    group = summary[0]
    assert group["total_weight_oz"] == pytest.approx(2.0)
    assert group["total_melt_value"] == pytest.approx(60.0)
    assert group["total_spent"] == pytest.approx(60.0)


def test_date_summary_empty_portfolio(tmp_db, tmp_stack_db):
    assert stack.date_summary() == []


# --- Timeseries (cost basis vs. current melt value over time) ------------


def test_timeseries_cumulative_spend_and_oz(tmp_db, tmp_stack_db):
    stack.create_item(
        _base_fields(purchase_date="2026-01-01", unit_weight_oz=1.0, count=1, purchase_price=30.0)
    )
    stack.create_item(
        _base_fields(purchase_date="2026-01-03", unit_weight_oz=1.0, count=2, purchase_price=62.0)
    )
    rows = stack.timeseries()
    assert [r["date"] for r in rows] == ["2026-01-01", "2026-01-03"]
    assert rows[0]["day_spend"] == pytest.approx(30.0)
    assert rows[0]["cumulative_spend"] == pytest.approx(30.0)
    assert rows[0]["cumulative_silver_oz"] == pytest.approx(1.0)
    assert rows[1]["day_spend"] == pytest.approx(62.0)
    assert rows[1]["cumulative_spend"] == pytest.approx(92.0)
    assert rows[1]["cumulative_silver_oz"] == pytest.approx(3.0)


def test_timeseries_uses_live_spot_for_cumulative_melt_value(tmp_db, tmp_stack_db):
    db_module.append_spot_price_ticks(
        [{"instrument": "XAG_SPOT", "ts": "2026-08-01T00:00:00Z", "price": 40.0, "change_pct_24h": None}]
    )
    stack.create_item(
        _base_fields(purchase_date="2026-01-01", unit_weight_oz=1.0, count=2, purchase_price=50.0)
    )
    rows = stack.timeseries()
    # 2 oz held as of this date x TODAY's $40 spot, not the $25/oz paid
    assert rows[0]["cumulative_melt_value"] == pytest.approx(80.0)


def test_timeseries_multiple_dates_accumulate_correctly(tmp_db, tmp_stack_db):
    db_module.append_spot_price_ticks(
        [{"instrument": "XAG_SPOT", "ts": "2026-08-01T00:00:00Z", "price": 30.0, "change_pct_24h": None}]
    )
    stack.create_item(_base_fields(purchase_date="2026-02-01", unit_weight_oz=1.0, count=1, purchase_price=25.0))
    stack.create_item(_base_fields(purchase_date="2026-01-01", unit_weight_oz=1.0, count=1, purchase_price=25.0))
    rows = stack.timeseries()
    assert [r["date"] for r in rows] == ["2026-01-01", "2026-02-01"]
    assert rows[0]["cumulative_silver_oz"] == pytest.approx(1.0)
    assert rows[1]["cumulative_silver_oz"] == pytest.approx(2.0)
    assert rows[1]["cumulative_melt_value"] == pytest.approx(60.0)


def test_timeseries_excludes_items_with_no_purchase_date(tmp_db, tmp_stack_db):
    stack.create_item(_base_fields(purchase_date=None, purchase_price=25.0))
    assert stack.timeseries() == []


def test_timeseries_empty_portfolio(tmp_db, tmp_stack_db):
    assert stack.timeseries() == []


# --- value_history: REAL historical weekly melt-vs-cost-basis -----------


def test_value_history_uses_real_weekly_closes_not_todays_spot(tmp_db, tmp_stack_db):
    """value_history() values each week at that week's REAL silver close
    (settlement_price XAG_YAHOO_DAILY_CLOSE), not today's spot applied
    backward the way timeseries() does — the whole point of the feature."""
    # Real close series: $30/oz through mid-Jan, $40/oz after.
    db_module.upsert_settlement_price_rows("XAG_YAHOO_DAILY_CLOSE", [
        {"date": "2026-01-05", "price": 30.0, "session": "daily"},
        {"date": "2026-01-19", "price": 40.0, "session": "daily"},
    ])
    # Today's spot is deliberately different again ($99) — must NOT be used.
    db_module.append_spot_price_ticks(
        [{"instrument": "XAG_SPOT", "ts": "2026-08-01T00:00:00Z", "price": 99.0, "change_pct_24h": None}]
    )
    stack.create_item(
        _base_fields(series="Test Series", purchase_date="2026-01-05",
                     unit_weight_oz=1.0, count=2, purchase_price=55.0)
    )
    rows = stack.value_history(series=["Test Series"])
    assert rows, "expected weekly rows"
    assert rows[0]["date"] == "2026-01-05"
    # Week of purchase: 2 oz x real $30 close = $60 melt, spend $55 -> gain +5
    assert rows[0]["melt_value"] == pytest.approx(60.0)
    assert rows[0]["gain"] == pytest.approx(5.0)
    # A later week (>= 2026-01-19) picks up the real $40 close -> $80 melt, +25
    later = [r for r in rows if r["date"] >= "2026-01-19"]
    assert later and later[0]["melt_value"] == pytest.approx(80.0)
    assert later[0]["gain"] == pytest.approx(25.0)


def test_value_history_series_filter_scopes_to_one_series(tmp_db, tmp_stack_db):
    db_module.upsert_settlement_price_rows("XAG_YAHOO_DAILY_CLOSE", [
        {"date": "2026-01-05", "price": 30.0, "session": "daily"},
    ])
    stack.create_item(_base_fields(series="Keep", purchase_date="2026-01-05",
                                   unit_weight_oz=1.0, count=1, purchase_price=25.0))
    stack.create_item(_base_fields(series="Drop", purchase_date="2026-01-05",
                                   unit_weight_oz=1.0, count=5, purchase_price=200.0))
    rows = stack.value_history(series=["Keep"])
    # Only the 1-oz "Keep" item: melt = 1 x $30 = $30, not 6 oz.
    assert rows[0]["melt_value"] == pytest.approx(30.0)


def test_value_history_null_melt_when_no_real_close_yet(tmp_db, tmp_stack_db):
    """A week before any real close exists for a metal actually held gets
    melt_value/gain NULL — nulls over zeros, no today's-spot fallback."""
    db_module.upsert_settlement_price_rows("XAG_YAHOO_DAILY_CLOSE", [
        {"date": "2026-06-01", "price": 30.0, "session": "daily"},
    ])
    stack.create_item(_base_fields(series="Early", purchase_date="2026-01-01",
                                   unit_weight_oz=1.0, count=1, purchase_price=25.0))
    rows = stack.value_history(series=["Early"])
    # First week (2026-01-01) predates the only real close (2026-06-01).
    assert rows[0]["melt_value"] is None
    assert rows[0]["gain"] is None
    # A week on/after 2026-06-01 has a real value again.
    assert any(r["melt_value"] is not None for r in rows)


def test_value_history_empty_for_unknown_series(tmp_db, tmp_stack_db):
    assert stack.value_history(series=["Nope"]) == []


def test_value_history_accepts_multiple_series(tmp_db, tmp_stack_db):
    """The multi-select legend passes a list — value_history sums oz/spend
    across every selected series-key, same as the whole-stack case scoped
    to a subset."""
    db_module.upsert_settlement_price_rows("XAG_YAHOO_DAILY_CLOSE", [
        {"date": "2026-01-05", "price": 30.0, "session": "daily"},
    ])
    stack.create_item(_base_fields(series="A", purchase_date="2026-01-05",
                                   unit_weight_oz=1.0, count=1, purchase_price=25.0))
    stack.create_item(_base_fields(series="B", purchase_date="2026-01-05",
                                   unit_weight_oz=1.0, count=2, purchase_price=55.0))
    stack.create_item(_base_fields(series="C", purchase_date="2026-01-05",
                                   unit_weight_oz=1.0, count=9, purchase_price=300.0))
    rows = stack.value_history(series=["A", "B"])
    # A (1 oz) + B (2 oz) = 3 oz x $30 = $90 melt, spend 25+55 = $80 -> +10.
    # C is excluded.
    assert rows[0]["melt_value"] == pytest.approx(90.0)
    assert rows[0]["gain"] == pytest.approx(10.0)


def test_value_history_none_or_empty_list_is_whole_stack(tmp_db, tmp_stack_db):
    db_module.upsert_settlement_price_rows("XAG_YAHOO_DAILY_CLOSE", [
        {"date": "2026-01-05", "price": 30.0, "session": "daily"},
    ])
    stack.create_item(_base_fields(series="A", purchase_date="2026-01-05",
                                   unit_weight_oz=1.0, count=1, purchase_price=25.0))
    stack.create_item(_base_fields(series="B", purchase_date="2026-01-05",
                                   unit_weight_oz=1.0, count=1, purchase_price=25.0))
    # Both None and [] mean "no filter" -> whole stack (2 oz x $30 = $60).
    for arg in (None, []):
        rows = stack.value_history(series=arg)
        assert rows[0]["melt_value"] == pytest.approx(60.0)


def test_value_history_metal_filter(tmp_db, tmp_stack_db):
    """The tab's All/Silver/Gold dropdown reaches this via ?metal= — a
    'silver' filter drops gold items from the oz/spend accumulation."""
    db_module.upsert_settlement_price_rows("XAG_YAHOO_DAILY_CLOSE", [
        {"date": "2026-01-05", "price": 30.0, "session": "daily"},
    ])
    db_module.upsert_settlement_price_rows("XAU_YAHOO_DAILY_CLOSE", [
        {"date": "2026-01-05", "price": 2000.0, "session": "daily"},
    ])
    stack.create_item(_base_fields(series="S", metal="silver", purchase_date="2026-01-05",
                                   unit_weight_oz=1.0, gold_weight_oz=None, count=2, purchase_price=55.0))
    stack.create_item(_base_fields(series="G", metal="gold", purchase_date="2026-01-05",
                                   unit_weight_oz=0.1, silver_weight_oz=None, gold_weight_oz=None,
                                   count=1, purchase_price=210.0))
    # Silver only: 2 oz x $30 = $60 melt, $55 spend -> +5. Gold excluded.
    s_rows = stack.value_history(metal="silver")
    assert s_rows[0]["melt_value"] == pytest.approx(60.0)
    assert s_rows[0]["gain"] == pytest.approx(5.0)
    # Gold only: 0.1 oz x $2000 = $200 melt, $210 spend -> -10.
    g_rows = stack.value_history(metal="gold")
    assert g_rows[0]["melt_value"] == pytest.approx(200.0)
    assert g_rows[0]["gain"] == pytest.approx(-10.0)
    # An unrecognized metal value is ignored (no filter).
    both = stack.value_history(metal="platinum")
    assert both[0]["melt_value"] == pytest.approx(260.0)


# --- Reference links ---------------------------------------------------


def test_add_and_list_and_delete_link(tmp_stack_db):
    item_id = stack.create_item(_base_fields())
    link_id = stack.add_link(item_id, "https://numista.com/x", "Numista listing")
    links = stack.list_links(item_id)
    assert len(links) == 1
    assert links[0]["url"] == "https://numista.com/x"
    assert links[0]["stack_item_id"] == item_id

    stack.delete_link(link_id)
    assert stack.list_links(item_id) == []


def test_add_link_requires_url(tmp_stack_db):
    item_id = stack.create_item(_base_fields())
    with pytest.raises(Exception) as exc_info:
        stack.add_link(item_id, "", "label")
    assert getattr(exc_info.value, "status_code", None) == 400


def test_add_link_to_missing_item_raises_404(tmp_stack_db):
    with pytest.raises(Exception) as exc_info:
        stack.add_link(999, "https://numista.com/x", None)
    assert getattr(exc_info.value, "status_code", None) == 404


# --- Photos --------------------------------------------------------------


class _FakeUploadFile:
    """Minimal stand-in for fastapi.UploadFile in a pure-unit (non-route)
    test — real multipart parsing is exercised separately at the route
    level via stack_client."""

    def __init__(self, filename, content: bytes):
        self.filename = filename
        self._content = content

    async def read(self):
        return self._content


@pytest.mark.asyncio
async def test_add_photo_writes_file_and_row(tmp_stack_db, tmp_stack_images):
    item_id = stack.create_item(_base_fields())
    photo = await stack.add_photo(item_id, _FakeUploadFile("original_name.jpg", b"fake image bytes"), "obverse")
    assert photo["stack_item_id"] == item_id
    assert photo["caption"] == "obverse"
    # UUID filename — never the client's original filename
    assert "original_name" not in photo["file_path"]
    assert photo["file_path"].startswith(f"{item_id}/")

    import os

    abs_path = os.path.join(tmp_stack_images, photo["file_path"])
    assert os.path.exists(abs_path)
    with open(abs_path, "rb") as f:
        assert f.read() == b"fake image bytes"


@pytest.mark.asyncio
async def test_add_photo_rejects_sixth_photo(tmp_stack_db, tmp_stack_images):
    item_id = stack.create_item(_base_fields())
    for i in range(stack.MAX_PHOTOS_PER_ITEM):
        await stack.add_photo(item_id, _FakeUploadFile(f"p{i}.jpg", b"x"), None)
    with pytest.raises(Exception) as exc_info:
        await stack.add_photo(item_id, _FakeUploadFile("one_too_many.jpg", b"x"), None)
    assert getattr(exc_info.value, "status_code", None) == 400


@pytest.mark.asyncio
async def test_add_photo_rejects_oversized_file(tmp_stack_db, tmp_stack_images):
    item_id = stack.create_item(_base_fields())
    oversized = b"x" * (stack.MAX_PHOTO_BYTES + 1)
    with pytest.raises(Exception) as exc_info:
        await stack.add_photo(item_id, _FakeUploadFile("big.jpg", oversized), None)
    assert getattr(exc_info.value, "status_code", None) == 400


@pytest.mark.asyncio
async def test_add_photo_to_missing_item_raises_404(tmp_stack_db, tmp_stack_images):
    with pytest.raises(Exception) as exc_info:
        await stack.add_photo(999, _FakeUploadFile("x.jpg", b"x"), None)
    assert getattr(exc_info.value, "status_code", None) == 404


@pytest.mark.asyncio
async def test_delete_photo_removes_row_and_file(tmp_stack_db, tmp_stack_images):
    item_id = stack.create_item(_base_fields())
    photo = await stack.add_photo(item_id, _FakeUploadFile("p.jpg", b"x"), None)

    import os

    abs_path = os.path.join(tmp_stack_images, photo["file_path"])
    assert os.path.exists(abs_path)

    stack.delete_photo(photo["id"])
    assert stack.list_images(item_id) == []
    assert not os.path.exists(abs_path)


def test_delete_missing_photo_raises_404(tmp_stack_db, tmp_stack_images):
    with pytest.raises(Exception) as exc_info:
        stack.delete_photo(999)
    assert getattr(exc_info.value, "status_code", None) == 404


# --- Route-level tests ---------------------------------------------------


@pytest.mark.asyncio
async def test_route_create_and_list_items(stack_client):
    resp = await stack_client.post(
        "/api/stack/items",
        json=_base_fields(),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    item_id = body["data"]["id"]

    resp = await stack_client.get("/api/stack/items/db")
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert any(i["id"] == item_id for i in body["data"])


@pytest.mark.asyncio
async def test_route_item_detail_includes_images_and_links(stack_client):
    resp = await stack_client.post("/api/stack/items", json=_base_fields())
    item_id = resp.json()["data"]["id"]

    resp = await stack_client.post(
        f"/api/stack/items/{item_id}/links", json={"url": "https://numista.com/x", "label": "listing"}
    )
    assert resp.status_code == 200

    resp = await stack_client.get(f"/api/stack/items/{item_id}/db")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["id"] == item_id
    assert len(data["reference_links"]) == 1
    assert data["images"] == []


@pytest.mark.asyncio
async def test_route_detail_404_for_missing_item(stack_client):
    resp = await stack_client.get("/api/stack/items/999999/db")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_route_bulk_create(stack_client):
    resp = await stack_client.post(
        "/api/stack/items/bulk",
        json=_base_fields(quantity=3, unit_price=10.0, purchase_price=None),
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert len(data["ids"]) == 3
    assert data["lot_id"] is not None


@pytest.mark.asyncio
async def test_route_series_summary(stack_client):
    await stack_client.post(
        "/api/stack/items/bulk",
        json=_base_fields(series="Canadian Maple Leaf", quantity=37, unit_price=30.0, purchase_price=None),
    )
    resp = await stack_client.get("/api/stack/series-summary/db")
    assert resp.status_code == 200
    data = resp.json()["data"]
    group = next(g for g in data if g["label"] == "Canadian Maple Leaf")
    assert group["item_count"] == 37


@pytest.mark.asyncio
async def test_route_date_summary(stack_client):
    await stack_client.post(
        "/api/stack/items/bulk",
        json=_base_fields(purchase_date="2026-01-30", quantity=5, unit_price=30.0, purchase_price=None),
    )
    resp = await stack_client.get("/api/stack/date-summary/db")
    assert resp.status_code == 200
    data = resp.json()["data"]
    group = next(g for g in data if g["label"] == "2026-01-30")
    assert group["item_count"] == 5


@pytest.mark.asyncio
async def test_route_timeseries(stack_client):
    await stack_client.post(
        "/api/stack/items", json=_base_fields(purchase_date="2026-01-30", purchase_price=30.0)
    )
    resp = await stack_client.get("/api/stack/timeseries/db")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert len(data) == 1
    assert data[0]["date"] == "2026-01-30"
    assert data[0]["cumulative_spend"] == pytest.approx(30.0)


@pytest.mark.asyncio
async def test_route_value_history(stack_client):
    db_module.upsert_settlement_price_rows("XAG_YAHOO_DAILY_CLOSE", [
        {"date": "2026-01-05", "price": 30.0, "session": "daily"},
    ])
    await stack_client.post(
        "/api/stack/items",
        json=_base_fields(series="Route Series", purchase_date="2026-01-05",
                          unit_weight_oz=1.0, count=1, purchase_price=25.0),
    )
    resp = await stack_client.get("/api/stack/value-history/db", params={"series": "Route Series"})
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data and data[0]["date"] == "2026-01-05"
    assert data[0]["melt_value"] == pytest.approx(30.0)
    assert data[0]["gain"] == pytest.approx(5.0)


@pytest.mark.asyncio
async def test_route_update_and_delete_item(stack_client):
    resp = await stack_client.post("/api/stack/items", json=_base_fields())
    item_id = resp.json()["data"]["id"]

    resp = await stack_client.put(
        f"/api/stack/items/{item_id}", json=_base_fields(description="Updated via route")
    )
    assert resp.status_code == 200

    resp = await stack_client.get(f"/api/stack/items/{item_id}/db")
    assert resp.json()["data"]["description"] == "Updated via route"

    resp = await stack_client.delete(f"/api/stack/items/{item_id}")
    assert resp.status_code == 200

    resp = await stack_client.get(f"/api/stack/items/{item_id}/db")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_route_bulk_update(stack_client):
    resp = await stack_client.post(
        "/api/stack/items/bulk",
        json=_base_fields(series=None, quantity=12, unit_price=114.87, purchase_price=None),
    )
    ids = resp.json()["data"]["ids"]

    resp = await stack_client.post(
        "/api/stack/items/bulk-update",
        json={"item_ids": ids, "fields": {"series": "Canadian Maple Leaf", "mint_year": 2013}},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["updated"] == 12

    resp = await stack_client.get(f"/api/stack/items/{ids[0]}/db")
    item = resp.json()["data"]
    assert item["series"] == "Canadian Maple Leaf"
    assert item["mint_year"] == 2013


@pytest.mark.asyncio
async def test_route_bulk_update_purchase_date(stack_client):
    resp = await stack_client.post(
        "/api/stack/items/bulk",
        json=_base_fields(purchase_date="2026-01-29", quantity=5, unit_price=30.0, purchase_price=None),
    )
    ids = resp.json()["data"]["ids"]
    resp = await stack_client.post(
        "/api/stack/items/bulk-update",
        json={"item_ids": ids, "fields": {"purchase_date": "2026-01-30"}},
    )
    assert resp.status_code == 200
    resp = await stack_client.get(f"/api/stack/items/{ids[0]}/db")
    assert resp.json()["data"]["purchase_date"] == "2026-01-30"


@pytest.mark.asyncio
async def test_route_bulk_update_rejects_disallowed_field(stack_client):
    resp = await stack_client.post("/api/stack/items", json=_base_fields())
    item_id = resp.json()["data"]["id"]
    resp = await stack_client.post(
        "/api/stack/items/bulk-update",
        json={"item_ids": [item_id], "fields": {"count": 5}},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_route_bulk_update_price_and_notes(stack_client):
    resp = await stack_client.post(
        "/api/stack/items/bulk",
        json=_base_fields(quantity=3, unit_price=30.0, purchase_price=None),
    )
    ids = resp.json()["data"]["ids"]
    resp = await stack_client.post(
        "/api/stack/items/bulk-update",
        json={"item_ids": ids, "fields": {"purchase_price": 35.0, "numismatic_notes": "corrected price"}},
    )
    assert resp.status_code == 200
    resp = await stack_client.get(f"/api/stack/items/{ids[0]}/db")
    item = resp.json()["data"]
    assert item["purchase_price"] == 35.0
    assert item["numismatic_notes"] == "corrected price"


@pytest.mark.asyncio
async def test_route_invalid_metal_returns_400(stack_client):
    resp = await stack_client.post("/api/stack/items", json=_base_fields(metal="platinum"))
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_route_summary(stack_client):
    resp = await stack_client.get("/api/stack/summary/db")
    assert resp.status_code == 200
    assert resp.json()["success"] is True


@pytest.mark.asyncio
async def test_stack_tab_is_pinnable(stack_client):
    """Regression test: the Stack nav tab existed in frontend/src/App.jsx's
    SECTIONS but was never added to main.py's _VALID_NAV_SECTIONS allowlist,
    so pinning it 400'd silently (the frontend's togglePin doesn't surface
    POST errors) — confirmed live against the running app before this fix."""
    resp = await stack_client.post("/api/ui/pinned-section", json={"section": "stack"})
    assert resp.status_code == 200
    assert resp.json()["data"]["pinned_section"] == "stack"

    resp = await stack_client.get("/api/ui/pinned-section")
    assert resp.json()["data"]["pinned_section"] == "stack"


@pytest.mark.asyncio
async def test_route_photo_upload_and_delete(stack_client):
    resp = await stack_client.post("/api/stack/items", json=_base_fields())
    item_id = resp.json()["data"]["id"]

    files = {"file": ("photo.jpg", io.BytesIO(b"fake jpeg bytes"), "image/jpeg")}
    resp = await stack_client.post(
        f"/api/stack/items/{item_id}/photos", files=files, data={"caption": "obverse"}
    )
    assert resp.status_code == 200
    photo = resp.json()["data"]
    assert photo["caption"] == "obverse"

    resp = await stack_client.delete(f"/api/stack/photos/{photo['id']}")
    assert resp.status_code == 200


# Note: the /stack_images StaticFiles mount binds its directory at app
# construction/import time (starlette.staticfiles.StaticFiles stores
# `directory` in __init__), so it can't be redirected to tmp_stack_images
# via monkeypatch the way stack_db.get_conn()/IMAGES_ROOT-consuming
# functions can — that's a real limitation of this route specifically, not
# of test coverage generally. File-write/delete-on-disk behavior is fully
# covered at the unit level (test_add_photo_writes_file_and_row,
# test_delete_photo_removes_row_and_file); the static-serving route itself
# is a one-line passthrough with no logic of its own to regress.


# --- Convention-suite compatibility ---------------------------------------


def test_stack_routes_covered_by_allowed_non_db_api():
    """The mutating /api/stack/* routes (POST/PUT/DELETE) aren't /db-suffixed
    reads — confirm tests/test_conventions.py's ALLOWED_NON_DB_API carries a
    "/api/stack/" entry so the frontend-fetch-scan guard doesn't flag them."""
    from tests import test_conventions

    assert any(
        prefix.startswith("/api/stack/") for prefix in test_conventions.ALLOWED_NON_DB_API
    ), "ALLOWED_NON_DB_API needs a /api/stack/ entry for Stack Tracker's CRUD routes"
