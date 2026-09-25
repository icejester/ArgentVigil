import time
import httpx

_token: str | None = None
_expires_at: int = 0

HEADERS_BASE = {
    "Referer": "https://metalcharts.org/comex/silver",
    "x-requested-with": "XMLHttpRequest",
}


async def get_token(client: httpx.AsyncClient) -> str:
    global _token, _expires_at
    now_ms = int(time.time() * 1000)
    if _token and now_ms < _expires_at - 5000:
        return _token
    resp = await client.get(
        "https://metalcharts.org/api/security/token",
        headers=HEADERS_BASE,
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    _token = data["token"]
    _expires_at = data["expiresAt"]
    return _token


def invalidate_token() -> None:
    """Drop the cached token so the next authed_headers() fetches a fresh
    one. metalcharts.org occasionally rejects a token (401) well inside its
    stated ~5-minute expiresAt — confirmed 2026-09-24 in the collector logs
    (every metalcharts source in one cycle 401'd together, isolated spot
    401s otherwise) while a freshly-fetched token worked immediately. Without
    this, the rejected token kept being reused until expiresAt passed."""
    global _token, _expires_at
    _token = None
    _expires_at = 0


async def authed_headers(client: httpx.AsyncClient) -> dict:
    token = await get_token(client)
    return {**HEADERS_BASE, "x-mc-token": token}
