import { useState, useRef, useEffect } from "react";

// Minimal chat UI over CATCOR's Research Pane backend
// (backend/catcor_research.py): first submit creates a research_sessions
// row (claim_text = that first message) via POST /sessions, every
// following submit reuses that session_id via POST /sessions/{id}/messages
// — so one page visit is one running session, closer to a single chat
// thread than SPEC.MD's session-picker flow. No session list/resume here;
// that's still open per SPEC.MD Section 5, this is just the chat surface.
export default function ResearchPanel() {
  const [messages, setMessages] = useState([]); // [{role, text}]
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const feedRef = useRef(null);

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messages, sending]);

  async function handleSubmit(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;

    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    setSending(true);
    setError(null);

    try {
      let body;
      if (!sessionId) {
        const res = await fetch("/api/catcor/research/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ claim_text: text }),
        });
        body = await res.json();
        if (!res.ok || !body.success) {
          throw new Error(body.detail || "Failed to start research session");
        }
        setSessionId(body.data.session_id);
      } else {
        const res = await fetch(`/api/catcor/research/sessions/${sessionId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text }),
        });
        body = await res.json();
        if (!res.ok || !body.success) {
          throw new Error(body.detail || "Failed to send message");
        }
      }
      setMessages((prev) => [...prev, { role: "assistant", text: body.data.final_text }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="app-shell">
      <details className="collapsible-pane" open>
        <summary className="collapsible-pane-title">
          <span>Research</span>
        </summary>
        <div className="collapsible-pane-body">
          <div className="research-feed" ref={feedRef}>
            {messages.length === 0 && !sending && (
              <div className="research-empty-hint">
                Paste a claim or ask a question — it'll be checked against AV's own data.
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={
                  "research-bubble" +
                  (m.role === "user" ? " research-bubble--user" : " research-bubble--assistant")
                }
              >
                <div className="research-bubble-role">
                  {m.role === "user" ? "You" : "AV Research"}
                </div>
                <div className="research-bubble-text">{m.text}</div>
              </div>
            ))}
            {sending && (
              <div className="research-bubble research-bubble--assistant research-bubble--pending">
                <div className="research-bubble-role">AV Research</div>
                <div className="research-bubble-text">Thinking…</div>
              </div>
            )}
          </div>

          {error && <div className="error-box">{error}</div>}

          <form className="research-input-row" onSubmit={handleSubmit}>
            <textarea
              className="research-textarea"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder="Paste a claim or ask a question…"
              rows={3}
              disabled={sending}
            />
            <button
              type="submit"
              className="research-submit-btn"
              disabled={sending || !input.trim()}
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </form>
        </div>
      </details>
    </div>
  );
}
