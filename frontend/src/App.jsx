import SilverCoTTracker from "./silver_cot_tracker";
import ComexInventoryDashboard from "./comex_inventory";
import MoneySupply from "./money_supply";
import CatcorPanel from "./catcor_panel";

export default function App() {
  return (
    <>
      <SilverCoTTracker />
      <div className="app-shell">
        <MoneySupply />
      </div>
      <div className="app-shell">
        <ComexInventoryDashboard />
      </div>
      <div className="app-shell">
        <CatcorPanel />
      </div>
    </>
  );
}
