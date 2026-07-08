import { useState } from "react";
import SilverCoTTracker from "./silver_cot_tracker";
import ComexInventoryDashboard from "./comex_inventory";
import MoneySupply from "./money_supply";
import CatcorPanel from "./catcor_panel";
import DataPanel from "./data_panel";

const SECTIONS = [
  { key: "cot", label: "CoT" },
  { key: "moneySupply", label: "Money Supply" },
  { key: "inventory", label: "Inventory" },
  { key: "catcor", label: "CATCOR" },
  { key: "data", label: "Data" },
];

export default function App() {
  const [activeSection, setActiveSection] = useState("cot");

  return (
    <>
      <div className="app-shell">
        <div className="app-header app-header--split">
          <div>
            <div className="app-title">ArgentVigil</div>
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
