import { useState, useEffect, useCallback } from "react";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { CATCOR_EVENT_COLORS } from "./palette";
import { FORCE_REFRESH_EVENT } from "./refresh_controls";

const WINDOWS = ["T-30m", "T+5m", "T+30m", "T+2h"];
const DEFAULT_WINDOW = "T+30m";
const METALS = ["XAG", "XAU"];
const LOOKAHEAD_DAYS = 30; // right edge of the timeline is always "today + 30 days"

// Preset lookback ranges, matching the app's existing range-selector
// convention (money_supply.jsx's 2y/5y/10y/20y buttons) rather than an
// exact-month picker. Left edge = today minus this many months, at the
// start of that day (not snapped to a calendar month boundary).
const LOOKBACK_PRESETS = [
  { label: "1M", monthsBack: 1 },
  { label: "3M", monthsBack: 3 },
  { label: "6M", monthsBack: 6 },
  { label: "1Y", monthsBack: 12 },
];
const DEFAULT_LOOKBACK_MONTHS_AGO = 3;

function lookbackStartFor(monthsBack) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - monthsBack, now.getDate()).getTime();
}

function fmtPct(v) {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function fmtMonthYear(t) {
  return new Date(t).toLocaleString(undefined, { month: "short", year: "numeric" });
}

// One row per (event, metal) for the currently-selected window — the raw
// /api/catcor/reactions/db response is one row per (event, metal, window),
// so filtering to a single window here is what turns it into one scatter
// point per event/metal.
//   - withSurprise (top scatter): only events with a real surprise_magnitude
//     (x = surprise magnitude, y = price reaction). Events without a known
//     consensus figure are never plotted here at a placeholder x=0 — that
//     would misrepresent "we don't know the surprise" as "we know it was
//     zero," a real, different value.
//   - timeline (bottom chart): EVERY event with a captured price reaction,
//     regardless of whether surprise_magnitude is known — a complete
//     "everything that happened, in time order" view, so an event can
//     appear in both charts if it has both a captured reaction and a known
//     surprise. x is the real calendar timestamp (ms since epoch), not a
//     relative "days since earliest" offset — ticks are formatted as
//     month/year so the axis reads as an actual calendar, not a backwards
//     countdown. Future events (scheduled_time in the future — sourced
//     from `events`, since `reactions` only has rows for events a
//     snapshot has actually been attempted for) are included too, with
//     isFuture:true and y:0 as a placeholder position (never a real
//     reaction) — rendered dim/greyed in the chart, distinct from a real
//     0% reaction, and the tooltip makes clear nothing has happened yet.
function toScatterPoints(reactions, events, window, metal) {
  const rows = reactions.filter((r) => r.window === window && r.metal === metal);
  const withSurprise = [];
  const timeline = [];
  const seenEventIds = new Set();
  for (const r of rows) {
    seenEventIds.add(r.event_id);
    if (r.price_delta_pct == null) continue; // no captured price reaction at all — nothing to plot either way
    const point = {
      event_id: r.event_id,
      event_name: r.event_name,
      event_type: r.event_type,
      scheduled_time: r.scheduled_time,
      research_session_id: r.research_session_id ?? null,
      y: r.price_delta_pct,
      surprise_magnitude: r.surprise_magnitude,
      isFuture: false,
    };
    if (r.surprise_magnitude != null) {
      withSurprise.push({ ...point, x: r.surprise_magnitude });
    }
    timeline.push({ ...point, t: new Date(r.scheduled_time).getTime() });
  }
  const now = Date.now();
  for (const e of events || []) {
    if (seenEventIds.has(e.event_id)) continue; // already has a real reaction row above
    const t = new Date(e.scheduled_time).getTime();
    if (t <= now) continue; // past event with no reaction row yet isn't "future" — just not captured
    timeline.push({
      event_id: e.event_id,
      event_name: e.event_name,
      event_type: e.event_type,
      scheduled_time: e.scheduled_time,
      research_session_id: e.research_session_id ?? null,
      y: 0,
      surprise_magnitude: null,
      isFuture: true,
      t,
    });
  }
  return { withSurprise, timeline };
}

function RecordHotlinkHint({ researchSessionId }) {
  if (!researchSessionId) return null;
  return (
    <div style={{ color: "#d9a441", marginTop: 4 }}>Click to open the research record →</div>
  );
}

function CatcorTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>
        <strong>{p.event_name}</strong>
      </div>
      <div style={{ color: "#8a94a6" }}>{fmtDateTime(p.scheduled_time)}</div>
      <div>Surprise magnitude: {p.x.toFixed(3)}</div>
      <div>Price reaction: {fmtPct(p.y)}</div>
      <RecordHotlinkHint researchSessionId={p.research_session_id} />
    </div>
  );
}

function TimelineTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  if (p.isFuture) {
    return (
      <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
        <div style={{ color: "#c8d0de", marginBottom: 4 }}>
          <strong>{p.event_name}</strong>
        </div>
        <div style={{ color: "#8a94a6" }}>{fmtDateTime(p.scheduled_time)}</div>
        <div style={{ color: "#8a94a6" }}>Scheduled — hasn't happened yet, no reaction to show</div>
        <RecordHotlinkHint researchSessionId={p.research_session_id} />
      </div>
    );
  }
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>
        <strong>{p.event_name}</strong>
      </div>
      <div style={{ color: "#8a94a6" }}>{fmtDateTime(p.scheduled_time)}</div>
      <div>Price reaction: {fmtPct(p.y)}</div>
      {p.surprise_magnitude != null ? (
        <div>Surprise magnitude: {p.surprise_magnitude.toFixed(3)}</div>
      ) : (
        <div style={{ color: "#8a94a6" }}>No consensus source yet — surprise magnitude unknown</div>
      )}
      <RecordHotlinkHint researchSessionId={p.research_session_id} />
    </div>
  );
}

// Custom point renderer shared by both charts: draws a diamond (same shape
// on both charts, so an event type reads consistently everywhere — the
// scatter, the timeline, and the legend all use diamonds) at normal radius,
// except the point matching hoveredEventId, which renders at ~2x radius —
// the visual cue that links a hovered point in one chart to its
// counterpart in the other.
// Future/scheduled events (isFuture: true — timeline chart only, since the
// scatter above never contains them) keep their normal event-type color
// but render at reduced opacity, so a known-but-not-yet-happened catalyst
// is visually distinct from an observed reaction without losing the
// type-color coding that ties it to the same legend/hover-link as
// everything else.
function makeLinkedShape(color, hoveredEventId, baseRadius, diamond) {
  return function LinkedShape(props) {
    const { cx, cy, payload } = props;
    const isHovered = payload.event_id === hoveredEventId;
    const isFuture = payload.isFuture;
    const r = isHovered ? baseRadius * 2 : baseRadius;
    const fill = color;
    const opacity = isFuture ? 0.4 : isHovered ? 1 : 0.85;
    if (diamond) {
      const d = r * 1.2;
      const points = `${cx},${cy - d} ${cx + d},${cy} ${cx},${cy + d} ${cx - d},${cy}`;
      return <polygon points={points} fill={fill} opacity={opacity} />;
    }
    return <circle cx={cx} cy={cy} r={r} fill={fill} opacity={opacity} />;
  };
}

export default function CatcorPanel({ onOpenResearchSession }) {
  const [events, setEvents] = useState(null);
  const [reactions, setReactions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [window_, setWindow] = useState(DEFAULT_WINDOW);
  const [metal, setMetal] = useState("XAG");
  // Left edge of the "Price Reaction" timeline chart — a 1M/3M/6M/1Y preset
  // picker, defaulting to 3M. Right edge is always fixed at "today + 2
  // weeks" (LOOKAHEAD_DAYS), not user-selectable, so there's always a
  // little forward room to see the very next scheduled catalyst.
  const [lookbackMonths, setLookbackMonths] = useState(DEFAULT_LOOKBACK_MONTHS_AGO);
  // Shared across both charts: hovering a point in either one sets this,
  // and both charts' point renderers check it to double the radius of the
  // matching event's point in the OTHER chart (and itself), regardless of
  // which chart the pointer is actually over.
  const [hoveredEventId, setHoveredEventId] = useState(null);
  // Legend click-to-toggle (same convention as silver_cot_tracker.jsx's
  // CoT lines) — a Set of event_type strings currently hidden from both
  // charts. Empty by default: everything visible until the user hides one.
  const [hiddenTypes, setHiddenTypes] = useState(() => new Set());

  function toggleType(type) {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  // Only Observed-origin (promoted-from-Research) points carry a
  // research_session_id — clicking a government-seeded (CPI/FOMC/NFP)
  // point is a no-op, since there's no session record to hotlink to.
  function handlePointClick(p) {
    if (p?.research_session_id && onOpenResearchSession) {
      onOpenResearchSession(p.research_session_id);
    }
  }

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [eventsRes, reactionsRes] = await Promise.all([
        fetch("/api/catcor/events/db"),
        fetch("/api/catcor/reactions/db"),
      ]);
      if (!eventsRes.ok) throw new Error(`HTTP ${eventsRes.status}`);
      if (!reactionsRes.ok) throw new Error(`HTTP ${reactionsRes.status}`);
      const eventsJson = await eventsRes.json();
      const reactionsJson = await reactionsRes.json();
      setEvents(eventsJson.data ?? []);
      setReactions(reactionsJson.data ?? []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    window.addEventListener(FORCE_REFRESH_EVENT, fetchAll);
    return () => window.removeEventListener(FORCE_REFRESH_EVENT, fetchAll);
  }, [fetchAll]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/catcor/refresh", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchAll();
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  const { withSurprise: allWithSurprise, timeline: fullTimeline } = reactions
    ? toScatterPoints(reactions, events, window_, metal)
    : { withSurprise: [], timeline: [] };
  const lookbackStart = lookbackStartFor(lookbackMonths);
  const lookaheadEnd = Date.now() + LOOKAHEAD_DAYS * 86400000;
  const withSurprise = allWithSurprise.filter((p) => !hiddenTypes.has(p.event_type));
  const timeline = fullTimeline.filter(
    (p) => p.t >= lookbackStart && p.t <= lookaheadEnd && !hiddenTypes.has(p.event_type)
  );
  const pointsByType = withSurprise.reduce((acc, p) => {
    (acc[p.event_type] ??= []).push(p);
    return acc;
  }, {});
  const timelineByType = timeline.reduce((acc, p) => {
    (acc[p.event_type] ??= []).push(p);
    return acc;
  }, {});

  return (
    <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">Catalyst Correlation</summary>
      <div className="collapsible-pane-body">
        <div className="comex-panel">
          <div className="comex-panel-header">
            Catalyst Timeline
            <div className="comex-range-selector">
              {LOOKBACK_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className={`comex-range-btn${lookbackMonths === p.monthsBack ? " comex-range-btn--active" : ""}`}
                  onClick={() => setLookbackMonths(p.monthsBack)}
                >
                  {p.label}
                </button>
              ))}
              {METALS.map((m) => (
                <button
                  key={m}
                  className={`comex-range-btn${metal === m ? " comex-range-btn--active" : ""}`}
                  onClick={() => setMetal(m)}
                >
                  {m}
                </button>
              ))}
              <button className="comex-range-btn" onClick={handleRefresh} disabled={refreshing}>
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>
          <div className="comex-range-selector" style={{ marginBottom: 8, justifyContent: "flex-end" }}>
            {WINDOWS.map((w) => (
              <button
                key={w}
                className={`comex-range-btn${window_ === w ? " comex-range-btn--active" : ""}`}
                onClick={() => setWindow(w)}
              >
                {w}
              </button>
            ))}
          </div>
          {loading && !reactions ? (
            <div className="comex-empty">Loading…</div>
          ) : error ? (
            <div className="comex-empty">
              No data available.
              <div className="comex-empty-note">{error}</div>
            </div>
          ) : timeline.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <ScatterChart margin={{ top: 4, right: 20, left: 12, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                <XAxis
                  type="number"
                  dataKey="t"
                  name="date"
                  domain={[lookbackStart, lookaheadEnd]}
                  tickFormatter={fmtMonthYear}
                  tick={{ fill: "#8a94a6", fontSize: 11 }}
                  label={{ value: "Date", position: "insideBottom", offset: -4, fill: "#5a6278", fontSize: 11 }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  width={70}
                  tickFormatter={(v) => `${v.toFixed(1)}%`}
                  tick={{ fill: "#8a94a6", fontSize: 11 }}
                  label={{ value: `${metal} reaction (%)`, angle: -90, position: "center", dx: -30, fill: "#5a6278", fontSize: 11 }}
                />
                <ZAxis range={[60, 60]} />
                <Tooltip content={<TimelineTooltip />} cursor={{ strokeDasharray: "3 3" }} />
                {Object.entries(timelineByType).map(([type, typePoints]) => (
                  <Scatter
                    key={type}
                    data={typePoints}
                    fill={CATCOR_EVENT_COLORS[type] ?? "#94a3b8"}
                    shape={makeLinkedShape(CATCOR_EVENT_COLORS[type] ?? "#94a3b8", hoveredEventId, 5, type !== "observed")}
                    onMouseEnter={(p) => setHoveredEventId(p.event_id)}
                    onMouseLeave={() => setHoveredEventId(null)}
                    onClick={handlePointClick}
                    style={{ cursor: typePoints.some((p) => p.research_session_id) ? "pointer" : "default" }}
                  />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          ) : (
            <div className="comex-empty">
              No catalysts captured in this range.
              <div className="comex-empty-note">Try an earlier month, or hit Refresh.</div>
            </div>
          )}

          <div className="comex-section-label" style={{ marginTop: 20 }}>
            Surprise Magnitude vs. Price Reaction
          </div>

          {loading && !reactions ? (
            <div className="comex-empty">Loading…</div>
          ) : error ? (
            <div className="comex-empty">
              No data available.
              <div className="comex-empty-note">{error}</div>
            </div>
          ) : withSurprise.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <ScatterChart margin={{ top: 4, right: 20, left: 12, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name="surprise magnitude"
                  tick={{ fill: "#8a94a6", fontSize: 11 }}
                  label={{ value: "Surprise magnitude", position: "insideBottom", offset: -4, fill: "#5a6278", fontSize: 11 }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="price reaction"
                  width={70}
                  tickFormatter={(v) => `${v.toFixed(1)}%`}
                  tick={{ fill: "#8a94a6", fontSize: 11 }}
                  label={{ value: `${metal} reaction (%)`, angle: -90, position: "center", dx: -30, fill: "#5a6278", fontSize: 11 }}
                />
                <ZAxis range={[60, 60]} />
                <Tooltip content={<CatcorTooltip />} cursor={{ strokeDasharray: "3 3" }} />
                {Object.entries(pointsByType).map(([type, typePoints]) => (
                  <Scatter
                    key={type}
                    data={typePoints}
                    fill={CATCOR_EVENT_COLORS[type] ?? "#94a3b8"}
                    shape={makeLinkedShape(CATCOR_EVENT_COLORS[type] ?? "#94a3b8", hoveredEventId, 5, type !== "observed")}
                    onMouseEnter={(p) => setHoveredEventId(p.event_id)}
                    onMouseLeave={() => setHoveredEventId(null)}
                    onClick={handlePointClick}
                    style={{ cursor: typePoints.some((p) => p.research_session_id) ? "pointer" : "default" }}
                  />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          ) : (
            <div className="comex-empty">
              No data available.
              <div className="comex-empty-note">
                Hit Refresh to seed the event calendar and fetch ALFRED actuals, or run
                pipeline data collection for a while so price reactions can be captured.
              </div>
            </div>
          )}

          {allWithSurprise.length > 0 && (
            <div className="comex-legend-list">
              {Object.keys(CATCOR_EVENT_COLORS).map((type) => {
                // events is sorted by scheduled_time ascending (get_upcoming_events),
                // so the first match for this type is its next scheduled date.
                const next = (events || []).find((e) => e.event_type === type);
                const isHidden = hiddenTypes.has(type);
                return (
                  <button
                    key={type}
                    type="button"
                    className={`comex-legend-item legend-btn-row${isHidden ? " legend-btn--off" : ""}`}
                    onClick={() => toggleType(type)}
                    title={isHidden ? `Show ${type} on both charts` : `Hide ${type} from both charts`}
                  >
                    <span
                      className={
                        "comex-legend-swatch" + (type !== "observed" ? " comex-legend-swatch--diamond" : "")
                      }
                      style={{ background: CATCOR_EVENT_COLORS[type] }}
                    />
                    <span>
                      <strong>{type}</strong>
                      {type === "FOMC" && " — FOMC rate decisions"}
                      {type === "CPI" && " — Consumer Price Index releases"}
                      {type === "NFP" && " — Employment Situation (nonfarm payrolls) releases"}
                      {type === "observed" && " — promoted from a Research session (click a point to open its record)"}
                      {next
                        ? ` — next: ${fmtDateTime(next.scheduled_time)}`
                        : " — no upcoming date scheduled"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="comex-panel-note" style={{ marginTop: 8 }}>
            Actual/consensus sourced from ALFRED (point-in-time vintage, not today's revised
            numbers) where available. Price reactions from live spot ticks where the app was
            running, Yahoo Finance intraday/daily-close backfill otherwise. No sentiment, no
            prediction framing — historical description only.
          </div>
        </div>
      </div>
    </details>
  );
}
