"""
CATCOR Iteration 2 — Research Pane. A place to work a single claim by hand:
paste it, see AV's own trusted numbers next to it, log a read, then decide —
promote to a tracked catalyst or dismiss as noise (Deliverable 3, not yet
built). This module now covers session/message CRUD (Deliverable 1) and a
2-call Claude pipeline (Deliverable 2):

  Call 1 (parser_v1) — decomposes the claim into testable sub-assertions,
  matches each to an AV tool/statistic, and runs the existing tool-use loop
  to actually fetch that data. Its own prose output is never the visible
  chat turn.

  Call 2 (analyst_v1) — takes Call 1's decomposition + the real tool data
  already gathered and contextualizes it (connects sub-assertions, notes
  agreement/tension in the evidence, explains what a reading means relative
  to its own historical range). Has no tools of its own — it only works
  from what Call 1 already fetched. Its output is what gets persisted as
  the assistant turn and shown in the chat thread. Same hard invariant as
  the parser: no verdict on the claim, no bullish/bearish framing — Call 2
  is allowed more synthesis before that stop, not a different stop.

Same convention as catcor.py: plain functions here, route decorators live in
main.py. `from . import db` for persistence. No Anthropic SDK — raw httpx
POSTs to the Messages API, per SPEC.MD 4.1 and consistent with every other
outbound integration in this codebase (metalcharts.org/ForexFactory/ALFRED/
Yahoo all go through the one shared httpx.AsyncClient, no SDK for any of
them).

Model backend layering (three layers, strict separation of duties):

  call_anthropic(system_prompt, messages, model) / call_forge(same
  signature) — one per vendor, identical signature and identical return
  shape ({"final_text": str}), each knowing only its own wire protocol.
  Neither has any concept of tools — pure text-in/text-out. Swapping which
  one answers a given call is purely a configuration choice, never a
  functional one.

  call_ai(backend, system_prompt, messages, model) — thin dispatcher, picks
  which vendor function to invoke by name. Also has no concept of tools.

  The tool-use loop (_run_parser) — the one place that knows about tools.
  It calls call_ai like any other primitive and inspects the plain text it
  gets back for a TOOL_REQUEST: <name> line (see prompts/parser_v1.py) —
  not a vendor-specific protocol (Anthropic's structured tools/tool_use
  blocks), specifically so the same loop works unchanged regardless of
  which backend answered.
"""

import json
import os
import re
import uuid
from datetime import datetime, timezone

import httpx

from . import db
from .prompts.analyst_v1 import PROMPT as ANALYST_PROMPT
from .prompts.parser_v1 import PROMPT as PARSER_PROMPT
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
FORGE_MODEL = "llama3.1:8b"

# Which backend call_ai uses when a caller doesn't specify one. "anthropic"
# for now — Forge is newly wired and not yet the default for real pipeline
# traffic.
DEFAULT_BACKEND = "anthropic"

MAX_TOKENS = 2000
# Hard cap on tool-request round-trips within a single turn — a new failure
# mode for this codebase (every existing loop in catcor.py is a fixed
# backfill or an asyncio.sleep poll, never "loop until the model stops
# asking").
MAX_TOOL_ROUNDS = 5

_TOOL_REQUEST_RE = re.compile(r"^TOOL_REQUEST:\s*(\w+)\s*$", re.MULTILINE)

_KNOWN_TOOL_NAMES = (
    "get_cot_positioning",
    "get_comex_inventory",
    "get_money_supply",
    "get_market_balance",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_session(claim_text: str, source_url: str | None = None) -> str:
    session_id = str(uuid.uuid4())
    db.create_research_session(session_id, claim_text, source_url, _now_iso())
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


def _execute_tool(name: str, tool_input: dict) -> dict:
    impl = _TOOL_IMPLS.get(name)
    if impl is None:
        return {"error": f"unknown tool: {name}"}
    try:
        return impl()
    except Exception as e:
        return {"error": f"tool execution failed: {e}"}


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


def _extract_tool_requests(text: str) -> list[str]:
    """Pulls every TOOL_REQUEST: <name> line out of the parser's plain-text
    reply, filtered to known tool names (an unrecognized name is dropped
    silently rather than passed to _execute_tool, which would just bounce
    it back as an "unknown tool" error — cheaper to filter here)."""
    return [name for name in _TOOL_REQUEST_RE.findall(text) if name in _KNOWN_TOOL_NAMES]


async def _run_parser(
    client: httpx.AsyncClient, messages: list[dict], backend: str = DEFAULT_BACKEND
) -> dict:
    """Call 1 of the pipeline: runs the bounded tool-request loop against
    the parser persona (decompose claim -> match statistic -> fetch it via
    AV's tools) through call_ai. Tool access is a plain-text contract (see
    prompts/parser_v1.py's TOOL_REQUEST: <name> format) rather than a
    vendor-specific tool-use protocol, so this loop works unchanged
    regardless of which backend answers. Returns
    {"final_text": ..., "tool_calls": [...]} — this is NOT persisted or
    shown directly; it's Call 2's (the analyst's) input. Raises
    RuntimeError if the loop exceeds MAX_TOOL_ROUNDS without resolving."""
    tool_calls_log = []

    for _round in range(MAX_TOOL_ROUNDS):
        data = await call_ai(client, PARSER_PROMPT, messages, backend=backend)
        final_text = data["final_text"]
        requested = _extract_tool_requests(final_text)

        if not requested:
            return {"final_text": final_text, "tool_calls": tool_calls_log}

        # Model asked for one or more tools: execute each, append its own
        # reply (so it can see what it asked for) and a plain-text user
        # message carrying the results, then loop again.
        messages.append({"role": "assistant", "content": final_text})
        result_lines = []
        for name in requested:
            result = _execute_tool(name, {})
            tool_calls_log.append({"tool": name, "input": {}, "result": result})
            result_lines.append(f"{name}: {json.dumps(result)}")
        messages.append({
            "role": "user",
            "content": "Tool results:\n" + "\n".join(result_lines),
        })

    raise RuntimeError(
        f"Parser tool-request loop exceeded {MAX_TOOL_ROUNDS} rounds without resolving to a final answer"
    )


def _build_analyst_input(user_content: str, parser_result: dict) -> list[dict]:
    """Call 2 gets a single synthetic user message: the original claim, the
    parser's decomposition, and the raw tool data it already gathered. Call
    2 has no tools of its own — it only ever sees what Call 1 fetched."""
    tool_data = json.dumps(
        [{"tool": t["tool"], "result": t["result"]} for t in parser_result["tool_calls"]],
        indent=2,
    )
    content = (
        f"A user made this claim: {user_content}\n\n"
        f"Here is the parsed breakdown and matched statistics:\n{parser_result['final_text']}\n\n"
        f"Raw data gathered for that breakdown:\n{tool_data}"
    )
    return [{"role": "user", "content": content}]


async def send_message(client: httpx.AsyncClient, session_id: str, user_content: str) -> dict:
    """Persists the user turn immediately (never lost even if what follows
    fails), then runs the 2-call pipeline: Call 1 (parser, with tools)
    decomposes the claim and fetches AV's real data; Call 2 (analyst, no
    tools) takes that output and contextualizes it. Only Call 2's output is
    persisted as the visible assistant turn — the parser's own decomposition
    is kept alongside it in the same row (parser_output) for inspection, but
    is never itself a chat turn or resent as history.

    The assistant turn is persisted only if both calls fully resolve — a
    network error, non-2xx response, or loop-cap breach at either stage
    raises and leaves no assistant row, so no half-written replies ever land
    in research_messages."""
    now = _now_iso()
    db.append_research_message(session_id, "user", user_content, now)

    history = db.list_research_messages(session_id)
    messages = _history_to_messages(history)

    parser_result = await _run_parser(client, messages)

    analyst_messages = _build_analyst_input(user_content, parser_result)
    analyst_data = await call_ai(client, ANALYST_PROMPT, analyst_messages)
    final_text = analyst_data["final_text"]

    assistant_content = json.dumps({
        "final_text": final_text,
        "tool_calls": parser_result["tool_calls"],
        "parser_output": parser_result["final_text"],
    })
    reply_now = _now_iso()
    db.append_research_message(session_id, "assistant", assistant_content, reply_now)
    return {
        "final_text": final_text,
        "tool_calls": parser_result["tool_calls"],
        "parser_output": parser_result["final_text"],
    }
