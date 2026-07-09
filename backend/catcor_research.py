"""
CATCOR Research Pane, per catcor-events-spec.md ("Stage 1" — supersedes the
original Iteration 2 doc's *architecture*, though the feature/table names
mostly carried forward). A workbench for working a single claim/observation
by hand, one turn at a time, with five independently-adjustable controls
per turn (model, persona, context blocks, memory mode, prompt transparency
— spec section 3), ending in a disposition: promote to a tracked Catalyst
Event, dismiss as noise, or discard outright (spec section 5).

Nothing is auto-fetched by a model deciding it's relevant — the old 2-call
parser+analyst pipeline (TOOL_REQUEST-driven, model-initiated tool use) is
discarded per spec section 3.3 ("Nothing is auto-fetched by the model
deciding it's relevant... you choose what's present before the turn goes
out"). assemble_prompt (below) replaces it: a one-time-per-turn step that
reads whichever context checkboxes are checked and folds each into a
labeled plain-text block, before the model ever sees the turn. analyst_v1
and parser_v1 remain in backend/prompts/ as ordinary selectable personas —
their prompt text just no longer drives any tool-use loop.

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

import importlib
import json
import os
import pkgutil
import uuid
from datetime import datetime, timezone

import httpx

from . import db
from . import prompts as _prompts_pkg
from pipeline.compute import compute_from_series
from pipeline.config import FRED_SERIES_CPI, FRED_SERIES_M2, FRED_SERIES_WALCL

DEFAULT_PERSONA = "word_count_v1"

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


# --- Persona loading -----------------------------------------------------

def list_personas() -> list[str]:
    """Dynamically enumerates backend/prompts/*.py, excluding packages
    (__pycache__) and any name starting with "_" (covers __init__ and any
    future private helper module) — sorted stems. No registration step: a
    new persona file just appears here on the next call, per
    catcor-events-spec.md section 3.2."""
    names = []
    for _, name, is_pkg in pkgutil.iter_modules(_prompts_pkg.__path__):
        if is_pkg or name.startswith("_"):
            continue
        names.append(name)
    return sorted(names)


def load_persona_prompt(persona: str) -> str:
    """Imports backend.prompts.<persona> and returns its PROMPT constant.
    Only ever imports a name that came from list_personas()'s own directory
    scan — never an arbitrary caller-supplied string — since this ends up
    driving a real Python import."""
    if persona not in list_personas():
        raise ValueError(f"unknown persona: {persona!r}")
    mod = importlib.import_module(f".prompts.{persona}", package="backend")
    prompt = getattr(mod, "PROMPT", None)
    if prompt is None:
        raise ValueError(f"persona module {persona!r} has no PROMPT constant")
    return prompt


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


# --- Context-block assembly ----------------------------------------------
# catcor-events-spec.md section 3.3: six context blocks, human-checked
# before a turn is sent — never auto-fetched by the model. Four map onto
# the existing evidence tools above via a dict->plain-text formatting step
# (which did not exist anywhere in this codebase before this change); the
# other two ("prior_turns", "freeform") have no zero-arg tool behind them
# and are handled directly in assemble_prompt.

def _fmt_cot_positioning(data: dict) -> str:
    lines = ["=== CoT Positioning (AV data) ==="]
    for metal in ("silver", "gold"):
        m = data.get(metal, {})
        if "error" in m:
            lines.append(f"{metal}: {m['error']}")
            continue
        latest = m["latest"]
        lines.append(
            f"{metal}: net long {latest['net_long_pct_oi']:.1f}% of OI as of {latest['date']}"
        )
        for window in ("2yr", "5yr"):
            win = m["windows"][window]
            lines.append(f"  {window} percentile: {win['percentile']:.0f} — {win['classification']}")
    return "\n".join(lines)


def _fmt_comex_inventory(data: dict) -> str:
    lines = ["=== COMEX/SHFE Inventory (AV data) ==="]
    for metal in ("silver", "gold"):
        m = data.get(metal, {})
        agg = m.get("latest_aggregate")
        if agg:
            lines.append(
                f"{metal}: total {agg['total']:,.0f} oz, registered {agg['registered']:,.0f} oz, "
                f"eligible {agg['eligible']:,.0f} oz, reg/total ratio {agg['reg_eligible_ratio']:.3f} "
                f"as of {agg['date']}"
            )
        else:
            lines.append(f"{metal}: no aggregate data persisted yet")
    return "\n".join(lines)


def _fmt_money_supply(data: dict) -> str:
    lines = ["=== Money Supply / Purchasing Power (AV data, FRED) ==="]
    labels = {"m2": "M2 Money Stock", "walcl": "Fed Balance Sheet (WALCL)", "cpi": "CPI"}
    for key, label in labels.items():
        d = data.get(key, {})
        if "error" in d:
            lines.append(f"{label}: {d['error']}")
            continue
        yoy = d["yoy_pct"]
        yoy_str = f"{yoy:+.2f}% YoY" if yoy is not None else "YoY not available"
        lines.append(f"{label}: {d['latest_value']:,.1f} as of {d['latest_date']} ({yoy_str})")
    return "\n".join(lines)


def _fmt_market_balance(data: dict) -> str:
    if data.get("latest_year") is None:
        return "=== Market Balance (Silver Institute) ===\nno data available"
    return (
        "=== Market Balance (Silver Institute, annual) ===\n"
        f"latest year {data['latest_year']}: net balance {data['latest_net_balance_moz']:+.1f} Moz\n"
        f"cumulative 5yr net balance: {data['cumulative_5y_net_balance_moz']:+.1f} Moz"
    )


_CONTEXT_FORMATTERS = {
    "cot_positioning": (_tool_get_cot_positioning, _fmt_cot_positioning),
    "comex_inventory": (_tool_get_comex_inventory, _fmt_comex_inventory),
    "money_supply": (_tool_get_money_supply, _fmt_money_supply),
    "market_balance": (_tool_get_market_balance, _fmt_market_balance),
}


def assemble_prompt(
    persona_prompt: str,
    context_blocks: list[str],
    memory_mode: str,
    history: list[dict],
    freeform_text: str | None,
    user_content: str,
) -> tuple[str, list[dict]]:
    """Builds (system_prompt, messages) for one turn. context_blocks is
    exactly the human-checked list — nothing more is folded in. Prior-turn
    history is included in `messages` only if memory_mode == "accumulating"
    AND "prior_turns" is checked (Stateless always wins regardless of the
    checkbox, per spec 3.4; an unchecked box means that data is absent full
    stop, per spec 3.3) — this two-key AND is the one subtle bit here."""
    blocks = [persona_prompt]
    for name in context_blocks:
        if name in _CONTEXT_FORMATTERS:
            tool_fn, fmt_fn = _CONTEXT_FORMATTERS[name]
            blocks.append(fmt_fn(tool_fn()))
        elif name == "freeform" and freeform_text:
            blocks.append(f"=== Freeform context (user-supplied) ===\n{freeform_text}")
        # "prior_turns" doesn't append a static block — it controls the
        # *messages* list below, not system-prompt text.
    system_prompt = "\n\n".join(blocks)

    include_history = memory_mode == "accumulating" and "prior_turns" in context_blocks
    messages = _history_to_messages(history) if include_history else []
    messages.append({"role": "user", "content": user_content})
    return system_prompt, messages


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


def _require_active(session: dict | None, session_id: str) -> dict:
    if session is None:
        raise ValueError(f"no research session with id {session_id}")
    if session["status"] != "active":
        raise ValueError(
            f"session {session_id} is {session['status']!r}, not active — "
            "promoted/dismissed sessions are read-only"
        )
    return session


async def send_message(
    client: httpx.AsyncClient,
    session_id: str,
    user_content: str,
    backend: str = DEFAULT_BACKEND,
    model: str | None = None,
    persona: str = DEFAULT_PERSONA,
    context_blocks: list[str] | None = None,
    memory_mode: str | None = None,
    freeform_text: str | None = None,
    system_prompt_override: str | None = None,
    messages_override: list[dict] | None = None,
) -> dict:
    """Persists the user turn immediately (never lost even if what follows
    fails), assembles this turn's prompt from the selected persona/context/
    memory (or the caller's already-edited override, per spec 3.5's
    per-section prompt-edit toggle), makes exactly one model call, and
    persists the assistant turn only if that call fully resolves — a
    network error or non-2xx response raises and leaves no assistant row,
    so no half-written replies ever land in research_messages.

    Raises ValueError if the session doesn't exist or isn't active
    (promoted/dismissed sessions are read-only, per spec section 2) —
    callers should surface this as an HTTP 409, not a 500."""
    context_blocks = context_blocks or []
    session = _require_active(db.get_research_session(session_id), session_id)

    effective_memory_mode = memory_mode if memory_mode is not None else session["memory_mode"]
    memory_changed = 1 if effective_memory_mode != session["memory_mode"] else 0
    if memory_changed:
        db.set_research_memory_mode(session_id, effective_memory_mode, _now_iso())

    if system_prompt_override is not None and messages_override is not None:
        system_prompt, messages = system_prompt_override, messages_override
    else:
        persona_prompt = load_persona_prompt(persona)
        history = db.list_research_messages(session_id)
        system_prompt, messages = assemble_prompt(
            persona_prompt, context_blocks, effective_memory_mode, history, freeform_text, user_content
        )
        if system_prompt_override is not None:
            system_prompt = system_prompt_override
        if messages_override is not None:
            messages = messages_override

    now = _now_iso()
    db.append_research_message(
        session_id,
        "user",
        user_content,
        now,
        context_blocks=json.dumps(context_blocks),
        memory_mode=effective_memory_mode,
        memory_changed=memory_changed,
        assembled_prompt=json.dumps({"system": system_prompt, "messages": messages}),
    )

    data = await call_ai(client, system_prompt, messages, backend=backend, model=model)
    final_text = data["final_text"]
    resolved_model = model or (ANTHROPIC_MODEL if backend == "anthropic" else FORGE_MODEL)

    assistant_content = json.dumps({"final_text": final_text})
    reply_now = _now_iso()
    db.append_research_message(
        session_id,
        "assistant",
        assistant_content,
        reply_now,
        backend=backend,
        model=resolved_model,
        persona=persona,
    )
    return {
        "final_text": final_text,
        "backend": backend,
        "model": resolved_model,
        "persona": persona,
        "context_blocks": context_blocks,
        "memory_mode": effective_memory_mode,
        "memory_changed": memory_changed,
    }


# --- Read -> disposition (spec section 5) --------------------------------

def set_read(session_id: str, user_read: str) -> None:
    session = _require_active(db.get_research_session(session_id), session_id)
    db.set_research_read(session_id, user_read, _now_iso())


def promote_session(session_id: str, event_name: str, scheduled_time: str, direction: str) -> str:
    """Requires the session to be active and to already have a read set
    (spec 5.2: "Requires a read to already be set"). Writes a new
    Observed-origin event_calendar row with source_tier="discovered" (the
    literal already referenced by db.py's own schema comment for this
    exact purpose) and research_session_id backlinking to this session,
    then flips the session to 'promoted' (terminal, read-only)."""
    session = _require_active(db.get_research_session(session_id), session_id)
    if not session["user_read"]:
        raise ValueError(f"session {session_id} has no read set — promote requires one first")

    event_id = str(uuid.uuid4())
    event_row = {
        "event_id": event_id,
        "event_name": event_name,
        "event_type": "observed",
        "scheduled_time": scheduled_time,
        "source_url": session["source_url"],
        "source_tier": "discovered",
        "research_session_id": session_id,
        "direction": direction,
    }
    db.promote_research_session(session_id, event_row, _now_iso())
    return event_id


def dismiss_session(session_id: str, reason: str) -> None:
    """Requires: active, a read already set, a non-empty reason, and at
    least one turn already sent (spec 5.2 — a zero-turn session has nothing
    to reason about and can only be discarded, never dismissed)."""
    session = _require_active(db.get_research_session(session_id), session_id)
    if not session["user_read"]:
        raise ValueError(f"session {session_id} has no read set — dismiss requires one first")
    if not reason or not reason.strip():
        raise ValueError("dismiss requires a non-empty reason")
    if db.get_research_message_count(session_id) < 1:
        raise ValueError(f"session {session_id} has no turns yet — discard it instead of dismissing")

    db.dismiss_research_session(
        session_id, session["claim_text"], session["source_url"], session["user_read"], reason, _now_iso()
    )


def discard_session(session_id: str) -> None:
    """No gating beyond rejecting an already-terminal session — discarding
    a promoted/dismissed session would orphan the event_calendar/
    research_log row it already produced (spec 5.2's "no catalyst, no
    dismissed record, nothing left" describes purging a session that never
    got that far, not un-doing a completed disposition)."""
    session = db.get_research_session(session_id)
    if session is None:
        raise ValueError(f"no research session with id {session_id}")
    if session["status"] != "active":
        raise ValueError(f"session {session_id} is already {session['status']!r} — cannot discard")
    db.discard_research_session(session_id)
