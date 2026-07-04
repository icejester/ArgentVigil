import SilverCoTTracker from "./silver_cot_tracker";
import ComexInventoryDashboard from "./comex_inventory";
import MoneySupply from "./money_supply";

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
    </>
  );
}
