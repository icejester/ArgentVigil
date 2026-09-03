// Shared helpers/constants for the Money Supply tab and its extracted
// sub-panels (treasury_auctions_panel.jsx, tic_holdings_panel.jsx,
// federal_outlays_panel.jsx). Pulled out of money_supply.jsx when those
// three panels moved into their own files — everything here was previously
// module-private in money_supply.jsx and used by more than one panel.

// --- number formatters -------------------------------------------------

export function fmtTrillions(v) {
  if (v == null) return "—";
  return `$${v.toFixed(2)}T`;
}

// Federal Outlays / Outlays by Agency use billions, not trillions like the
// rest of the tab — most individual agencies' monthly figures are well
// under $1T and read as near-invisible fractions ("$0.20T") in trillions.
export function fmtBillions(v) {
  if (v == null) return "—";
  return `$${v.toFixed(1)}B`;
}

export function fmtPct(v) {
  if (v == null) return "—";
  return `${v.toFixed(1)}%`;
}

export function fmtUsd(v) {
  if (v == null) return "—";
  return `$${v.toFixed(2)}`;
}

export function round1(v) {
  return Math.round(v * 10) / 10;
}

// --- chart helpers ---------------------------------------------------

// xTicks now lives in date_utils.js (consolidated from three copies —
// this one, comex_inventory.jsx's, and silver_cot_tracker.jsx's inline
// version). Re-exported so the many `import { xTicks } from
// "./money_supply_shared"` call sites keep working unchanged.
export { xTicks } from "./date_utils";

// --- shared palette --------------------------------------------------

export const RATIO_COLOR = "#e8ecf4"; // pinned-date ReferenceLine on non-M2 charts
export const WIN_COLOR = "#4caf76";
export const LOSS_COLOR = "#e05252";

// Federal Outlays sub-panel — outlays/receipts share the WALCL/M2
// red/green convention (spending = red, income = green); Deficit is a
// derived comparison so it gets its own color; Interest-on-debt is the
// most narratively-loaded figure and is drawn dashed.
export const OUTLAYS_COLOR = "#e05252";
export const RECEIPTS_COLOR = "#4caf76";
export const DEFICIT_COLOR = "#7b9fff";
export const INTEREST_COLOR = "#e0a84c";
