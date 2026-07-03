import { useState } from "react";
import SilverCoTTracker, { MacroWatchlist } from "./silver_cot_tracker";
import ComexInventoryDashboard from "./comex_inventory";
import MoneySupply from "./money_supply";

export default function App() {
  const [cotData, setCotData] = useState(null);

  return (
    <>
      <SilverCoTTracker onData={setCotData} />
      <div className="section-divider">
        <span className="section-divider-label">COMEX Inventory Dashboard</span>
      </div>
      <ComexInventoryDashboard />
      <div className="section-divider">
        <span className="section-divider-label">Money Supply</span>
      </div>
      <div className="app-shell">
        <MoneySupply />
      </div>
      <div className="section-divider">
        <span className="section-divider-label">Macro Context</span>
      </div>
      <div className="app-shell">
        <MacroWatchlist watchlist={cotData?.macro_watchlist} />
      </div>
    </>
  );
}
