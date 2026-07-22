import { useState, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import SilverCoTTracker from "./silver_cot_tracker";
import ComexInventoryDashboard from "./comex_inventory";
import MoneySupply from "./money_supply";
import CatcorPanel from "./catcor_panel";
import DataPanel, { computeStatus } from "./data_panel";
import ResearchPanel from "./research_panel";

const SECTIONS = [
  { key: "cot", label: "Trading" },
  { key: "moneySupply", label: "Money Supply" },
  { key: "inventory", label: "Inventory" },
  { key: "catcor", label: "CATCOR" },
  { key: "research", label: "Research" },
  { key: "data", label: "Data" },
];

const HEALTH_POLL_INTERVAL_MS = 60000;

// Small passive-visibility dot (Story #7) — red if any tracked source is
// erroring, yellow if any is stale with no errors, green otherwise. Links
// nowhere; the Data tab nav button is already one click away for the
// per-source drill-down (Decision 4). Shares data_panel.jsx's exported
// computeStatus rather than re-implementing the same ok/stale/error rule
// inline (a real duplication that existed before this fix) — its numeric
// threshold (expected_interval_s) now ships directly on each /api/health/db
// row (derived server-side from backend/sources.py's CadenceSpec), so this
// component no longer needs a separate static import for that number at all.
function HeaderHealthDot() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    const poll = () => {
      fetch("/api/health/db")
        .then((r) => r.json())
        .then((j) => {
          const rows = Object.values(j.sources ?? {});
          let worst = "ok";
          for (const row of rows) {
            const rowStatus = computeStatus(row, row.expected_interval_s);
            if (rowStatus === "error") worst = "error";
            else if (rowStatus === "stale" && worst !== "error") worst = "stale";
          }
          setStatus(worst);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, HEALTH_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  if (!status) return null;
  const color = status === "error" ? "#e0555c" : status === "stale" ? "#d9a441" : "#4caf76";
  return <span className="header-health-dot" style={{ background: color }} title={`Data health: ${status}`} />;
}

const TICKER_POLL_INTERVAL_MS = 60000; // same cadence as HeaderHealthDot — the fast tier's own 60s cadence, no point polling faster than new ticks can actually arrive
const TICKER_SPARKLINE_HOURS = 3; // "2-3 hours of history" — real spot_price ticks only (see HeaderTicker's own note on why this stays off the daily/leverage chart's data)

// Fixed-content tooltip for the expanded ticker chart — factual only (time
// + price), no prediction/target framing per AV Voice Rules.
function TickerTooltipContent({ active, payload, color }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;
  return (
    <div style={{ background: "#141820", border: "1px solid #2e3547", padding: "6px 8px", fontSize: 11 }}>
      <div style={{ color: "#8a94a6" }}>{new Date(row.ts).toLocaleTimeString()}</div>
      <div style={{ color }}>${row.price.toFixed(2)}</div>
    </div>
  );
}

// One collapsible row per metal — collapsed shows just label/price/change
// (no chart), matching every other collapsible-pane summary in the app.
// Expanded reveals the real chart: last ~3h of REAL spot ticks
// (spot_price's XAG_SPOT/XAU_SPOT via /api/prices/db/ticks — the same
// tick-resolution feed the Paper Games panel's leverage chart deliberately
// does NOT use, since that chart wants years of daily history, not hours
// of live ticks). Purely a "stuff's running" visual, not a trading
// readout — no price targets/prediction framing. Price change shown is
// absolute change over the fetched window, not a 24h %, since the point
// here is "what's the live feed showing right now."
function TickerRow({ metalKey, label, color, ticks }) {
  if (!ticks || ticks.length === 0) return null;
  const latest = ticks[ticks.length - 1].price;
  const first = ticks[0].price;
  const change = latest - first;
  const changeColor = change === 0 ? "#5a6278" : change > 0 ? "#4caf76" : "#e0555c";

  return (
    <details className="collapsible-pane header-ticker-pane">
      <summary className="collapsible-pane-title header-ticker-summary">
        <span className="header-ticker-label" style={{ color }}>{label}</span>
        <span className="header-ticker-price">${latest.toFixed(2)}</span>
        <span className="header-ticker-pct" style={{ color: changeColor }}>
          {change >= 0 ? "+" : ""}{change.toFixed(2)}
        </span>
      </summary>
      <div className="collapsible-pane-body">
        {ticks.length > 1 ? (
          <ResponsiveContainer width="100%" height={140}>
            <LineChart data={ticks} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e2333" />
              <XAxis
                dataKey="ts"
                tickFormatter={(t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
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
          <div className="comex-empty">Not enough real ticks yet — check back in a minute.</div>
        )}
      </div>
    </details>
  );
}

function HeaderTicker() {
  const [series, setSeries] = useState(null); // { XAG: [{ts,price}, ...], XAU: [...] } | null

  useEffect(() => {
    const poll = () => {
      Promise.all(
        ["XAG", "XAU"].map((key) =>
          fetch(`/api/prices/db/ticks?series_id=${key}&hours=${TICKER_SPARKLINE_HOURS}`)
            .then((r) => r.json())
            .then((j) => [key, j.data ?? []])
        )
      )
        .then((pairs) => setSeries(Object.fromEntries(pairs)))
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, TICKER_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  if (!series) return null;

  const rows = [
    { key: "XAG", label: "Ag", color: "#5aa9e6", ticks: series.XAG },
    { key: "XAU", label: "Au", color: "#e0c14c", ticks: series.XAU },
  ];

  return (
    <div className="header-ticker">
      {rows.map(({ key, label, color, ticks }) => (
        <TickerRow key={key} metalKey={key} label={label} color={color} ticks={ticks} />
      ))}
    </div>
  );
}

export default function App() {
  const [activeSection, setActiveSection] = useState("cot");
  const [pinnedSection, setPinnedSection] = useState(null);
  // Cross-panel hotlink: CatcorPanel sets this when a promoted (Observed-
  // origin) catalyst's dot is clicked, so the Research tab opens straight
  // into that session's record instead of its own session list.
  const [openResearchSessionId, setOpenResearchSessionId] = useState(null);

  function openResearchSession(sessionId) {
    setOpenResearchSessionId(sessionId);
    setActiveSection("research");
  }

  // On first load, open whichever tab is pinned (if any) instead of always
  // defaulting to CoT — the pin is a shared, server-persisted setting
  // (backend/db.py's ui_settings table), not a per-browser localStorage
  // value, so it's consistent across devices/reloads.
  useEffect(() => {
    fetch("/api/ui/pinned-section")
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
    fetch("/api/ui/pinned-section", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section: next }),
    }).catch(() => {});
  }

  return (
    <>
      <div className="app-shell">
        <div className="app-header app-header--split">
          <div>
            <div className="app-title">
              ArgentVigil
              <HeaderHealthDot />
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
                onClick={() => setActiveSection(s.key)}
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

      <div className={activeSection === "cot" ? "" : "section-hidden"}>
        <SilverCoTTracker />
      </div>
      <div
        className={
          "app-shell" + (activeSection === "moneySupply" ? "" : " section-hidden")
        }
      >
        <MoneySupply />
      </div>
      <div
        className={
          "app-shell" + (activeSection === "inventory" ? "" : " section-hidden")
        }
      >
        <ComexInventoryDashboard />
      </div>
      <div
        className={
          "app-shell" + (activeSection === "catcor" ? "" : " section-hidden")
        }
      >
        <CatcorPanel onOpenResearchSession={openResearchSession} />
      </div>
      <div className={activeSection === "research" ? "" : "section-hidden"}>
        <ResearchPanel
          openSessionId={openResearchSessionId}
          onOpenedSession={() => setOpenResearchSessionId(null)}
        />
      </div>
      <div
        className={
          "app-shell" + (activeSection === "data" ? "" : " section-hidden")
        }
      >
        <DataPanel />
      </div>
    </>
  );
}
