export const VAULT_COLORS = [
  "#7b9fff", "#4caf76", "#c9a227", "#e05252", "#a78bfa",
  "#38bdf8", "#fb923c", "#f472b6", "#34d399", "#facc15", "#94a3b8",
];

export const CATCOR_EVENT_COLORS = {
  FOMC: "#e05252",
  CPI: "#7b9fff",
  NFP: "#4caf76",
  observed: "#d9a441",
};

export const TRADE_FLOW_COLORS = [
  "#7b9fff", "#4caf76", "#c9a227", "#e05252", "#94a3b8",
];

// Money Management tab (money-management-spec.md) — one categorical set,
// assigned in order within each small-multiple chart. Same hues as
// VAULT_COLORS so the app keeps one visual family.
export const MONEY_MGMT_COLORS = [
  "#7b9fff", "#4caf76", "#c9a227", "#e05252", "#a78bfa", "#38bdf8", "#fb923c",
];

// Money Management asset-share pies. Validated with the dataviz skill's
// validate_palette.js on this app's #141820 panel surface, dark mode,
// adjacent pairs (the pie/stack case): lightness band, chroma floor, CVD
// separation (worst ΔE 8.4), normal-vision floor (worst 19.3) and 3:1
// contrast all PASS. The first two also pass --pairs all (ΔE 26.8), which is
// what the bank screen's 2-slice pie uses. Red (slot 8) added for the top-10
// pie; the 8-slot set re-validated on #141820, all checks PASS. Colors are
// assigned by position in fixed order, never cycled; a 9th+ entity folds into the neutral gray
// "Other" (deliberately low-chroma — it is not a series).
export const MM_PIE_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
export const MM_PIE_OTHER_COLOR = "#6b7280";
export const MM_SURFACE = "#141820"; // 2px ring between slices
// Bank Lookup's top-10 pie: slices 9-10 are each drawn individually in
// MM_PIE_OTHER_COLOR (one neutral, never extra hues); the remainder of the
// population is this darker neutral. Both are deliberately non-series grays,
// identified by legend + direct label, not by hue. Validator (dark, #141820):
// the two grays sit ΔE 16.4 apart (normal and CVD), but #3d4454 is only
// 1.82:1 against the surface — a WARN whose required relief is met by its
// always-rendered % label, its legend row and the ranked table beside it.
// Lighter steps raise contrast but fall under the ΔE 15 floor vs. #6b7280.
export const MM_PIE_REST_COLOR = "#3d4454";
