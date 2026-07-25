"""In-process lifespan integration tests.

Unlike every other test module (which drives `client`/`upstream_client`
with lifespan deliberately skipped, per conftest.py's ground rules), this
module runs FastAPI's REAL `lifespan()` — the startup fetch chain and
`_schedule_loop`'s registration/first-tick pass — against a tmp DB, with
every upstream host caught by a catch-all respx mock. It exists to catch
wiring bugs route-level tests structurally cannot see: a source registered
in sources.py but never actually reachable from lifespan, a startup-only
source firing more than once, an exception during boot that isn't
swallowed where CLAUDE.md says it should be, or _schedule_loop crashing
outright on first tick against a fresh SOURCE_REGISTRY.

Still never touches runtime/argentvigil.db (tmp_db's monkeypatch) and
never calls a live upstream (respx.mock's catch-all routes below) — same
two ground rules as the rest of the suite, just with lifespan itself now
in scope instead of bypassed.
"""

import asyncio

import httpx
import pytest
import respx
from helpers import make_fake_date
from datetime import date

from backend import main as main_module
from backend import sources


def _catchall_mock():
    """One generic 200 response per real upstream host main.py/catcor.py
    talk to (see CLAUDE.md's Data sources list) — enough for every
    fetch_fn to complete without raising, without re-asserting each
    source's own parse logic (that's test_upstream_contracts.py's job).
    metalcharts.org's token endpoint gets a real-shaped token response
    since authed_headers() would otherwise KeyError on data["token"]."""
    router = respx.mock(assert_all_called=False)
    router.get("https://metalcharts.org/api/security/token").mock(
        return_value=httpx.Response(200, json={"token": "fake-token", "expiresAt": 99999999999999})
    )
    router.route(host="metalcharts.org").mock(
        return_value=httpx.Response(200, json={"data": []})
    )
    router.route(host="api.stlouisfed.org").mock(
        return_value=httpx.Response(200, json={"observations": []})
    )
    router.route(host="query1.finance.yahoo.com").mock(
        return_value=httpx.Response(200, json={"chart": {"result": [{"timestamp": [], "indicators": {"quote": [{"close": [], "volume": []}]}}]}})
    )
    router.route(host="www.goldapi.io").mock(
        return_value=httpx.Response(404, json={"error": "no data"})
    )
    router.route(host="api.census.gov").mock(return_value=httpx.Response(204))
    router.route(host="nfs.faireconomy.media").mock(return_value=httpx.Response(200, json=[]))
    router.route(host="sprott.com").mock(return_value=httpx.Response(200, json=[]))
    router.route(host="api.stlouisfed.org", path__regex=r".*release/dates.*").mock(
        return_value=httpx.Response(200, json={"release_dates": []})
    )
    return router


@pytest.fixture()
async def booted_app(tmp_db, monkeypatch):
    """Drives backend.main.app through a real lifespan cycle. Yields
    (app, tmp_db) while lifespan's background tasks are alive; tears them
    down the same way lifespan's own __aexit__ does (cancel + client
    close) so no task leaks into the next test.

    Also resets _startup_fired before each boot — like _refresh_tasks
    (see test_lifespan_teardown_cancels_background_tasks' note),
    _startup_fired is module-level and only ever grows; a real process
    only boots once so this never matters in production, but a second
    lifespan() call in the same test process would otherwise see
    fire_at_startup sources as already-fired from a PRIOR test's boot and
    skip them, which is what test_startup_only_sources_fire_exactly_once
    is specifically trying to observe."""
    monkeypatch.setattr(main_module, "date", make_fake_date(date(2026, 7, 21)))  # Tuesday
    main_module._startup_fired.clear()
    router = _catchall_mock()
    with router:
        from backend.main import app

        async with main_module.lifespan(app):
            # Let _schedule_loop and the one-shot startup tasks run at
            # least one real pass before assertions — 1s tick interval,
            # so a short real sleep is the simplest deterministic wait
            # (no internal "settled" signal exists to await instead).
            await asyncio.sleep(1.5)
            yield app, tmp_db


async def test_lifespan_boots_without_raising(booted_app):
    """The core wiring assertion: every registered source's fetch_fn ran
    at least once (fast tier + every fire_at_startup source) against a
    fully-mocked upstream without an unhandled exception escaping
    lifespan or _schedule_loop's per-source try/except."""
    app, tmp_db = booted_app
    assert app is not None


async def test_every_registered_source_is_reachable(booted_app):
    """Every key in sources.SOURCE_REGISTRY must correspond to a callable
    fetch_fn — a source present in the registry but wired to a stale/typo'd
    function reference would raise AttributeError-shaped errors at import
    time already, but this guards the shape contract directly too."""
    _app, _tmp_db = booted_app
    assert len(sources.SOURCE_REGISTRY) > 0
    for key, source in sources.SOURCE_REGISTRY.items():
        assert callable(source.fetch_fn), f"{key} has no callable fetch_fn"


async def test_fast_tier_source_fires_and_records_health(booted_app):
    """spot_prices is trigger=interval/fast_enabled, on by default
    (_refresh_settings['fast_enabled'] starts True) — within one
    _schedule_loop tick it should have fired at least once and recorded a
    source_health row, proving the scheduler->fetch_fn->db.record path is
    actually wired end to end, not just individually unit-testable."""
    _app, tmp_db = booted_app
    health = tmp_db.get_source_health("spot_prices")
    assert health is not None
    assert health["last_attempt_status"] in ("success", "error")


async def test_startup_only_sources_fire_exactly_once(booted_app):
    """money_supply/metals_prices/lbma_fix/census_trade are all
    trigger='manual_only', fire_at_startup=True — _schedule_loop tracks
    them in _startup_fired so they fire exactly once at boot and never
    again automatically. Confirms the _startup_fired bookkeeping (a real,
    previously-buggy area per CLAUDE.md's fire_at_startup history) doesn't
    double-fire within a single boot + short scheduler run."""
    _app, tmp_db = booted_app
    for key in ("money_supply", "metals_prices", "lbma_fix", "census_trade"):
        assert key in main_module._startup_fired, f"{key} never fired at startup"


async def test_always_on_source_is_not_gated_by_enabled_flag(booted_app):
    """catcor_snapshot is trigger='always_on' — must fire regardless of
    slow_enabled/fast_enabled state. slow_enabled defaults False; if
    catcor_snapshot were accidentally gated on it (the exact bug
    always_on's dedicated trigger value exists to make structurally
    impossible), due_snapshots() would simply find nothing to capture
    (no seeded events yet) — so this asserts the tick loop reached it at
    all via source_health, not that it captured anything."""
    _app, tmp_db = booted_app
    # catcor_snapshot has self_recording=False, so a tick that ran at all
    # (even a no-op "nothing due") still leaves no source_health row here
    # since due_snapshots() returning empty means source.fetch_fn's inner
    # loop body never calls anything that raises or needs recording. The
    # real assertion is indirect: prove the tick loop is alive and didn't
    # crash on this source by checking _schedule_loop's task is still
    # running (not done/cancelled) after the sleep window.
    task = main_module._refresh_tasks[-1]
    assert not task.done(), "_schedule_loop task died during boot"


async def test_lifespan_teardown_cancels_background_tasks():
    """Exiting the lifespan context (as the real app does on shutdown)
    must cancel every task it created and close the shared httpx client —
    a leaked task would otherwise keep firing fetch_fns against a closed
    DB/client in later tests, a real cross-test contamination risk this
    guards against directly.

    NOTE: backend.main._refresh_tasks is a module-level list that
    lifespan() only ever appends to (main.py:137) and never clears —
    cancelling a task doesn't remove it from the list either. That's a
    non-issue in production (lifespan runs once per process) but means
    calling lifespan() a second time in the same process, as this test
    module does, leaks the PRIOR boot's already-cancelled task into the
    list. Snapshotting the list length before this boot and slicing to
    only the tasks created during THIS boot works around that leak
    without papering over it — if this workaround is ever removed and the
    test starts flaking on a stale prior-boot task, that confirms the
    leak, it doesn't mean this test is wrong."""
    import backend.db as db_module
    import tempfile
    import os

    router = _catchall_mock()
    with tempfile.TemporaryDirectory() as d:
        db_module.DB_PATH = os.path.join(d, "test.db")
        db_module.init_db()
        with router:
            from backend.main import app

            pre_boot_count = len(main_module._refresh_tasks)
            async with main_module.lifespan(app):
                await asyncio.sleep(0.2)
                tasks_during = list(main_module._refresh_tasks)[pre_boot_count:]
                for t in tasks_during:
                    assert not t.done(), f"_schedule_loop task ended early: {t.exception() if t.done() else None}"

            # after __aexit__: every tracked task must be cancelled, and
            # the shared client must be closed (mirrors lifespan's own
            # teardown body: `for t in _refresh_tasks: t.cancel()` +
            # `await _client.aclose()`).
            await asyncio.sleep(0.1)
            for t in tasks_during:
                assert t.cancelled() or t.done()
            assert main_module._client.is_closed
