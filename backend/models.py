"""Pydantic response models — api-split-implementation-plan.md Story 3.2,
first pass (Stack, OFAC, CoT route groups).

Additive typing only: every model here is written against a route's real,
already-shipping return shape (confirmed by seeding a tmp DB and reading the
actual JSON back, not guessed from the underlying db.py/stack.py function
names alone). None of these change a route's behavior — a route that
returned an extra or missing field before this file existed still does,
and any such mismatch is a separate finding, not something quietly "fixed"
by writing the model to match intent instead of reality.

Fields that are themselves free-form/dynamic (a computed dict keyed by
window size, a JSON-parsed program_tags list, a per-source-shaped payload)
stay loosely typed (`dict`, `list`, `Any`) rather than nested models that
would have to be kept in lockstep with pipeline/db internals by hand.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


# --- CoT (/cot/db) ----------------------------------------------------------


class CotReportRow(BaseModel):
    date: str
    noncomm_long: float | None = None
    noncomm_short: float | None = None
    open_interest: float | None = None
    net_long: float | None = None
    net_long_pct_oi: float | None = None


# windows' real JSON keys are "2yr"/"5yr"/"disagree" — "2yr"/"5yr" aren't
# valid Python identifiers, so this stays a plain dict (each metal's value
# is either a {"percentile", "window_size", "classification"}-shaped dict,
# or, for "disagree", a bool) rather than a named model that would need an
# alias round-trip for no real typing benefit.


class CotLookaheadStat(BaseModel):
    hit_rate_pct: float
    correct: int
    total: int
    median_price_chg_pct: float
    min_price_chg_pct: float
    max_price_chg_pct: float


class CotSignalZoneRecord(BaseModel):
    sample_count: int
    thin_sample: bool
    events: list[dict[str, Any]]
    # Keyed "4w"/"8w" (pipeline/config.py's LOOKAHEAD_WEEKS) — same
    # not-a-Python-identifier reason "windows" above stays a plain dict
    # rather than named fields.
    lookahead: dict[str, CotLookaheadStat | None]


class CotSignalTrackRecord(BaseModel):
    crowded: CotSignalZoneRecord
    capitulated: CotSignalZoneRecord
    thin_sample_warning: bool


class CotMetalBlock(BaseModel):
    series: list[dict[str, Any]]
    latest: dict[str, Any]
    windows: dict[str, Any]
    signal_track_record: CotSignalTrackRecord


class GsrPoint(BaseModel):
    date: str
    gsr: float


class CotDbResponse(BaseModel):
    success: bool
    cot_as_of_date: str
    generated_at: str | None
    series: list[dict[str, Any]]
    latest: dict[str, Any]
    windows: dict[str, Any]
    signal_track_record: CotSignalTrackRecord
    gold: CotMetalBlock
    gsr_series: list[GsrPoint]


# --- OFAC (/ofac/db, /ofac/{uid}/db) ----------------------------------------


class OfacDesignation(BaseModel):
    id: int
    ofac_uid: str
    entity_name: str
    entity_type: str | None = None
    program_tags: list[str] = []
    list_source: str
    designation_date: str | None = None
    legal_basis: str | None = None
    vessel_flag: str | None = None
    vessel_type: str | None = None
    first_seen_snapshot_date: str
    last_seen_snapshot_date: str
    delisted_date: str | None = None
    created_at: str
    updated_at: str
    chart_date: str | None = None


class OfacAlias(BaseModel):
    name: str
    is_primary: bool | int
    alias_type: str | None = None


class OfacAddress(BaseModel):
    address1: str | None = None
    address2: str | None = None
    address3: str | None = None
    city: str | None = None
    state_province: str | None = None
    postal_code: str | None = None
    country: str | None = None


class OfacIdDocument(BaseModel):
    id_type: str | None = None
    id_number: str | None = None
    issuing_country: str | None = None


class OfacDesignationDetail(OfacDesignation):
    aliases: list[OfacAlias]
    addresses: list[OfacAddress]
    id_documents: list[OfacIdDocument]


class OfacListResponse(BaseModel):
    success: bool
    data: list[OfacDesignation]


class OfacDetailResponse(BaseModel):
    success: bool
    data: OfacDesignationDetail


# --- Stack Tracker (/stack/*) ------------------------------------------------


class StackItem(BaseModel):
    """A stack_items row plus compute_valuation()'s derived fields and
    list_items()'s joined photo_count. Every field nulls-over-zeros per the
    standing convention — a missing spot price or unset numismatic field is
    None, never a fabricated 0."""

    id: int
    description: str
    metal: str
    form: str
    silver_weight_oz: float | None = None
    gold_weight_oz: float | None = None
    unit_weight_oz: float | None = None
    count: int
    lot_id: str | None = None
    purchase_date: str | None = None
    purchase_price: float | None = None
    premium_paid: float | None = None
    mint_year: int | None = None
    series: str | None = None
    mint_mark: str | None = None
    mintage: int | None = None
    grading_service: str | None = None
    grade: str | None = None
    certification_number: str | None = None
    numismatic_value: float | None = None
    numismatic_value_as_of: str | None = None
    numismatic_notes: str | None = None
    created_at: str
    updated_at: str
    photo_count: int = 0
    total_weight_oz: float | None = None
    melt_value: float | None = None
    numismatic_premium: float | None = None
    unrealized_gain: float | None = None
    unrealized_gain_pct: float | None = None


class StackReferenceLink(BaseModel):
    id: int
    stack_item_id: int
    url: str
    label: str | None = None
    added_at: str


class StackImage(BaseModel):
    id: int
    stack_item_id: int
    file_path: str
    caption: str | None = None
    added_at: str


class StackItemDetail(StackItem):
    images: list[StackImage]
    reference_links: list[StackReferenceLink]


class StackItemsListResponse(BaseModel):
    success: bool
    data: list[StackItem]


class StackItemDetailResponse(BaseModel):
    success: bool
    data: StackItemDetail


class StackSummary(BaseModel):
    total_spent: float | None = None
    total_current_value: float | None = None
    total_unrealized_gain: float | None = None
    total_unrealized_gain_pct: float | None = None
    total_silver_oz: float | None = None
    total_gold_oz: float | None = None
    silver_gain_pct: float | None = None
    gold_gain_pct: float | None = None
    silver_dca: float | None = None
    gold_dca: float | None = None
    spot_silver: float | None = None
    spot_gold: float | None = None
    value_by_metal: dict[str, float]


class StackSummaryResponse(BaseModel):
    success: bool
    data: StackSummary


class _StackGroupRollupFields(BaseModel):
    """Shared rollup fields both series_summary and date_summary add on top
    of their own distinct grouping key (see stack._summarize_group) —
    factored out so neither route's model carries the other's key with a
    fabricated null, which would be a real (if minor) response-shape
    change from what these routes return today."""

    label: str
    item_count: int
    total_count: int
    total_weight_oz: float | None = None
    total_melt_value: float | None = None
    total_spent: float | None = None
    item_ids: list[int]


class StackSeriesGroupRollup(_StackGroupRollupFields):
    series: str | None = None


class StackDateGroupRollup(_StackGroupRollupFields):
    purchase_date: str | None = None


class StackSeriesSummaryResponse(BaseModel):
    success: bool
    data: list[StackSeriesGroupRollup]


class StackDateSummaryResponse(BaseModel):
    success: bool
    data: list[StackDateGroupRollup]


class StackTimeseriesPoint(BaseModel):
    date: str
    day_spend: float
    cumulative_spend: float
    cumulative_silver_oz: float
    cumulative_gold_oz: float
    cumulative_melt_value: float | None = None


class StackTimeseriesResponse(BaseModel):
    success: bool
    data: list[StackTimeseriesPoint]


class StackValueHistoryPoint(BaseModel):
    date: str
    spend: float
    melt_value: float | None = None
    gain: float | None = None


class StackValueHistoryResponse(BaseModel):
    success: bool
    data: list[StackValueHistoryPoint]


class IdResponse(BaseModel):
    """Generic {"id": N} data payload — create-item, add-link."""

    id: int


class BulkCreateResult(BaseModel):
    ids: list[int]
    lot_id: str | None = None


class BulkUpdateResult(BaseModel):
    updated: int


class PhotoResult(BaseModel):
    id: int
    stack_item_id: int
    file_path: str
    caption: str | None = None


class PhotoCopyResult(BaseModel):
    copied: list[int]
    skipped_full: list[int]
    skipped_missing: list[int]


class StackCreateResponse(BaseModel):
    success: bool
    data: IdResponse


class StackBulkCreateResponse(BaseModel):
    success: bool
    data: BulkCreateResult


class StackBulkUpdateResponse(BaseModel):
    success: bool
    data: BulkUpdateResult


class StackNullDataResponse(BaseModel):
    """update/delete routes that return {"success": True, "data": None} —
    a real, deliberate null, not an omitted field."""

    success: bool
    data: None = None


class StackPhotoUploadResponse(BaseModel):
    success: bool
    data: PhotoResult


class StackPhotoCopyResponse(BaseModel):
    success: bool
    data: PhotoCopyResult


class StackLinkCreateResponse(BaseModel):
    success: bool
    data: IdResponse
