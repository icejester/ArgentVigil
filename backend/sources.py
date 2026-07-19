"""Canonical data-source registry (datasources-spec.md Story #1 + #3).

Single source of truth for "what gets fetched, on what cadence, under
which source_health key, subject to what rate limit" — replaces the
four-homes-by-hand pattern main.py used to have (three separate registry
dicts, three bespoke rate-limit `if` blocks, and CATCOR's own two loops
that were never in any registry at all). backend/main.py's scheduler,
the health routes, and the frontend Data tab (via GET /api/data-sources/db)
all read from SOURCE_REGISTRY instead of parallel lists.

This module intentionally has no FastAPI/httpx-level knowledge of its
own — it imports fetch functions from backend.main and backend.catcor and
wraps them with scheduling/rate-limit metadata only. It is populated by
build_registry(), called once from main.py after every fetch function it
references has been defined (module-level functions, same ordering
constraint the old _SOURCE_REGISTRY had).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Awaitable, Callable, Literal

Trigger = Literal["startup", "interval", "manual_only", "always_on"]


@dataclass(frozen=True)
class CadenceSpec:
    """How often a source is eligible to fetch, and by what mechanism.

    trigger:
      - "interval": fired by the generic scheduler every interval_seconds,
        subject to enabled_flag if set.
      - "always_on": fired by the generic scheduler every interval_seconds,
        UNCONDITIONALLY — no enabled_flag branch is ever consulted for this
        trigger value. This is deliberately a distinct value from
        "interval" (not "interval" + enabled_flag=None) so a source that
        must never be gated — CATCOR's reaction-snapshot capture, where a
        missed window is permanent data loss, unlike re-fetchable tier
        data — is structurally incapable of being paused by a future
        settings toggle or accidentally-added min_gap. Enforcement by
        construction, not by convention.
      - "manual_only": never ticked by the scheduler; reachable only via
        POST /api/health/refresh/{key}. min_gap/gate_on still apply there.
      - "startup": fired once at boot from main.py's lifespan (not by the
        generic scheduler — see main.py's _catcor_startup/_lbma_fix_startup/
        _census_trade_startup, whose internal ordering is load-bearing and
        deliberately not generalized in this pass). Also reachable via the
        manual health-refresh route at any time.

    min_gap + gate_on: a cooldown since either the last fetch ATTEMPT
    (source_health.last_attempt_at) or the last PERSISTED data's own age,
    depending on gate_on. These are genuinely different mechanisms for two
    real current sources — Census gates on attempt time (its ~2-month
    publication lag means persisted-data age is never a useful gate),
    CoT gates on persisted report age (CFTC publishes within ~3 days of
    its as-of date, so report age closely tracks fetch recency there).
    persisted_age_fn is required when gate_on == "persisted_data_age".
    """

    trigger: Trigger
    interval_seconds: int | None = None
    min_gap: timedelta | None = None
    gate_on: Literal["last_attempt_at", "persisted_data_age"] = "last_attempt_at"
    persisted_age_fn: Callable[[], "date | None"] | None = None
    enabled_flag: str | None = None

    @property
    def expected_interval_s(self) -> int | None:
        """Derived staleness-threshold input for the Data tab — never
        stored, always computed from this spec. None for triggers with no
        meaningful cadence number (manual_only/startup with no min_gap) —
        the health payload omits the field rather than fabricating one."""
        if self.interval_seconds is not None:
            return self.interval_seconds
        if self.min_gap is not None:
            return int(self.min_gap.total_seconds())
        return None

    def gate_block_reason(self, source_key: str, get_source_health: Callable[[str], dict | None]) -> str | None:
        """Returns a skip reason string if this source's min_gap cooldown
        hasn't elapsed yet, else None. Pure function of persisted state —
        callers decide what to do with a non-None result (record a
        'skipped' attempt, refuse to fetch, etc)."""
        if self.min_gap is None:
            return None
        if self.gate_on == "persisted_data_age":
            if self.persisted_age_fn is None:
                raise ValueError(f"{source_key}: gate_on='persisted_data_age' requires persisted_age_fn")
            latest = self.persisted_age_fn()
            if latest is None:
                return None
            age = date.today() - latest
            if age < self.min_gap:
                days = self.min_gap.days
                return f"Latest persisted data is less than {days} days old — skipped to respect upstream publish cadence."
            return None
        # gate_on == "last_attempt_at"
        health = get_source_health(source_key)
        if not health or not health.get("last_attempt_at"):
            return None
        last_attempt = datetime.fromisoformat(health["last_attempt_at"])
        if last_attempt.tzinfo is None:
            last_attempt = last_attempt.replace(tzinfo=timezone.utc)
        elapsed = datetime.now(timezone.utc) - last_attempt
        if elapsed < self.min_gap:
            days = self.min_gap.days
            return f"Last fetch attempt is less than {days} days old — skipped to respect upstream rate limit."
        return None


@dataclass(frozen=True)
class RateLimitSpec:
    """Rendered as real enforced state on the Data tab (Story #6), not
    free text that can drift from what the code does."""

    kind: Literal["numeric_quota", "min_gap_derived", "undocumented"]
    quota_per_period: str | None = None
    min_gap: timedelta | None = None
    note: str | None = None


@dataclass(frozen=True)
class SourceDefinition:
    key: str
    label: str
    affinity_group: Literal["gov_regulatory", "exchange_market", "calendar_events", "static_internal"]
    fetch_fn: Callable[[], Awaitable[None]]
    tables: list[str]
    cadence: CadenceSpec
    rate_limit: RateLimitSpec
    requires_env: list[str] = field(default_factory=list)
    curl_example: str = ""
    self_recording: bool = False

    @property
    def tier(self) -> str:
        """Small, scheduling-only label — deliberately distinct from
        affinity_group (a 4-value source-CATEGORY grouping). Kept separate
        so the Data tab's existing fast/slow rollup (TieredLoopSummary)
        keeps working unchanged; affinity_group answers a different
        question ("what kind of source is this") than tier does ("how/when
        does it fire")."""
        if self.cadence.trigger == "always_on":
            return "always-on"
        if self.cadence.trigger == "interval":
            if self.cadence.enabled_flag == "fast_enabled":
                return "fast"
            if self.cadence.enabled_flag == "slow_enabled":
                return "slow"
            return "interval"
        if self.cadence.trigger == "startup":
            return "startup"
        return "on-demand"


SOURCE_REGISTRY: dict[str, SourceDefinition] = {}


def register(source: SourceDefinition) -> SourceDefinition:
    """Adds one SourceDefinition to the module-level registry and returns
    it unchanged, so build_registry() call sites read as a flat list of
    `register(SourceDefinition(...))` calls rather than a separate
    build-then-assign step."""
    if source.key in SOURCE_REGISTRY:
        raise ValueError(f"duplicate source_key: {source.key}")
    SOURCE_REGISTRY[source.key] = source
    return source


def sources_by_tier(tier: str) -> dict[str, SourceDefinition]:
    return {k: s for k, s in SOURCE_REGISTRY.items() if s.tier == tier}


def serialize(source: SourceDefinition) -> dict:
    """JSON-safe view of a SourceDefinition for GET /api/data-sources/db —
    excludes fetch_fn/persisted_age_fn (not serializable, and not
    something the frontend needs), converts timedelta fields to seconds."""
    cadence = source.cadence
    rate_limit = source.rate_limit
    return {
        "key": source.key,
        "label": source.label,
        "affinity_group": source.affinity_group,
        "tables": source.tables,
        "requires_env": source.requires_env,
        "curl_example": source.curl_example,
        "self_recording": source.self_recording,
        "tier": source.tier,
        "cadence": {
            "trigger": cadence.trigger,
            "interval_seconds": cadence.interval_seconds,
            "min_gap_seconds": int(cadence.min_gap.total_seconds()) if cadence.min_gap else None,
            "gate_on": cadence.gate_on,
            "enabled_flag": cadence.enabled_flag,
            "expected_interval_s": cadence.expected_interval_s,
        },
        "rate_limit": {
            "kind": rate_limit.kind,
            "quota_per_period": rate_limit.quota_per_period,
            "min_gap_seconds": int(rate_limit.min_gap.total_seconds()) if rate_limit.min_gap else None,
            "note": rate_limit.note,
        },
    }
