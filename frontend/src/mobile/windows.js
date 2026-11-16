// Window sets per panel (mobile-spec.md Principle 7). Each panel keeps its
// desktop set; 45D is added only where a story names 45 days.
export const D45 = { key: "45d", label: "45D", days: 45 };

export const TRADING_WINDOWS = [
  { key: "1w", label: "1W", days: 7 },
  { key: "1m", label: "1M", days: 30 },
  { key: "6m", label: "6M", days: 182 },
  { key: "1y", label: "1Y", days: 365 },
  { key: "all", label: "All", all: true },
];

export const W1 = { key: "1w", label: "1W", days: 7 };
export const W2 = { key: "2w", label: "2W", days: 14 };
export const D30 = { key: "30d", label: "30D", days: 30 };

export const INVENTORY_WINDOWS = [
  W1,
  W2,
  D30,
  D45,
  { key: "3m", label: "3M", days: 91 },
  { key: "6m", label: "6M", days: 182 },
  { key: "all", label: "All", all: true },
];

// Money keeps 2Y/5Y/10Y/20Y/Custom. "Since 2000" exceeds 20Y so it is the
// Custom range, selected on load (Appendix B).
export const MONEY_WINDOWS = [
  { key: "2y", label: "2Y", days: 365 * 2 },
  { key: "5y", label: "5Y", days: 365 * 5 },
  { key: "10y", label: "10Y", days: 365 * 10 },
  { key: "20y", label: "20Y", days: 365 * 20 },
];
export const MONEY_NEAR_WINDOWS = [D45, { key: "6m", label: "6M", days: 182 }, { key: "1y", label: "1Y", days: 365 }, { key: "2y", label: "2Y", days: 730 }, { key: "all", label: "All", all: true }];
export const SINCE_2000 = "2000-01-01";
