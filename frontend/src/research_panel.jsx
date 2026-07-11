import { useState, useRef, useEffect, useCallback } from "react";

// Research Pane, per catcor-events-spec.md. A workbench for working a
// single claim by hand: browse/resume past sessions, assemble each turn
// from five independently-adjustable controls (model, persona, context
// blocks, memory mode, prompt transparency), read the terminal-style
// transcript, and end in a disposition (promote/dismiss/discard).

const CONTEXT_BLOCKS = [
  { key: "cot_positioning", label: "CoT positioning (current)" },
  { key: "comex_inventory", label: "COMEX/SHFE inventory (current)" },
  { key: "money_supply", label: "Money supply / purchasing power" },
  { key: "market_balance", label: "Market balance (Silver Institute annual)" },
  { key: "prior_turns", label: "Prior turns in this session" },
  { key: "freeform", label: "Freeform paste" },
];

const STATUS_LABELS = {
  active: "Active",
  promoted: "Promoted",
  dismissed: "Dismissed",
};

function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.detail || `request to ${url} failed`);
  }
  return data.data;
}

async function deleteJSON(url) {
  const res = await fetch(url, { method: "DELETE" });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.detail || `request to ${url} failed`);
  }
  return data.data;
}

async function getJSON(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.detail || `request to ${url} failed`);
  }
  return data.data;
}

export default function ResearchPanel({ openSessionId, onOpenedSession }) {
  const [view, setView] = useState("list"); // "list" | "session"
  const [sessions, setSessions] = useState([]);
  const [sessionsError, setSessionsError] = useState(null);
  const [activeSessionId, setActiveSessionId] = useState(null);

  const refreshSessions = useCallback(() => {
    getJSON("/api/catcor/research/sessions/db")
      .then(setSessions)
      .catch((err) => setSessionsError(err.message));
  }, []);

  useEffect(() => {
    if (view === "list") refreshSessions();
  }, [view, refreshSessions]);

  function openSession(id) {
    setActiveSessionId(id);
    setView("session");
  }

  function backToList() {
    setActiveSessionId(null);
    setView("list");
    refreshSessions();
  }

  // Hotlink entry point (a CATCOR timeline dot's "open record" click) —
  // jumps straight into a specific session regardless of whatever view
  // this panel was already showing. onOpenedSession clears the request so
  // navigating away and back to Research afterward doesn't re-trigger it.
  useEffect(() => {
    if (openSessionId) {
      openSession(openSessionId);
      onOpenedSession?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSessionId]);

  return (
    <div className="app-shell">
      <details className="collapsible-pane" open>
        <summary className="collapsible-pane-title">
          <span>Research</span>
        </summary>
        <div className="collapsible-pane-body">
          {view === "list" && (
            <SessionList
              sessions={sessions}
              error={sessionsError}
              onOpen={openSession}
              onCreated={openSession}
              onRefresh={refreshSessions}
            />
          )}
          {view === "session" && (
            <SessionView sessionId={activeSessionId} onBack={backToList} />
          )}
          <ForgeSessionsPlaceholder />
        </div>
      </details>
    </div>
  );
}

// --- Session list/browser --------------------------------------------

function SessionList({ sessions, error, onOpen, onCreated, onRefresh }) {
  const [claimText, setClaimText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [backend, setBackend] = useState("forge");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [acting, setActing] = useState(false);

  const sessionsById = new Map(sessions.map((s) => [s.session_id, s]));

  // Selectable rows: active (discardable) or promoted (demotable) —
  // dismissed sessions are terminal with no further action, so they never
  // render a checkbox at all. A selection CAN be a mix of active and
  // promoted rows — in that case selectionStatus is null and both the
  // discard and demote header buttons render disabled (greyed out) rather
  // than either guessing which action was meant.
  const selectableIds = sessions.filter((s) => s.status === "active" || s.status === "promoted").map((s) => s.session_id);
  const selectedStatuses = new Set([...selected].map((id) => sessionsById.get(id)?.status).filter(Boolean));
  const selectionStatus = selectedStatuses.size === 1 ? [...selectedStatuses][0] : null;
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  function toggleOne(e, session) {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(session.session_id)) next.delete(session.session_id);
      else next.add(session.session_id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  }

  async function handleDiscardSelected() {
    if (selected.size === 0 || selectionStatus !== "active") return;
    const count = selected.size;
    if (!window.confirm(`Discard ${count} session${count === 1 ? "" : "s"}? This purges them entirely — no record kept.`)) return;
    setActing(true);
    setActionError(null);
    try {
      await Promise.all(
        [...selected].map((sessionId) => postJSON(`/api/catcor/research/sessions/${sessionId}/discard`, {}))
      );
      setSelected(new Set());
      onRefresh();
    } catch (err) {
      setActionError(err.message);
      onRefresh(); // some may have succeeded before the failure — reflect that
    } finally {
      setActing(false);
    }
  }

  async function handleDemoteSelected() {
    if (selected.size === 0 || selectionStatus !== "promoted") return;
    const count = selected.size;
    if (!window.confirm(
      `Demote ${count} catalyst${count === 1 ? "" : "s"}? This removes ${count === 1 ? "it" : "them"} from the CATCOR timeline and reopens the session${count === 1 ? "" : "s"} for editing/re-promotion/dismiss/discard.`
    )) return;
    setActing(true);
    setActionError(null);
    try {
      const eventIds = [...selected]
        .map((sessionId) => sessionsById.get(sessionId)?.promoted_event_id)
        .filter(Boolean);
      await Promise.all(eventIds.map((eventId) => deleteJSON(`/api/catcor/events/${eventId}`)));
      setSelected(new Set());
      onRefresh();
    } catch (err) {
      setActionError(err.message);
      onRefresh();
    } finally {
      setActing(false);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    const text = claimText.trim();
    if (!text || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const data = await postJSON("/api/catcor/research/sessions", {
        claim_text: text,
        source_url: sourceUrl.trim() || undefined,
        backend,
        context_blocks: [],
      });
      setClaimText("");
      setSourceUrl("");
      onCreated(data.session_id);
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="research-list">
      <form className="research-new-session" onSubmit={handleCreate}>
        <textarea
          className="research-textarea research-mono"
          value={claimText}
          onChange={(e) => setClaimText(e.target.value)}
          placeholder="Paste a claim or observation to work…"
          rows={3}
          disabled={creating}
        />
        <input
          className="research-input research-mono"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="Source URL (optional)"
          disabled={creating}
        />
        <div className="research-new-session-row">
          <button type="submit" className="research-submit-btn" disabled={creating || !claimText.trim()}>
            {creating ? "Starting…" : "New session"}
          </button>
          <select
            className="research-new-session-model"
            value={backend}
            onChange={(e) => setBackend(e.target.value)}
            disabled={creating}
          >
            <option value="forge">amp-forge</option>
            <option value="anthropic">Claude</option>
          </select>
        </div>
      </form>
      {createError && <div className="error-box">{createError}</div>}
      {actionError && <div className="error-box">{actionError}</div>}

      {error && <div className="error-box">{error}</div>}
      {!error && sessions.length === 0 && (
        <div className="research-empty-hint">No sessions yet — start one above.</div>
      )}
      {sessions.length > 0 && (
        <div className="comex-table-wrap">
          <table className="comex-table research-mono">
            <thead>
              <tr>
                <th className="research-select-col">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={selectableIds.length === 0}
                    title="Select all"
                  />
                </th>
                <th>Claim</th>
                <th>Status</th>
                <th>Read</th>
                <th className="right">Updated</th>
                <th className="right">
                  {selected.size > 0 && (
                    <>
                      <button
                        type="button"
                        className="research-trash-btn"
                        onClick={handleDiscardSelected}
                        disabled={acting || selectionStatus !== "active"}
                        title={
                          selectionStatus === "active"
                            ? `Discard ${selected.size} selected`
                            : "Select only active sessions to discard"
                        }
                      >
                        {acting && selectionStatus === "active" ? "…" : `🗑 (${selected.size})`}
                      </button>
                      <button
                        type="button"
                        className="research-demote-btn"
                        onClick={handleDemoteSelected}
                        disabled={acting || selectionStatus !== "promoted"}
                        title={
                          selectionStatus === "promoted"
                            ? `Demote ${selected.size} selected`
                            : "Select only promoted catalysts to demote"
                        }
                      >
                        {acting && selectionStatus === "promoted" ? "…" : `⬇ (${selected.size})`}
                      </button>
                    </>
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.session_id} className="research-session-row" onClick={() => onOpen(s.session_id)}>
                  <td className="research-select-col">
                    {(s.status === "active" || s.status === "promoted") && (
                      <input
                        type="checkbox"
                        checked={selected.has(s.session_id)}
                        onChange={(e) => toggleOne(e, s)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    )}
                  </td>
                  <td>{s.claim_text.length > 80 ? s.claim_text.slice(0, 80) + "…" : s.claim_text}</td>
                  <td>
                    <span className={`research-status-badge research-status-badge--${s.status}`}>
                      {STATUS_LABELS[s.status] || s.status}
                    </span>
                  </td>
                  <td>{s.user_read || "—"}</td>
                  <td className="right">{fmtDateTime(s.updated_at)}</td>
                  <td></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Session view: transcript + turn controls + disposition -----------

function SessionView({ sessionId, onBack }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [personas, setPersonas] = useState([]);

  const refresh = useCallback(() => {
    getJSON(`/api/catcor/research/sessions/${sessionId}/db`)
      .then(setDetail)
      .catch((err) => setError(err.message));
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    getJSON("/api/catcor/research/personas").then(setPersonas).catch(() => {});
  }, []);

  if (error) {
    return (
      <div className="research-session-view">
        <button className="research-back-btn" onClick={onBack}>← Back to sessions</button>
        <div className="error-box">{error}</div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="research-session-view">
        <button className="research-back-btn" onClick={onBack}>← Back to sessions</button>
        <div className="loading">Loading…</div>
      </div>
    );
  }

  const { session, messages } = detail;
  const isActive = session.status === "active";

  return (
    <div className="research-session-view">
      <button className="research-back-btn" onClick={onBack}>← Back to sessions</button>

      <div className="research-claim-header research-mono">{session.claim_text}</div>
      {session.source_url && (
        <div className="research-source-url research-mono">{session.source_url}</div>
      )}

      <Transcript messages={messages} />

      {isActive ? (
        <TurnComposer
          sessionId={sessionId}
          personas={personas}
          currentMemoryMode={session.memory_mode}
          onSent={refresh}
        />
      ) : (
        <div className="research-readonly-note">
          This session is {session.status} — read-only.
        </div>
      )}

      <DispositionControls session={session} onChanged={refresh} onDiscarded={onBack} />
    </div>
  );
}

// --- Transcript (terminal-style, not chat bubbles) ---------------------

function Transcript({ messages }) {
  const feedRef = useRef(null);
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [messages]);

  // Pair up user/assistant rows by sequence — a "turn" is one user row
  // followed by its assistant reply, same convention the backend uses.
  const turns = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      const reply = messages[i + 1]?.role === "assistant" ? messages[i + 1] : null;
      turns.push({ userMsg: messages[i], assistantMsg: reply });
      if (reply) i++;
    }
  }

  return (
    <div className="research-transcript" ref={feedRef}>
      {turns.length === 0 && (
        <div className="research-empty-hint">No turns yet.</div>
      )}
      {turns.map((t, i) => (
        <Turn key={t.userMsg.id} turn={t} isFirst={i === 0} />
      ))}
    </div>
  );
}

function Turn({ turn, isFirst }) {
  const { userMsg, assistantMsg } = turn;
  const [inputOpen, setInputOpen] = useState(false);
  const contextBlocks = userMsg.context_blocks ? JSON.parse(userMsg.context_blocks) : [];
  const showMemoryDivider = !isFirst && userMsg.memory_changed === 1;

  return (
    <>
      {showMemoryDivider && (
        <div className="research-turn-memory-divider">
          — memory switched to {userMsg.memory_mode} —
        </div>
      )}
      <div className="research-turn">
        <div className="research-turn-meta">
          <span>model: {assistantMsg?.backend ?? "—"}{assistantMsg?.model ? ` (${assistantMsg.model})` : ""}</span>
          <span>persona: {assistantMsg?.persona ?? "—"}</span>
          <span>context: {contextBlocks.length ? contextBlocks.join(", ") : "none"}</span>
          <span>memory: {userMsg.memory_mode ?? "—"}</span>
        </div>
        <details
          className="research-turn-input-details"
          open={inputOpen}
          onToggle={(e) => setInputOpen(e.target.open)}
        >
          <summary>input</summary>
          <AssembledInput assembledPrompt={userMsg.assembled_prompt} />
        </details>
        <div className="research-turn-response">
          {assistantMsg ? assistantMsg.content && JSON.parse(assistantMsg.content).final_text : "…"}
        </div>
      </div>
    </>
  );
}

// Shared renderer for an assembled {system, messages} payload — used both
// for a transcript turn's expandable "input" (already-sent, read from
// storage) and the live prompt preview (not yet sent, fetched fresh from
// the backend on every relevant change). The system prompt is persona text
// followed by AV's own context blocks, each fenced with "=== ... ==="
// headers (see catcor_research.py's _fmt_* functions) — rendered distinctly
// from plain persona/user text so AV's own numbers never blur together
// with commentary, per spec section 4.
function AssembledPayload({ system, messages, className }) {
  const sections = system.split(/(?===)/);
  return (
    <div className={className}>
      {sections.map((section, i) =>
        section.trim().startsWith("===") ? (
          <div className="research-evidence-block" key={i}>{section.trim()}</div>
        ) : (
          <div key={i}>{section.trim()}</div>
        )
      )}
      {messages.map((m, i) => (
        <div key={i} className="research-turn-input-msg">
          {m.role}: {m.content}
        </div>
      ))}
    </div>
  );
}

function AssembledInput({ assembledPrompt }) {
  if (!assembledPrompt) return null;
  let parsed;
  try {
    parsed = JSON.parse(assembledPrompt);
  } catch {
    return <div className="research-turn-input">{assembledPrompt}</div>;
  }
  return (
    <AssembledPayload system={parsed.system} messages={parsed.messages} className="research-turn-input" />
  );
}

// --- Turn composer: the five controls + send ----------------------------

function TurnComposer({ sessionId, personas, currentMemoryMode, onSent }) {
  const [content, setContent] = useState("");
  const [backend, setBackend] = useState("forge");
  const [persona, setPersona] = useState("word_count_v1");
  const [checkedBlocks, setCheckedBlocks] = useState([]);
  const [freeformText, setFreeformText] = useState("");
  const [memoryMode, setMemoryMode] = useState(currentMemoryMode || "accumulating");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  function toggleBlock(key) {
    setCheckedBlocks((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }

  // Live, exact preview (spec 3.5's "non-editable preview of the fully
  // assembled payload... shown as plain structured text before you send")
  // — only fetched while the preview panel is open, and refetched whenever
  // any control or the draft text changes, so it never goes stale.
  useEffect(() => {
    if (!previewOpen) return;
    let cancelled = false;
    postJSON(`/api/catcor/research/sessions/${sessionId}/preview`, {
      persona,
      context_blocks: checkedBlocks,
      memory_mode: memoryMode,
      freeform_text: checkedBlocks.includes("freeform") ? freeformText : undefined,
      content,
    })
      .then((data) => {
        if (!cancelled) {
          setPreview(data);
          setPreviewError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setPreviewError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [previewOpen, sessionId, persona, checkedBlocks, memoryMode, freeformText, content]);

  async function handleSend(e) {
    e.preventDefault();
    const text = content.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await postJSON(`/api/catcor/research/sessions/${sessionId}/messages`, {
        content: text,
        backend,
        persona,
        context_blocks: checkedBlocks,
        memory_mode: memoryMode,
        freeform_text: checkedBlocks.includes("freeform") ? freeformText : undefined,
      });
      setContent("");
      onSent();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  const personaOptions = personas.length ? personas : [persona];

  return (
    <form className="research-turn-composer" onSubmit={handleSend}>
      <div className="research-controls-row">
        <label className="research-control">
          <span>Model</span>
          <select value={backend} onChange={(e) => setBackend(e.target.value)} disabled={sending}>
            <option value="forge">amp-forge</option>
            <option value="anthropic">Claude</option>
          </select>
        </label>
        <label className="research-control">
          <span>Persona</span>
          <select value={persona} onChange={(e) => setPersona(e.target.value)} disabled={sending}>
            {personaOptions.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="research-control">
          <span>Memory</span>
          <select value={memoryMode} onChange={(e) => setMemoryMode(e.target.value)} disabled={sending}>
            <option value="stateless">Stateless</option>
            <option value="accumulating">Accumulating</option>
          </select>
        </label>
      </div>

      <div className="research-context-checkboxes">
        {CONTEXT_BLOCKS.map((b) => (
          <label key={b.key} className="research-checkbox-item">
            <input
              type="checkbox"
              checked={checkedBlocks.includes(b.key)}
              onChange={() => toggleBlock(b.key)}
              disabled={sending}
            />
            {b.label}
          </label>
        ))}
      </div>
      {checkedBlocks.includes("freeform") && (
        <textarea
          className="research-textarea research-mono"
          value={freeformText}
          onChange={(e) => setFreeformText(e.target.value)}
          placeholder="Freeform context to fold into this turn…"
          rows={2}
          disabled={sending}
        />
      )}

      <details
        className="research-preview-details"
        open={previewOpen}
        onToggle={(e) => setPreviewOpen(e.target.open)}
      >
        <summary>Prompt preview</summary>
        {previewError && <div className="error-box">{previewError}</div>}
        {preview ? (
          <AssembledPayload
            system={preview.system}
            messages={preview.messages}
            className="research-preview-body research-mono"
          />
        ) : (
          <div className="research-preview-body research-mono">Loading preview…</div>
        )}
      </details>

      <textarea
        className="research-textarea research-mono"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend(e);
          }
        }}
        placeholder="Your turn…"
        rows={3}
        disabled={sending}
      />
      {error && <div className="error-box">{error}</div>}
      <button type="submit" className="research-submit-btn" disabled={sending || !content.trim()}>
        {sending ? "Sending…" : "Send"}
      </button>
    </form>
  );
}

// --- Read -> disposition -------------------------------------------------

function DispositionControls({ session, onChanged, onDiscarded }) {
  const [error, setError] = useState(null);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [eventName, setEventName] = useState("");
  const [scheduledTime, setScheduledTime] = useState("");
  const [direction, setDirection] = useState("bullish");
  const [dismissReason, setDismissReason] = useState("");
  const [busy, setBusy] = useState(false);

  const isActive = session.status === "active";
  const hasRead = !!session.user_read;

  async function setRead(value) {
    setError(null);
    try {
      await postJSON(`/api/catcor/research/sessions/${session.session_id}/read`, { user_read: value });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handlePromote(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await postJSON(`/api/catcor/research/sessions/${session.session_id}/promote`, {
        event_name: eventName,
        scheduled_time: scheduledTime,
        direction,
      });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDismiss(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await postJSON(`/api/catcor/research/sessions/${session.session_id}/dismiss`, {
        reason: dismissReason,
      });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDiscard() {
    if (!window.confirm("Discard this session? This purges it entirely — no record kept.")) return;
    setBusy(true);
    setError(null);
    try {
      await postJSON(`/api/catcor/research/sessions/${session.session_id}/discard`, {});
      onDiscarded();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!isActive) {
    return (
      <div className="research-disposition research-mono">
        Read: {session.user_read || "—"} · Status: {session.status}
      </div>
    );
  }

  return (
    <div className="research-disposition">
      <div className="research-read-row">
        <span>Your read:</span>
        {["bullish", "bearish", "neutral"].map((r) => (
          <button
            key={r}
            type="button"
            className={`research-read-btn${session.user_read === r ? " research-read-btn--active" : ""}`}
            onClick={() => setRead(r)}
            disabled={busy}
          >
            {r}
          </button>
        ))}
      </div>

      <div className="research-disposition-actions">
        <button
          type="button"
          className="research-disposition-btn"
          disabled={!hasRead || busy}
          onClick={() => setPromoteOpen((v) => !v)}
        >
          Promote to catalyst
        </button>
        <button
          type="button"
          className="research-disposition-btn"
          disabled={!hasRead || busy}
          onClick={() => setDismissOpen((v) => !v)}
        >
          Log as noise
        </button>
        <button
          type="button"
          className="research-disposition-btn research-disposition-btn--danger"
          disabled={busy}
          onClick={handleDiscard}
        >
          Discard
        </button>
      </div>

      {promoteOpen && (
        <form className="research-disposition-form" onSubmit={handlePromote}>
          <input
            className="research-input research-mono"
            value={eventName}
            onChange={(e) => setEventName(e.target.value)}
            placeholder="Event name"
            required
          />
          <input
            className="research-input research-mono"
            value={scheduledTime}
            onChange={(e) => setScheduledTime(e.target.value)}
            placeholder="Scheduled time (ISO 8601)"
            required
          />
          <select value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="bullish">bullish</option>
            <option value="bearish">bearish</option>
          </select>
          <button type="submit" className="research-submit-btn" disabled={busy}>
            Confirm promote
          </button>
        </form>
      )}

      {dismissOpen && (
        <form className="research-disposition-form" onSubmit={handleDismiss}>
          <input
            className="research-input research-mono"
            value={dismissReason}
            onChange={(e) => setDismissReason(e.target.value)}
            placeholder="Reason this didn't hold up (required)"
            required
          />
          <button type="submit" className="research-submit-btn" disabled={busy || !dismissReason.trim()}>
            Confirm dismiss
          </button>
        </form>
      )}

      {error && <div className="error-box">{error}</div>}
    </div>
  );
}

// --- amp-forge session visibility (stub, spec 3.4) ----------------------

function ForgeSessionsPlaceholder() {
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    fetch("/api/catcor/research/forge-sessions")
      .then((r) => r.json())
      .then(setDetail)
      .catch(() => {});
  }, []);

  return (
    <details className="research-forge-placeholder">
      <summary>amp-forge sessions (local model state)</summary>
      <div className="research-forge-placeholder-body">
        {detail?.detail || "Not yet available."}
      </div>
    </details>
  );
}
