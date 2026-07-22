import { useState, useEffect, useCallback, useMemo } from "react";
import { nearestRowDate } from "./date_utils";
import {
  ComposedChart,
  LineChart,
  Area,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  ReferenceLine,
} from "recharts";

const M2_COLOR = "#4caf76";
const M2_YOY_COLOR = "#7b9fff";
const WALCL_COLOR = "#e05252";
// Liabilities (WRESBAL/RRPONTSYD) get a reddish palette, Assets (WSHOTSL/
// WSHOMCB/WLCFLPCL) get a greenish one — each series keeps its own distinct
// shade within that family so it's still visually distinguishable in "By
// Series" view and the pie's per-slice tooltip, but the group is
// recognizable at a glance (assets = green family, liabilities = red family,
// matching the M2/WALCL chart's own red-share-of-green-area convention).
const WRESBAL_COLOR = "#e05252";
const RRPONTSYD_COLOR = "#c9536b";
const WSHOTSL_COLOR = "#4caf76";
const WSHOMCB_COLOR = "#7fcf9a";
const WLCFLPCL_COLOR = "#2f8f5b";
const RATIO_COLOR = "#e8ecf4";
const FIAT_COLOR = "#1f6f4a";
const PP_COLOR = "#c026d3";
const XAU_COLOR = "#d4af37";
const XAG_COLOR = "#9aa5b1";
const WIN_COLOR = "#4caf76";
const LOSS_COLOR = "#e05252";

// Treasury Yields sub-panel — each series its own distinct shade, no
// group-color convention needed (unlike Composition's assets/liabilities
// split) since these are 4 flat, ungrouped % series on one shared axis.
const DGS2_COLOR = "#7b9fff";
const DGS10_COLOR = "#e0a84c";
const DFII10_COLOR = "#4caf76";
const T10Y2Y_COLOR = "#c9536b";

// M2SL is monthly with a ~4-6wk publication lag; WALCL is weekly with only a
// few days' lag. Different thresholds reflect each series' own normal cadence.
const M2_STALE_DAYS = 45;
const WALCL_STALE_DAYS = 10;

function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr)) / 86400000);
}

function fmtTrillions(v) {
  if (v == null) return "—";
  return `$${v.toFixed(2)}T`;
}

function fmtPct(v) {
  if (v == null) return "—";
  return `${v.toFixed(1)}%`;
}

function xTicks(data, maxTicks = 8) {
  if (!data || data.length === 0) return [];
  const n = Math.min(data.length, maxTicks);
  const step = Math.floor(data.length / n) || 1;
  return data.filter((_, i) => i % step === 0).map((r) => r.date);
}

// All 4 Treasury yield series are real daily FRED series in the same %
// units already — a plain date-key merge, no forward-fill/ratio math
// needed (unlike mergeSeries/mergeComposition below, which bridge series
// on genuinely different cadences).
function mergeYields(dgs2, dgs10, dfii10, t10y2y) {
  const byDate = {};
  for (const [key, rows] of [
    ["dgs2", dgs2],
    ["dgs10", dgs10],
    ["dfii10", dfii10],
    ["t10y2y", t10y2y],
  ]) {
    for (const r of rows || []) {
      byDate[r.date] = { ...(byDate[r.date] || {}), date: r.date, [key]: r.value };
    }
  }
  return Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// M2 (monthly) and WALCL (weekly) have different date grids — merge on date
// so the chart has one row per unique date, gapping series that lack a point.
function mergeSeries(m2, walcl) {
  const byDate = {};
  for (const r of m2 || []) {
    byDate[r.date] = { ...(byDate[r.date] || {}), date: r.date, m2: r.value_trillions, m2_yoy: r.yoy };
  }
  for (const r of walcl || []) {
    byDate[r.date] = { ...(byDate[r.date] || {}), date: r.date, walcl: r.value_trillions };
  }
  const rows = Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
  // WALCL as a % of M2: "how big is the Fed's balance sheet relative to the
  // broader money supply." M2 only updates monthly while WALCL is weekly, so
  // forward-fill the most recent M2 reading onto every row (same "nearest
  // date on/before" convention used elsewhere in this codebase, e.g.
  // VaultSnapshotPanel's pinned-date lookups) rather than only computing the
  // ratio on the rare dates where both series happen to land on the same day.
  // Two dollar-scale values that stack to exactly M2's total, so the chart
  // can shade "this much of the M2 area is the Fed balance sheet" directly
  // rather than plotting WALCL as a separate line the user has to mentally
  // compare against M2's height. walcl_share is WALCL's own dollar value;
  // m2_remainder is whatever's left of M2 above that. Both use a
  // forward-filled WALCL reading (most recent value as of that date), not
  // just whatever's on that exact row — a real bug caught by the user: M2
  // updates on the 1st of the month, a date WALCL (weekly) essentially never
  // has its own row for, so m2_remainder's old "fall back to raw M2 when
  // walcl_share is null for this row" logic quietly used the FULL M2 value
  // instead of M2 minus WALCL on every M2-only row — collapsing the red
  // WALCL band to 0 and spiking the green band to M2's full total on those
  // dates specifically (visually: "WALCL plummets, M2 spikes" on the 1st of
  // nearly every month, though neither series actually moved).
  // Stacked areas (walcl_share/m2_remainder below) need a real value on
  // EVERY row, not just the ~1-in-20 rows where M2 itself reports — a real
  // bug caught by the user ("M2 is spiky"): Recharts' stackId math doesn't
  // interpolate across null rows the same smooth way a plain connectNulls
  // line does, so a stack with real values on only the 1st of each month
  // rendered as visibly jagged even though the underlying M2 series climbs
  // smoothly month to month (confirmed against raw FRED data: no real
  // spikiness exists). Forward-filling M2 (same convention as WALCL below)
  // gives the stack a real number at every x-position, eliminating the
  // misinterpolation. m2Filled is ONLY used for the stacked-area geometry —
  // the raw (non-forward-filled) m2 field stays as-is for the M2 YoY line
  // and the tooltip, which should show "—"/bracket text on days M2 didn't
  // actually report, not a fabricated same-as-last-month number.
  // Forward-fill only bridges INTERIOR gaps (between two real readings) —
  // it must stop once a row's date passes that series' own true last real
  // date, rather than repeating the last known value indefinitely. Without
  // this cap, a real publication-lag gap (M2's real last print can run ~2.5
  // months behind WALCL's) would silently keep "M2" on the chart all the
  // way to today by repeating a stale figure — a real concern the user
  // raised directly ("we've manufactured data that hasn't been released
  // yet"). AV's standing nulls-over-zeros convention says a gap should stay
  // a gap; forward-fill is only for smoothing interpolation within a
  // series' own real coverage window, not for extending it.
  const lastRealM2Date = m2?.length ? m2[m2.length - 1].date : null;
  const lastRealWalclDate = walcl?.length ? walcl[walcl.length - 1].date : null;
  let lastM2 = null;
  let lastWalcl = null;
  for (const row of rows) {
    if (row.m2 != null) lastM2 = row.m2;
    if (row.walcl != null) lastWalcl = row.walcl;
    const m2InRange = lastRealM2Date == null || row.date <= lastRealM2Date;
    const walclInRange = lastRealWalclDate == null || row.date <= lastRealWalclDate;
    const filledM2 = m2InRange ? lastM2 : null;
    const filledWalcl = walclInRange ? lastWalcl : null;
    row.walcl_pct_m2 = row.walcl != null && filledM2 != null && filledM2 !== 0
      ? round1((row.walcl / filledM2) * 100)
      : null;
    row.walcl_share = filledWalcl;
    row.m2_remainder = filledM2 != null && filledWalcl != null
      ? Math.max(0, round1(filledM2 - filledWalcl))
      : null;
  }
  return rows;
}

// All five candidate FRED H.4.1 series (fed-balance-spec.md), weekly like
// WALCL but on a much smaller scale — kept as their own chart rather than
// added to the M2/WALCL dual-axis chart above, so that chart's scale isn't
// disturbed. Merge on date, same convention as mergeSeries.
// `label` (with FRED acronym) is used anywhere the series needs to be tied
// back to its real FRED series_id — the line-chart tooltip in "By Series"
// view. `legendLabel` (no acronym) is used everywhere user-facing: the pie
// chart's own on-slice labels/tooltip (the pie chart IS the legend now —
// see the JSX below) and the "By Series" checkbox row. Same underlying
// series, two presentations for two audiences.
//
// `group` matters more than it looks: these 5 series are NOT 5 slices of one
// pie. WSHOTSL/WSHOMCB/WLCFLPCL are genuinely "Assets:" series per FRED's own
// titles — they're what WALCL (the Fed's total-assets figure) is made of,
// and roughly sum to it. WRESBAL is explicitly "Liabilities:" per FRED's
// title — the other side of the same balance sheet, not a slice of the
// asset total. RRPONTSYD is a separate temporary-open-market-operations
// mechanism, balance-sheet-adjacent but not an "Assets:" line either.
// Confirmed live against FRED's /fred/series titles after a real user-caught
// bug: an earlier version summed all 5 into one "Total Balance" and one pie,
// which silently double-counted assets against liabilities (on 2023-03-22,
// summing all 5 gives ~$13.75T against WALCL's real $8.73T that same week).
const COMPOSITION_SERIES = [
  {
    key: "wresbal",
    label: "Bank Reserves (WRESBAL)",
    legendLabel: "Bank Reserves",
    color: WRESBAL_COLOR,
    group: "liabilities",
    eli5: "Reserves = bank balances held at the Fed, credited whenever the Fed buys Treasuries/MBS (QE). Not the bank's own capital — it's a liability the Fed owes the bank, not money the bank earned or risked.\n\nAt 0% reserve requirement, banks don't need reserves to lend — every loan creates new money on the spot, capped only by capital requirements (Basel III), not liquidity.\n\nSince 2008, the Fed pays interest on reserves (IORB) — a risk-free, government-set return for parking a balance the bank did nothing to earn. Banks profit twice off separate pools: interest on loans they underwrite (real risk, real work) and IORB on reserves (zero risk, zero work).\n\nSince 2022, the Fed has been paying out more in IORB than it earns on its own older assets — running losses covered by an internal IOU, funded by foregone remittances to Treasury (i.e., revenue the government would've otherwise used to offset the deficit). Reserve growth ≠ credit reaching the economy — it can just be banks collecting rent on a balance the Fed itself created.",
  },
  {
    key: "rrpontsyd",
    label: "Reverse Repo Facility (RRPONTSYD)",
    legendLabel: "Reverse Repo Facility",
    color: RRPONTSYD_COLOR,
    group: "liabilities",
    eli5: "Reserves are for banks. RRP is the equivalent parking lot for everyone else with a giant pile of cash — money market funds, mostly. They hand the Fed cash overnight, get a Treasury back as collateral, and collect Fed-set interest, risk-free, same idea as IORB just for non-banks.\n\nWho benefits: money market funds (and by extension, the millions of people/institutions parked in them) get a guaranteed, no-risk return set by the Fed — again, for doing nothing productive with the money. This is why RRP and bank reserves are basically substitutes: liquidity the Fed pumps out via QE goes wherever the return is best, RRP or reserves, same free lunch either way.\n\nRRP usage exploding (2021–2023, up to ~$2.5T) while bank reserves stayed flatter is the tell that liquidity was parking outside the traditional banking system entirely — same 'sitting on free money instead of funding real activity' story, just a different address for the cash.",
  },
  {
    key: "wshotsl",
    label: "Treasuries Held (WSHOTSL)",
    legendLabel: "Treasuries Held",
    color: WSHOTSL_COLOR,
    group: "assets",
    eli5: "The Fed's pile of U.S. government debt — the single biggest line on its balance sheet. When the Fed buys these (QE), it's not spending tax revenue; it's crediting reserve accounts with new balances, as covered above. The Fed earns interest on every dollar of this pile.\n\nWho benefits: the Treasury gets a guaranteed buyer for its debt, which keeps government borrowing costs artificially lower than the free market would otherwise demand. Banks and bond dealers who sell into QE get paid up front, in cash/reserves, for assets they were going to hold anyway — a built-in bid whenever the Fed is buying.\n\nSince 2022 rate hikes, this pile is the other side of the Fed's cash-flow problem: it's stuck earning yesterday's lower rates while paying today's higher IORB on the liabilities side. The Fed is running the government's bond desk at a loss, funded by foregone remittances to Treasury.",
  },
  {
    key: "wshomcb",
    label: "MBS Held (WSHOMCB)",
    legendLabel: "Mortgage-Backed Securities Held",
    color: WSHOMCB_COLOR,
    group: "assets",
    eli5: "Mortgage-backed securities the Fed bought, mostly during 2020's emergency QE — bundles of home loans repackaged into a bond. Same mechanic as Treasuries: the Fed credits reserves to buy them, not cash.\n\nWho benefits: this is a direct subsidy to the mortgage market and the banks/originators selling loans into it — the Fed buying MBS in bulk pushes mortgage rates down and gives banks an instant, liquid buyer for loans they'd otherwise have to hold and hope get paid back. It's targeted stimulus for housing and mortgage lenders specifically, not the broader economy.\n\nThe Fed has been letting this run off (QT) rather than selling outright — but even that's slow, since prepayments (people refinancing/selling) are the only thing shrinking it, and higher rates mean fewer people are doing either. So the Fed is stuck holding a pile of below-market-rate mortgages, still losing money on the spread the same way it is on Treasuries.",
  },
  {
    key: "wlcflpcl",
    label: "Discount Window Lending (WLCFLPCL)",
    legendLabel: "Discount Window Lending",
    color: WLCFLPCL_COLOR,
    group: "assets",
    eli5: "Direct emergency loans from the Fed straight to individual banks, collateralized, short-term — the 'break glass' facility for a bank that's suddenly short on cash and can't borrow from anyone else overnight.\n\nWho benefits: whichever bank is desperate enough to use it. This one's actually a bit self-limiting as a wealth-transfer mechanic — the rate charged is deliberately above market (a penalty rate), specifically so healthy banks don't casually tap it, and using it publicly signals weakness (bank runs have started over a bank being spotted at the window — SVB, 2023).\n\nA sudden spike here is a real distress signal, not a subsidy — it means specific institutions are in genuine trouble. Nearly flat/zero most of the time; watch this one for stress, not for steady rent-seeking.",
  },
];

const COMPOSITION_GROUPS = {
  assets: { label: "Assets", totalKey: "totalAssets" },
  liabilities: { label: "Liabilities", totalKey: "totalLiabilities" },
};

// M2/WALCL chart's own legend, same shape as COMPOSITION_SERIES
// (legendLabel for the compact clickable row, eli5 for the full
// explanation shown only when that row is clicked) — added to give this
// legend the same look and click-to-reveal behavior as Composition's,
// per the user's explicit request. `dashed: true` marks the M2 YoY %
// entry, whose swatch is a dashed outline (matching its dashed line on
// the chart) rather than a solid fill.
const M2_LEGEND_SERIES = [
  {
    key: "m2",
    legendLabel: "M2 Money Stock",
    color: M2_COLOR,
    eli5: "Broad U.S. dollar money supply (cash, checking/savings deposits, retail money-market funds), left axis, trillions USD. Published monthly. The full green+red area together is the total M2.",
  },
  {
    key: "walcl",
    legendLabel: "Fed Balance Sheet",
    color: WALCL_COLOR,
    eli5: "Total assets held by the Federal Reserve (Treasuries, MBS, and other holdings from QE/QT operations), shaded in red as the share of the M2 area it takes up — \"how big is the Fed's balance sheet relative to the broader money supply,\" shown as a portion of the whole rather than a separate line. Left axis, same dollar scale as M2. Published weekly; M2 only updates monthly, so this uses the most recent M2 reading available as of each date.",
  },
  {
    key: "m2_yoy",
    legendLabel: "M2 YoY %",
    color: M2_YOY_COLOR,
    dashed: true,
    eli5: "Year-over-year percent change in M2, right axis. Shows the rate of money-supply growth or contraction, not the level.",
  },
];

// QE/QT chart's legend, same shape as M2_LEGEND_SERIES/COMPOSITION_SERIES
// (UI_STANDARDS.md: click-to-toggle detail + chart highlight, applied
// consistently across every legend in this panel). "change" has no single
// swatch color of its own — per week it's colored green (grew, "QE") or red
// (shrank, "QT") as a Bar, per UI_STANDARDS.md's color convention — so its
// legend swatch shows both halves via a gradient rather than picking one.
const QE_QT_LEGEND_SERIES = [
  {
    key: "change",
    legendLabel: "Weekly Change (Assets)",
    color: `linear-gradient(90deg, ${WIN_COLOR} 50%, ${LOSS_COLOR} 50%)`,
    eli5: "Week-over-week change in the Fed's total assets (Treasuries + MBS + Discount Window Lending). Green bars = assets grew that week (\"QE,\" quantitative easing). Red bars = assets shrank (\"QT,\" quantitative tightening). Left axis, billions USD.",
  },
  {
    key: "totalAssets",
    legendLabel: "Balance Sheet Total (Assets)",
    color: RATIO_COLOR,
    dashed: true,
    eli5: "The Fed's total assets level itself (Treasuries + MBS + Discount Window Lending), right axis, trillions USD — plotted alongside its own week-over-week change so the level and the momentum are visible on one chart. Same totalAssets figure shown in the Fed Balance Sheet Composition chart above.",
  },
];

// Treasury Yields sub-panel's legend — same shape/behavior as every other
// legend in this panel (click to highlight + reveal eli5). Flat, ungrouped
// series (no assets/liabilities split like Composition), all sharing one
// % axis, so no dashed/gradient swatches needed here.
const YIELDS_LEGEND_SERIES = [
  {
    key: "dgs2",
    legendLabel: "2-Year Yield",
    color: DGS2_COLOR,
    eli5: "Market yield on the 2-Year Treasury, daily — read as the market's near-term expectation for where the Fed funds rate is headed over the next couple years. Rises when the market expects tighter policy (higher rates for longer), falls when it expects cuts.",
  },
  {
    key: "dgs10",
    legendLabel: "10-Year Yield",
    color: DGS10_COLOR,
    eli5: "Market yield on the 10-Year Treasury, daily — the most commonly cited long-term rate benchmark (mortgage rates, corporate borrowing costs, and \"risk-free rate\" comparisons all reference this). Reflects longer-run growth/inflation expectations, not just near-term Fed policy.",
  },
  {
    key: "dfii10",
    legendLabel: "10-Year Real Yield (TIPS)",
    color: DFII10_COLOR,
    eli5: "The 10-Year yield adjusted for expected inflation (TIPS-derived) — the rate most often cited as gold's actual competing return, since gold pays no yield of its own. When real yields rise, holding gold instead of a real-yielding bond costs more in forgone interest; when real yields fall (or go negative), that cost shrinks or reverses, which is the textbook mechanism behind gold's inverse real-rate relationship. Not a guarantee gold moves opposite this on any given day — plenty of other forces (dollar strength, physical demand, positioning) move gold too — but this is the one rate series most directly tied to gold's opportunity cost.",
  },
  {
    key: "t10y2y",
    legendLabel: "10Y–2Y Spread",
    color: T10Y2Y_COLOR,
    eli5: "10-Year yield minus 2-Year yield — the classic yield-curve slope. Negative (inverted) has historically preceded most U.S. recessions by 12-18 months; it means the market expects the Fed to cut rates more than it's currently signaling. Shown here as context alongside the two rates it's built from, not as a standalone prediction.",
  },
];

function mergeComposition(data) {
  const byDate = {};
  for (const { key } of COMPOSITION_SERIES) {
    for (const r of data?.[key] || []) {
      byDate[r.date] = { ...(byDate[r.date] || {}), date: r.date, [key]: r.value_trillions };
    }
  }
  const rows = Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
  // Two totals, not one — assets (WSHOTSL+WSHOMCB+WLCFLPCL, should roughly
  // track WALCL) and liabilities (WRESBAL+RRPONTSYD) are opposite sides of
  // the same balance sheet and must never be summed together (see the
  // COMPOSITION_SERIES comment above for the bug this replaced).
  //
  // Totals are computed from FORWARD-FILLED per-series values, not each
  // row's own raw value — same fix as mergeSeries' m2_remainder/walcl_share
  // (see that function's comment for the full story). RRPONTSYD is daily
  // but the other four series are weekly-as-of-Wednesday, so a row's own
  // WSHOTSL/WSHOMCB/WLCFLPCL/WRESBAL are null on ~4 out of every 5 rows —
  // without forward-filling, totalAssets/totalLiabilities (and everything
  // derived from them: the ratio, the Assets/Liabilities/Both stacked
  // areas, the QE/QT week-over-week diff) were only non-null on the rare
  // Wednesdays where all of a group's series happened to have their own
  // row, and Recharts' stackId math doesn't interpolate across those nulls
  // the same smooth way a plain connectNulls line does — a real bug caught
  // by the user ("the Total Assets line is spiky") even though the
  // underlying FRED series climb/decline smoothly week to week.
  // Forward-fill must stop once a row's date passes that series' own true
  // last real date, same fix/reasoning as mergeSeries' lastRealM2Date cap —
  // otherwise a real publication gap on any one series would silently keep
  // repeating its last known value on every later row, which reads as
  // "manufactured data that hasn't actually been released yet."
  const lastRealDate = {};
  for (const { key } of COMPOSITION_SERIES) {
    const rowsForKey = data?.[key];
    lastRealDate[key] = rowsForKey?.length ? rowsForKey[rowsForKey.length - 1].date : null;
  }
  const lastValue = {};
  for (const row of rows) {
    for (const { key } of COMPOSITION_SERIES) {
      if (row[key] != null) lastValue[key] = row[key];
      const inRange = lastRealDate[key] == null || row.date <= lastRealDate[key];
      // "_filled" fields are what the Assets/Liabilities/Both stacked-area
      // charts actually render (see the JSX below) — the raw `key` field is
      // kept as-is (real gaps and all) for "By Series" line view and the
      // tooltip's per-series bracket lookup, which should legitimately show
      // "—"/a bracket on a day that series didn't report, not a fabricated
      // forward-filled number presented as if it were real.
      row[`${key}_filled`] = inRange ? (lastValue[key] ?? null) : null;
    }
    for (const groupKey of Object.keys(COMPOSITION_GROUPS)) {
      const { totalKey } = COMPOSITION_GROUPS[groupKey];
      let sum = null;
      for (const { key, group } of COMPOSITION_SERIES) {
        const filled = row[`${key}_filled`];
        if (group === groupKey && filled != null) sum = (sum ?? 0) + filled;
      }
      row[totalKey] = sum;
    }
    // Assets:Liabilities ratio — how many dollars of assets the Fed holds
    // per dollar of (tracked) liabilities. Not clamped/smoothed: when
    // Liabilities is near zero (RRPONTSYD usage has largely dried up
    // recently), the ratio can swing to a large number — that's a real
    // reading, not a display bug, so it's left as-is rather than capped.
    row.assetsLiabilitiesRatio = row.totalAssets != null && row.totalLiabilities != null && row.totalLiabilities !== 0
      ? round1(row.totalAssets / row.totalLiabilities)
      : null;
  }
  // Week-over-week change in the Assets total — the QE/QT signal itself.
  // Positive = the Fed's asset holdings grew since the prior weekly reading
  // (QE-like expansion); negative = shrank (QT-like contraction). Diffed
  // against the previous row that actually has a totalAssets reading (the
  // prior Wednesday), not just the previous row in the array, since most
  // rows are RRPONTSYD-only daily rows with no totalAssets value.
  // In $ BILLIONS, not trillions — real weekly changes are usually in the
  // $1B-$150B range, well below round1's 1-decimal-in-trillions precision
  // (i.e. $100B buckets), which was silently flattening nearly every real
  // week's change to 0.0 — a real bug the user caught by noticing the QE/QT
  // chart looked flat for a stretch that FRED's own data shows was not flat.
  let prevAssets = null;
  for (const row of rows) {
    row.assetsChangeBillions = row.totalAssets != null && prevAssets != null
      ? Math.round((row.totalAssets - prevAssets) * 1000)
      : null;
    if (row.totalAssets != null) prevAssets = row.totalAssets;
  }
  return rows;
}

// Hovering a non-Wednesday day has no real reading for 4 of the 5 series
// (only RRPONTSYD is daily) — snap to the nearest row on or before the
// hovered date that has every WEEKLY series in the given group populated,
// same "nearest date on/before" convention VaultSnapshotPanel uses for its
// own pinned-date lookups, so the pie chart never renders with missing
// slices. RRPONTSYD is deliberately excluded from the "required" check
// (both for the liabilities group and the ungrouped/"all" case) — it's not
// just off-cadence like the other four, it has a genuine ~9-month gap with
// NO real FRED data at all (2006-07-19 through 2007-04-26), confirmed live.
// Requiring it would make the whole liabilities pie empty for that entire
// window even though WRESBAL alone has real data there — a real bug the
// user caught by hovering 1/29/2007 and getting nothing back. RRPONTSYD
// still renders in the pie/tooltip on rows where it happens to have a real
// value (via compositionPieData's own >0 filter), just isn't required for
// the nearest-row lookup to succeed.
function findNearestCompositionRow(rows, hoveredDate, groupKey) {
  const requiredKeys = (groupKey
    ? COMPOSITION_SERIES.filter((s) => s.group === groupKey && s.key !== "rrpontsyd")
    : COMPOSITION_SERIES.filter((s) => s.key !== "rrpontsyd")
  ).map((s) => s.key);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.date > hoveredDate) continue;
    if (requiredKeys.every((k) => row[k] != null)) return row;
  }
  return null;
}

// XAG/XAU are month-end resampled (last trading day of the month), while
// CPI-derived purchasing power is stamped on the 1st of each month by FRED —
// they're both "one point per calendar month" but never share an exact date
// string. Merge by year-month instead of exact date so all three series
// land on the same row and render as continuous lines together.
function monthKey(dateStr) {
  return dateStr.slice(0, 7); // YYYY-MM
}

function mergeMetals(xag, xau, purchasingPower) {
  const byMonth = {};
  for (const r of xag || []) {
    const k = monthKey(r.date);
    byMonth[k] = { ...(byMonth[k] || {}), date: r.date, xag_price: r.price, xag_index: r.index };
  }
  for (const r of xau || []) {
    const k = monthKey(r.date);
    byMonth[k] = { ...(byMonth[k] || {}), date: byMonth[k]?.date ?? r.date, xau_price: r.price, xau_index: r.index };
  }
  for (const r of purchasingPower || []) {
    const k = monthKey(r.date);
    byMonth[k] = { ...(byMonth[k] || {}), date: byMonth[k]?.date ?? r.date, pp_index: r.index };
  }
  // Fiat is a flat $100 nominal-dollar count — a dollar is always worth
  // exactly one dollar, nominally, regardless of what it can buy. Distinct
  // from pp_index (CPI-adjusted purchasing power, which does move).
  for (const row of Object.values(byMonth)) {
    row.fiat_index = 100;
  }
  return Object.values(byMonth).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Rebase all three indexed series against whichever one is the selected
// baseline, so the baseline reads as a flat 0% line and the other two show
// their real (relative) performance against it. For two series already
// indexed to 100 at the window start, A's return relative to B at time t is
// (A[t]/A[0]) / (B[t]/B[0]) - 1 — since A[0]==B[0]==100, this simplifies to
// A[t]/B[t] - 1, expressed as a percent.
// Purchasing power isn't a holdable asset — you can't "hold" it the way you
// hold cash, gold, or silver, so it's excluded as a baseline choice. It's
// still shown as a comparison line and can still be shown/hidden.
const METAL_SERIES = [
  { key: "fiat_index", label: "Fiat ($100)", shortLabel: "fiat", selectableBaseline: true },
  { key: "xau_index", label: "Gold (XAU)", shortLabel: "Au", selectableBaseline: true },
  { key: "xag_index", label: "Silver (XAG)", shortLabel: "Ag", selectableBaseline: true },
  { key: "pp_index", label: "Purchasing Power", shortLabel: "PP", selectableBaseline: false },
];

function rebaseToBaseline(rows, baselineKey) {
  return rows.map((row) => {
    const baseVal = row[baselineKey];
    const out = { date: row.date, xau_price: row.xau_price, xag_price: row.xag_price };
    for (const { key } of METAL_SERIES) {
      if (key === baselineKey) {
        out[key] = row[key] != null ? 0 : null;
      } else {
        out[key] = row[key] != null && baseVal != null
          ? round1((row[key] / baseVal - 1) * 100)
          : null;
      }
    }
    return out;
  });
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// Hypothetical stake used to show the held-comparison tooltip's relative
// return in dollars alongside the percentage — "if I'd put $100 into the
// baseline on the held date, what would that $100 be worth today judged
// against each series' move?" Purely illustrative, not a position size.
const HELD_STAKE_USD = 100;

// "If I'd bought on the held date, where do I stand as of the latest data?"
// Re-anchors each series to 0% at the held date (instead of the window
// start), then rebases against whichever series is the current baseline —
// same ratio math as rebaseToBaseline, just with a different zero point.
// Operates on the pre-rebase indexed rows so the held date becomes the new
// 100 for each series independently, regardless of what the window-start
// rebase currently shows on the chart.
function computeHeldComparison(indexedRows, heldDateStr, baselineKey) {
  const heldIdx = indexedRows.findIndex((r) => r.date === heldDateStr);
  if (heldIdx === -1) return null;
  const heldRow = indexedRows[heldIdx];

  // The most recent row isn't necessarily fully populated — CPI-derived
  // purchasing power lags 1-2 months behind the month-end metal closes, so
  // the newest row(s) can be missing pp_index while xag/xau are already
  // filled in. Use the latest row where ALL three series have a value, so
  // the comparison always has real numbers instead of silently going null.
  let latestRow = null;
  for (let i = indexedRows.length - 1; i >= 0; i--) {
    const r = indexedRows[i];
    if (METAL_SERIES.every(({ key }) => r[key] != null)) {
      latestRow = r;
      break;
    }
  }
  if (!latestRow) return null;

  const returns = {};
  for (const { key } of METAL_SERIES) {
    const heldVal = heldRow[key];
    const latestVal = latestRow[key];
    returns[key] = heldVal != null && latestVal != null
      ? round1((latestVal / heldVal - 1) * 100)
      : null;
  }

  const baseReturn = returns[baselineKey];
  const relative = {};
  const stakeValue = {};
  for (const { key } of METAL_SERIES) {
    if (key === baselineKey) {
      relative[key] = returns[key] != null ? 0 : null;
    } else {
      relative[key] = returns[key] != null && baseReturn != null
        ? round1(((1 + returns[key] / 100) / (1 + baseReturn / 100) - 1) * 100)
        : null;
    }
    stakeValue[key] = relative[key] != null
      ? Math.round((HELD_STAKE_USD * (1 + relative[key] / 100)) * 100) / 100
      : null;
  }

  return { heldDate: heldRow.date, latestDate: latestRow.date, relative, stakeValue };
}

// For a sparser series (e.g. monthly M2 on a weekly-merged grid), a hovered
// date often has no real reading of its own. Rather than show "—", find the
// nearest known reading before and after that date and show that bracket —
// the true range the real value falls inside of.
function bracketFor(rows, index, key) {
  let before = null;
  for (let i = index; i >= 0; i--) {
    if (rows[i][key] != null) {
      before = rows[i];
      break;
    }
  }
  let after = null;
  for (let i = index; i < rows.length; i++) {
    if (rows[i][key] != null) {
      after = rows[i];
      break;
    }
  }
  return { before, after };
}

function bracketLabel(before, after, key, fmt) {
  if (!before && !after) return "—";
  if (before && after && before.date === after.date) return fmt(before[key]);
  if (!before) return `≤ ${fmt(after[key])} (as of ${after.date})`;
  if (!after) return `≥ ${fmt(before[key])} (as of ${before.date})`;
  return `${fmt(before[key])} (${before.date}) – ${fmt(after[key])} (${after.date})`;
}

function MoneySupplyTooltip({ active, payload, label, merged }) {
  if (!active || !payload || !payload.length) return null;
  const index = merged.findIndex((r) => r.date === label);
  if (index === -1) return null;
  const row = merged[index];

  const m2Text =
    row.m2 != null
      ? fmtTrillions(row.m2)
      : bracketLabel(...Object.values(bracketFor(merged, index, "m2")), "m2", fmtTrillions);
  const walclText =
    row.walcl != null
      ? fmtTrillions(row.walcl)
      : bracketLabel(...Object.values(bracketFor(merged, index, "walcl")), "walcl", fmtTrillions);
  const walclPctText =
    row.walcl_pct_m2 != null
      ? fmtPct(row.walcl_pct_m2)
      : bracketLabel(...Object.values(bracketFor(merged, index, "walcl_pct_m2")), "walcl_pct_m2", fmtPct);
  const yoyText =
    row.m2_yoy != null
      ? fmtPct(row.m2_yoy)
      : bracketLabel(...Object.values(bracketFor(merged, index, "m2_yoy")), "m2_yoy", fmtPct);

  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{label}</div>
      <div style={{ color: M2_COLOR }}>M2 Money Stock: {m2Text}</div>
      <div style={{ color: WALCL_COLOR }}>Fed Balance Sheet: {walclPctText} of M2 ({walclText})</div>
      <div style={{ color: M2_YOY_COLOR }}>M2 YoY %: {yoyText}</div>
    </div>
  );
}

// Shared by the Composition chart's live Recharts <Tooltip> (hover) and the
// pinned-tooltip box rendered below the chart (click) — same content either
// way, just a different trigger for when it's shown.
function CompositionTooltipContent({ active, label, composition, compositionView, compositionPieGroup }) {
  if (!active || !label) return null;
  const row = findNearestCompositionRow(composition, label, compositionPieGroup) ?? {};
  const isExact = row.date === label;
  // Detailed totals: not just the two group sums, but each of the 5
  // individual series' own values, grouped under Assets (green) /
  // Liabilities (red) headers — added at the user's request. Scoped to
  // whichever group(s) the current view actually shows (compositionView
  // "assets"/"liabilities" only render their own group; "both" renders
  // both) rather than always showing all 5 regardless of view.
  const showAssets = compositionView !== "liabilities";
  const showLiabilities = compositionView !== "assets";
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>
        {label}
        {!isExact && row.date && (
          <span style={{ color: "#5a6278" }}> (nearest weekly reading: {row.date})</span>
        )}
      </div>
      {showAssets && (
        <>
          <div style={{ color: WIN_COLOR, fontWeight: 600 }}>Total Assets: {fmtTrillions(row.totalAssets)}</div>
          {COMPOSITION_SERIES.filter(({ group }) => group === "assets").map(({ key, legendLabel }) => (
            <div key={key} style={{ color: WIN_COLOR, marginLeft: 10 }}>
              {legendLabel}: {fmtTrillions(row[`${key}_filled`])}
            </div>
          ))}
        </>
      )}
      {showLiabilities && (
        <>
          <div style={{ color: LOSS_COLOR, fontWeight: 600, marginTop: showAssets ? 4 : 0 }}>
            Total Liabilities: {fmtTrillions(row.totalLiabilities)}
          </div>
          {COMPOSITION_SERIES.filter(({ group }) => group === "liabilities").map(({ key, legendLabel }) => (
            <div key={key} style={{ color: LOSS_COLOR, marginLeft: 10 }}>
              {legendLabel}: {fmtTrillions(row[`${key}_filled`])}
            </div>
          ))}
        </>
      )}
      <div style={{ color: RATIO_COLOR, marginTop: 4 }}>
        Assets : Liabilities — {row.assetsLiabilitiesRatio != null ? `${row.assetsLiabilitiesRatio}x` : "—"}
      </div>
    </div>
  );
}

// Shared by the QE/QT chart's live Recharts <Tooltip> (hover) and the
// pinned-tooltip box rendered below the chart (click).
function QeQtTooltipContent({ active, label, qeQtRows }) {
  if (!active || !label) return null;
  const row = qeQtRows.find((r) => r.date === label);
  if (!row) return null;
  const change = row.assetsChangeBillions;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{label}</div>
      <div style={{ color: RATIO_COLOR }}>Balance sheet total (Assets): {fmtTrillions(row.totalAssets)}</div>
      <div style={{ color: change != null ? (change >= 0 ? WIN_COLOR : LOSS_COLOR) : RATIO_COLOR }}>
        Weekly change (Assets): {change != null ? `${change >= 0 ? "+" : ""}$${change.toFixed(0)}B` : "—"}
      </div>
    </div>
  );
}

function YieldsTooltipContent({ active, label, yieldsMerged }) {
  if (!active || !label) return null;
  const row = yieldsMerged.find((r) => r.date === label);
  if (!row) return null;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{label}</div>
      {row.dgs2 != null && <div style={{ color: DGS2_COLOR }}>2-Year: {row.dgs2.toFixed(2)}%</div>}
      {row.dgs10 != null && <div style={{ color: DGS10_COLOR }}>10-Year: {row.dgs10.toFixed(2)}%</div>}
      {row.dfii10 != null && <div style={{ color: DFII10_COLOR }}>10-Year Real (TIPS): {row.dfii10.toFixed(2)}%</div>}
      {row.t10y2y != null && <div style={{ color: T10Y2Y_COLOR }}>10Y–2Y Spread: {row.t10y2y >= 0 ? "+" : ""}{row.t10y2y.toFixed(2)}%</div>}
    </div>
  );
}

function fmtUsd(v) {
  if (v == null) return "—";
  return `$${v.toFixed(2)}`;
}

const METAL_SERIES_COLOR = { fiat_index: FIAT_COLOR, pp_index: PP_COLOR, xau_index: XAU_COLOR, xag_index: XAG_COLOR };
const METAL_SERIES_UNIT = { fiat_index: null, pp_index: null, xau_index: "xau_price", xag_index: "xag_price" };

function MetalsTooltip({ active, payload, label, merged, baselineKey, visible, heldComparison }) {
  if (!active || !payload || !payload.length) return null;

  if (heldComparison) {
    return (
      <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
        <div style={{ color: "#c8d0de", marginBottom: 4 }}>
          Since {heldComparison.heldDate} → {heldComparison.latestDate}
        </div>
        {METAL_SERIES.filter(({ key }) => visible[key]).map(({ key, label: seriesLabel }) => {
          const v = heldComparison.relative[key];
          // Baseline is always exactly 0 — neither a win nor a loss, so it
          // keeps its own series color instead of red/green.
          const color = key === baselineKey || v == null
            ? METAL_SERIES_COLOR[key]
            : v > 0 ? WIN_COLOR : v < 0 ? LOSS_COLOR : METAL_SERIES_COLOR[key];
          return (
            <div key={key} style={{ color }}>
              {seriesLabel}{key === baselineKey ? " (baseline)" : ""}: {fmtPct(v)}
              {" "}(${HELD_STAKE_USD} → {fmtUsd(heldComparison.stakeValue[key])})
            </div>
          );
        })}
      </div>
    );
  }

  const index = merged.findIndex((r) => r.date === label);
  if (index === -1) return null;
  const row = merged[index];

  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{label}</div>
      {METAL_SERIES.filter(({ key }) => visible[key]).map(({ key, label: seriesLabel }) => {
        const priceKey = METAL_SERIES_UNIT[key];
        const priceText = priceKey && row[priceKey] != null ? ` (${fmtUsd(row[priceKey])}/oz)` : "";
        const text = row[key] != null
          ? `${fmtPct(row[key])}${priceText}`
          : bracketLabel(...Object.values(bracketFor(merged, index, key)), key, fmtPct);
        return (
          <div key={key} style={{ color: METAL_SERIES_COLOR[key] }}>
            {seriesLabel}{key === baselineKey ? " (baseline)" : ""}: {text}
          </div>
        );
      })}
    </div>
  );
}

export default function MoneySupply() {
  const [window_, setWindow] = useState("2y");
  // Custom date range: only takes effect once both bounds are set (start <=
  // end) and window_ === "custom" — selecting "Custom" alone doesn't refetch
  // anything until real dates are picked, since a half-filled range has no
  // meaningful start/end to send.
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [data, setData] = useState(null);
  const [metalsData, setMetalsData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [baseline, setBaseline] = useState("fiat_index");
  const [visible, setVisible] = useState({ fiat_index: true, pp_index: true, xau_index: true, xag_index: true });
  const [heldDate, setHeldDate] = useState(null);
  // Click-to-pin a date on any chart in this panel, highlighted via a
  // ReferenceLine on every other chart — distinct from heldDate above
  // (which drives the metals chart's own press-and-hold "since that date"
  // return comparison) and from hoveredCompositionDate/hoveredPieKey
  // (transient hover state, cleared on mouseleave). pinnedDate persists
  // until clicked again or a "clear" affordance is used.
  const [pinnedDate, setPinnedDate] = useState(null);
  const [compositionView, setCompositionView] = useState("both"); // "both" | "assets" | "liabilities"
  const [hoveredCompositionDate, setHoveredCompositionDate] = useState(null);
  // Click (not hover) a legend row below the pie to show/hide its ELI5
  // tooltip — clicking the already-open row again closes it. Renamed from
  // hoveredPieKey: on-slice hover labels were dropped (see the pie chart's
  // own comment below for why) in favor of a fixed legend, and the
  // interaction moved from hover to click at the same time.
  const [clickedPieKey, setClickedPieKey] = useState(null);
  // Same click-to-toggle-ELI5 legend pattern as the Composition pie's
  // legend, applied to the M2/WALCL chart's own 3-entry legend at the
  // user's request ("same look and functions").
  const [clickedM2Key, setClickedM2Key] = useState(null);
  // Same click-to-toggle-ELI5 + chart-highlight legend pattern applied to
  // the QE/QT chart, per UI_STANDARDS.md.
  const [clickedQeQtKey, setClickedQeQtKey] = useState(null);
  // Same pattern applied to the Treasury Yields chart's 4-entry legend.
  const [clickedYieldsKey, setClickedYieldsKey] = useState(null);

  // Safety net: if the mouse button is released outside the chart's own SVG
  // (e.g. dragged off it before releasing), the chart's own onMouseUp never
  // fires — clear the held state on any window-level mouseup regardless.
  useEffect(() => {
    function clearHeld() {
      setHeldDate(null);
    }
    window.addEventListener("mouseup", clearHeld);
    return () => window.removeEventListener("mouseup", clearHeld);
  }, []);

  const load = useCallback(async (w, start, end) => {
    setLoading(true);
    setError(null);
    try {
      const rangeParams = w === "custom" && start && end ? `&start=${start}&end=${end}` : "";
      const [moneyRes, metalsRes] = await Promise.all([
        fetch(`/api/fred/money-supply/db?window=${w}${rangeParams}`),
        fetch(`/api/metals/prices/db?window=${w}${rangeParams}`),
      ]);
      if (!moneyRes.ok) throw new Error(`HTTP ${moneyRes.status}`);
      if (!metalsRes.ok) throw new Error(`HTTP ${metalsRes.status}`);
      const moneyJson = await moneyRes.json();
      const metalsJson = await metalsRes.json();
      setData(moneyJson.data ?? null);
      setMetalsData(metalsJson.data ?? null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // "custom" doesn't fetch until both bounds are picked and start <= end
    // — selecting the Custom button alone shouldn't fire a request with no
    // real range yet.
    if (window_ === "custom") {
      if (customStart && customEnd && customStart <= customEnd) {
        load(window_, customStart, customEnd);
      }
      return;
    }
    load(window_);
  }, [window_, customStart, customEnd, load]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const [moneyRes, metalsRes] = await Promise.all([
        fetch("/api/fred/money-supply/refresh"),
        fetch("/api/metals/prices/refresh"),
      ]);
      if (!moneyRes.ok) throw new Error(`HTTP ${moneyRes.status}`);
      if (!metalsRes.ok) throw new Error(`HTTP ${metalsRes.status}`);
      await load(window_, customStart, customEnd);
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  // mergeSeries/mergeComposition do real per-row work (forward-fill passes,
  // group totals, ratios, week-over-week diffs) — without memoizing them,
  // every hover-driven re-render (mousemove over any chart, since that
  // updates hoveredCompositionDate/tooltip state) was recomputing both from
  // scratch, which is what made the whole panel feel sluggish while
  // hovering. Keyed on `data` only — these are pure functions of the fetched
  // API response, so they should be stable across renders that don't change
  // what was fetched (window/custom-range changes already replace `data`
  // itself via a new fetch, so this key is sufficient).
  const merged = useMemo(() => (data ? mergeSeries(data.m2, data.walcl) : []), [data]);
  const ticks = useMemo(() => xTicks(merged), [merged]);

  const yieldsMerged = useMemo(
    () => (data ? mergeYields(data.dgs2, data.dgs10, data.dfii10, data.t10y2y) : []),
    [data]
  );
  const yieldsTicks = useMemo(() => xTicks(yieldsMerged), [yieldsMerged]);

  const composition = useMemo(() => (data ? mergeComposition(data) : []), [data]);
  // Fewer ticks than the default 8 — this chart shares its row with the pie
  // (see the flex layout below), so it has less width than the other
  // full-width charts in this panel; 8 full YYYY-MM-DD labels at the same
  // font size overlapped/bled into each other in that narrower space, a
  // real bug the user caught.
  const compositionTicks = useMemo(() => xTicks(composition, 4), [composition]);
  // "lines"/"both" views' pie/tooltip check all 5 series regardless of group
  // (groupKey undefined); "assets"/"liabilities" views scope the nearest-row
  // lookup (and therefore the pie) to just that group's series, so a
  // liabilities-only pie never gets padded out with an unrelated asset slice
  // or vice versa.
  const compositionPieGroup = compositionView === "liabilities" ? "liabilities" : compositionView === "assets" ? "assets" : undefined;
  // Priority: an explicit pin beats a live hover, which beats "latest" — a
  // standing rule the user asked to apply panel-wide (every section's
  // summary/pie should reflect the pinned date when one's set, and only
  // fall back to the latest reasonable data otherwise). Pinned takes
  // priority over hover specifically so clicking elsewhere to pin a date
  // doesn't get silently overridden by whatever's currently under the mouse
  // on this chart.
  const compositionPieRow = pinnedDate
    ? findNearestCompositionRow(composition, pinnedDate, compositionPieGroup)
    : hoveredCompositionDate
      ? findNearestCompositionRow(composition, hoveredCompositionDate, compositionPieGroup)
      : findNearestCompositionRow(composition, composition[composition.length - 1]?.date ?? "", compositionPieGroup);
  // compositionPieGroup is unset exactly when compositionView === "both"
  // (the only remaining ungrouped view now that "By Series" is gone) — show
  // every series in that case, same as "assets"/"liabilities" always
  // showing their full group.
  const compositionPieSeries = compositionPieGroup
    ? COMPOSITION_SERIES.filter(({ group }) => group === compositionPieGroup)
    : COMPOSITION_SERIES;
  const compositionPieData = compositionPieRow
    ? compositionPieSeries
        .filter(({ key }) => compositionPieRow[key] != null && compositionPieRow[key] > 0)
        .map(({ key, legendLabel, color, eli5 }) => ({ key, name: legendLabel, value: compositionPieRow[key], color, eli5 }))
    : [];

  const metalsIndexed = useMemo(
    () => mergeMetals(metalsData?.xag, metalsData?.xau, data?.purchasing_power),
    [metalsData, data]
  );
  const metalsMerged = useMemo(() => rebaseToBaseline(metalsIndexed, baseline), [metalsIndexed, baseline]);
  const metalsTicks = useMemo(() => xTicks(metalsMerged), [metalsMerged]);

  // Each chart snaps the shared pinnedDate to its own nearest real row date
  // before drawing a ReferenceLine — see nearestRowDate's comment for why
  // (different charts have different date grids that rarely share exact
  // date strings).
  const pinnedDateMerged = nearestRowDate(merged, pinnedDate);
  const pinnedDateYields = nearestRowDate(yieldsMerged, pinnedDate);
  const pinnedDateComposition = nearestRowDate(composition, pinnedDate);
  // QE/QT renders a filtered subset of `composition` (only rows with a real
  // assetsChangeBillions), a different date grid than the unfiltered
  // Composition chart above it — snap against that same filtered set rather
  // than reusing pinnedDateComposition, which could point to a row this
  // chart doesn't actually have.
  const qeQtRows = useMemo(() => composition.filter((r) => r.assetsChangeBillions != null), [composition]);
  const pinnedDateQeQt = nearestRowDate(qeQtRows, pinnedDate);
  const pinnedDateMetals = nearestRowDate(metalsMerged, pinnedDate);

  // Keep 0% vertically centered regardless of whether the data skews
  // positive or negative — symmetric domain around zero, sized to the
  // largest magnitude among the currently visible series only.
  const metalsVisibleKeys = METAL_SERIES.filter(({ key }) => visible[key]).map(({ key }) => key);
  const metalsMaxAbs = metalsMerged.reduce((max, row) => {
    for (const key of metalsVisibleKeys) {
      if (row[key] != null) max = Math.max(max, Math.abs(row[key]));
    }
    return max;
  }, 0);
  const metalsYDomain = metalsMaxAbs > 0 ? [-metalsMaxAbs * 1.05, metalsMaxAbs * 1.05] : [-1, 1];

  const m2Latest = data?.m2?.length ? data.m2[data.m2.length - 1].date : null;
  const walclLatest = data?.walcl?.length ? data.walcl[data.walcl.length - 1].date : null;
  const m2Stale = daysSince(m2Latest) > M2_STALE_DAYS;
  const walclStale = daysSince(walclLatest) > WALCL_STALE_DAYS;
  const m2LatestValue = data?.m2?.length ? data.m2[data.m2.length - 1].value_trillions : null;
  // Last row with a real walcl_pct_m2 reading — not necessarily the very
  // last row of `merged`, since that field goes null past whichever of
  // M2/WALCL's own real coverage ends first (see mergeSeries' forward-fill
  // cap).
  const lastPctRow = [...merged].reverse().find((r) => r.walcl_pct_m2 != null);
  // Every collapsible sub-panel's summary line should reflect the pinned
  // date when one's set, and only fall back to "latest reasonable data"
  // when nothing's pinned — a standing rule the user asked to apply across
  // every section, not just the ones that already had per-pin logic. For
  // M2/WALCL specifically: when pinned, use that chart's own snapped row
  // (pinnedDateMerged) for both the M2 value and the WALCL-%-of-M2 value;
  // when not pinned, keep the existing "latest real reading" fallbacks
  // above (m2LatestValue/lastPctRow) rather than the merged array's literal
  // last row, since M2/WALCL frequently have different real coverage ends.
  const m2SummaryRow = pinnedDateMerged ? merged.find((r) => r.date === pinnedDateMerged) : null;
  const m2SummaryValue = m2SummaryRow ? m2SummaryRow.m2 : m2LatestValue;
  const m2SummaryPct = m2SummaryRow ? m2SummaryRow.walcl_pct_m2 : lastPctRow?.walcl_pct_m2;
  const m2SummaryDate = m2SummaryRow ? m2SummaryRow.date : null;

  return (
    <div className="comex-panel">
      {/* "Dollars and Sense" is NOT its own collapsible level — per the
          user's explicit request, this whole tab should only have two
          levels of nesting (this panel, then its 4 sub-panels), not three.
          Window/Custom-range/Refresh controls live here at the top,
          uncollapsed, since they drive every chart below (Money Supply,
          Composition, QE/QT, Purchasing Power all share one window_ state)
          and must stay visible regardless of which individual sub-panel is
          collapsed. */}
      <div className="comex-panel-header">
        Dollars and Sense
        <div className="comex-range-selector">
          {pinnedDate && (
            <button
              className="comex-range-btn"
              onClick={() => setPinnedDate(null)}
              title="Click to remove the pinned date"
            >
              📌 {pinnedDate}
            </button>
          )}
          {["2y", "5y", "10y", "20y"].map((w) => (
            <button
              key={w}
              className={`comex-range-btn${window_ === w ? " comex-range-btn--active" : ""}`}
              onClick={() => setWindow(w)}
            >
              {w.toUpperCase()}
            </button>
          ))}
          <button
            className={`comex-range-btn${window_ === "custom" ? " comex-range-btn--active" : ""}`}
            onClick={() => setWindow("custom")}
          >
            Custom
          </button>
          <button className="comex-range-btn" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      {window_ === "custom" && (
        <div className="comex-range-selector" style={{ marginBottom: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#8a94a6" }}>
            From
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              max={customEnd || undefined}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#8a94a6" }}>
            To
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              min={customStart || undefined}
            />
          </label>
          {customStart && customEnd && customStart > customEnd && (
            <span style={{ fontSize: 11, color: LOSS_COLOR }}>Start must be before end.</span>
          )}
        </div>
      )}

      <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">
        M2 Money Stock / Fed Balance Sheet
        {m2SummaryValue != null && (
          <span style={{ fontWeight: "normal", fontSize: 12, color: "#8a94a6", marginLeft: 10 }}>
            {m2SummaryDate && `${m2SummaryDate} · `}
            M2 {fmtTrillions(m2SummaryValue)}
            {m2SummaryPct != null && ` · Fed Balance Sheet ${fmtPct(m2SummaryPct)} of M2`}
            {!pinnedDate && (m2Stale || walclStale) && <span style={{ color: LOSS_COLOR }}> ⚠ stale</span>}
          </span>
        )}
      </summary>
      <div className="collapsible-pane-body">
      <div className="comex-panel-note">
        Tracks the supply of the thing being debased. Descriptive historical series — no
        thresholds, no predictions. Click a point on any chart in this panel to highlight that
        date (and its values) on all of them; click the 📌 pinned-date button above to clear it.
      </div>
      {(m2Stale || walclStale) && (
        <div className="comex-freshness comex-freshness--stale">
          ⚠ Stale —{" "}
          {m2Stale && `M2 last reported ${m2Latest}${m2LatestValue != null ? ` (${fmtTrillions(m2LatestValue)})` : ""} (FRED publishes monthly, ~4-6wk lag)`}
          {m2Stale && walclStale && "; "}
          {walclStale && `Fed Balance Sheet last reported ${walclLatest}${lastPctRow ? ` (${fmtPct(lastPctRow.walcl_pct_m2)} of M2)` : ""} (published weekly)`}
        </div>
      )}

      {loading && !data ? (
        <div className="comex-empty">Loading…</div>
      ) : error ? (
        <div className="comex-empty">
          No data available.
          <div className="comex-empty-note">{error}</div>
        </div>
      ) : merged.length > 0 ? (
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart
            data={merged}
            margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
            onClick={(state) => {
              if (state?.activeLabel) setPinnedDate(state.activeLabel);
            }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
            <XAxis dataKey="date" ticks={ticks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
            <YAxis
              yAxisId="level"
              tickFormatter={(v) => `$${v.toFixed(0)}T`}
              tick={{ fill: "#8a94a6", fontSize: 11 }}
              label={{ value: "Trillions USD", angle: -90, position: "insideLeft", fill: "#5a6278", fontSize: 11 }}
            />
            <YAxis
              yAxisId="pct"
              orientation="right"
              tickFormatter={(v) => `${v.toFixed(0)}%`}
              tick={{ fill: "#e8ecf4", fontSize: 11 }}
              label={{ value: "Percent", angle: 90, position: "insideRight", fill: "#5a6278", fontSize: 11 }}
            />
            <Tooltip content={<MoneySupplyTooltip merged={merged} />} />
            {pinnedDateMerged && (
              <ReferenceLine yAxisId="level" x={pinnedDateMerged} stroke={RATIO_COLOR} strokeDasharray="3 3" />
            )}
            {/* Stacked area: WALCL's own dollar value (red) stacked below
                whatever's left of M2 above it (green) — so the red portion
                visually IS "this share of the M2 area is the Fed balance
                sheet," not a separate line the user has to compare by eye
                against M2's height. Both stack to exactly M2's total.
                Clicking a legend row also highlights that series here
                (thicker stroke, fuller opacity) while dimming the others —
                same treatment as the Composition chart's legend/highlight
                behavior. */}
            <Area
              yAxisId="level"
              type="monotone"
              dataKey="walcl_share"
              stackId="m2-walcl-share"
              stroke={WALCL_COLOR}
              strokeWidth={clickedM2Key === "walcl" ? 3 : 1}
              fill={WALCL_COLOR}
              fillOpacity={clickedM2Key && clickedM2Key !== "walcl" ? 0.2 : 0.55}
              connectNulls
            />
            <Area
              yAxisId="level"
              type="monotone"
              dataKey="m2_remainder"
              stackId="m2-walcl-share"
              stroke={M2_COLOR}
              strokeWidth={clickedM2Key === "m2" ? 3 : 1}
              fill={M2_COLOR}
              fillOpacity={clickedM2Key && clickedM2Key !== "m2" ? 0.1 : 0.25}
              connectNulls
            />
            <Line
              yAxisId="pct"
              type="monotone"
              dataKey="m2_yoy"
              stroke={M2_YOY_COLOR}
              strokeDasharray="4 3"
              dot={false}
              strokeWidth={clickedM2Key === "m2_yoy" ? 3.2 : 1.8}
              strokeOpacity={clickedM2Key && clickedM2Key !== "m2_yoy" ? 0.3 : 1}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      ) : (
        <div className="comex-empty">
          No data available.
          <div className="comex-empty-note">
            Hit Refresh to fetch from FRED, or run the refresh endpoint once to seed the database.
          </div>
        </div>
      )}
      {/* Pinned tooltip: reuses this chart's own hover-tooltip content
          component, forced open at the pinned (snapped) date instead of
          Recharts' own hover-driven state — Recharts 3.x's <Tooltip> has no
          clean "force open at date X" API without synthesizing mouse
          events, and a fixed box below the chart (same convention as the
          Composition pie's hover box) is simpler/more robust than computing
          this chart's own pixel x-position to float the box exactly over
          the reference line. */}
      {pinnedDateMerged && (
        <div style={{ marginTop: 4 }}>
          <MoneySupplyTooltip active payload={[{}]} label={pinnedDateMerged} merged={merged} />
        </div>
      )}

      {/* Same look/behavior as the Composition pie's legend, per the user's
          request: horizontal, compact swatch+label rows, click to reveal
          the full explanation below (rather than always-visible inline
          prose) instead of the vertical always-expanded legend this used
          to be. */}
      {merged.length > 0 && (
        <div className="comex-legend-list comex-legend-list--horizontal">
          {M2_LEGEND_SERIES.map((entry) => (
            <button
              key={entry.key}
              className={`comex-legend-item legend-btn-row${clickedM2Key === entry.key ? " legend-btn-row--baseline" : ""}`}
              onClick={() => setClickedM2Key((k) => (k === entry.key ? null : entry.key))}
            >
              <span
                className={`comex-legend-swatch${entry.dashed ? " comex-legend-swatch--dashed" : ""}`}
                style={entry.dashed ? { borderColor: entry.color } : { background: entry.color }}
              />
              <span>
                <strong>{entry.legendLabel}</strong>
              </span>
            </button>
          ))}
        </div>
      )}
      {clickedM2Key && (
        <div className="comex-panel-note comex-panel-note--eli5">
          {M2_LEGEND_SERIES.find((d) => d.key === clickedM2Key)?.eli5}
        </div>
      )}
      </div>
      </details>

      <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">
        Fed Balance Sheet Composition
        {compositionPieRow?.assetsLiabilitiesRatio != null && (
          <span style={{ fontWeight: "normal", fontSize: 12, color: "#8a94a6", marginLeft: 10 }}>
            {pinnedDate && `${compositionPieRow.date} · `}
            Assets / Liabilities:{" "}
            <span style={{ color: compositionPieRow.assetsLiabilitiesRatio > 1.25 ? WIN_COLOR : LOSS_COLOR }}>
              {compositionPieRow.assetsLiabilitiesRatio}:1
            </span>
          </span>
        )}
      </summary>
      <div className="collapsible-pane-body">
      <div className="comex-panel-note">
        What the Fed Balance Sheet above is made of: <strong>Assets</strong> (what it owns) vs.{" "}
        <strong>Liabilities</strong> (what it owes) — never summed together. Hover the chart for
        that day's mix.
      </div>
      <div className="comex-range-selector" style={{ marginBottom: 8 }}>
        {[["both", "Assets + Liabilities"], ["assets", "Assets Total"], ["liabilities", "Liabilities Total"]].map(([v, label]) => (
          <button
            key={v}
            className={`comex-range-btn${compositionView === v ? " comex-range-btn--active" : ""}`}
            onClick={() => setCompositionView(v)}
          >
            {label}
          </button>
        ))}
      </div>
      {composition.length > 0 ? (
        <div className="comex-vault-pie-row">
          {/* Line chart + pie side by side, not stacked — the pie was
              eating a full-width row of its own below the line chart, which
              (even after capping its own container to 320px) still left the
              line chart's full-width row above it looking sparse next to a
              much narrower circle. Splitting into a flex row (line chart
              ~62%, pie ~38%) uses the width both actually need instead of
              two separate full-width rows. Legend stays full-width, below
              both, since it needs the room to lay out all 5 series
              horizontally. */}
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 420px", minWidth: 0 }}>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart
              data={composition}
              margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
              onMouseMove={(state) => {
                if (state?.activeLabel) setHoveredCompositionDate(state.activeLabel);
              }}
              onMouseLeave={() => setHoveredCompositionDate(null)}
              onClick={(state) => {
                if (state?.activeLabel) setPinnedDate(state.activeLabel);
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
              <XAxis dataKey="date" ticks={compositionTicks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
              <YAxis
                yAxisId="level"
                tickFormatter={(v) => `$${v.toFixed(1)}T`}
                tick={{ fill: "#8a94a6", fontSize: 11 }}
                label={{ value: "Trillions USD", angle: -90, position: "insideLeft", fill: "#5a6278", fontSize: 11 }}
              />
              {(compositionView === "assets" || compositionView === "liabilities" || compositionView === "both") && (
                <YAxis
                  yAxisId="ratio"
                  orientation="right"
                  tickFormatter={(v) => `${v.toFixed(1)}x`}
                  tick={{ fill: "#e8ecf4", fontSize: 11 }}
                  label={{ value: "Assets ÷ Liabilities", angle: 90, position: "insideRight", fill: "#5a6278", fontSize: 11 }}
                />
              )}
              {pinnedDateComposition && (
                <ReferenceLine yAxisId="level" x={pinnedDateComposition} stroke={RATIO_COLOR} strokeDasharray="3 3" />
              )}
              <Tooltip
                content={(props) => (
                  <CompositionTooltipContent
                    {...props}
                    composition={composition}
                    compositionView={compositionView}
                    compositionPieGroup={compositionPieGroup}
                  />
                )}
              />
              {compositionView === "assets" || compositionView === "liabilities" ? (
                <>
                  {/* Same highlight-on-legend-click treatment as the pie's
                      <Cell>s above — the clicked series' area gets a
                      thicker stroke and full opacity, the rest dim. */}
                  {COMPOSITION_SERIES.filter(({ group }) => group === compositionView).map(({ key, color }) => (
                    <Area
                      key={key}
                      yAxisId="level"
                      type="monotone"
                      dataKey={`${key}_filled`}
                      stackId="composition-total"
                      stroke={color}
                      strokeWidth={clickedPieKey === key ? 3 : 1}
                      fill={color}
                      fillOpacity={clickedPieKey && clickedPieKey !== key ? 0.25 : 0.65}
                      connectNulls
                    />
                  ))}
                  <Line
                    yAxisId="ratio"
                    type="monotone"
                    dataKey="assetsLiabilitiesRatio"
                    stroke={RATIO_COLOR}
                    strokeDasharray="4 3"
                    dot={false}
                    strokeWidth={1.8}
                    connectNulls
                  />
                </>
              ) : compositionView === "both" ? (
                <>
                  {/* Two independent stacks (assets, liabilities), not one
                      combined stack — these are opposite sides of the same
                      balance sheet and must never be summed together (see
                      COMPOSITION_SERIES's comment on the bug this guards
                      against). Different stackId per group keeps Recharts
                      from merging them. */}
                  {COMPOSITION_SERIES.filter(({ group }) => group === "assets").map(({ key, color }) => (
                    <Area
                      key={key}
                      yAxisId="level"
                      type="monotone"
                      dataKey={`${key}_filled`}
                      stackId="composition-assets"
                      stroke={color}
                      strokeWidth={clickedPieKey === key ? 3 : 1}
                      fill={color}
                      fillOpacity={clickedPieKey && clickedPieKey !== key ? 0.25 : 0.65}
                      connectNulls
                    />
                  ))}
                  {COMPOSITION_SERIES.filter(({ group }) => group === "liabilities").map(({ key, color }) => (
                    <Area
                      key={key}
                      yAxisId="level"
                      type="monotone"
                      dataKey={`${key}_filled`}
                      stackId="composition-liabilities"
                      stroke={color}
                      strokeWidth={clickedPieKey === key ? 3 : 1}
                      fill={color}
                      fillOpacity={clickedPieKey && clickedPieKey !== key ? 0.25 : 0.65}
                      connectNulls
                    />
                  ))}
                  <Line
                    yAxisId="ratio"
                    type="monotone"
                    dataKey="assetsLiabilitiesRatio"
                    stroke={RATIO_COLOR}
                    strokeDasharray="4 3"
                    dot={false}
                    strokeWidth={1.8}
                    connectNulls
                  />
                </>
              ) : null}
            </ComposedChart>
          </ResponsiveContainer>
          {pinnedDateComposition && (
            <div style={{ marginTop: 4 }}>
              <CompositionTooltipContent
                active
                label={pinnedDateComposition}
                composition={composition}
                compositionView={compositionView}
                compositionPieGroup={compositionPieGroup}
              />
            </div>
          )}
          </div>

          {/* On-slice labels were dropped — a real bug caught by the user:
              they'd disappear whenever the pie's data moved (a new hovered
              date, a slice crossing in/out of the >0 filter, etc.), since
              label position is computed from live slice geometry that was
              itself changing mid-render. A fixed legend below the chart,
              positioned independent of slice geometry, doesn't have that
              failure mode. Legend rows are also now click-to-toggle (not
              hover) for the ELI5 tooltip, matching this codebase's
              established "custom legends" convention (hand-rolled
              comex-legend-list/comex-legend-item, clickable rows via
              legend-btn-row) rather than Recharts' own label/Legend
              components. Sits beside the line chart (not below it, and not
              in its own full-width row) — see the flex row opened above.
              Column flex-basis (180px), container size (180×180), and
              outerRadius (70) were all shrunk together from an earlier,
              looser sizing (260px/240×240/80) — the user found even that
              still left too much dead margin around the circle itself.
              Zeroed the PieChart's own margin prop too, since Recharts
              reserves default chart margins that add extra buffer on top
              of the container size. */}
          <div style={{ flex: "0 0 180px", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <ResponsiveContainer width={180} height={180}>
              <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                <Pie
                  data={compositionPieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={70}
                  innerRadius={36}
                  paddingAngle={1}
                >
                  {/* Clicking a legend row highlights that series here too
                      (full opacity + a light outline) while dimming the
                      others, not just opening the ELI5 popup — a visual
                      tie-back from legend to chart the user asked for. */}
                  {compositionPieData.map((entry) => (
                    <Cell
                      key={entry.key}
                      fill={entry.color}
                      fillOpacity={clickedPieKey && clickedPieKey !== entry.key ? 0.35 : 1}
                      stroke={clickedPieKey === entry.key ? "#e8ecf4" : undefined}
                      strokeWidth={clickedPieKey === entry.key ? 2 : undefined}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
                  formatter={(v, name) => [fmtTrillions(v), name]}
                />
              </PieChart>
            </ResponsiveContainer>
            {/* Pie data is a single date's snapshot (compositionPieRow), not
                a range like the line chart beside it — without this, there
                was no way to tell which date the slice sizes actually
                reflect (the pinned/hovered date, or the latest reading if
                neither is set). */}
            {compositionPieRow?.date && (
              <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 4 }}>
                As of {compositionPieRow.date}
              </div>
            )}
          </div>
          </div>
          {/* Always all 5 series, regardless of which ones the pie itself is
              currently showing (compositionPieData is filtered to value > 0,
              so a near-zero series like RRPONTSYD would otherwise drop out
              of the legend along with its slice — a real gap the user
              caught). Sourced from COMPOSITION_SERIES directly rather than
              compositionPieData, since COMPOSITION_SERIES already carries
              color/legendLabel/eli5 for every series unconditionally.
              Horizontal, not the vertical comex-legend-list stack used
              elsewhere — see .comex-legend-list--horizontal in index.css. */}
          <div className="comex-legend-list comex-legend-list--horizontal">
            {COMPOSITION_SERIES.map((entry) => (
              <button
                key={entry.key}
                className={`comex-legend-item legend-btn-row${clickedPieKey === entry.key ? " legend-btn-row--baseline" : ""}`}
                onClick={() => setClickedPieKey((k) => (k === entry.key ? null : entry.key))}
              >
                <span className="comex-legend-swatch" style={{ background: entry.color }} />
                <span>
                  <strong>{entry.legendLabel}</strong>
                </span>
              </button>
            ))}
          </div>
          {clickedPieKey && (
            <div className="comex-panel-note comex-panel-note--eli5">
              {COMPOSITION_SERIES.find((d) => d.key === clickedPieKey)?.eli5}
            </div>
          )}
        </div>
      ) : (
        <div className="comex-empty">
          No data available.
          <div className="comex-empty-note">Hit Refresh to fetch from FRED, or run the refresh endpoint once to seed the database.</div>
        </div>
      )}
      </div>
      </details>

      <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">
        QE / QT
        {(() => {
          const row = pinnedDate
            ? qeQtRows.find((r) => r.date === pinnedDateQeQt)
            : qeQtRows[qeQtRows.length - 1];
          if (!row) return null;
          const change = row.assetsChangeBillions;
          return (
            <span style={{ fontWeight: "normal", fontSize: 12, color: "#8a94a6", marginLeft: 10 }}>
              {pinnedDate && `${row.date} · `}
              Assets {fmtTrillions(row.totalAssets)}
              {change != null && (
                <>
                  {" · "}
                  <span style={{ color: change >= 0 ? WIN_COLOR : LOSS_COLOR }}>
                    {change >= 0 ? "+" : ""}${change.toFixed(0)}B
                  </span>
                </>
              )}
            </span>
          );
        })()}
      </summary>
      <div className="collapsible-pane-body">
      <div className="comex-panel-note">
        <strong>QE / QT</strong> — week-over-week change in Fed assets. Above zero = growing
        ("QE"); below = shrinking ("QT").
      </div>
      {qeQtRows.length > 0 ? (
        <div>
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart
              data={qeQtRows}
              margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
              onClick={(state) => {
                if (state?.activeLabel) setPinnedDate(state.activeLabel);
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
              <XAxis dataKey="date" ticks={xTicks(qeQtRows)} tick={{ fill: "#8a94a6", fontSize: 11 }} />
              <YAxis
                yAxisId="delta"
                tickFormatter={(v) => `$${v.toFixed(0)}B`}
                tick={{ fill: "#8a94a6", fontSize: 11 }}
                label={{ value: "Weekly Δ, Billions USD", angle: -90, position: "insideLeft", fill: "#5a6278", fontSize: 11 }}
              />
              <YAxis
                yAxisId="level"
                orientation="right"
                tickFormatter={(v) => `$${v.toFixed(1)}T`}
                tick={{ fill: "#e8ecf4", fontSize: 11 }}
                label={{ value: "Balance Sheet Total, Trillions USD", angle: 90, position: "insideRight", fill: "#5a6278", fontSize: 11 }}
              />
              {pinnedDateQeQt && (
                <ReferenceLine yAxisId="delta" x={pinnedDateQeQt} stroke={RATIO_COLOR} strokeDasharray="3 3" />
              )}
              <Tooltip content={(props) => <QeQtTooltipContent {...props} qeQtRows={qeQtRows} />} />
              {/* Bar, not Area — per UI_STANDARDS.md's color convention,
                  each week's change is colored green (assets grew, "QE") or
                  red (shrank, "QT") individually via per-Cell fill, which
                  Recharts only supports on Bar/Pie, not Area. Clicking the
                  "Weekly Change" legend row dims the Balance Sheet Total
                  line and full-opacities these bars (they're already
                  per-point green/red, so "highlighting" this series means
                  making sure the OTHER series dims, not recoloring these). */}
              <Bar yAxisId="delta" dataKey="assetsChangeBillions">
                {qeQtRows.map((row) => {
                  const dimmed = clickedQeQtKey === "totalAssets";
                  const positive = row.assetsChangeBillions >= 0;
                  return (
                    <Cell
                      key={row.date}
                      fill={positive ? WIN_COLOR : LOSS_COLOR}
                      fillOpacity={dimmed ? 0.25 : 0.85}
                    />
                  );
                })}
              </Bar>
              <Line
                yAxisId="level"
                type="monotone"
                dataKey="totalAssets"
                stroke={RATIO_COLOR}
                strokeDasharray="4 3"
                dot={false}
                strokeWidth={clickedQeQtKey === "totalAssets" ? 3.2 : 1.8}
                strokeOpacity={clickedQeQtKey && clickedQeQtKey !== "totalAssets" ? 0.3 : 1}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
          {pinnedDateQeQt && (
            <div style={{ marginTop: 4 }}>
              <QeQtTooltipContent active label={pinnedDateQeQt} qeQtRows={qeQtRows} />
            </div>
          )}
          {/* Legend, per UI_STANDARDS.md: horizontal, click-to-toggle
              detail below, clicking also highlights that series on the
              chart above. Same clickedQeQtKey pattern as
              clickedPieKey/clickedM2Key elsewhere in this panel. */}
          <div className="comex-legend-list comex-legend-list--horizontal">
            {QE_QT_LEGEND_SERIES.map((entry) => (
              <button
                key={entry.key}
                className={`comex-legend-item legend-btn-row${clickedQeQtKey === entry.key ? " legend-btn-row--baseline" : ""}`}
                onClick={() => setClickedQeQtKey((k) => (k === entry.key ? null : entry.key))}
              >
                <span
                  className={`comex-legend-swatch${entry.dashed ? " comex-legend-swatch--dashed" : ""}`}
                  style={entry.dashed ? { borderColor: entry.color } : { background: entry.color }}
                />
                <span>
                  <strong>{entry.legendLabel}</strong>
                </span>
              </button>
            ))}
          </div>
          {clickedQeQtKey && (
            <div className="comex-panel-note comex-panel-note--eli5">
              {QE_QT_LEGEND_SERIES.find((d) => d.key === clickedQeQtKey)?.eli5}
            </div>
          )}
        </div>
      ) : (
        <div className="comex-empty">
          No data available.
          <div className="comex-empty-note">Hit Refresh to fetch from FRED, or run the refresh endpoint once to seed the database.</div>
        </div>
      )}
      </div>
      </details>

      <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">
        Treasury Yields
        {yieldsMerged.length > 0 && (
          <span style={{ fontWeight: "normal", fontSize: 12, color: "#8a94a6", marginLeft: 10 }}>
            {(() => {
              const row = pinnedDate
                ? yieldsMerged.find((r) => r.date === pinnedDateYields)
                : yieldsMerged[yieldsMerged.length - 1];
              if (!row) return null;
              return (
                <>
                  {row.date} · 2Y {row.dgs2 != null ? `${row.dgs2.toFixed(2)}%` : "—"} · 10Y{" "}
                  {row.dgs10 != null ? `${row.dgs10.toFixed(2)}%` : "—"} · 10Y–2Y{" "}
                  {row.t10y2y != null ? `${row.t10y2y >= 0 ? "+" : ""}${row.t10y2y.toFixed(2)}%` : "—"}
                </>
              );
            })()}
          </span>
        )}
      </summary>
      <div className="collapsible-pane-body">
      <div className="comex-panel-note">
        Real FRED Treasury series, daily. Gold's most-cited "opportunity cost" driver is the
        10-Year real (TIPS) yield — see that series' legend entry below for why. Descriptive
        historical series — no thresholds, no predictions.
      </div>
      {yieldsMerged.length > 0 ? (
        <div>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart
              data={yieldsMerged}
              margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
              onClick={(state) => {
                if (state?.activeLabel) setPinnedDate(state.activeLabel);
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
              <XAxis dataKey="date" ticks={yieldsTicks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
              {/* Two axes, not one — dgs2/dgs10/dfii10 are yield LEVELS
                  (~2-5%), t10y2y is a SPREAD between two of them (~0.3-0.5%,
                  can go negative on an inversion). Forcing all four onto one
                  axis (Recharts' default domain includes 0) squashed
                  everything into a ~0-5% range where the levels' real day-
                  to-day movement (tenths of a point) looked flat and the
                  spread was pinned near the bottom — confirmed against real
                  fetched data (2yr ~4.18%, 10yr ~4.55%, spread ~0.39%) that
                  the underlying series DO move, only the shared axis was
                  hiding it. dataMin/dataMax (not [0,"auto"]) so each axis
                  fills its own real range instead of both including zero. */}
              <YAxis
                yAxisId="level"
                domain={["dataMin - 0.1", "dataMax + 0.1"]}
                tickFormatter={(v) => `${v.toFixed(1)}%`}
                tick={{ fill: "#8a94a6", fontSize: 11 }}
                label={{ value: "Yield %", angle: -90, position: "insideLeft", fill: "#5a6278", fontSize: 11 }}
              />
              <YAxis
                yAxisId="spread"
                orientation="right"
                domain={["dataMin - 0.05", "dataMax + 0.05"]}
                tickFormatter={(v) => `${v.toFixed(2)}%`}
                tick={{ fill: "#8a94a6", fontSize: 11 }}
                label={{ value: "10Y–2Y Spread", angle: 90, position: "insideRight", fill: "#5a6278", fontSize: 11 }}
              />
              <Tooltip content={<YieldsTooltipContent yieldsMerged={yieldsMerged} />} />
              {pinnedDateYields && (
                <ReferenceLine yAxisId="level" x={pinnedDateYields} stroke={RATIO_COLOR} strokeDasharray="3 3" />
              )}
              <ReferenceLine yAxisId="spread" y={0} stroke="#5a6278" strokeDasharray="2 4" />
              {YIELDS_LEGEND_SERIES.map((entry) => (
                <Line
                  key={entry.key}
                  yAxisId={entry.key === "t10y2y" ? "spread" : "level"}
                  type="monotone"
                  dataKey={entry.key}
                  stroke={entry.color}
                  dot={false}
                  strokeWidth={clickedYieldsKey === entry.key ? 3 : 1.5}
                  strokeOpacity={clickedYieldsKey && clickedYieldsKey !== entry.key ? 0.25 : 1}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          {pinnedDateYields && (
            <div style={{ marginTop: 4 }}>
              <YieldsTooltipContent active label={pinnedDateYields} yieldsMerged={yieldsMerged} />
            </div>
          )}
          <div className="comex-legend-list comex-legend-list--horizontal">
            {YIELDS_LEGEND_SERIES.map((entry) => (
              <button
                key={entry.key}
                className={`comex-legend-item legend-btn-row${clickedYieldsKey === entry.key ? " legend-btn-row--baseline" : ""}`}
                onClick={() => setClickedYieldsKey((k) => (k === entry.key ? null : entry.key))}
              >
                <span className="comex-legend-swatch" style={{ background: entry.color }} />
                <span>
                  <strong>{entry.legendLabel}</strong>
                </span>
              </button>
            ))}
          </div>
          {clickedYieldsKey && (
            <div className="comex-panel-note comex-panel-note--eli5">
              {YIELDS_LEGEND_SERIES.find((d) => d.key === clickedYieldsKey)?.eli5}
            </div>
          )}
        </div>
      ) : (
        <div className="comex-empty">
          No data available.
          <div className="comex-empty-note">Hit Refresh to fetch from FRED, or run the refresh endpoint once to seed the database.</div>
        </div>
      )}
      </div>
      </details>

      <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">
        Dollars vs Silver vs Gold as Purchasing Power
        {(() => {
          const row = pinnedDate
            ? metalsMerged.find((r) => r.date === pinnedDateMetals)
            : metalsMerged[metalsMerged.length - 1];
          if (!row) return null;
          const baselineLabel = METAL_SERIES.find((s) => s.key === baseline)?.shortLabel ?? baseline;
          return (
            <span style={{ fontWeight: "normal", fontSize: 12, color: "#8a94a6", marginLeft: 10 }}>
              {pinnedDate && `${row.date} · `}
              Baseline {baselineLabel}
              {row.xau_index != null && (
                <>
                  {" · Au "}
                  <span style={{ color: row.xau_index >= 0 ? WIN_COLOR : LOSS_COLOR }}>{fmtPct(row.xau_index)}</span>
                </>
              )}
              {row.xag_index != null && (
                <>
                  {" · Ag "}
                  <span style={{ color: row.xag_index >= 0 ? WIN_COLOR : LOSS_COLOR }}>{fmtPct(row.xag_index)}</span>
                </>
              )}
            </span>
          );
        })()}
      </summary>
      <div className="collapsible-pane-body">
      <div className="comex-panel-note">
        Four ways to have held a dollar since 2006: Fiat ($100 nominal — always worth $100 of
        itself), Gold (XAU) and Silver (XAG) month-end closing prices via Yahoo Finance
        (SI=F/GC=F), and CPI-derived Purchasing Power (what that $100 could actually buy).
        Click a line's label in the legend below to make it the baseline — the baseline renders
        flat at 0%, and the others show their return relative to it over the selected window.
        Click the checkbox to show/hide a line. Click and hold a point on the chart to see each
        series' return from that date to the latest data, relative to the current baseline —
        release to return to normal. Not a claim that any one of them "should" track another.
      </div>
      {metalsMerged.length > 0 ? (
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart
            data={metalsMerged}
            margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
            onMouseDown={(state) => {
              if (state?.activeLabel) setHeldDate(state.activeLabel);
            }}
            onMouseUp={() => setHeldDate(null)}
            onMouseLeave={() => setHeldDate(null)}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
            <XAxis dataKey="date" ticks={metalsTicks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
            <YAxis
              domain={metalsYDomain}
              tick={{ fill: "#8a94a6", fontSize: 11 }}
              tickFormatter={(v) => `${Math.round(v)}%`}
              width={70}
              label={{ value: "Return vs. baseline (%)", angle: -90, position: "insideLeft", fill: "#5a6278", fontSize: 11, dx: -10 }}
            />
            <Tooltip
              content={
                <MetalsTooltip
                  merged={metalsMerged}
                  baselineKey={baseline}
                  visible={visible}
                  heldComparison={heldDate ? computeHeldComparison(metalsIndexed, heldDate, baseline) : null}
                />
              }
            />
            {/* Doesn't originate a pin itself (this chart's mousedown/mouseup
                are already claimed by the hold-to-compare gesture above —
                adding click-to-pin here would fire on every hold-release
                too) but still displays a pin set from any other chart in
                the panel. */}
            {pinnedDateMetals && <ReferenceLine x={pinnedDateMetals} stroke={RATIO_COLOR} strokeDasharray="3 3" />}
            {visible.xau_index && (
              <Area
                type="monotone"
                dataKey="xau_index"
                stroke={XAU_COLOR}
                fill={XAU_COLOR}
                fillOpacity={0.3}
                connectNulls
              />
            )}
            {visible.xag_index && (
              <Area
                type="monotone"
                dataKey="xag_index"
                stroke={XAG_COLOR}
                fill={XAG_COLOR}
                fillOpacity={0.3}
                connectNulls
              />
            )}
            {visible.pp_index && (
              <Line
                type="monotone"
                dataKey="pp_index"
                stroke={PP_COLOR}
                dot={false}
                strokeWidth={1.8}
                connectNulls
              />
            )}
            {visible.fiat_index && (
              <Line
                type="monotone"
                dataKey="fiat_index"
                stroke={FIAT_COLOR}
                dot={false}
                strokeWidth={1.8}
                connectNulls
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      ) : (
        <div className="comex-empty">
          No data available.
          <div className="comex-empty-note">Hit Refresh to fetch metal price history from Yahoo Finance.</div>
        </div>
      )}
      {pinnedDateMetals && (
        <div style={{ marginTop: 4 }}>
          <MetalsTooltip
            active
            payload={[{}]}
            label={pinnedDateMetals}
            merged={metalsMerged}
            baselineKey={baseline}
            visible={visible}
            heldComparison={null}
          />
        </div>
      )}
      {metalsMerged.length > 0 && (
        <div className="comex-legend-list comex-legend-list--horizontal">
          {METAL_SERIES.map(({ key, label: seriesLabel, shortLabel, selectableBaseline }) => (
            <div key={key} className="metals-legend-row">
              <input
                type="checkbox"
                className="metals-legend-checkbox"
                checked={visible[key]}
                onChange={() => setVisible((v) => ({ ...v, [key]: !v[key] }))}
                title={visible[key] ? "Hide this line" : "Show this line"}
              />
              {selectableBaseline ? (
                <button
                  className={`comex-legend-item legend-btn-row${baseline === key ? " legend-btn-row--baseline" : ""}`}
                  onClick={() => setBaseline(key)}
                >
                  <span className="comex-legend-swatch" style={{ background: METAL_SERIES_COLOR[key] }} />
                  <span>
                    <strong>{seriesLabel}</strong>
                    {baseline === key && (
                      <span className="metals-legend-baseline-note"> — baseline ({shortLabel} at 0%)</span>
                    )}
                  </span>
                </button>
              ) : (
                <div className="comex-legend-item">
                  <span className="comex-legend-swatch" style={{ background: METAL_SERIES_COLOR[key] }} />
                  <span>
                    <strong>{seriesLabel}</strong>
                    <span className="metals-legend-baseline-note"> — not selectable as baseline (not a holdable asset)</span>
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="comex-panel-note" style={{ marginTop: 8 }}>
        Source: FRED (Federal Reserve Bank of St. Louis) — M2SL, WALCL, CPIAUCSL, WRESBAL,
        RRPONTSYD, WSHOTSL, WSHOMCB, WLCFLPCL. Metal prices: Yahoo Finance (SI=F, GC=F).
      </div>
      </div>
      </details>
    </div>
  );
}
