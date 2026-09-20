import { useState, useEffect, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { PRICE_HISTORY_WINDOWS, PRICE_LIVE_POLL_MS } from "./date_utils";
import SilverCoTTracker from "./silver_cot_tracker";
import ComexInventoryDashboard from "./comex_inventory";
import MoneySupply from "./money_supply";
import CatcorPanel from "./catcor_panel";
import { computeStatus } from "./data_panel";
import ResearchPanel from "./research_panel";
import StackTracker from "./stack_tracker";
import SanctionsPanel from "./sanctions_panel";
import SettingsView from "./settings_panel";
import { HealthProvider, useHealthRows } from "./health_context";
import { PinnedDateProvider } from "./pinned_date_context";
import { apiFetch } from "./api_client";

// Nav tab set. MUST stay in lockstep with backend main.py's
// _VALID_NAV_SECTIONS allowlist — tests/test_conventions.py's
// test_nav_sections_match_backend_allowlist fails the suite on drift
// (the two-list bug CLAUDE.md documents from the Stack and OFAC builds).
// "data" is intentionally absent: the Data tab's content moved into the
// Settings view (gear icon, a sibling of activeSection), which is not a
// pinnable default-landing tab.
const SECTIONS = [
  { key: "cot", label: "Trading" },
  { key: "inventory", label: "Inventory" },
  { key: "moneySupply", label: "Money Supply" },
  { key: "stack", label: "Stack" },
  { key: "catcor", label: "CATCOR" },
  { key: "research", label: "Research" },
  { key: "sanctions", label: "OFAC" },
];

// AV_ENV (2026-09-16, at the user's explicit request) — a visual indicator,
// other than the port number, for "am I looking at Test AV or prod." Read
// from VITE_AV_ENV, baked in at frontend build time (see
// Dockerfile.frontend/docker-compose.yml's `web` service, which sets it to
// "test"); absent/unset means prod, matching every other VITE_* var's
// "unset = today's default behavior" convention in this repo — vigil.sh's
// native frontend build never sets it, so prod is never accidentally
// mislabeled by an env var it doesn't know exists.
const AV_ENV = import.meta.env.VITE_AV_ENV || "prod";
const IS_TEST_ENV = AV_ENV !== "prod";

// Small passive-visibility dot (Story #7) — red if any tracked source is
// erroring, yellow if any is stale with no errors, green otherwise. Links
// nowhere; the Data tab nav button is already one click away for the
// per-source drill-down (Decision 4). Shares data_panel.jsx's exported
// computeStatus rather than re-implementing the same ok/stale/error rule
// inline (a real duplication that existed before this fix). As of the
// per-source-cadence pass, also shares health_context.jsx's single polled
// HealthProvider (via useHealthRows with no sourceKey filter — every row)
// rather than its own independent 60s poll of /api/health/db, since
// per-sub-panel ChartStaleness badges now poll the same route too and a
// second independent poll here would be pure duplication.
//
// Test-environment override (2026-09-16, made deliberately loud at the
// user's explicit request — "annoyingly bright," "painfully clear I'm in
// test," after an initial quieter purple was rejected as too easy to miss):
// in Test AV, this dot is bigger, pulsing neon magenta
// (.header-health-dot--test, index.css), regardless of underlying data
// health — the point is "you are in test," a stronger signal than whether
// test's own snapshot data happens to be stale (it usually is, by design —
// it's a point-in-time copy). Real health is still computed and shown in
// the tooltip text, just not as the dot's color/size, so a genuinely
// erroring test source isn't hidden either.
function HeaderHealthDot() {
  const { rows } = useHealthRows(null);
  if (rows.length === 0) return null;
  let worst = "ok";
  for (const row of rows) {
    const rowStatus = computeStatus(row, row.expected_interval_s);
    if (rowStatus === "error") worst = "error";
    else if (rowStatus === "stale" && worst !== "error") worst = "stale";
  }
  if (IS_TEST_ENV) {
    return (
      <span
        className="header-health-dot header-health-dot--test"
        title={`TEST AV (env: ${AV_ENV}) — data health: ${worst}`}
      />
    );
  }
  const color = worst === "error" ? "#e0555c" : worst === "stale" ? "#d9a441" : "#4caf76";
  return <span className="header-health-dot" style={{ background: color }} title={`Data health: ${worst}`} />;
}

// Default window before a user picks anything — "2-3 hours of history" was
// the original fixed sparkline width; now just the initial preset, since
// each TickerRow owns its own range picker (see below).
const TICKER_DEFAULT_WINDOW_MS = PRICE_HISTORY_WINDOWS[0].ms; // "6H"

// Fixed-content tooltip for the expanded ticker chart — factual only (time
// + price), no prediction/target framing per AV Voice Rules. Full
// date+time (not just time) since the range picker now allows windows
// spanning multiple days, unlike the old fixed 3h-only sparkline.
function TickerTooltipContent({ active, payload, color }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;
  return (
    <div style={{ background: "#141820", border: "1px solid #2e3547", padding: "6px 8px", fontSize: 11 }}>
      <div style={{ color: "#8a94a6" }}>{new Date(row.ts).toLocaleString()}</div>
      <div style={{ color }}>${row.price.toFixed(2)}</div>
    </div>
  );
}

// One collapsible row per metal — collapsed shows just label/price/change
// (no chart), matching every other collapsible-pane summary in the app.
// Expanded reveals the real chart plus its own range picker + Live toggle
// (same PRICE_HISTORY_WINDOWS/PRICE_LIVE_POLL_MS convention as the CoT
// tab's MetalPriceHistoryChart — see silver_cot_tracker.jsx) — real
// spot_price ticks via /api/prices/db/ticks, the same tick-resolution feed
// the Paper Games panel's leverage chart deliberately does NOT use, since
// that chart wants years of daily history, not hours of live ticks.
// Purely a "stuff's running" visual, not a trading readout — no price
// targets/prediction framing. Price change shown is absolute change over
// the fetched window, not a 24h %, since the point here is "what's the
// feed showing right now for the window I picked."
//
// Range/live state is owned per-row (not hoisted to HeaderTicker) since
// each metal's pane expands/collapses and picks its own window
// independently — same reasoning MetalPriceHistoryChart keeps its own
// state local rather than sharing a panel-level selector.
function TickerRow({ metalKey, label, color }) {
  const [open, setOpen] = useState(false);
  const [windowMs, setWindowMs] = useState(TICKER_DEFAULT_WINDOW_MS);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [live, setLive] = useState(true); // matches the old always-polling default
  const [ticks, setTicks] = useState(null);

  const customSince = customStart ? new Date(customStart + "T00:00") : null;
  const customUntil = customEnd ? new Date(customEnd + "T23:59") : null;
  const customRangeIncomplete = windowMs === "custom" && (!customStart || !customEnd || customStart > customEnd);

  // Live always tracks to "now", same semantics as MetalPriceHistoryChart's
  // Live toggle — ignores whatever preset/Custom window was picked before.
  const effectiveSince = live
    ? new Date(Date.now() - TICKER_DEFAULT_WINDOW_MS)
    : windowMs === "custom"
    ? customSince
    : windowMs == null
    ? null
    : new Date(Date.now() - windowMs);
  const effectiveUntil = live ? null : windowMs === "custom" ? customUntil : null;

  const chartSince = !live && customRangeIncomplete ? null : effectiveSince;
  const chartUntil = !live && customRangeIncomplete ? null : effectiveUntil;

  const fetchTicks = useCallback(() => {
    // Collapsed panes don't need fresh data — skip the fetch/poll entirely
    // rather than the old behavior of always polling regardless of expand
    // state, which was pure waste for a pane nobody's looking at.
    if (!open) return;
    if (!live && customRangeIncomplete) return;
    const params = new URLSearchParams({ series_id: metalKey });
    if (chartSince) params.set("since", chartSince.toISOString());
    if (chartUntil) params.set("until", chartUntil.toISOString());
    apiFetch(`/api/prices/db/ticks?${params.toString()}`)
      .then((r) => r.json())
      .then((j) => setTicks(j.data ?? []))
      .catch(() => setTicks([]));
  }, [metalKey, open, chartSince?.getTime(), chartUntil?.getTime(), live, customRangeIncomplete]);

  useEffect(() => {
    fetchTicks();
    let timer = null;
    if (open && live) timer = setInterval(fetchTicks, PRICE_LIVE_POLL_MS);
    return () => { if (timer) clearInterval(timer); };
  }, [fetchTicks, open, live]);

  const rows = ticks ?? [];
  const latest = rows.length ? rows[rows.length - 1].price : null;
  const first = rows.length ? rows[0].price : null;
  const change = latest != null && first != null ? latest - first : null;
  const changeColor = change == null ? "#5a6278" : change === 0 ? "#5a6278" : change > 0 ? "#4caf76" : "#e0555c";

  const activeWindowLabel = PRICE_HISTORY_WINDOWS.find((w) => w.ms === windowMs)?.label
    ?? (windowMs === "custom" ? "Custom" : "6H");

  return (
    <details
      className="collapsible-pane header-ticker-pane"
      open={open}
      onToggle={(e) => setOpen(e.target.open)}
    >
      <summary className="collapsible-pane-title header-ticker-summary">
        <span className="header-ticker-label" style={{ color }}>{label}</span>
        {latest != null && <span className="header-ticker-price">${latest.toFixed(2)}</span>}
        {change != null && (
          <span className="header-ticker-pct" style={{ color: changeColor }}>
            {change >= 0 ? "+" : ""}{change.toFixed(2)}
          </span>
        )}
      </summary>
      <div className="collapsible-pane-body">
        <div className="comex-range-selector" style={{ marginBottom: 8 }}>
          {PRICE_HISTORY_WINDOWS.map((w) => (
            <button
              key={w.label}
              type="button"
              className={`comex-range-btn${!live && windowMs === w.ms ? " comex-range-btn--active" : ""}`}
              disabled={live}
              onClick={() => setWindowMs(w.ms)}
            >
              {w.label}
            </button>
          ))}
          <button
            type="button"
            className={`comex-range-btn${!live && windowMs === "custom" ? " comex-range-btn--active" : ""}`}
            disabled={live}
            onClick={() => setWindowMs("custom")}
          >
            Custom
          </button>
          <label className="live-toggle" title="Track to now, polling every 60s (matches the backend's own spot-price write cadence)">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            Live
          </label>
        </div>
        {windowMs === "custom" && !live && (
          <div className="comex-range-selector" style={{ marginBottom: 8 }}>
            <label className="form-inline-label">
              From
              <input
                type="datetime-local"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                max={customEnd || undefined}
              />
            </label>
            <label className="form-inline-label">
              To
              <input
                type="datetime-local"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                min={customStart || undefined}
              />
            </label>
            {customStart && customEnd && customStart > customEnd && (
              <span style={{ fontSize: 11, color: "#e05252" }}>Start must be before end.</span>
            )}
          </div>
        )}
        {ticks == null ? null : rows.length > 1 ? (
          <ResponsiveContainer width="100%" height={140}>
            <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e2333" />
              <XAxis
                dataKey="ts"
                tickFormatter={(t) =>
                  windowMs != null && windowMs !== "custom" && windowMs <= 24 * 60 * 60 * 1000
                    ? new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
                    : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                }
                minTickGap={50}
                stroke="#5a6278"
                fontSize={11}
              />
              {/* Real tick-to-tick movement here is a few cents/dollars,
                  tiny against Recharts' default auto-domain padding —
                  without an explicit dataMin/dataMax domain the line
                  renders as visually flat even though the underlying data
                  genuinely moves (confirmed via /api/prices/db/ticks
                  directly). */}
              <YAxis
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v) => `$${v.toFixed(2)}`}
                stroke="#5a6278"
                fontSize={11}
                width={64}
              />
              <Tooltip content={<TickerTooltipContent color={color} />} />
              <Line
                type="monotone"
                dataKey="price"
                stroke={color}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="comex-empty">Not enough real ticks yet for this window — check back in a minute.</div>
        )}
      </div>
    </details>
  );
}

function HeaderTicker() {
  const rows = [
    { key: "XAG", label: "Ag", color: "#5aa9e6" },
    { key: "XAU", label: "Au", color: "#e0c14c" },
  ];

  return (
    <div className="header-ticker">
      {rows.map(({ key, label, color }) => (
        <TickerRow key={key} metalKey={key} label={label} color={color} />
      ))}
    </div>
  );
}

export default function App() {
  const [activeSection, setActiveSection] = useState("cot");
  const [pinnedSection, setPinnedSection] = useState(null);
  // Settings is a sibling view, not a nav section: an always-mounted,
  // visibility-toggled panel (same pattern as the tabs) opened by the
  // header gear icon. It fully covers the content area while open; any
  // nav-button click closes it by switching activeSection.
  const [showSettings, setShowSettings] = useState(false);
  // Cross-panel hotlink: CatcorPanel sets this when a promoted (Observed-
  // origin) catalyst's dot is clicked, so the Research tab opens straight
  // into that session's record instead of its own session list.
  const [openResearchSessionId, setOpenResearchSessionId] = useState(null);

  function openResearchSession(sessionId) {
    setOpenResearchSessionId(sessionId);
    setActiveSection("research");
    setShowSettings(false);
  }

  // A tab panel is visible only when it's the active section AND Settings
  // isn't covering the content area. `base` is the wrapper's own layout
  // class ("app-shell" for most, "" for cot/research which don't use it).
  function sectionClass(key, base) {
    const visible = activeSection === key && !showSettings;
    return (base ? base + " " : "") + (visible ? "" : "section-hidden");
  }

  // On first load, open whichever tab is pinned (if any) instead of always
  // defaulting to CoT — the pin is a shared, server-persisted setting
  // (backend/db.py's ui_settings table), not a per-browser localStorage
  // value, so it's consistent across devices/reloads.
  useEffect(() => {
    apiFetch("/api/ui/pinned-section")
      .then((r) => r.json())
      .then((j) => {
        const pinned = j.data?.pinned_section ?? null;
        setPinnedSection(pinned);
        if (pinned && SECTIONS.some((s) => s.key === pinned)) {
          setActiveSection(pinned);
        }
      })
      .catch(() => {});
  }, []);

  function togglePin(e, sectionKey) {
    e.stopPropagation();
    const next = pinnedSection === sectionKey ? null : sectionKey;
    setPinnedSection(next);
    apiFetch("/api/ui/pinned-section", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section: next }),
    }).catch(() => {});
  }

  return (
    <HealthProvider>
     <PinnedDateProvider>
      <div className="app-shell">
        <div className="app-header app-header--split">
          <div>
            <div className="app-title">
              ArgentVigil
              <HeaderHealthDot />
              <span
                role="button"
                tabIndex={0}
                className={
                  "header-settings-gear" +
                  (showSettings ? " header-settings-gear--active" : "")
                }
                title={showSettings ? "Close settings" : "Settings — source health & configuration"}
                onClick={() => setShowSettings((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setShowSettings((v) => !v);
                }}
              >
                ⚙️
              </span>
            </div>
            <div className="app-subtitle">
              Silver Market Observability Platform
            </div>
          </div>
          <HeaderTicker />
        </div>
        <div className="app-header">
          <div className="section-nav">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                className={
                  "section-nav-button" +
                  (activeSection === s.key ? " section-nav-button--active" : "")
                }
                onClick={() => {
                  setActiveSection(s.key);
                  setShowSettings(false);
                }}
              >
                {s.label}
                <span
                  role="button"
                  tabIndex={0}
                  className={
                    "section-pin-icon" +
                    (pinnedSection === s.key ? " section-pin-icon--pinned" : "")
                  }
                  title={
                    pinnedSection === s.key
                      ? "Pinned as default tab — click to unpin"
                      : "Pin as default tab on startup"
                  }
                  onClick={(e) => togglePin(e, s.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") togglePin(e, s.key);
                  }}
                >
                  📌
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* All panels stay mounted; visibility is toggled so switching tabs
          (or opening Settings) never refires mount-time fetches/listeners.
          Settings, when open, hides every tab panel regardless of which
          one is active. */}
      <div className={showSettings ? "" : "section-hidden"}>
        <SettingsView onClose={() => setShowSettings(false)} />
      </div>

      <div className={sectionClass("cot", "")}>
        <SilverCoTTracker />
      </div>
      <div className={sectionClass("moneySupply", "app-shell")}>
        <MoneySupply />
      </div>
      <div className={sectionClass("inventory", "app-shell")}>
        <ComexInventoryDashboard />
      </div>
      <div className={sectionClass("catcor", "app-shell")}>
        <CatcorPanel onOpenResearchSession={openResearchSession} />
      </div>
      <div className={sectionClass("research", "")}>
        <ResearchPanel
          openSessionId={openResearchSessionId}
          onOpenedSession={() => setOpenResearchSessionId(null)}
        />
      </div>
      <div className={sectionClass("stack", "app-shell")}>
        <StackTracker />
      </div>
      <div className={sectionClass("sanctions", "app-shell")}>
        <SanctionsPanel />
      </div>
     </PinnedDateProvider>
    </HealthProvider>
  );
}
