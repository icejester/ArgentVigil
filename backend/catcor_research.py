"""
CATCOR Iteration 2 — Research Pane. A place to work a single claim by hand:
paste it, see AV's own trusted numbers next to it, log a read, then decide —
promote to a tracked catalyst or dismiss as noise (Deliverable 3, not yet
built). This module covers session/message CRUD (Deliverable 1) and a
single-call chat pipeline (Deliverable 2, temporarily simplified):

  send_message makes exactly one call per turn — no tools, no parser/
  analyst split — against the word-count persona (prompts/word_count_v1.py),
  a deliberately trivial stand-in used to validate chat plumbing (session/
  message persistence, backend routing, frontend rendering) independent of
  any real evidence-gathering or synthesis. The earlier 2-call parser+
  analyst pipeline (decompose claim -> fetch AV data via tools ->
  contextualize) is not currently wired into send_message; the tool
  functions themselves (_tool_get_*, dump_all_evidence) remain, still used
  by GET /evidence/db.

Same convention as catcor.py: plain functions here, route decorators live in
main.py. `from . import db` for persistence. No Anthropic SDK — raw httpx
POSTs to the Messages API, per SPEC.MD 4.1 and consistent with every other
outbound integration in this codebase (metalcharts.org/ForexFactory/ALFRED/
Yahoo all go through the one shared httpx.AsyncClient, no SDK for any of
them).

Model backend layering:

  call_anthropic(system_prompt, messages, model) / call_forge(same
  signature) — one per vendor, identical signature and identical return
  shape ({"final_text": str}), each knowing only its own wire protocol.
  Neither has any concept of tools — pure text-in/text-out. Swapping which
  one answers a given call is purely a configuration choice, never a
  functional one.

  call_ai(backend, system_prompt, messages, model) — thin dispatcher, picks
  which vendor function to invoke by name. Also has no concept of tools.
"""

import json
import os
import uuid
from datetime import datetime, timezone

import httpx

from . import db
from .prompts.word_count_v1 import PROMPT as WORD_COUNT_PROMPT
from pipeline.compute import compute_from_series
from pipeline.config import FRED_SERIES_CPI, FRED_SERIES_M2, FRED_SERIES_WALCL

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARKET_BALANCE_PATH = os.path.join(_REPO_ROOT, "seed_data", "silver_market_balance.json")

ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_API_VERSION = "2023-06-01"
# Haiku, not Sonnet — a deliberate choice for this iteration given the loop
# is exercised interactively and repeatedly during testing (cost, not a
# SPEC.MD requirement — the spec names Sonnet as "current generation" but
# leaves the exact string to confirm at build time). Revisit if Haiku's
# quality proves insufficient for evidence-surfacing quality. Confirm this
# exact model string against docs.claude.com if it ever needs correcting.
ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"

# Local Ollama-backed service (amp-forge), reached over the LAN — see
# forge-spec.md (in the amp-dev repo) for the stateless/system-prompt
# contract this relies on. Configurable via env var so a different host/
# port doesn't require a code change.
FORGE_URL = os.environ.get("FORGE_URL", "http://amp-forge:8001/chat/stream")
FORGE_MODEL = "qwen3:8b"

# Which backend call_ai uses when a caller doesn't specify one. Configurable
# via env var, same convention as FORGE_URL above — "anthropic" if unset.
DEFAULT_BACKEND = os.environ.get("AI_BACKEND", "forge")

MAX_TOKENS = 2000


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_session(claim_text: str, source_url: str | None = None) -> str:
    """Persists the session row only — does NOT seed research_messages with
    claim_text. The caller (main.py's create-session route) is expected to
    follow this with a send_message(session_id, claim_text) call to actually
    get the claim into conversation history and produce a first reply; doing
    the seeding here as well as there would duplicate the first turn."""
    session_id = str(uuid.uuid4())
    now = _now_iso()
    db.create_research_session(session_id, claim_text, source_url, now)
    return session_id


def list_sessions() -> list[dict]:
    return db.list_research_sessions()


def get_session_detail(session_id: str) -> dict | None:
    session = db.get_research_session(session_id)
    if session is None:
        return None
    return {
        "session": session,
        "messages": db.list_research_messages(session_id),
    }


# --- Evidence tools ---------------------------------------------------

def _tool_get_cot_positioning() -> dict:
    result = {}
    for metal, series_fn in (("silver", db.get_silver_series), ("gold", db.get_gold_series)):
        series = series_fn()
        if not series:
            result[metal] = {"error": "no CoT data persisted yet"}
            continue
        computed = compute_from_series(series)
        result[metal] = {"latest": computed["latest"], "windows": computed["windows"]}
    return result


def _tool_get_comex_inventory() -> dict:
    result = {}
    for metal, agg_fn, depo_fn in (
        ("silver", db.get_aggregate_history, db.get_latest_depositories),
        ("gold", db.get_gold_aggregate_history, db.get_latest_gold_depositories),
    ):
        latest_agg = agg_fn(limit=1)
        result[metal] = {
            "latest_aggregate": latest_agg[-1] if latest_agg else None,
            "depositories": depo_fn(),
        }
    return result


def _yoy_pct(rows: list[dict], months_back: int) -> float | None:
    if len(rows) <= months_back:
        return None
    cur, prior = rows[-1]["value"], rows[-1 - months_back]["value"]
    if cur is None or prior in (None, 0):
        return None
    return round((cur / prior - 1) * 100, 2)


def _tool_get_money_supply() -> dict:
    result = {}
    for label, series_id, months_back in (
        ("m2", FRED_SERIES_M2, 12),
        ("walcl", FRED_SERIES_WALCL, 12),
        ("cpi", FRED_SERIES_CPI, 12),
    ):
        rows = db.get_fred_observations(series_id, since="1900-01-01")
        if not rows:
            result[label] = {"error": "no data persisted yet"}
            continue
        result[label] = {
            "latest_date": rows[-1]["date"],
            "latest_value": rows[-1]["value"],
            "yoy_pct": _yoy_pct(rows, months_back),
        }
    return result


def _tool_get_market_balance() -> dict:
    try:
        with open(MARKET_BALANCE_PATH) as f:
            rows = json.load(f)
    except FileNotFoundError:
        return {"error": "silver_market_balance.json not found"}
    rows = sorted(rows, key=lambda r: r["year"])
    latest = rows[-1] if rows else None
    recent5 = [r["net_balance_moz"] for r in rows[-5:] if r.get("net_balance_moz") is not None]
    return {
        "latest_year": latest["year"] if latest else None,
        "latest_net_balance_moz": latest.get("net_balance_moz") if latest else None,
        "cumulative_5y_net_balance_moz": round(sum(recent5), 1) if recent5 else None,
    }


_TOOL_IMPLS = {
    "get_cot_positioning": _tool_get_cot_positioning,
    "get_comex_inventory": _tool_get_comex_inventory,
    "get_money_supply": _tool_get_money_supply,
    "get_market_balance": _tool_get_market_balance,
}


def dump_all_evidence() -> dict:
    """All four tools' exact output, keyed by tool name — no Anthropic call
    involved. Every tool is zero-argument, so its result is fully
    deterministic from AV's own current state; this just runs all four
    directly, letting you see exactly what data Claude has access to before
    any conversation happens, at zero cost."""
    return {name: impl() for name, impl in _TOOL_IMPLS.items()}



# --- Claude tool-use chat loop ------------------------------------------

def _history_to_messages(history: list[dict]) -> list[dict]:
    """Past turns are resent as plain text only — an assistant turn's stored
    JSON ({"final_text": ..., "tool_calls": [...]}) is collapsed to just its
    final_text. Claude retains its own prior conclusions on resend, not a
    literal replay of which tool produced which number (see the plan's
    Decision 1 for why this tradeoff was made deliberately)."""
    messages = []
    for row in history:
        if row["role"] == "user":
            messages.append({"role": "user", "content": row["content"]})
        else:
            parsed = json.loads(row["content"])
            messages.append({"role": "assistant", "content": parsed["final_text"]})
    return messages


async def call_anthropic(
    client: httpx.AsyncClient,
    system_prompt: str,
    messages: list[dict],
    model: str = ANTHROPIC_MODEL,
    mock_key: str | None = None,
) -> dict:
    """One POST to Anthropic's Messages API, raw httpx (no SDK). Pure
    text-in/text-out: no concept of tools at this layer (see module
    docstring's "Model backend layering" for why) — returns only
    {"final_text": str}, identical shape to call_forge.

    mock_key exists only so call_anthropic and call_forge keep an identical
    signature regardless of which one a caller is configured to use (see
    call_forge's docstring) — Anthropic has no mock mode, and a non-None
    value here almost certainly means a caller misconfigured backend/
    mock_key together (e.g. a test harness bug). Raising instead of silently
    ignoring it is deliberate: this is a real API with real cost per call,
    and a mock-mode test suite that accidentally routes to this function
    should fail loudly on the first call, not burn a budget quietly."""
    if mock_key is not None:
        raise ValueError(
            f"call_anthropic received mock_key={mock_key!r} — Anthropic has no mock mode; "
            "this almost always means backend was misconfigured to \"anthropic\" while a "
            "mock_key was also set. Refusing to send real (billed) traffic in this state."
        )
    api_key = os.environ["ANTHROPIC_API_KEY"]
    resp = await client.post(
        ANTHROPIC_MESSAGES_URL,
        headers={
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_API_VERSION,
            "content-type": "application/json",
        },
        json={
            "model": model,
            "max_tokens": MAX_TOKENS,
            "system": system_prompt,
            "messages": messages,
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    final_text = "".join(
        b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
    )
    return {"final_text": final_text}


async def call_forge(
    client: httpx.AsyncClient,
    system_prompt: str,
    messages: list[dict],
    model: str = FORGE_MODEL,
    mock_key: str | None = None,
) -> dict:
    """One POST to amp-forge's /chat/stream (a local Ollama-backed service
    reached over the LAN — see forge-spec.md in the amp-dev repo for the
    stateless/system-prompt contract this relies on). Accumulates the SSE
    `token` events into one string. Pure text-in/text-out, identical
    signature and return shape to call_anthropic — no concept of tools at
    this layer.

    mock_key, if given, asks Forge to skip Ollama entirely and stream back
    a fixed fixture file instead (see forge-spec.md Section 5) — for
    testing AV's own data flow (tool-request parsing, persistence) against
    a known-fixed response, independent of a live model's actual reasoning
    quality. call_anthropic accepts this same parameter and ignores it, so
    both backends keep an identical signature regardless of which one a
    caller is configured to use."""
    if not messages:
        raise ValueError("call_forge requires at least one message")
    *history, last = messages
    if last["role"] != "user":
        raise ValueError("call_forge expects the last message to be from the user")

    payload = {
        "message": last["content"],
        "system": system_prompt,
        "history": history,
        "persist": False,
        "model": model,
    }
    if mock_key is not None:
        payload["mock_key"] = mock_key

    tokens: list[str] = []
    async with client.stream("POST", FORGE_URL, json=payload, timeout=120) as resp:
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            if not line.startswith("data: "):
                continue
            event = json.loads(line[len("data: "):])
            if event.get("type") == "token":
                tokens.append(event.get("content", ""))
            elif event.get("type") == "error":
                raise RuntimeError(f"forge error: {event.get('message')}")

    return {"final_text": "".join(tokens)}


_BACKENDS = {"anthropic": call_anthropic, "forge": call_forge}


async def call_ai(
    client: httpx.AsyncClient,
    system_prompt: str,
    messages: list[dict],
    backend: str = DEFAULT_BACKEND,
    model: str | None = None,
    mock_key: str | None = None,
) -> dict:
    """Thin dispatcher — picks which vendor function answers this call.
    Same text-in/text-out contract as either vendor function; has no
    concept of tools itself, purely a routing decision. `model`, if given,
    is passed through to whichever backend is chosen (otherwise each
    backend's own default is used). `mock_key`, if given, is passed through
    too — meaningful only for the forge backend (see call_forge's
    docstring), harmlessly ignored by call_anthropic."""
    fn = _BACKENDS.get(backend)
    if fn is None:
        raise ValueError(f"unknown backend: {backend}")
    kwargs = {}
    if model is not None:
        kwargs["model"] = model
    if mock_key is not None:
        kwargs["mock_key"] = mock_key
    return await fn(client, system_prompt, messages, **kwargs)


async def send_message(
    client: httpx.AsyncClient, session_id: str, user_content: str, backend: str = DEFAULT_BACKEND
) -> dict:
    """Persists the user turn immediately (never lost even if what follows
    fails), then makes exactly one call — no tools, no parser/analyst split
    — against the word-count persona (prompts/word_count_v1.py). This is a
    deliberately trivial single-call path used to validate chat plumbing
    (session/message persistence, backend routing, frontend rendering)
    independent of any real evidence-gathering; it replaces the earlier
    2-call parser+analyst pipeline for now.

    The assistant turn is persisted only if the call fully resolves — a
    network error or non-2xx response raises and leaves no assistant row,
    so no half-written replies ever land in research_messages."""
    now = _now_iso()
    db.append_research_message(session_id, "user", user_content, now)

    history = db.list_research_messages(session_id)
    messages = _history_to_messages(history)

    data = await call_ai(client, WORD_COUNT_PROMPT, messages, backend=backend)
    final_text = data["final_text"]

    assistant_content = json.dumps({"final_text": final_text})
    reply_now = _now_iso()
    db.append_research_message(session_id, "assistant", assistant_content, reply_now)
    return {"final_text": final_text}
