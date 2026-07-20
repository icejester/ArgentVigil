"""Shared fixtures for the ArgentVigil test suite.

Ground rules (see CLAUDE.md's test-suite section):
- Never touches runtime/argentvigil.db — every test gets a fresh, real
  SQLite file in tmp_path via the tmp_db fixture.
- Never calls a live upstream — outbound httpx is mocked with respx in
  test_upstream_contracts.py; everything else reads only the tmp DB.
- Never runs main.py's lifespan (no startup fetch chain, no scheduler
  loops) — the `client` fixture builds a TestClient without entering its
  context manager, which is what skips lifespan.
"""

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend import db as db_module  # noqa: E402


@pytest.fixture()
def tmp_db(tmp_path, monkeypatch):
    """Fresh schema in a throwaway SQLite file. db.get_conn() reads
    db.DB_PATH at call time (not import time), so monkeypatching the module
    attribute redirects every backend/pipeline write for this test only."""
    monkeypatch.setattr(db_module, "DB_PATH", str(tmp_path / "argentvigil_test.db"))
    db_module.init_db()
    return db_module


@pytest.fixture()
async def client(tmp_db):
    """The real app driven through httpx.ASGITransport — the same httpx the
    app itself uses, rather than starlette's deprecated TestClient shim
    (which warns on import). Lifespan deliberately never runs: no upstream
    fetches fire, no scheduler loops start, and routes see the tmp DB via
    the tmp_db fixture's monkeypatch."""
    import httpx

    from backend.main import app

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


@pytest.fixture()
async def upstream_client(monkeypatch):
    """Hands backend.main a real AsyncClient (lifespan normally creates
    _client; tests skip lifespan) so respx can intercept its requests."""
    import httpx

    from backend import main as main_module

    client = httpx.AsyncClient()
    monkeypatch.setattr(main_module, "_client", client)
    yield client
    await client.aclose()
