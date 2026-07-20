"""Convention guards (CLAUDE.md: Standing architectural rules +
Cross-cutting data conventions) — mechanical checks that the documented
rules still hold as the codebase grows."""

import json
import re
from datetime import timedelta
from pathlib import Path

import pytest

import backend.main  # noqa: F401 — importing populates SOURCE_REGISTRY
from backend import db as db_module
from backend import sources

REPO_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_SRC = REPO_ROOT / "frontend" / "src"
EDITORIAL_JSON = FRONTEND_SRC / "data_editorial.json"


# --- Data-tab sync: registry <-> editorial (the strict standing rule) -----


def _editorial_source_keys() -> set[str]:
    cards = json.loads(EDITORIAL_JSON.read_text())
    return {k for c in cards for k in c.get("sourceKeys", [])}


def test_every_editorial_source_key_exists_in_registry():
    unknown = _editorial_source_keys() - set(sources.SOURCE_REGISTRY)
    assert not unknown, f"data_editorial.json names source keys the registry doesn't have: {sorted(unknown)}"


def test_every_registry_source_has_an_editorial_home():
    undocumented = set(sources.SOURCE_REGISTRY) - _editorial_source_keys()
    assert not undocumented, (
        f"Sources registered in backend/sources.py with no data_editorial.json card: "
        f"{sorted(undocumented)} — the Data tab MUST be updated whenever app data changes."
    )


# --- Table ownership: every DDL table is claimed or explicitly infra ------

# Tables with no upstream source by design — infra/app-state/hand-maintained.
# Adding a table here requires the same justification these have.
NON_SOURCE_TABLES = {
    "source_health",       # fetch bookkeeping about every other source
    "interval_overrides",  # per-source cadence overrides (app state)
    "ui_settings",         # pinned-tab state (app state)
    "research_sessions",   # Research tab: on-demand chat, no market upstream
    "research_messages",
    "research_log",
    "squeeze_case_log",    # hand-maintained reference data, no fetch
}


def test_every_table_is_owned_by_a_source_or_declared_infra():
    ddl_tables = set(re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)", db_module.DDL))
    owned = {t for s in sources.SOURCE_REGISTRY.values() for t in s.tables}
    orphans = ddl_tables - owned - NON_SOURCE_TABLES
    assert not orphans, (
        f"Tables in db.py's DDL claimed by no SourceDefinition.tables and not in "
        f"NON_SOURCE_TABLES: {sorted(orphans)}"
    )
    ghosts = owned - ddl_tables
    assert not ghosts, f"SourceDefinition.tables name tables db.py's DDL doesn't create: {sorted(ghosts)}"


# --- Persist-on-fetch: frontend never reads upstream directly -------------

# Non-/db API paths the frontend may legitimately call. Two kinds:
# user-initiated refresh COMMANDS (they trigger a _fetch_and_persist_*,
# preserving persist-on-fetch — the frontend still never receives upstream
# data directly), and reads of app state / seed data with no upstream at
# all. Anything new failing this test needs a conscious decision, not a
# reflexive allowlist addition.
ALLOWED_NON_DB_API = {
    "/api/refresh/settings": "tier settings read/write — app state, no upstream",
    "/api/refresh/force": "user-initiated refresh command (persists, then panels re-read /db)",
    "/api/catcor/refresh": "user-initiated CATCOR re-seed/backfill command",
    "/api/fred/money-supply/refresh": "Money Supply Refresh button — user-initiated persist trigger",
    "/api/metals/prices/refresh": "Money Supply Refresh button — user-initiated persist trigger",
    "/api/health/refresh/": "Data tab 'Re-run now' — user-initiated persist trigger",
    "/api/data-sources/": "interval-override POST (app state); its read is /db-suffixed",
    "/api/ui/pinned-section": "pinned-tab state read/write — app state, no upstream",
    "/api/silver/market-balance": "reads seed_data JSON server-side — no upstream fetch",
    "/api/catcor/research/": "Research workflow (sessions/personas/preview) — on-demand chat, no market upstream",
}

# Limitation, documented: this scans string-literal fetch() URLs only.
# research_panel.jsx routes through fetch(url, ...) with variable URLs —
# those are covered by the /api/catcor/research/ allowlist entry above.
FETCH_URL_RE = re.compile(r"""fetch\(\s*[`"']([^`"']+)[`"']""")


def _frontend_api_urls() -> set[str]:
    urls = set()
    for path in list(FRONTEND_SRC.glob("*.jsx")) + list(FRONTEND_SRC.glob("*.js")):
        for m in FETCH_URL_RE.finditer(path.read_text()):
            url = m.group(1)
            if url.startswith("/api/"):
                urls.add(url)
    return urls


def test_frontend_only_fetches_db_routes_or_sanctioned_commands():
    violations = []
    for url in sorted(_frontend_api_urls()):
        is_db = url.endswith("/db") or "/db?" in url or "/db/" in url
        is_allowed = any(url.startswith(prefix) for prefix in ALLOWED_NON_DB_API)
        if not (is_db or is_allowed):
            violations.append(url)
    assert not violations, (
        f"Frontend fetches non-/db API routes not in the sanctioned allowlist: {violations} "
        f"— persist-on-fetch requires the frontend to read persisted data only."
    )


# --- Registry invariants (backend/sources.py) ------------------------------


def _dummy_source(key: str, cadence: sources.CadenceSpec) -> sources.SourceDefinition:
    async def _noop():
        return None

    return sources.SourceDefinition(
        key=key,
        label="Test source",
        affinity_group="static_internal",
        fetch_fn=_noop,
        tables=[],
        cadence=cadence,
        rate_limit=sources.RateLimitSpec(kind="undocumented"),
    )


def test_register_rejects_duplicate_keys():
    key = "_test_duplicate_key"
    try:
        sources.register(_dummy_source(key, sources.CadenceSpec(trigger="manual_only")))
        with pytest.raises(ValueError, match="duplicate"):
            sources.register(_dummy_source(key, sources.CadenceSpec(trigger="manual_only")))
    finally:
        sources.SOURCE_REGISTRY.pop(key, None)


def test_register_rejects_always_on_with_fire_at_startup():
    """Reaction capture's always-on property must stay structurally
    unambiguous — one firing path, never two that could race."""
    key = "_test_always_on_startup"
    try:
        with pytest.raises(ValueError):
            sources.register(
                _dummy_source(
                    key,
                    sources.CadenceSpec(trigger="always_on", interval_seconds=60, fire_at_startup=True),
                )
            )
    finally:
        sources.SOURCE_REGISTRY.pop(key, None)


def test_expected_interval_is_derived_not_stored():
    """expected_interval_s is a property of CadenceSpec (2x it = the
    staleness threshold) — interval sources derive it from
    interval_seconds, gated manual sources from min_gap, and pure
    manual_only sources honestly have none."""
    assert sources.CadenceSpec(trigger="interval", interval_seconds=300).expected_interval_s == 300
    gated = sources.CadenceSpec(trigger="manual_only", min_gap=timedelta(days=25))
    assert gated.expected_interval_s == int(timedelta(days=25).total_seconds())
    assert sources.CadenceSpec(trigger="manual_only").expected_interval_s is None


async def test_always_on_reaction_capture_is_never_interval_overridable(tmp_db, client):
    """catcor_snapshot (reaction capture) is always_on because a missed
    window is permanent data loss — the interval-override route must
    refuse to touch it."""
    resp = await client.post(
        "/api/data-sources/catcor_snapshot/interval", json={"interval_seconds": 3600}
    )
    assert resp.status_code >= 400
    assert tmp_db.get_interval_overrides() == {}
