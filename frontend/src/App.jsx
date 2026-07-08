import { useState, useEffect } from "react";
import SilverCoTTracker from "./silver_cot_tracker";
import ComexInventoryDashboard from "./comex_inventory";
import MoneySupply from "./money_supply";
import CatcorPanel from "./catcor_panel";
import DataPanel from "./data_panel";
import ResearchPanel from "./research_panel";
import { DATA_SOURCES } from "./data_map";

const SECTIONS = [
  { key: "cot", label: "CoT" },
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
// per-source drill-down (Decision 4).
function HeaderHealthDot() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    const poll = () => {
      fetch("/api/health/db")
        .then((r) => r.json())
        .then((j) => {
          const sources = j.sources ?? {};
          let worst = "ok";
          for (const source of DATA_SOURCES) {
            for (const [sourceKey, meta] of Object.entries(source.healthMeta ?? {})) {
              const row = sources[sourceKey];
              if (!row) continue;
              if (row.last_attempt_status === "error") {
                worst = "error";
              } else if (row.last_success_at) {
                const ageS = (Date.now() - new Date(row.last_success_at).getTime()) / 1000;
                if (ageS > 2 * meta.expectedIntervalS && worst !== "error") worst = "stale";
              }
            }
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

export default function App() {
  const [activeSection, setActiveSection] = useState("cot");

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
        <CatcorPanel />
      </div>
      <div className={activeSection === "research" ? "" : "section-hidden"}>
        <ResearchPanel />
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
