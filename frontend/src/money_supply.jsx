import { useState, useEffect, useCallback, useMemo } from "react";
import { nearestRowDate } from "./date_utils";
import { VAULT_COLORS } from "./palette";
import {
  ComposedChart,
  LineChart,
  AreaChart,
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
// Added to round out the curve beyond the original 4 — see
// pipeline/config.py's own comment on DGS3MO vs. DTB3. T10Y3MO (a second,
// real spread — the classic recession-inversion pair most commonly cited,
// distinct from T10Y2Y) is computed client-side from dgs10/dgs3mo, unlike
// T10Y2Y which FRED maintains directly — no equivalent FRED-maintained
// 10Y-3mo spread series exists, confirmed during the Treasuries-picture
// research pass.
const DGS3MO_COLOR = "#94a3b8";
const DGS5_COLOR = "#a78bfa";
const DGS30_COLOR = "#f472b6";
const T10Y3MO_COLOR = "#fb923c";

// Federal Outlays sub-panel (fed-spend-spec.md) — 4 flat series, same
// ungrouped-lines shape as Treasury Yields, not Composition's grouped
// pie/stack treatment (spec's explicit "close to Yields' ceiling for one
// flat chart" framing). Outlays/Receipts share the WALCL/M2 red/green
// convention (outlays = red/spending, receipts = green/income) since
// they're the two flows that make up the deficit; Deficit gets its own
// distinct color since it's a derived comparison of the two, not a flow
// itself; Interest-on-debt is dashed, per the spec's open question #3 —
// singled out as the most narratively-loaded figure here (what the
// government pays just to service existing debt, independent of any new
// spending decision).
const OUTLAYS_COLOR = "#e05252";
const RECEIPTS_COLOR = "#4caf76";
const DEFICIT_COLOR = "#7b9fff";
const INTEREST_COLOR = "#e0a84c";

// Treasury Auctions sub-panel (Treasuries-picture expansion) — bid-to-cover
// and buyer-category mix, per real settled auction. Security types get
// their own distinct colors (bid-to-cover chart plots multiple types on
// one shared axis); buyer categories get their own separate palette (the
// %-stacked mix chart only ever shows one security type at a time, so its
// 4 categories don't need to be visually distinct from the security-type
// colors above).
const AUCTION_SECURITY_TYPES = ["Bill", "Note", "Bond", "TIPS", "FRN"];
const AUCTION_TYPE_COLOR = {
  Bill: "#7b9fff",
  Note: "#4caf76",
  Bond: "#e0a84c",
  TIPS: "#a78bfa",
  FRN: "#f472b6",
};
const AUCTION_BUYER_COLORS = {
  primary_dealer: "#7b9fff",
  indirect_bidder: "#4caf76",
  direct_bidder: "#e0a84c",
  soma: "#e05252",
};
const AUCTION_BUYERS = [
  { key: "primary_dealer", label: "Primary Dealers" },
  { key: "indirect_bidder", label: "Indirect Bidders" },
  { key: "direct_bidder", label: "Direct Bidders" },
  { key: "soma", label: "SOMA (the Fed)" },
];

// One row per real settled auction (bid_to_cover_ratio non-null — an
// announced-but-unsettled row has every result field null, per the
// standing nulls-over-zeros convention, and isn't meaningful to plot).
// buyer_mix_pct is computed here at read time (not persisted) as each
// category's share of total_accepted — "who actually bought this auction,"
// the % framing making auctions of very different sizes comparable on one
// chart the way raw dollar amounts wouldn't be. This is a flat per-auction
// list (potentially several rows sharing one date, since multiple security
// types can auction the same day) — used by the buyer-mix chart (which
// filters to one security type at a time, so no ambiguity there) and by
// AuctionsTooltipContent (which explicitly looks up ALL rows for a hovered
// date). It is NOT used directly as chart `data` for the multi-type
// bid-to-cover chart — see mergeAuctionsByType below for why.
function mergeAuctions(rows) {
  return (rows || [])
    .filter((r) => r.bid_to_cover_ratio != null)
    .map((r) => {
      const total = r.total_accepted;
      const pct = (v) => (v != null && total ? round1((v / total) * 100) : null);
      return {
        date: r.auction_date,
        cusip: r.cusip,
        security_type: r.security_type,
        security_term: r.security_term,
        bid_to_cover_ratio: r.bid_to_cover_ratio,
        high_yield: r.high_yield,
        primary_dealer_pct: pct(r.primary_dealer_accepted),
        indirect_bidder_pct: pct(r.indirect_bidder_accepted),
        direct_bidder_pct: pct(r.direct_bidder_accepted),
        soma_pct: pct(r.soma_accepted),
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Pivots mergeAuctions' flat per-auction list into one row per real date,
// with each security type as its own column (bid_to_cover_ratio keyed by
// type) — the same "one row per date, one column per series" shape every
// other multi-line chart in this file uses. A real bug this replaces: the
// bid-to-cover chart originally gave each <Line> its own filtered
// data={auctionsByType[t]} array while the chart itself used the full
// auctionsMerged as its shared data — Recharts positions a category-axis
// point by that SERIES' OWN array index/date, not a globally shared
// position, so two types' points landed at mismatched x-positions on the
// same visual axis even when their real dates matched (confirmed live —
// the user's own "same date, different location" report). Rows with only
// ONE type auctioned that day still get every other type's column as
// null, which Line's connectNulls already handles correctly (a real gap,
// not a manufactured value).
function mergeAuctionsByType(auctionRows) {
  const byDate = {};
  for (const r of auctionRows) {
    const row = (byDate[r.date] ??= { date: r.date });
    row[r.security_type] = r.bid_to_cover_ratio;
  }
  return Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
}

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

// Federal Outlays / Outlays by Agency sub-panels use billions, not
// trillions like the rest of this panel — most individual agencies' monthly
// figures are well under $1T, which read as near-invisible fractions
// ("$0.20T") in trillions; billions gives real precision at the actual
// scale these numbers move at.
function fmtBillions(v) {
  if (v == null) return "—";
  return `$${v.toFixed(1)}B`;
}

function fmtPct(v) {
  if (v == null) return "—";
  return `${v.toFixed(1)}%`;
}

// Lightens a hex color toward white by `amount` (0-1) — used to derive a
// visually-related "other" shade from a base agency color, so a
// group-of-two pie slices (e.g. Treasury split into Interest + other) reads
// as one wedge shaded by internal proportion rather than two arbitrary
// colors sitting side by side.
function lightenHex(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function xTicks(data, maxTicks = 8) {
  if (!data || data.length === 0) return [];
  const n = Math.min(data.length, maxTicks);
  const step = Math.floor(data.length / n) || 1;
  return data.filter((_, i) => i % step === 0).map((r) => r.date);
}

// All 7 Treasury yield series are real daily FRED series in the same %
// units already — a plain date-key merge, no forward-fill/ratio math
// needed (unlike mergeSeries/mergeComposition below, which bridge series
// on genuinely different cadences). t10y3mo is the one derived field here —
// no FRED-maintained 10Y-3mo spread series exists (confirmed during the
// Treasuries-picture research pass, unlike T10Y2Y which FRED does maintain
// directly) — computed client-side from dgs10/dgs3mo on whichever dates
// both are real, same "derived values computed at read time" convention as
// everywhere else in this app, just done in the frontend merge instead of
// the backend route since it's a pure function of two already-fetched
// series with no persistence involved either way.
function mergeYields(dgs2, dgs10, dfii10, t10y2y, dgs3mo, dgs5, dgs30) {
  const byDate = {};
  for (const [key, rows] of [
    ["dgs2", dgs2],
    ["dgs10", dgs10],
    ["dfii10", dfii10],
    ["t10y2y", t10y2y],
    ["dgs3mo", dgs3mo],
    ["dgs5", dgs5],
    ["dgs30", dgs30],
  ]) {
    for (const r of rows || []) {
      byDate[r.date] = { ...(byDate[r.date] || {}), date: r.date, [key]: r.value };
    }
  }
  const rows = Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const row of rows) {
    row.t10y3mo = row.dgs10 != null && row.dgs3mo != null ? round1(row.dgs10 - row.dgs3mo) : null;
  }
  return rows;
}

// Foreign/TIC holdings — data.tic_countries is {countryName: [{date,
// value_trillions}]}, data.tic_grand_total is the same shape as one more
// series. Merged into one flat per-date row (same date-key-merge pattern
// as mergeYields) so all countries + the grand total share one chart's x
// axis. TIC_COUNTRY_ORDER fixes a stable ranking (largest real 2026-05
// holders first) so a country's assigned color/legend position doesn't
// reshuffle as values change month to month — same "fixed ranking, not
// re-ranked per period" reasoning as topAgenciesByLatestMonth's own
// comment. Grand Total is NOT one of these countries — see its own
// TIC_COUNTRY_ORDER exclusion and the standalone tic_grand_total field.
const TIC_COUNTRY_ORDER = [
  "Japan", "China", "United Kingdom", "Belgium", "Cayman Islands", "Luxembourg",
  "Canada", "Total Caribbean", "Taiwan", "Ireland", "Switzerland", "Hong Kong",
  "India", "Turkey",
];
const TIC_COUNTRY_COLOR = Object.fromEntries(
  TIC_COUNTRY_ORDER.map((country, i) => [country, VAULT_COLORS[i % VAULT_COLORS.length]])
);
const TIC_GRAND_TOTAL_COLOR = "#e8ecf4";

function mergeTicHoldings(ticCountries, ticGrandTotal) {
  const byDate = {};
  for (const country of TIC_COUNTRY_ORDER) {
    for (const r of ticCountries?.[country] || []) {
      byDate[r.date] = { ...(byDate[r.date] || {}), date: r.date, [country]: r.value_trillions };
    }
  }
  for (const r of ticGrandTotal || []) {
    byDate[r.date] = { ...(byDate[r.date] || {}), date: r.date, grand_total: r.value_trillions };
  }
  return Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// treasury_outlays/db already returns one flat row per real calendar month
// (date, receipts_usd, outlays_usd, deficit_usd, interest_usd) — no merge
// across series needed (unlike mergeYields' 4 separately-fetched FRED
// series), just a trillions conversion + an interest-as-%-of-outlays figure
// used by the sub-panel's collapsed summary.
// U.S. federal fiscal year: Oct-Sep, labeled by the calendar year it ENDS
// in (FY2025 = Oct 2024 - Sep 2025) — same convention Treasury's own MTS
// data uses (matches the fiscal-year-block reconstruction already built
// server-side for Table 1/5 parsing). date is a 'YYYY-MM-01' string.
function fiscalYearOf(dateStr) {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(5, 7));
  return month >= 10 ? year + 1 : year;
}

// Rolls monthly rows up to one row per fiscal year, summing every numeric
// field present across that FY's real months. A FY with fewer than 12 real
// months (the in-progress current FY, or any gap) is marked monthsPresent
// so the UI can flag it as partial rather than silently presenting a
// 9-month sum as if it were a real complete-year total — the same
// nulls-over-zeros spirit as everywhere else in this app, just applied to
// "don't imply completeness that isn't there" instead of "don't fabricate
// a missing number."
function aggregateAnnual(monthlyRows, valueKeys) {
  const byFy = {};
  for (const row of monthlyRows) {
    const fy = fiscalYearOf(row.date);
    const bucket = (byFy[fy] ??= { fiscalYear: fy, date: String(fy), monthsPresent: 0, _sums: {} });
    bucket.monthsPresent += 1;
    for (const key of valueKeys) {
      if (row[key] == null) continue;
      bucket._sums[key] = (bucket._sums[key] ?? 0) + row[key];
    }
  }
  return Object.values(byFy)
    .map((bucket) => {
      const out = { date: bucket.date, fiscalYear: bucket.fiscalYear, monthsPresent: bucket.monthsPresent };
      for (const key of valueKeys) {
        out[key] = bucket._sums[key] != null ? round1(bucket._sums[key]) : null;
      }
      return out;
    })
    .sort((a, b) => a.fiscalYear - b.fiscalYear);
}

function mergeOutlays(rows) {
  return (rows || []).map((r) => ({
    date: r.date,
    outlays: r.outlays_usd != null ? round1(r.outlays_usd / 1e9) : null,
    receipts: r.receipts_usd != null ? round1(r.receipts_usd / 1e9) : null,
    deficit: r.deficit_usd != null ? round1(r.deficit_usd / 1e9) : null,
    interest: r.interest_usd != null ? round1(r.interest_usd / 1e9) : null,
    interest_pct_outlays:
      r.interest_usd != null && r.outlays_usd
        ? round1((r.interest_usd / r.outlays_usd) * 100)
        : null,
  }));
}

// treasury_outlays_by_agency/db returns one flat row per (date, agency) —
// 29 real departments, too many for a flat multi-line/stacked-area chart to
// read (Treasury Yields tops out at 4, Composition's own precedent groups
// down to 2). Reduces to the top N agencies by |outlay_usd| as of the LATEST
// real month (a fixed ranking, not re-ranked per month, so a given agency's
// color/identity stays stable across the whole chart rather than reshuffling
// month to month), bucketing every other agency into a single "Other" sum
// per month. Mirrors comex_inventory.jsx's VAULT_COLORS-cycling convention
// for "N real categories, more than a hand-picked palette" charts.
const OUTLAYS_BY_AGENCY_TOP_N = 8;
const OUTLAYS_OTHER_COLOR = "#5a6278";
// Matches backend/main.py's TREASURY_OUTLAYS_BY_AGENCY_MONTHS — display copy
// only, not a value the fetch itself depends on (the backend already trims
// what it persists; this is just so the panel note states the same number).
const TREASURY_OUTLAYS_BY_AGENCY_WINDOW_LABEL = "3 years";

function topAgenciesByLatestMonth(rows, n) {
  if (!rows || rows.length === 0) return [];
  const latestDate = rows.reduce((max, r) => (r.date > max ? r.date : max), rows[0].date);
  const latestRows = rows.filter((r) => r.date === latestDate);
  return [...latestRows]
    .sort((a, b) => Math.abs(b.outlay_usd ?? 0) - Math.abs(a.outlay_usd ?? 0))
    .slice(0, n)
    .map((r) => r.agency);
}

function mergeOutlaysByAgency(rows, topAgencies) {
  const topSet = new Set(topAgencies);
  const byDate = {};
  for (const r of rows || []) {
    const row = (byDate[r.date] ??= { date: r.date, other: 0, other_has_data: false });
    if (r.outlay_usd == null) continue;
    const billions = round1(r.outlay_usd / 1e9);
    if (topSet.has(r.agency)) {
      row[r.agency] = billions;
    } else {
      row.other += billions;
      row.other_has_data = true;
    }
  }
  return Object.values(byDate)
    .map((row) => ({ ...row, other: row.other_has_data ? round1(row.other) : null }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
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
  // The row grid itself (built from the union of M2's and WALCL's own dates)
  // still reaches WALCL's later, weekly-cadence coverage even once the
  // stacked-area fields above have correctly gone null past M2's real last
  // date — so the chart's x-axis kept stretching out to WALCL's latest date
  // with a trailing empty gap, reading as "the Fed balance sheet extends
  // past the available M2 data" even though no value was actually drawn
  // there. Trim the grid itself to M2's own last real date so the chart's
  // extent matches M2's real coverage, per the user's explicit call.
  return lastRealM2Date == null ? rows : rows.filter((row) => row.date <= lastRealM2Date);
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
// Ordered by real maturity along the curve (3mo -> 2y -> 5y -> 10y -> 30y),
// real-10y right after nominal 10y since it's the same maturity adjusted
// for inflation, with both spread series placed last as a group — spreads
// are a different kind of thing (a computed comparison between two of the
// yields above, not a maturity point on the curve themselves), so grouping
// them at the end of the legend keeps "the curve" and "derived comparisons
// of the curve" visually separate, per the user's explicit request.
const YIELDS_LEGEND_SERIES = [
  {
    key: "dgs3mo",
    legendLabel: "3-Month Yield",
    color: DGS3MO_COLOR,
    eli5: "Market yield on the 3-Month Treasury bill, daily — the very short end of the curve, closely tracking the Fed's current target rate itself rather than expectations about the future (unlike the 2-Year, which prices in where the market thinks policy is headed). DGS3MO specifically (constant-maturity, bond-equivalent basis) rather than the secondary-market discount-basis 3-month bill rate, for methodological consistency with the other constant-maturity series on this chart.",
  },
  {
    key: "dgs2",
    legendLabel: "2-Year Yield",
    color: DGS2_COLOR,
    eli5: "Market yield on the 2-Year Treasury, daily — read as the market's near-term expectation for where the Fed funds rate is headed over the next couple years. Rises when the market expects tighter policy (higher rates for longer), falls when it expects cuts.",
  },
  {
    key: "dgs5",
    legendLabel: "5-Year Yield",
    color: DGS5_COLOR,
    eli5: "Market yield on the 5-Year Treasury, daily — a mid-curve reference point between the near-term-policy-driven 2-Year and the longer-run-expectations-driven 10-Year.",
  },
  {
    key: "dgs10",
    legendLabel: "10-Year Yield",
    color: DGS10_COLOR,
    eli5: "Market yield on the 10-Year Treasury, daily — the most commonly cited long-term rate benchmark (mortgage rates, corporate borrowing costs, and \"risk-free rate\" comparisons all reference this). Reflects longer-run growth/inflation expectations, not just near-term Fed policy.",
  },
  {
    key: "dgs30",
    legendLabel: "30-Year Yield",
    color: DGS30_COLOR,
    eli5: "Market yield on the 30-Year Treasury, daily — the long end of the curve, most closely tied to very-long-run growth/inflation expectations and (indirectly) 30-year mortgage rates, which typically track this yield with a spread on top rather than the 10-Year.",
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
  {
    key: "t10y3mo",
    legendLabel: "10Y–3mo Spread",
    color: T10Y3MO_COLOR,
    eli5: "10-Year yield minus 3-Month yield — the other classic yield-curve-inversion pair, and the one the Fed's own research has cited as the more statistically reliable recession predictor of the two spreads on this chart (vs. 10Y-2Y). No FRED-maintained series exists for this spread the way T10Y2Y is maintained directly, so it's computed here client-side from dgs10/dgs3mo, per the computed-at-read-time convention. Same non-prediction framing as 10Y-2Y — shown as context alongside the two rates it's built from.",
  },
];

// Federal Outlays sub-panel's legend — same click-to-highlight + click-to-reveal
// shape as every other legend in this panel. Flat, ungrouped series (no
// assets/liabilities split), all sharing one dollar axis, so no gradient
// swatch needed — only Interest gets a dashed swatch, per its own dashed
// line on the chart.
const OUTLAYS_LEGEND_SERIES = [
  {
    key: "outlays",
    legendLabel: "Outlays",
    color: OUTLAYS_COLOR,
    eli5: "Total federal spending for the month — every dollar the government paid out, from Social Security and defense to interest on the debt itself. Source: U.S. Treasury's Monthly Treasury Statement (Table 1), reported directly, not derived.",
  },
  {
    key: "receipts",
    legendLabel: "Receipts",
    color: RECEIPTS_COLOR,
    eli5: "Total federal revenue for the month — individual and corporate income tax, payroll tax, excise tax, and other collections. The other half of Outlays minus Receipts = Deficit.",
  },
  {
    key: "deficit",
    legendLabel: "Deficit / Surplus",
    color: DEFICIT_COLOR,
    eli5: "Outlays minus Receipts for the month, reported directly by Treasury (not computed client-side). Positive = deficit (spent more than collected, the normal case in recent decades); negative = surplus. This is the monthly figure, not a running fiscal-year or annual total — expect real month-to-month swings tied to tax-collection timing (e.g. April receipts typically spike from individual filing deadlines).",
  },
  {
    key: "interest",
    legendLabel: "Interest on the Public Debt",
    color: INTEREST_COLOR,
    dashed: true,
    eli5: "The portion of Outlays that's purely the cost of servicing existing federal debt — not new spending, just interest on money already borrowed. Arguably the most direct read on \"why does the money supply keep growing\": as this line grows, more of every new dollar borrowed goes to paying interest on the last dollar borrowed, independent of any policy choice about new programs. Source: Treasury's Monthly Treasury Statement (Table 5, \"Total--Interest on the Public Debt\"). Real API coverage starts 2015-03 — earlier months on this chart will show a gap for this line specifically even where Outlays/Receipts/Deficit have real data back to 2013-10, since the two source tables have different real coverage floors (see fed-spend-spec.md). Historical description only, per AV Voice Rules — not a claim about future debt-service costs.",
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
  const rows = Object.values(byMonth).sort((a, b) => (a.date < b.date ? -1 : 1));
  // pp_index is CPI-derived (CPIAUCSL) and reports monthly with a real
  // publication lag, same pattern as M2 lagging WALCL in mergeSeries above —
  // xag/xau (Yahoo daily closes, resampled to month-end) run much more
  // current. Without a cap, the grid (built from the union of all three
  // series' months) kept stretching out to xag/xau's latest month with
  // Purchasing Power silently absent, reading as "this chart extends past
  // the available data" the same way the M2/WALCL chart did. Trim to
  // Purchasing Power's own last real month so the chart's extent matches
  // its most-lagging real series, same fix/reasoning as mergeSeries' cap.
  const lastRealPpDate = purchasingPower?.length
    ? purchasingPower[purchasingPower.length - 1].date
    : null;
  return lastRealPpDate == null ? rows : rows.filter((row) => row.date <= lastRealPpDate);
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
      {row.dgs3mo != null && <div style={{ color: DGS3MO_COLOR }}>3-Month: {row.dgs3mo.toFixed(2)}%</div>}
      {row.dgs2 != null && <div style={{ color: DGS2_COLOR }}>2-Year: {row.dgs2.toFixed(2)}%</div>}
      {row.dgs5 != null && <div style={{ color: DGS5_COLOR }}>5-Year: {row.dgs5.toFixed(2)}%</div>}
      {row.dgs10 != null && <div style={{ color: DGS10_COLOR }}>10-Year: {row.dgs10.toFixed(2)}%</div>}
      {row.dgs30 != null && <div style={{ color: DGS30_COLOR }}>30-Year: {row.dgs30.toFixed(2)}%</div>}
      {row.dfii10 != null && <div style={{ color: DFII10_COLOR }}>10-Year Real (TIPS): {row.dfii10.toFixed(2)}%</div>}
      {row.t10y2y != null && <div style={{ color: T10Y2Y_COLOR }}>10Y–2Y Spread: {row.t10y2y >= 0 ? "+" : ""}{row.t10y2y.toFixed(2)}%</div>}
      {row.t10y3mo != null && <div style={{ color: T10Y3MO_COLOR }}>10Y–3mo Spread: {row.t10y3mo >= 0 ? "+" : ""}{row.t10y3mo.toFixed(2)}%</div>}
    </div>
  );
}

// Foreign Holdings chart's hover tooltip — shows only currently-visible
// (not hidden) countries plus the grand total, sorted largest-first at
// that date so the ranking is legible at a glance rather than fixed
// alphabetically or by TIC_COUNTRY_ORDER's own latest-month ranking (which
// can differ from a hovered historical date's real ranking).
function TicHoldingsTooltipContent({ active, label, ticMerged, hiddenCountries }) {
  if (!active || !label) return null;
  const row = ticMerged.find((r) => r.date === label);
  if (!row) return null;
  const countryRows = TIC_COUNTRY_ORDER
    .filter((c) => !hiddenCountries.has(c) && row[c] != null)
    .map((c) => ({ name: c, value: row[c], color: TIC_COUNTRY_COLOR[c] }))
    .sort((a, b) => b.value - a.value);
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{label}</div>
      {row.grand_total != null && (
        <div style={{ color: TIC_GRAND_TOTAL_COLOR, fontWeight: 600, marginBottom: 2 }}>
          Grand Total (LT only): {fmtTrillions(row.grand_total)}
        </div>
      )}
      {countryRows.map((c) => (
        <div key={c.name} style={{ color: c.color }}>
          {c.name}: {fmtTrillions(c.value)}
        </div>
      ))}
    </div>
  );
}

// Bid-to-cover chart's hover tooltip — unlike the other Money Supply
// tooltips, more than one real auction can share the same date (a Bill and
// a Note auctioned the same day are both real, distinct rows), so this
// looks up ALL auctionsMerged rows for the hovered date rather than
// find()ing a single row.
function AuctionsTooltipContent({ active, label, auctionsMerged }) {
  if (!active || !label) return null;
  const rows = auctionsMerged.filter((r) => r.date === label);
  if (!rows.length) return null;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{label}</div>
      {rows.map((r) => (
        <div key={r.cusip} style={{ color: AUCTION_TYPE_COLOR[r.security_type] ?? "#c8d0de", marginBottom: 2 }}>
          {r.security_type} ({r.security_term}): {r.bid_to_cover_ratio.toFixed(2)}x bid-to-cover
          {r.high_yield != null && `, ${r.high_yield.toFixed(2)}% yield`}
        </div>
      ))}
    </div>
  );
}

// Buyer-mix %-stacked chart's hover tooltip — single security type at a
// time, so a plain find() by date is correct here (unlike AuctionsTooltipContent).
function AuctionMixTooltipContent({ active, label, rows, hiddenBuyers }) {
  if (!active || !label) return null;
  const row = rows.find((r) => r.date === label);
  if (!row) return null;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>
        {label} ({row.security_term})
      </div>
      {AUCTION_BUYERS.filter((b) => !hiddenBuyers?.has(b.key) && row[`${b.key}_pct`] != null).map((b) => (
        <div key={b.key} style={{ color: AUCTION_BUYER_COLORS[b.key] }}>
          {b.label}: {row[`${b.key}_pct`].toFixed(1)}%
        </div>
      ))}
    </div>
  );
}

function OutlaysTooltipContent({ active, label, outlaysMerged }) {
  if (!active || !label) return null;
  const row = outlaysMerged.find((r) => r.date === label);
  if (!row) return null;
  const headerLabel = row.fiscalYear != null
    ? `FY${row.fiscalYear}${row.monthsPresent < 12 ? ` (partial, ${row.monthsPresent}/12 mo.)` : ""}`
    : label;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{headerLabel}</div>
      {row.outlays != null && <div style={{ color: OUTLAYS_COLOR }}>Outlays: {fmtBillions(row.outlays)}</div>}
      {row.receipts != null && <div style={{ color: RECEIPTS_COLOR }}>Receipts: {fmtBillions(row.receipts)}</div>}
      {row.deficit != null && (
        <div style={{ color: row.deficit >= 0 ? LOSS_COLOR : WIN_COLOR }}>
          {row.deficit >= 0 ? "Deficit" : "Surplus"}: {fmtBillions(Math.abs(row.deficit))}
        </div>
      )}
      {row.interest != null && (
        <div style={{ color: INTEREST_COLOR }}>
          Interest on the Public Debt: {fmtBillions(row.interest)}
          {row.interest_pct_outlays != null && ` (${fmtPct(row.interest_pct_outlays)} of Outlays)`}
        </div>
      )}
    </div>
  );
}

// Interest-on-Treasury pie, shared by both the Topline and By Department
// Federal Outlays views — a real user-requested consolidation: Interest was
// first a standalone Topline-only pie, then folded into a Treasury/Interest
// split inside the By Department pie, then the user asked for that SAME
// pie to also appear in the Topline view rather than maintaining two. One
// component, two call sites (see the pie's own comments in outlaysView's
// JSX for how outlaysByAgencyPieData/TREASURY_AGENCY_NAME's split works).
function OutlaysInterestPieChart({ pieData, pieRow, clickedAgencyKey }) {
  if (!pieRow) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <ResponsiveContainer width={180} height={180}>
        <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <Pie
            data={pieData}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={70}
            innerRadius={36}
            paddingAngle={1}
          >
            {/* Dimming/highlight keys off entry.group, not entry.key —
                Treasury's two sub-slices (interest/other) share one group
                value (treasuryAgencyName) so clicking Treasury's single
                legend row highlights both sub-wedges together as one unit,
                matching the "Treasury is one thing" framing even though
                it's 2 real Cells under the hood. Every other agency's group
                equals its own key, so this is a no-op change for them. */}
            {pieData.map((entry) => (
              <Cell
                key={entry.key}
                fill={entry.color}
                fillOpacity={clickedAgencyKey && clickedAgencyKey !== entry.group ? 0.35 : 1}
                stroke={clickedAgencyKey === entry.group ? "#e8ecf4" : undefined}
                strokeWidth={clickedAgencyKey === entry.group ? 2 : undefined}
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
            formatter={(v, name) => [fmtBillions(v), name]}
          />
        </PieChart>
      </ResponsiveContainer>
      {pieRow.date && (
        <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 4 }}>
          {pieRow.fiscalYear != null
            ? `FY${pieRow.fiscalYear}${pieRow.monthsPresent < 12 ? " (partial)" : ""}`
            : `As of ${pieRow.date}`}
        </div>
      )}
    </div>
  );
}

function OutlaysInterestLegend({
  pieRow,
  topAgencies,
  treasuryAgencyName,
  interestAsOfRow,
  agencyColor,
  clickedAgencyKey,
  setClickedAgencyKey,
  otherCount,
  hiddenAgencies,
  setHiddenAgencies,
}) {
  if (!pieRow) return null;
  // Checkbox = show/hide (drives the stacked chart's Area mounting AND the
  // y-axis rescale — see clickedAgencyYDomain/the Area-slot filter in the
  // chart JSX), separate from the existing click-to-highlight-and-restack
  // button — same "checkbox toggles visibility, button toggles
  // highlight/selection" split already established by the Purchasing Power
  // chart's own legend (metals-legend-checkbox + a separate button).
  const toggleHidden = (key) =>
    setHiddenAgencies((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <>
      <div className="comex-legend-list comex-legend-list--horizontal">
        {topAgencies.map((a) => {
          // Treasury stays ONE legend row — per the user's explicit
          // "Treasury is one thing" framing — but its swatch is a two-tone
          // gradient (own base color for Interest's real share, a
          // lightened tint for the remainder) so the row itself previews
          // the same interest-proportion split the pie wedge shows, rather
          // than a flat single-color swatch that hides it.
          const isTreasury = a === treasuryAgencyName;
          const treasuryTotal = isTreasury ? pieRow[a] : null;
          const treasuryInterestPct = isTreasury && interestAsOfRow != null && treasuryTotal
            ? Math.min(100, Math.round((Math.min(interestAsOfRow.interest, treasuryTotal) / treasuryTotal) * 100))
            : null;
          const swatchStyle = treasuryInterestPct != null
            ? {
                background: `linear-gradient(90deg, ${agencyColor(a)} ${treasuryInterestPct}%, ${lightenHex(agencyColor(a), 0.55)} ${treasuryInterestPct}%)`,
              }
            : { background: agencyColor(a) };
          return (
            <div key={a} className="metals-legend-row">
              <input
                type="checkbox"
                className="metals-legend-checkbox"
                checked={!hiddenAgencies.has(a)}
                onChange={() => toggleHidden(a)}
                title={hiddenAgencies.has(a) ? "Show this department" : "Hide this department"}
              />
              <button
                className={`comex-legend-item legend-btn-row${clickedAgencyKey === a ? " legend-btn-row--baseline" : ""}`}
                onClick={() => setClickedAgencyKey((k) => (k === a ? null : a))}
              >
                <span className="comex-legend-swatch" style={swatchStyle} />
                <span>
                  <strong>{a}</strong>
                  {treasuryInterestPct != null && (
                    <span style={{ color: "#8a94a6", fontWeight: "normal" }}> ({treasuryInterestPct}% interest)</span>
                  )}
                  {/* Per-department total at the resolved pin/hover/latest
                      date (pieRow) — replaces the static full-width pinned
                      readout box that used to render this same data below
                      the chart, per the user's explicit request to move it
                      here instead. */}
                  {pieRow[a] != null && (
                    <span style={{ color: "#8a94a6", fontWeight: "normal" }}> — {fmtBillions(pieRow[a])}</span>
                  )}
                </span>
              </button>
            </div>
          );
        })}
        <div className="metals-legend-row">
          <input
            type="checkbox"
            className="metals-legend-checkbox"
            checked={!hiddenAgencies.has("other")}
            onChange={() => toggleHidden("other")}
            title={hiddenAgencies.has("other") ? "Show Other" : "Hide Other"}
          />
          <button
            className={`comex-legend-item legend-btn-row${clickedAgencyKey === "other" ? " legend-btn-row--baseline" : ""}`}
            onClick={() => setClickedAgencyKey((k) => (k === "other" ? null : "other"))}
          >
            <span className="comex-legend-swatch" style={{ background: OUTLAYS_OTHER_COLOR }} />
            <span>
              <strong>Other ({otherCount} more)</strong>
              {pieRow.other != null && (
                <span style={{ color: "#8a94a6", fontWeight: "normal" }}> — {fmtBillions(pieRow.other)}</span>
              )}
            </span>
          </button>
        </div>
      </div>
      <div className="comex-panel-note" style={{ marginTop: 8, color: "#8a94a6" }}>
        Note: Department of the Treasury's own reported total includes Interest on the Public Debt
        (Treasury is who issues/services it) — shown here as one wedge, shaded internally by its
        own interest share (darker portion) vs. the rest of Treasury's spending (lighter portion).
        Click the Treasury row to highlight the whole wedge.
      </div>
    </>
  );
}

// Live hover tooltip for the By Department chart (Recharts' normal
// cursor-following box). The static pinned-date box that used to render
// this same data in a full-width grid below the chart was removed at the
// user's request — those per-department totals now render inline next to
// each legend row instead (see OutlaysInterestLegend's valueRow prop).
function OutlaysByAgencyTooltipContent({ active, label, rows, topAgencies, agencyColor, otherCount }) {
  if (!active || !label) return null;
  const row = rows.find((r) => r.date === label);
  if (!row) return null;
  const headerLabel = row.fiscalYear != null
    ? `FY${row.fiscalYear}${row.monthsPresent < 12 ? ` (partial, ${row.monthsPresent}/12 mo.)` : ""}`
    : label;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{headerLabel}</div>
      {topAgencies
        .filter((a) => row[a] != null)
        .sort((a, b) => Math.abs(row[b] ?? 0) - Math.abs(row[a] ?? 0))
        .map((a) => (
          <div key={a} style={{ color: agencyColor(a) }}>
            {a}: {fmtBillions(row[a])}
          </div>
        ))}
      {row.other != null && (
        <div style={{ color: OUTLAYS_OTHER_COLOR }}>Other ({otherCount} more): {fmtBillions(row.other)}</div>
      )}
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
  const [outlaysData, setOutlaysData] = useState(null);
  const [outlaysByAgencyData, setOutlaysByAgencyData] = useState(null);
  // Auctions data is fetched once per mount, independent of the panel-wide
  // window_ state — /api/treasury-auctions/db has no window param at all
  // (deliberately: real persisted history is a rolling ~120-day trailing
  // window on disk, not multi-year, so a window selector implying more
  // history exists than does would be misleading — see the route's own
  // comment in main.py). Fetched separately from `load` below rather than
  // folded into its Promise.all, since it doesn't need to re-fire on every
  // window/custom-range change the way the money/metals/outlays fetches do.
  const [auctionsData, setAuctionsData] = useState(null);
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
  // Same pattern applied to the Treasury Yields chart's legend.
  const [clickedYieldsKey, setClickedYieldsKey] = useState(null);
  // Per-series show/hide for the Treasury Yields chart — same
  // checkbox-toggles-visibility / button-toggles-highlight split as the
  // Federal Outlays by Department legend's hiddenAgencies, applied here at
  // the user's explicit request once the curve grew from 4 to 7 series
  // (dense enough that hiding a few becomes genuinely useful, same
  // motivation as the by-department legend's own hide feature).
  const [hiddenYieldsKeys, setHiddenYieldsKeys] = useState(() => new Set());
  // Same pattern applied to the Purchasing Power chart's companion pie
  // (fiat/gold/silver relative-value split) — see metalsPieData below.
  const [clickedMetalsPieKey, setClickedMetalsPieKey] = useState(null);
  // Same pattern applied to the Federal Outlays chart's 4-entry legend.
  const [clickedOutlaysKey, setClickedOutlaysKey] = useState(null);
  // Same pattern applied to the Outlays by Agency chart's top-N + Other legend.
  const [clickedAgencyKey, setClickedAgencyKey] = useState(null);
  // Per-department show/hide for the Outlays by Agency stacked chart —
  // separate from clickedAgencyKey (which highlights + restacks-to-bottom
  // on click, same click-to-highlight convention as every other legend in
  // this file). A Set of HIDDEN agency names/"other", empty by default (all
  // visible) — same "checkbox toggles visibility, button toggles
  // highlight" split already established by the Purchasing Power chart's
  // own legend (metals-legend-checkbox + a separate button).
  const [hiddenAgencies, setHiddenAgencies] = useState(() => new Set());
  // Shared by both Federal Outlays sub-panels (Topline, by Agency) — toggles
  // between the real monthly rows and a client-side fiscal-year rollup of
  // them. Not part of the panel-wide window_ state: window_ controls WHICH
  // dates are fetched, this controls how the already-fetched monthly rows
  // are displayed, a orthogonal concern scoped to just these two charts.
  const [outlaysGranularity, setOutlaysGranularity] = useState("monthly"); // "monthly" | "annual"

  // Real memory reduction, not just visual hiding: native <details> closed
  // state only applies display:none — it does NOT unmount a collapsed
  // panel's content, so Recharts' SVG trees and every chart's derived data
  // stayed fully resident in memory regardless of collapsed/open state, a
  // real cost the user flagged directly. Each sub-panel's body is now only
  // rendered while its own open flag is true (defaults to false/collapsed,
  // matching the earlier "default all sub-panels collapsed" request) —
  // opening a panel mounts its chart fresh from already-fetched data (a
  // re-render, not a refetch), collapsing it unmounts that render entirely.
  // No other file in this codebase has this pattern yet (every other
  // <details className="collapsible-pane"> is uncontrolled, just the
  // native open attribute) — this is the first controlled one, done here
  // because Money Supply is the panel with the memory complaint.
  const [m2PanelOpen, setM2PanelOpen] = useState(false);
  const [compositionPanelOpen, setCompositionPanelOpen] = useState(false);
  const [qeQtPanelOpen, setQeQtPanelOpen] = useState(false);
  const [yieldsPanelOpen, setYieldsPanelOpen] = useState(false);
  const [auctionsPanelOpen, setAuctionsPanelOpen] = useState(false);
  const [ticPanelOpen, setTicPanelOpen] = useState(false);
  const [metalsPanelOpen, setMetalsPanelOpen] = useState(false);
  const [outlaysPanelOpen, setOutlaysPanelOpen] = useState(false);
  // Topline (flat outlays/receipts/deficit/interest lines) vs. By Department
  // (stacked area + pie, same data source split out by agency) used to be
  // two separate collapsible panels — merged into one panel with this
  // toggle at the user's request, since they're two views of the same
  // Treasury data sharing one granularity/window control anyway.
  const [outlaysView, setOutlaysView] = useState("topline"); // "topline" | "byAgency"
  // Which real month the pie snapshot shows — pin > hover > latest, same
  // priority rule as compositionPieRow above.
  const [hoveredAgencyDate, setHoveredAgencyDate] = useState(null);

  // A real bug caught by the user: the default 2Y window only covers ~24
  // real months, straddling 3 fiscal years where the FIRST and LAST are
  // both partial (e.g. FY2024 with only 3 of 12 months) — switching to
  // Annual under that window made the "latest" summary/pie default to a
  // 3-month partial year, which read as if the chart had reset/lost data.
  // Switching TO annual auto-widens window_ to at least 10y (only if the
  // current window is narrower — never fights a window the user already
  // widened themselves) so Annual always defaults to showing several real
  // complete fiscal years. Switching back to Monthly does NOT auto-narrow
  // window_ back down — that's the user's own choice, not something to
  // undo automatically.
  const OUTLAYS_WINDOW_RANK = { "2y": 0, "5y": 1, "10y": 2, "20y": 3, custom: 4 };
  function handleOutlaysGranularityChange(g) {
    setOutlaysGranularity(g);
    if (g === "annual" && (OUTLAYS_WINDOW_RANK[window_] ?? 4) < OUTLAYS_WINDOW_RANK["10y"]) {
      setWindow("10y");
    }
  }

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
      const [moneyRes, metalsRes, outlaysRes, outlaysByAgencyRes] = await Promise.all([
        fetch(`/api/fred/money-supply/db?window=${w}${rangeParams}`),
        fetch(`/api/metals/prices/db?window=${w}${rangeParams}`),
        fetch(`/api/treasury-outlays/db?window=${w}${rangeParams}`),
        fetch(`/api/treasury-outlays-by-agency/db?window=${w}${rangeParams}`),
      ]);
      if (!moneyRes.ok) throw new Error(`HTTP ${moneyRes.status}`);
      if (!metalsRes.ok) throw new Error(`HTTP ${metalsRes.status}`);
      if (!outlaysRes.ok) throw new Error(`HTTP ${outlaysRes.status}`);
      if (!outlaysByAgencyRes.ok) throw new Error(`HTTP ${outlaysByAgencyRes.status}`);
      const moneyJson = await moneyRes.json();
      const metalsJson = await metalsRes.json();
      const outlaysJson = await outlaysRes.json();
      const outlaysByAgencyJson = await outlaysByAgencyRes.json();
      setData(moneyJson.data ?? null);
      setMetalsData(metalsJson.data ?? null);
      setOutlaysData(outlaysJson.data ?? null);
      setOutlaysByAgencyData(outlaysByAgencyJson.data ?? null);
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

  useEffect(() => {
    fetch("/api/treasury-auctions/db")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) => setAuctionsData(json.data ?? null))
      .catch(() => setAuctionsData(null));
  }, []);

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
    () => (data ? mergeYields(data.dgs2, data.dgs10, data.dfii10, data.t10y2y, data.dgs3mo, data.dgs5, data.dgs30) : []),
    [data]
  );
  const yieldsTicks = useMemo(() => xTicks(yieldsMerged), [yieldsMerged]);

  const auctionsMerged = useMemo(() => mergeAuctions(auctionsData), [auctionsData]);
  // Bid-to-cover chart plots every security type on one shared axis
  // (auctionSelectedTypes controls which lines show, checkbox-style, same
  // show/hide convention as the Yields/By-Department legends). The buyer-mix
  // %-stacked chart only makes sense for ONE security type at a time (Bills
  // vs. 30-Year Bonds have structurally different buyer compositions — an
  // "all types stacked together" mix would be a meaningless blend), hence
  // the separate single-select auctionMixType below.
  const [auctionSelectedTypes, setAuctionSelectedTypes] = useState(() => new Set(AUCTION_SECURITY_TYPES));
  const [auctionMixType, setAuctionMixType] = useState("Note");
  // Click-to-highlight for both Treasury Auctions charts' legends — same
  // convention as every other legend in this file (checkbox toggles
  // visibility, a separate click highlights + dims the rest).
  const [clickedAuctionTypeKey, setClickedAuctionTypeKey] = useState(null);
  const [clickedAuctionBuyerKey, setClickedAuctionBuyerKey] = useState(null);
  const [hiddenAuctionBuyers, setHiddenAuctionBuyers] = useState(() => new Set());
  const auctionsByType = useMemo(() => {
    const byType = {};
    for (const t of AUCTION_SECURITY_TYPES) byType[t] = [];
    for (const row of auctionsMerged) {
      if (byType[row.security_type]) byType[row.security_type].push(row);
    }
    return byType;
  }, [auctionsMerged]);
  const auctionMixRows = auctionsByType[auctionMixType] || [];
  // Bid-to-cover chart's real chart data — one row per date, one column
  // per security type (see mergeAuctionsByType's own comment for the real
  // mis-positioning bug this replaces). auctionsMerged itself stays a flat
  // per-auction list, used elsewhere (buyer-mix filtering, the tooltip's
  // multi-row-per-date lookup).
  const auctionsPivoted = useMemo(() => mergeAuctionsByType(auctionsMerged), [auctionsMerged]);
  const auctionsTicks = useMemo(() => xTicks(auctionsPivoted), [auctionsPivoted]);
  const auctionMixTicks = useMemo(() => xTicks(auctionMixRows), [auctionMixRows]);
  // Cross-chart pin (pinnedDate) never reached either Auctions chart before
  // — a real gap the user caught ("doesn't seem to be shifting with the
  // page like the others"): every other chart in this panel both
  // originates a pin (click sets pinnedDate) and displays one set
  // elsewhere via its own snapped ReferenceLine; Auctions did neither.
  // auctionsMerged/auctionMixRows have their own date grids (auctionMixRows
  // is additionally filtered to one security type), so each snaps
  // independently, same "different charts, different grids" reasoning as
  // every other nearestRowDate call in this file.
  const pinnedDateAuctions = nearestRowDate(auctionsPivoted, pinnedDate);
  const pinnedDateAuctionMix = nearestRowDate(auctionMixRows, pinnedDate);

  // Foreign/TIC holdings — comes back inside the same /api/fred/money-supply/db
  // response as everything else on this tab (data.tic_countries/
  // data.tic_grand_total), so it shares the panel-wide window_ state and
  // needs no separate fetch, unlike auctionsData above.
  const ticMerged = useMemo(() => (data ? mergeTicHoldings(data.tic_countries, data.tic_grand_total) : []), [data]);
  const ticTicks = useMemo(() => xTicks(ticMerged), [ticMerged]);
  const [hiddenTicCountries, setHiddenTicCountries] = useState(() => new Set());
  const [clickedTicKey, setClickedTicKey] = useState(null);

  const outlaysMonthly = useMemo(() => mergeOutlays(outlaysData), [outlaysData]);
  // Annual rollup sums outlays/receipts/deficit/interest across each FY's
  // real months, then recomputes interest_pct_outlays from the SUMMED
  // figures (not a sum/average of the monthly percentages, which would be
  // a meaningless number — the ratio only makes sense computed against the
  // annual totals directly).
  const outlaysAnnual = useMemo(() => {
    const rows = aggregateAnnual(outlaysMonthly, ["outlays", "receipts", "deficit", "interest"]);
    return rows.map((row) => ({
      ...row,
      interest_pct_outlays:
        row.interest != null && row.outlays ? round1((row.interest / row.outlays) * 100) : null,
    }));
  }, [outlaysMonthly]);
  const outlaysMerged = outlaysGranularity === "annual" ? outlaysAnnual : outlaysMonthly;
  const outlaysTicks = useMemo(() => xTicks(outlaysMerged), [outlaysMerged]);

  const topAgencies = useMemo(
    () => topAgenciesByLatestMonth(outlaysByAgencyData, OUTLAYS_BY_AGENCY_TOP_N),
    [outlaysByAgencyData]
  );
  const outlaysByAgencyMonthly = useMemo(
    () => mergeOutlaysByAgency(outlaysByAgencyData, topAgencies),
    [outlaysByAgencyData, topAgencies]
  );
  const outlaysByAgencyAnnual = useMemo(
    () => aggregateAnnual(outlaysByAgencyMonthly, [...topAgencies, "other"]),
    [outlaysByAgencyMonthly, topAgencies]
  );
  const outlaysByAgencyMerged = outlaysGranularity === "annual" ? outlaysByAgencyAnnual : outlaysByAgencyMonthly;
  const outlaysByAgencyTicks = useMemo(
    () => xTicks(outlaysByAgencyMerged, outlaysGranularity === "annual" ? 8 : 4),
    [outlaysByAgencyMerged, outlaysGranularity]
  );
  const allAgencyNames = useMemo(
    () => [...new Set((outlaysByAgencyData || []).map((r) => r.agency))],
    [outlaysByAgencyData]
  );
  // Clicking a department moves it to the bottom of the stack (see the
  // Area re-sort in the chart JSX below) so its own band starts from a flat
  // zero baseline instead of sitting mid-stack — but the y-axis still spans
  // the FULL stacked total (every department combined), so a smaller
  // department's real month-to-month variation was still visually
  // flattened to a thin sliver near the bottom of a much taller axis. Per
  // the user's explicit request ("I don't care that it distorts the scale
  // for the other departments when I'm looking at one"), the axis rescales
  // to just that department's own real min/max — since it's the bottom
  // band starting at 0, this is [0, max value * 1.05], not a min/max span
  // (there's no meaningful "min" above 0 baseline to anchor to). Only
  // active while a department is clicked; unclicking (or hovering the
  // legend "Other" row, etc.) reverts to the normal full-stack domain.
  // Hiding one or more departments (via the legend's per-department
  // checkboxes) shrinks the real stacked total just like clicking a single
  // department does — the axis should rescale to whatever's actually still
  // visible, not stay sized for the full original stack (which would leave
  // a mostly-empty chart if several large departments are hidden). Both
  // cases funnel through the same domain: clicking one department shows
  // just that department's own max (its bottom-of-stack band, [0, max]);
  // otherwise, if anything is hidden, the domain is the max real total
  // across only the currently-visible agencies+other, summed per row (this
  // IS the actual stack height the chart will render, since Recharts stacks
  // whatever Areas are actually mounted).
  const clickedAgencyYDomain = useMemo(() => {
    // Guard: if the clicked department has since been hidden via its
    // checkbox, it's no longer rendered at all (see the Area-slot filter in
    // the chart JSX) — fall through to the hidden-agencies branch below
    // rather than computing a domain sized for a department that isn't on
    // the chart.
    if (clickedAgencyKey && !hiddenAgencies.has(clickedAgencyKey)) {
      let max = 0;
      for (const row of outlaysByAgencyMerged) {
        const v = row[clickedAgencyKey];
        if (v != null) max = Math.max(max, v);
      }
      return max > 0 ? [0, round1(max * 1.05)] : undefined;
    }
    if (hiddenAgencies.size === 0) return undefined;
    const visibleKeys = [...topAgencies, "other"].filter((a) => !hiddenAgencies.has(a));
    let max = 0;
    for (const row of outlaysByAgencyMerged) {
      let total = 0;
      for (const key of visibleKeys) {
        if (row[key] != null) total += row[key];
      }
      max = Math.max(max, total);
    }
    return max > 0 ? [0, round1(max * 1.05)] : undefined;
  }, [clickedAgencyKey, outlaysByAgencyMerged, hiddenAgencies, topAgencies]);
  const agencyColor = (name) => VAULT_COLORS[topAgencies.indexOf(name) % VAULT_COLORS.length];
  const outlaysOtherCount = Math.max(0, allAgencyNames.length - topAgencies.length);

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
  const pinnedDateOutlays = nearestRowDate(outlaysMerged, pinnedDate);
  // Topline's own simple pie: Outlays split into Interest vs. everything
  // else, sitting beside the Topline chart the same way every other paired
  // chart+pie in this panel is laid out. Deliberately NOT the By
  // Department view's Treasury-splitting pie (that one only exists to
  // solve a different problem — Treasury's reported total already
  // including Interest) — this is a plain 2-slice pie of one period's real
  // Outlays total, reusing outlaysMerged (the Topline series) directly
  // rather than the by-agency date grid.
  const outlaysToplinePieRow = pinnedDateOutlays
    ? outlaysMerged.find((r) => r.date === pinnedDateOutlays)
    : [...outlaysMerged].reverse().find((r) => r.interest_pct_outlays != null);
  const outlaysToplinePieData = outlaysToplinePieRow && outlaysToplinePieRow.interest != null && outlaysToplinePieRow.outlays != null
    ? [
        { key: "interest", name: "Interest on the Public Debt", value: outlaysToplinePieRow.interest, color: INTEREST_COLOR },
        {
          key: "everything_else",
          name: "Everything Else",
          value: Math.max(0, round1(outlaysToplinePieRow.outlays - outlaysToplinePieRow.interest)),
          color: OUTLAYS_COLOR,
        },
      ]
    : [];
  const pinnedDateOutlaysByAgency = nearestRowDate(outlaysByAgencyMerged, pinnedDate);
  // Pin > hover > latest, same priority rule as compositionPieRow.
  const outlaysByAgencyPieDate = pinnedDate
    ? pinnedDateOutlaysByAgency
    : hoveredAgencyDate
      ? nearestRowDate(outlaysByAgencyMerged, hoveredAgencyDate)
      : outlaysByAgencyMerged[outlaysByAgencyMerged.length - 1]?.date;
  const outlaysByAgencyPieRow = outlaysByAgencyMerged.find((r) => r.date === outlaysByAgencyPieDate);
  // Department of the Treasury's own reported total already includes
  // Interest on the Public Debt mixed in with its other spending (grants,
  // operations, etc.) — confirmed live against the real agency string
  // ("Department of the Treasury") — so Interest isn't a separate top-level
  // bucket in the by-agency data the way it is in the Topline series.
  // Combining the two pies at the user's request means splitting Treasury's
  // one slice into two: Interest on the Public Debt (pulled from the
  // Topline outlaysMerged series, nearest date on/before this pie's own
  // date, same "as-of" convention used elsewhere for cross-series joins —
  // e.g. the leverage panel's registered-inventory join) and "Treasury
  // (other)" (Treasury's reported total minus that Interest figure). Every
  // other department's slice is unchanged. This keeps the pie's total
  // summing to real Outlays with no double-count, rather than adding
  // Interest as an extra overlay slice on top of an unmodified Treasury
  // total (which would double-count Interest dollars).
  const TREASURY_AGENCY_NAME = "Department of the Treasury";
  const interestAsOfRow = outlaysByAgencyPieRow
    ? [...outlaysMerged].reverse().find((r) => r.date <= outlaysByAgencyPieRow.date && r.interest != null)
    : null;
  // Treasury reads as ONE wedge (one legend row, one highlight target, per
  // the user's explicit "Treasury is one thing" framing) shaded internally
  // by its own interest share — not two arbitrarily-colored slices sitting
  // side by side. Both sub-parts share `group: TREASURY_AGENCY_NAME` so the
  // legend can render a single row and clicking it highlights both; the
  // "interest" sub-slice keeps Treasury's own base color (agencyColor),
  // "other" is a lightened tint of that same hue (lightenHex) so the two
  // read as one color family split by proportion, not two unrelated colors.
  const outlaysByAgencyPieData = outlaysByAgencyPieRow
    ? [
        ...topAgencies
          .filter((a) => outlaysByAgencyPieRow[a] != null && outlaysByAgencyPieRow[a] > 0 && !hiddenAgencies.has(a))
          .flatMap((a) => {
            const total = outlaysByAgencyPieRow[a];
            if (a !== TREASURY_AGENCY_NAME || interestAsOfRow == null) {
              return [{ key: a, group: a, name: a, value: total, color: agencyColor(a) }];
            }
            const interestValue = Math.min(interestAsOfRow.interest, total);
            const otherValue = Math.max(0, round1(total - interestValue));
            const treasuryBase = agencyColor(a);
            return [
              {
                key: "interest",
                group: a,
                name: "Interest on the Public Debt",
                value: interestValue,
                color: treasuryBase,
              },
              ...(otherValue > 0
                ? [{ key: a, group: a, name: "Treasury (other)", value: otherValue, color: lightenHex(treasuryBase, 0.55) }]
                : []),
            ];
          }),
        ...(outlaysByAgencyPieRow.other != null && outlaysByAgencyPieRow.other > 0 && !hiddenAgencies.has("other")
          ? [{ key: "other", group: "other", name: `Other (${outlaysOtherCount} more)`, value: outlaysByAgencyPieRow.other, color: OUTLAYS_OTHER_COLOR }]
          : []),
      ]
    : [];
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

  // Companion pie for the Purchasing Power chart — visualizes the exact
  // same comparison the click-to-hold gesture's tooltip already shows in
  // text: "since the held date, how did fiat/gold/silver each do, relative
  // to the current baseline." Reuses computeHeldComparison directly (same
  // function powering MetalsTooltip's held-comparison branch) rather than a
  // separate window-start rebase, so the pie and the tooltip can never
  // disagree about what a given held date means. Purchasing Power is
  // excluded (same as it's excluded from baseline selection — not a
  // holdable asset). A pie's slices must be non-negative and sum to a
  // meaningful whole — heldComparison.stakeValue (each series' $100 grown
  // by its relative return since the held date) already is that: an
  // underperformer's slice just shrinks relative to the others, an
  // outperformer's grows, and the baseline's own slice always stays exactly
  // $100 (0% relative return by construction).
  const METALS_PIE_SERIES = METAL_SERIES.filter((s) => s.selectableBaseline);
  const metalsHeldComparison = heldDate ? computeHeldComparison(metalsIndexed, heldDate, baseline) : null;
  const metalsPieData = metalsHeldComparison
    ? METALS_PIE_SERIES.filter(({ key }) => metalsHeldComparison.stakeValue[key] != null).map(({ key, label: seriesLabel }) => ({
        key,
        name: seriesLabel,
        value: metalsHeldComparison.stakeValue[key],
        pct: metalsHeldComparison.relative[key],
        color: METAL_SERIES_COLOR[key],
      }))
    : [];

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

      <details className="collapsible-pane" open={m2PanelOpen} onToggle={(e) => setM2PanelOpen(e.target.open)}>
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
      {m2PanelOpen && (
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
      )}
      </details>

      <details className="collapsible-pane" open={compositionPanelOpen} onToggle={(e) => setCompositionPanelOpen(e.target.open)}>
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
      {compositionPanelOpen && (
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
      )}
      </details>

      <details className="collapsible-pane" open={outlaysPanelOpen} onToggle={(e) => setOutlaysPanelOpen(e.target.open)}>
      <summary className="collapsible-pane-title">
        Federal Outlays{outlaysView === "byAgency" ? " by Department/Agency" : ""}
        {outlaysView === "topline" && outlaysMerged.length > 0 && (
          <span style={{ fontWeight: "normal", fontSize: 12, color: "#8a94a6", marginLeft: 10 }}>
            {(() => {
              const row = pinnedDate
                ? outlaysMerged.find((r) => r.date === pinnedDateOutlays)
                : outlaysMerged[outlaysMerged.length - 1];
              if (!row) return null;
              const label = row.fiscalYear != null
                ? `FY${row.fiscalYear}${row.monthsPresent < 12 ? ` (partial, ${row.monthsPresent}/12 mo.)` : ""}`
                : row.date;
              return (
                <>
                  {label} ·{" "}
                  {row.deficit != null && (
                    <span style={{ color: row.deficit >= 0 ? LOSS_COLOR : WIN_COLOR }}>
                      {row.deficit >= 0 ? "Deficit" : "Surplus"} {fmtBillions(Math.abs(row.deficit))}
                    </span>
                  )}
                  {row.interest_pct_outlays != null &&
                    ` · Interest ${fmtPct(row.interest_pct_outlays)} of Outlays`}
                </>
              );
            })()}
          </span>
        )}
        {outlaysView === "byAgency" && outlaysByAgencyPieRow?.date && (
          <span style={{ fontWeight: "normal", fontSize: 12, color: "#8a94a6", marginLeft: 10 }}>
            {outlaysByAgencyPieRow.fiscalYear != null
              ? `FY${outlaysByAgencyPieRow.fiscalYear}${outlaysByAgencyPieRow.monthsPresent < 12 ? ` (partial, ${outlaysByAgencyPieRow.monthsPresent}/12 mo.)` : ""}`
              : outlaysByAgencyPieRow.date}
            {topAgencies[0] && outlaysByAgencyPieRow[topAgencies[0]] != null &&
              ` · Top: ${topAgencies[0]} ${fmtBillions(outlaysByAgencyPieRow[topAgencies[0]])}`}
          </span>
        )}
      </summary>
      {outlaysPanelOpen && (
      <div className="collapsible-pane-body">
      {/* Topline (flat lines) and By Department (stacked area + pie) used to
          be two separate collapsible panels — merged into one at the user's
          request, since both are the same Treasury Monthly Treasury
          Statement data sharing one granularity/window control, just split
          by total vs. by-agency. This toggle picks which chart body below
          renders; outlaysGranularity/outlaysMerged/outlaysByAgencyMerged
          etc. are unchanged from before the merge. */}
      <div className="comex-range-selector" style={{ marginBottom: 8 }}>
        {[{ key: "topline", label: "Topline" }, { key: "byAgency", label: "By Department" }].map((v) => (
          <button
            key={v.key}
            className={`comex-range-btn${outlaysView === v.key ? " comex-range-btn--active" : ""}`}
            onClick={() => setOutlaysView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </div>
      <div className="comex-panel-note">
        {outlaysView === "topline" ? (
          <>
            Why the money supply keeps growing, alongside how much of it there already is. Federal
            outlays, receipts, deficit/surplus, and interest expense on the public debt — U.S.
            Treasury's Monthly Treasury Statement. Descriptive historical series only, per AV Voice
            Rules — no forecast, no "at this rate" extrapolation.
          </>
        ) : (
          <>
            Which parts of the government the Topline Outlays line is actually made of — top{" "}
            {OUTLAYS_BY_AGENCY_TOP_N} departments/agencies by current spend, everything else
            bucketed into "Other." A department's own reported total, not a client-side sum of its
            sub-programs. Bounded to the most recent {TREASURY_OUTLAYS_BY_AGENCY_WINDOW_LABEL} of
            history (see the note below) — the Topline view goes back further. Note: the stacked
            chart below still shows Department of the Treasury as one reported band (it includes
            Interest on the Public Debt mixed in with Treasury's other spending, at source) — the
            pie beside it splits that same band into "Interest on the Public Debt" and "Treasury
            (other)" so Interest is visible as its own slice.
          </>
        )}
      </div>
      <div className="comex-range-selector" style={{ marginBottom: 8 }}>
        {["monthly", "annual"].map((g) => (
          <button
            key={g}
            className={`comex-range-btn${outlaysGranularity === g ? " comex-range-btn--active" : ""}`}
            onClick={() => handleOutlaysGranularityChange(g)}
          >
            {g === "monthly" ? "Monthly" : "Annual (FY)"}
          </button>
        ))}
      </div>
      {outlaysView === "topline" ? (
        <>
      {outlaysGranularity === "annual" && outlaysAnnual.some((r) => r.monthsPresent < 12) && (
        <div className="comex-panel-note" style={{ color: "#8a94a6" }}>
          {outlaysAnnual.filter((r) => r.monthsPresent < 12).map((r) => (
            <span key={r.fiscalYear}>FY{r.fiscalYear} is partial ({r.monthsPresent} of 12 months) — not a complete fiscal-year total yet. </span>
          ))}
        </div>
      )}
      {outlaysMerged.length > 0 ? (
        <div className="comex-vault-pie-row">
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 420px", minWidth: 0 }}>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart
              data={outlaysMerged}
              margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
              onClick={(state) => {
                if (state?.activeLabel) setPinnedDate(state.activeLabel);
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
              <XAxis dataKey="date" ticks={outlaysTicks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
              <YAxis
                tickFormatter={(v) => `$${v.toFixed(0)}B`}
                tick={{ fill: "#8a94a6", fontSize: 11 }}
                label={{ value: "Billions USD", angle: -90, position: "insideLeft", fill: "#5a6278", fontSize: 11 }}
              />
              <Tooltip content={<OutlaysTooltipContent outlaysMerged={outlaysMerged} />} />
              {pinnedDateOutlays && (
                <ReferenceLine x={pinnedDateOutlays} stroke={RATIO_COLOR} strokeDasharray="3 3" />
              )}
              <ReferenceLine y={0} stroke="#5a6278" strokeDasharray="2 4" />
              {OUTLAYS_LEGEND_SERIES.map((entry) => (
                <Line
                  key={entry.key}
                  type="monotone"
                  dataKey={entry.key}
                  stroke={entry.color}
                  strokeDasharray={entry.dashed ? "4 3" : undefined}
                  dot={false}
                  strokeWidth={clickedOutlaysKey === entry.key ? 3 : 1.5}
                  strokeOpacity={clickedOutlaysKey && clickedOutlaysKey !== entry.key ? 0.25 : 1}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          </div>

          {/* Topline's own simple pie — Outlays split into Interest vs.
              Everything Else, sitting beside the chart like every other
              paired chart+pie in this panel. See outlaysToplinePieData's
              own comment above for why this is a separate, simpler pie
              from By Department's Treasury-splitting one, not a reuse of
              it. */}
          <div style={{ flex: "0 0 180px", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <ResponsiveContainer width={180} height={180}>
              <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                <Pie
                  data={outlaysToplinePieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={70}
                  innerRadius={36}
                  paddingAngle={1}
                >
                  {outlaysToplinePieData.map((entry) => (
                    <Cell key={entry.key} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
                  formatter={(v, name) => [
                    `${fmtBillions(v)} (${fmtPct((v / outlaysToplinePieRow.outlays) * 100)})`,
                    name,
                  ]}
                />
              </PieChart>
            </ResponsiveContainer>
            {outlaysToplinePieRow?.date && (
              <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 4 }}>
                {outlaysToplinePieRow.fiscalYear != null
                  ? `FY${outlaysToplinePieRow.fiscalYear}${outlaysToplinePieRow.monthsPresent < 12 ? ` (partial)` : ""}`
                  : `As of ${outlaysToplinePieRow.date}`}
              </div>
            )}
          </div>
          </div>
          {pinnedDateOutlays && (
            <div style={{ marginTop: 4 }}>
              <OutlaysTooltipContent active label={pinnedDateOutlays} outlaysMerged={outlaysMerged} />
            </div>
          )}
          <div className="comex-legend-list comex-legend-list--horizontal">
            {OUTLAYS_LEGEND_SERIES.map((entry) => (
              <button
                key={entry.key}
                className={`comex-legend-item legend-btn-row${clickedOutlaysKey === entry.key ? " legend-btn-row--baseline" : ""}`}
                onClick={() => setClickedOutlaysKey((k) => (k === entry.key ? null : entry.key))}
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
          {clickedOutlaysKey && (
            <div className="comex-panel-note comex-panel-note--eli5">
              {OUTLAYS_LEGEND_SERIES.find((d) => d.key === clickedOutlaysKey)?.eli5}
            </div>
          )}
        </div>
      ) : (
        <div className="comex-empty">
          No data available.
          <div className="comex-empty-note">Run the backend once to seed the database — this source fetches automatically at startup, no key required.</div>
        </div>
      )}
      <div className="comex-panel-note" style={{ marginTop: 8 }}>
        Source: U.S. Treasury (fiscaldata.treasury.gov) — Monthly Treasury Statement, Table 1
        (Receipts/Outlays/Deficit) and Table 5 (Interest on the Public Debt). Real coverage:
        Outlays/Receipts/Deficit from 2013-10, Interest from 2015-03.
      </div>
        </>
      ) : (
        <>
      {outlaysGranularity === "annual" && outlaysByAgencyAnnual.some((r) => r.monthsPresent < 12) && (
        <div className="comex-panel-note" style={{ color: "#8a94a6" }}>
          {outlaysByAgencyAnnual.filter((r) => r.monthsPresent < 12).map((r) => (
            <span key={r.fiscalYear}>FY{r.fiscalYear} is partial ({r.monthsPresent} of 12 months) — not a complete fiscal-year total yet. </span>
          ))}
        </div>
      )}
      {outlaysByAgencyMerged.length > 0 ? (
        <div className="comex-vault-pie-row">
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 420px", minWidth: 0 }}>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart
              data={outlaysByAgencyMerged}
              margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
              onMouseMove={(state) => {
                if (state?.activeLabel) setHoveredAgencyDate(state.activeLabel);
              }}
              onMouseLeave={() => setHoveredAgencyDate(null)}
              onClick={(state) => {
                if (state?.activeLabel) setPinnedDate(state.activeLabel);
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
              <XAxis dataKey="date" ticks={outlaysByAgencyTicks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
              <YAxis
                domain={clickedAgencyYDomain}
                allowDataOverflow={!!clickedAgencyKey || hiddenAgencies.size > 0}
                tickFormatter={(v) => `$${v.toFixed(0)}B`}
                tick={{ fill: "#8a94a6", fontSize: 11 }}
                label={{ value: "Billions USD", angle: -90, position: "insideLeft", fill: "#5a6278", fontSize: 11 }}
              />
              <Tooltip
                content={(props) => (
                  <OutlaysByAgencyTooltipContent
                    {...props}
                    rows={outlaysByAgencyMerged}
                    topAgencies={topAgencies}
                    agencyColor={agencyColor}
                    otherCount={outlaysOtherCount}
                  />
                )}
              />
              {pinnedDateOutlaysByAgency && (
                <ReferenceLine x={pinnedDateOutlaysByAgency} stroke={RATIO_COLOR} strokeDasharray="3 3" />
              )}
              {/* Recharts 3.x does NOT re-derive stack order from current
                  JSX child order on every render — each <Area> registers
                  itself once (keyed by React key) into Recharts' own
                  internal store on mount, and reordering the JSX array
                  while keeping the same keys only replaces that item's
                  props in place; it does not move its position in
                  Recharts' internal stacking order. Confirmed live: an
                  earlier version that re-sorted the array of <Area>
                  elements (same keys, new order) had no effect on visual
                  stack order at all. Fixed by keeping each <Area>'s KEY
                  (and therefore its Recharts-internal stack slot) fixed to
                  a stable SLOT INDEX, and instead choosing which agency's
                  dataKey/color that slot renders — slot 0 always renders
                  whichever agency is currently "first" (the clicked one,
                  or the default latest-month-spend ranking if none is
                  clicked). This is the mechanism that actually moves a
                  clicked department to the bottom of the stack. */}
              {(() => {
                // Hidden agencies (per-department legend checkboxes) are
                // dropped entirely before slot assignment — not rendered at
                // 0 opacity — so they don't occupy a stack slot or
                // contribute to the stacked total at all, matching what
                // clickedAgencyYDomain computes as the real visible total.
                const visible = [...topAgencies, "other"].filter((a) => !hiddenAgencies.has(a));
                const order = clickedAgencyKey && visible.includes(clickedAgencyKey)
                  ? [clickedAgencyKey, ...visible.filter((a) => a !== clickedAgencyKey)]
                  : visible;
                return order.map((a, slot) =>
                  a === "other" ? (
                    <Area
                      key={`slot-${slot}`}
                      type="monotone"
                      dataKey="other"
                      stackId="outlays-by-agency"
                      stroke={OUTLAYS_OTHER_COLOR}
                      strokeWidth={clickedAgencyKey === "other" ? 3 : 1}
                      fill={OUTLAYS_OTHER_COLOR}
                      fillOpacity={clickedAgencyKey && clickedAgencyKey !== "other" ? 0.2 : 0.45}
                      connectNulls
                    />
                  ) : (
                    <Area
                      key={`slot-${slot}`}
                      type="monotone"
                      dataKey={a}
                      stackId="outlays-by-agency"
                      stroke={agencyColor(a)}
                      strokeWidth={clickedAgencyKey === a ? 3 : 1}
                      fill={agencyColor(a)}
                      fillOpacity={clickedAgencyKey && clickedAgencyKey !== a ? 0.2 : 0.65}
                      connectNulls
                    />
                  )
                );
              })()}
            </ComposedChart>
          </ResponsiveContainer>
          </div>

          <div style={{ flex: "0 0 180px" }}>
            <OutlaysInterestPieChart
              pieData={outlaysByAgencyPieData}
              pieRow={outlaysByAgencyPieRow}
              clickedAgencyKey={clickedAgencyKey}
            />
          </div>
          </div>
          {/* The static pinned-date readout (a full-width box below the
              chart) was removed at the user's request — its per-department
              dollar totals now render directly next to each legend row
              instead (see OutlaysInterestLegend's own valueRow prop below),
              so the same information no longer needs a separate floating
              box. outlaysByAgencyPieRow already resolves the right
              pin/hover/latest date (see its own derivation above) — passed
              straight through as the legend's value source. */}
          <OutlaysInterestLegend
            pieRow={outlaysByAgencyPieRow}
            topAgencies={topAgencies}
            treasuryAgencyName={TREASURY_AGENCY_NAME}
            interestAsOfRow={interestAsOfRow}
            agencyColor={agencyColor}
            clickedAgencyKey={clickedAgencyKey}
            setClickedAgencyKey={setClickedAgencyKey}
            otherCount={outlaysOtherCount}
            hiddenAgencies={hiddenAgencies}
            setHiddenAgencies={setHiddenAgencies}
          />
        </div>
      ) : (
        <div className="comex-empty">
          No data available.
          <div className="comex-empty-note">Run the backend once to seed the database — this source fetches automatically at startup, no key required.</div>
        </div>
      )}
      <div className="comex-panel-note" style={{ marginTop: 8 }}>
        Source: U.S. Treasury (fiscaldata.treasury.gov) — Monthly Treasury Statement, Table 5,
        per-department/agency totals. Real coverage: 2015-03 through present — Table 5 has no
        real data at all before that (confirmed live), a harder floor than the Topline view's
        2013-10. Ongoing fetches (each backend restart) only pull the most recent{" "}
        {TREASURY_OUTLAYS_BY_AGENCY_WINDOW_LABEL} (one HTTP request per real month against a free
        API with no documented rate limit); the deeper 2015–2023 history was added via a one-time
        manual backfill.
      </div>
        </>
      )}
      </div>
      )}
      </details>

      <details className="collapsible-pane" open={qeQtPanelOpen} onToggle={(e) => setQeQtPanelOpen(e.target.open)}>
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
      {qeQtPanelOpen && (
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
      )}
      </details>

      <details className="collapsible-pane" open={yieldsPanelOpen} onToggle={(e) => setYieldsPanelOpen(e.target.open)}>
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
      {yieldsPanelOpen && (
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
              {YIELDS_LEGEND_SERIES.filter((entry) => !hiddenYieldsKeys.has(entry.key)).map((entry) => (
                <Line
                  key={entry.key}
                  yAxisId={entry.key === "t10y2y" || entry.key === "t10y3mo" ? "spread" : "level"}
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
              <div key={entry.key} className="metals-legend-row">
                <input
                  type="checkbox"
                  className="metals-legend-checkbox"
                  checked={!hiddenYieldsKeys.has(entry.key)}
                  onChange={() =>
                    setHiddenYieldsKeys((prev) => {
                      const next = new Set(prev);
                      if (next.has(entry.key)) next.delete(entry.key);
                      else next.add(entry.key);
                      return next;
                    })
                  }
                  title={hiddenYieldsKeys.has(entry.key) ? "Show this series" : "Hide this series"}
                />
                <button
                  className={`comex-legend-item legend-btn-row${clickedYieldsKey === entry.key ? " legend-btn-row--baseline" : ""}`}
                  onClick={() => setClickedYieldsKey((k) => (k === entry.key ? null : entry.key))}
                >
                  <span className="comex-legend-swatch" style={{ background: entry.color }} />
                  <span>
                    <strong>{entry.legendLabel}</strong>
                  </span>
                </button>
              </div>
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
      )}
      </details>

      <details className="collapsible-pane" open={auctionsPanelOpen} onToggle={(e) => setAuctionsPanelOpen(e.target.open)}>
      <summary className="collapsible-pane-title">
        Treasury Auctions
        {auctionsMerged.length > 0 && (
          <span style={{ fontWeight: "normal", fontSize: 12, color: "#8a94a6", marginLeft: 10 }}>
            {(() => {
              const latest = auctionsMerged[auctionsMerged.length - 1];
              return `${latest.security_type} (${latest.security_term}) ${latest.date} · ${latest.bid_to_cover_ratio.toFixed(2)}x bid-to-cover`;
            })()}
          </span>
        )}
      </summary>
      {auctionsPanelOpen && (
      <div className="collapsible-pane-body">
      <div className="comex-panel-note">
        Real Treasury auction results — bid-to-cover ratio (demand strength) and who actually
        bought each auction (primary dealers, indirect bidders — the closest public proxy for
        foreign/other indirect buyers, direct bidders, and the Fed's own SOMA account). Real
        persisted history is a rolling trailing window (see the note below), not multi-year —
        this is about recent auction dynamics, not a long-run series. Descriptive only, per AV
        Voice Rules — no claim about what a given bid-to-cover or buyer mix means for future
        rates or prices.
      </div>
      {auctionsMerged.length > 0 ? (
        <>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart
              data={auctionsPivoted}
              margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
              onClick={(state) => {
                if (state?.activeLabel) setPinnedDate(state.activeLabel);
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
              <XAxis dataKey="date" ticks={auctionsTicks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
              <YAxis
                domain={["dataMin - 0.2", "dataMax + 0.2"]}
                tickFormatter={(v) => `${v.toFixed(1)}x`}
                tick={{ fill: "#8a94a6", fontSize: 11 }}
                label={{ value: "Bid-to-Cover", angle: -90, position: "insideLeft", fill: "#5a6278", fontSize: 11 }}
              />
              <Tooltip content={<AuctionsTooltipContent auctionsMerged={auctionsMerged} />} />
              {pinnedDateAuctions && (
                <ReferenceLine x={pinnedDateAuctions} stroke={RATIO_COLOR} strokeDasharray="3 3" />
              )}
              {AUCTION_SECURITY_TYPES.filter((t) => auctionSelectedTypes.has(t)).map((t) => (
                <Line
                  key={t}
                  type="monotone"
                  dataKey={t}
                  name={t}
                  stroke={AUCTION_TYPE_COLOR[t]}
                  dot={{ r: 2 }}
                  strokeWidth={clickedAuctionTypeKey === t ? 3 : 1.5}
                  strokeOpacity={clickedAuctionTypeKey && clickedAuctionTypeKey !== t ? 0.25 : 1}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          {pinnedDateAuctions && (
            <div style={{ marginTop: 4 }}>
              <AuctionsTooltipContent active label={pinnedDateAuctions} auctionsMerged={auctionsMerged} />
            </div>
          )}
          <div className="comex-legend-list comex-legend-list--horizontal">
            {AUCTION_SECURITY_TYPES.map((t) => (
              <div key={t} className="metals-legend-row">
                <input
                  type="checkbox"
                  className="metals-legend-checkbox"
                  checked={auctionSelectedTypes.has(t)}
                  onChange={() =>
                    setAuctionSelectedTypes((prev) => {
                      const next = new Set(prev);
                      if (next.has(t)) next.delete(t);
                      else next.add(t);
                      return next;
                    })
                  }
                  title={auctionSelectedTypes.has(t) ? "Hide this security type" : "Show this security type"}
                />
                <button
                  className={`comex-legend-item legend-btn-row${clickedAuctionTypeKey === t ? " legend-btn-row--baseline" : ""}`}
                  onClick={() => setClickedAuctionTypeKey((k) => (k === t ? null : t))}
                >
                  <span className="comex-legend-swatch" style={{ background: AUCTION_TYPE_COLOR[t] }} />
                  <span>
                    <strong>{t}</strong>
                  </span>
                </button>
              </div>
            ))}
          </div>

          <div className="comex-panel-note" style={{ marginTop: 16 }}>
            Buyer mix — who actually bought this security, as a % of the total accepted at
            auction. Only one security type at a time (a Bill's buyer mix isn't comparable to a
            30-Year Bond's on the same chart).
          </div>
          <div className="comex-range-selector" style={{ marginBottom: 8 }}>
            {AUCTION_SECURITY_TYPES.map((t) => (
              <button
                key={t}
                className={`comex-range-btn${auctionMixType === t ? " comex-range-btn--active" : ""}`}
                onClick={() => setAuctionMixType(t)}
              >
                {t}
              </button>
            ))}
          </div>
          {auctionMixRows.length > 0 ? (
            <>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart
                data={auctionMixRows}
                stackOffset="expand"
                margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
                onClick={(state) => {
                  if (state?.activeLabel) setPinnedDate(state.activeLabel);
                }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                <XAxis dataKey="date" ticks={auctionMixTicks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
                <YAxis tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fill: "#8a94a6", fontSize: 11 }} />
                <Tooltip content={<AuctionMixTooltipContent rows={auctionMixRows} hiddenBuyers={hiddenAuctionBuyers} />} />
                {pinnedDateAuctionMix && (
                  <ReferenceLine x={pinnedDateAuctionMix} stroke={RATIO_COLOR} strokeDasharray="3 3" />
                )}
                {AUCTION_BUYERS.filter((b) => !hiddenAuctionBuyers.has(b.key)).map((b) => (
                  <Area
                    key={b.key}
                    type="monotone"
                    dataKey={`${b.key}_pct`}
                    name={b.label}
                    stackId="mix"
                    stroke={AUCTION_BUYER_COLORS[b.key]}
                    fill={AUCTION_BUYER_COLORS[b.key]}
                    strokeWidth={clickedAuctionBuyerKey === b.key ? 3 : 1}
                    fillOpacity={clickedAuctionBuyerKey && clickedAuctionBuyerKey !== b.key ? 0.2 : 0.7}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
            {pinnedDateAuctionMix && (
              <div style={{ marginTop: 4 }}>
                <AuctionMixTooltipContent active label={pinnedDateAuctionMix} rows={auctionMixRows} hiddenBuyers={hiddenAuctionBuyers} />
              </div>
            )}
            </>
          ) : (
            <div className="comex-empty">
              No settled {auctionMixType} auctions in the current window.
            </div>
          )}
          <div className="comex-legend-list comex-legend-list--horizontal">
            {AUCTION_BUYERS.map((b) => (
              <div key={b.key} className="metals-legend-row">
                <input
                  type="checkbox"
                  className="metals-legend-checkbox"
                  checked={!hiddenAuctionBuyers.has(b.key)}
                  onChange={() =>
                    setHiddenAuctionBuyers((prev) => {
                      const next = new Set(prev);
                      if (next.has(b.key)) next.delete(b.key);
                      else next.add(b.key);
                      return next;
                    })
                  }
                  title={hiddenAuctionBuyers.has(b.key) ? "Show this buyer category" : "Hide this buyer category"}
                />
                <button
                  className={`comex-legend-item legend-btn-row${clickedAuctionBuyerKey === b.key ? " legend-btn-row--baseline" : ""}`}
                  onClick={() => setClickedAuctionBuyerKey((k) => (k === b.key ? null : b.key))}
                >
                  <span className="comex-legend-swatch" style={{ background: AUCTION_BUYER_COLORS[b.key] }} />
                  <span>
                    <strong>{b.label}</strong>
                  </span>
                </button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="comex-empty">
          No data available.
          <div className="comex-empty-note">Auction results accumulate on a rolling basis once the backend has run — check back after the next restart or scheduled fetch.</div>
        </div>
      )}
      <div className="comex-panel-note" style={{ marginTop: 8 }}>
        Source: U.S. Treasury (fiscaldata.treasury.gov) — Auctions Query API. Real persisted
        history is a rolling ~120-day trailing window, refetched daily (not multi-year like the
        other Treasury charts in this panel) — a newly-announced auction has every result field
        null until it settles a few days later, at which point the same record is updated in
        place with real values. "Indirect Bidders" is the closest public proxy for foreign
        central bank and other indirect buyers — it does not identify individual countries.
      </div>
      </div>
      )}
      </details>

      <details className="collapsible-pane" open={ticPanelOpen} onToggle={(e) => setTicPanelOpen(e.target.open)}>
      <summary className="collapsible-pane-title">
        Foreign Holdings of U.S. Treasuries
        {ticMerged.length > 0 && (
          <span style={{ fontWeight: "normal", fontSize: 12, color: "#8a94a6", marginLeft: 10 }}>
            {(() => {
              const row = pinnedDate ? ticMerged.find((r) => r.date === nearestRowDate(ticMerged, pinnedDate)) : ticMerged[ticMerged.length - 1];
              if (!row) return null;
              const top = TIC_COUNTRY_ORDER.filter((c) => row[c] != null).sort((a, b) => row[b] - row[a])[0];
              return (
                <>
                  {row.date}
                  {row.grand_total != null && ` · Grand Total (LT) ${fmtTrillions(row.grand_total)}`}
                  {top && ` · Top: ${top} ${fmtTrillions(row[top])}`}
                </>
              );
            })()}
          </span>
        )}
      </summary>
      {ticPanelOpen && (
      <div className="collapsible-pane-body">
      <div className="comex-panel-note">
        Which countries hold how much U.S. Treasury debt, over time — FRED's own ingestion of
        Treasury's TIC (Treasury International Capital) data. <strong>Long-term Treasuries
        only — excludes T-bills entirely.</strong> Treasury's own separately-published Major
        Foreign Holders total (bills-inclusive) runs meaningfully higher than the grand total
        this data represents; the two are not interchangeable. "Cayman Islands" is a real subset
        of "Total Caribbean," not a duplicate — both are shown, but summing them would
        double-count.
      </div>
      {ticMerged.length > 0 ? (
        <div className="comex-vault-pie-row">
          {(() => {
            const pinnedDateTic = nearestRowDate(ticMerged, pinnedDate);
            // Pin > hover > latest, same priority rule as every other pie
            // in this panel (compositionPieRow, outlaysByAgencyPieRow).
            const ticPieDate = pinnedDate ? pinnedDateTic : ticMerged[ticMerged.length - 1]?.date;
            const ticPieRow = ticMerged.find((r) => r.date === ticPieDate) ?? null;
            const ticPieData = ticPieRow
              ? TIC_COUNTRY_ORDER
                  .filter((c) => !hiddenTicCountries.has(c) && ticPieRow[c] != null && ticPieRow[c] > 0)
                  .map((c) => ({ key: c, name: c, value: ticPieRow[c], color: TIC_COUNTRY_COLOR[c] }))
              : [];
            return (
              <>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 420px", minWidth: 0 }}>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={ticMerged} margin={{ top: 4, right: 20, left: 12, bottom: 4 }} onClick={(state) => {
              if (state?.activeLabel) setPinnedDate(state.activeLabel);
            }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
              <XAxis dataKey="date" ticks={ticTicks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
              <YAxis
                tickFormatter={(v) => `$${v.toFixed(1)}T`}
                tick={{ fill: "#8a94a6", fontSize: 11 }}
                label={{ value: "Trillions USD", angle: -90, position: "insideLeft", fill: "#5a6278", fontSize: 11 }}
              />
              <Tooltip content={<TicHoldingsTooltipContent ticMerged={ticMerged} hiddenCountries={hiddenTicCountries} />} />
              {pinnedDateTic && <ReferenceLine x={pinnedDateTic} stroke={RATIO_COLOR} strokeDasharray="3 3" />}
              {/* Stack order highest-to-lowest at the pinned/hovered/latest
                  date (ticPieRow, same row the companion pie already
                  computes), per the user's explicit request — largest
                  holder's Area renders first, landing at the bottom of the
                  stack. Same slot-index-key mechanism as the Outlays by
                  Agency chart's own click-to-bottom fix: Recharts does NOT
                  re-derive stack order from current JSX child order on
                  every render, it tracks each Area's stack position by
                  React key at mount time. Re-sorting the .map() output
                  alone (same keys, new order) would have no visual effect —
                  confirmed by that earlier fix. Keeping each Area's key
                  pinned to a stable SLOT index and choosing which country's
                  dataKey/color that slot renders is the only way to
                  actually move stack order here too. Hidden countries are
                  dropped before ranking, same as before. */}
              {(() => {
                const visible = TIC_COUNTRY_ORDER.filter((c) => !hiddenTicCountries.has(c));
                const ranked = ticPieRow
                  ? [...visible].sort((a, b) => (ticPieRow[b] ?? 0) - (ticPieRow[a] ?? 0))
                  : visible;
                return ranked.map((c, slot) => (
                  <Area
                    key={`slot-${slot}`}
                    type="monotone"
                    dataKey={c}
                    name={c}
                    stackId="tic-holdings"
                    stroke={TIC_COUNTRY_COLOR[c]}
                    fill={TIC_COUNTRY_COLOR[c]}
                    strokeWidth={clickedTicKey === c ? 3 : 1}
                    fillOpacity={clickedTicKey && clickedTicKey !== c ? 0.2 : 0.65}
                    connectNulls
                  />
                ));
              })()}
            </ComposedChart>
          </ResponsiveContainer>
          {pinnedDateTic && (
            <div style={{ marginTop: 4 }}>
              <TicHoldingsTooltipContent active label={pinnedDateTic} ticMerged={ticMerged} hiddenCountries={hiddenTicCountries} />
            </div>
          )}
          </div>

          {/* Companion pie, same convention as every other paired chart+pie
              in this panel (Composition, Outlays by Agency) — a 14-country
              line chart was genuinely illegible (the user's own word) with
              every series drawn at once; the pie makes "who's biggest right
              now" legible at a glance for whatever date is pinned/hovered,
              while the line chart above stays useful for trend-over-time on
              whichever countries are checked visible. */}
          <div style={{ flex: "0 0 180px", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <ResponsiveContainer width={180} height={180}>
              <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                <Pie
                  data={ticPieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={70}
                  innerRadius={36}
                  paddingAngle={1}
                  onClick={(entry) => setClickedTicKey((k) => (k === entry.key ? null : entry.key))}
                  style={{ cursor: "pointer" }}
                >
                  {ticPieData.map((entry) => (
                    <Cell
                      key={entry.key}
                      fill={entry.color}
                      fillOpacity={clickedTicKey && clickedTicKey !== entry.key ? 0.35 : 1}
                      stroke={clickedTicKey === entry.key ? "#e8ecf4" : undefined}
                      strokeWidth={clickedTicKey === entry.key ? 2 : undefined}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
                  formatter={(v, name) => [fmtTrillions(v), name]}
                />
              </PieChart>
            </ResponsiveContainer>
            {ticPieRow?.date && (
              <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 4 }}>
                As of {ticPieRow.date}
                {ticPieRow.grand_total != null && (
                  <>
                    <br />
                    Grand Total (LT): {fmtTrillions(ticPieRow.grand_total)}
                  </>
                )}
              </div>
            )}
          </div>
          </div>
              </>
            );
          })()}
          <div className="comex-legend-list comex-legend-list--horizontal">
            {TIC_COUNTRY_ORDER.map((c) => (
              <div key={c} className="metals-legend-row">
                <input
                  type="checkbox"
                  className="metals-legend-checkbox"
                  checked={!hiddenTicCountries.has(c)}
                  onChange={() =>
                    setHiddenTicCountries((prev) => {
                      const next = new Set(prev);
                      if (next.has(c)) next.delete(c);
                      else next.add(c);
                      return next;
                    })
                  }
                  title={hiddenTicCountries.has(c) ? "Show this country" : "Hide this country"}
                />
                <button
                  className={`comex-legend-item legend-btn-row${clickedTicKey === c ? " legend-btn-row--baseline" : ""}`}
                  onClick={() => setClickedTicKey((k) => (k === c ? null : c))}
                >
                  <span className="comex-legend-swatch" style={{ background: TIC_COUNTRY_COLOR[c] }} />
                  <span>
                    <strong>{c}</strong>
                  </span>
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="comex-empty">
          No data available.
          <div className="comex-empty-note">Requires FRED_API_KEY — hit Refresh on the panel above, or run the refresh endpoint once to seed the database.</div>
        </div>
      )}
      <div className="comex-panel-note" style={{ marginTop: 8 }}>
        Source: FRED's own ingestion of U.S. Treasury's TIC (Treasury International Capital)
        data — FORLTTREASPOS* series, monthly, real coverage from 1984-12 for most countries
        (Belgium/Luxembourg/Cayman Islands from ~2001, a real TIC reporting-category change).
        Country codes are TIC's own, looked up from Treasury's published country-code table,
        not derived from ISO codes.
      </div>
      </div>
      )}
      </details>

      <details className="collapsible-pane" open={metalsPanelOpen} onToggle={(e) => setMetalsPanelOpen(e.target.open)}>
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
      {metalsPanelOpen && (
      <div className="collapsible-pane-body">
      <div className="comex-panel-note">
        Four ways to have held a dollar since 2006: Fiat ($100 nominal — always worth $100 of
        itself), Gold (XAU) and Silver (XAG) month-end closing prices via Yahoo Finance
        (SI=F/GC=F), and CPI-derived Purchasing Power (what that $100 could actually buy).
        Click a line's label in the legend below to make it the baseline — the baseline renders
        flat at 0%, and the others show their return relative to it over the selected window.
        Click the checkbox to show/hide a line. Click a point on the chart to see (and pin, in the
        pie beside it) each series' return from that date to the latest data, relative to the
        current baseline — click the same point again to clear it. Not a claim that any one of
        them "should" track another.
      </div>
      {metalsMerged.length > 0 ? (
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 420px", minWidth: 280 }}>
          <ResponsiveContainer width="100%" height={280}>
          <ComposedChart
            data={metalsMerged}
            margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
            // Click a point to set it as a persistent held/reference date —
            // "since that date, how did fiat/gold/silver each do, relative
            // to the current baseline" — shown in the tooltip and the
            // companion pie beside this chart, and staying visible until a
            // different point is clicked or the same one is clicked again
            // to clear it. Replaces an earlier press-and-hold gesture
            // (mousedown/mouseup/mouseleave), which reverted the moment the
            // mouse button was released — too transient to actually look at
            // the pie the user asked for without holding the mouse down the
            // whole time.
            onClick={(state) => {
              if (state?.activeLabel) setHeldDate((d) => (d === state.activeLabel ? null : state.activeLabel));
            }}
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
                  heldComparison={metalsHeldComparison}
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
                strokeWidth={clickedMetalsPieKey === "xau_index" ? 2.5 : 1}
                fill={XAU_COLOR}
                fillOpacity={clickedMetalsPieKey && clickedMetalsPieKey !== "xau_index" ? 0.08 : 0.3}
                strokeOpacity={clickedMetalsPieKey && clickedMetalsPieKey !== "xau_index" ? 0.3 : 1}
                connectNulls
              />
            )}
            {visible.xag_index && (
              <Area
                type="monotone"
                dataKey="xag_index"
                stroke={XAG_COLOR}
                strokeWidth={clickedMetalsPieKey === "xag_index" ? 2.5 : 1}
                fill={XAG_COLOR}
                fillOpacity={clickedMetalsPieKey && clickedMetalsPieKey !== "xag_index" ? 0.08 : 0.3}
                strokeOpacity={clickedMetalsPieKey && clickedMetalsPieKey !== "xag_index" ? 0.3 : 1}
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
                strokeOpacity={clickedMetalsPieKey ? 0.3 : 1}
                connectNulls
              />
            )}
            {visible.fiat_index && (
              <Line
                type="monotone"
                dataKey="fiat_index"
                stroke={FIAT_COLOR}
                dot={false}
                strokeWidth={clickedMetalsPieKey === "fiat_index" ? 3 : 1.8}
                strokeOpacity={clickedMetalsPieKey && clickedMetalsPieKey !== "fiat_index" ? 0.3 : 1}
                connectNulls
              />
            )}
          </ComposedChart>
          </ResponsiveContainer>
          </div>

          {/* Companion pie: the click-to-hold comparison, visualized. Click a
              point on the line chart to set a held date — the pie then
              shows $100 held in fiat/gold/silver since that date, grown by
              each series' real return relative to the current baseline
              (the baseline's own slice always sits at exactly $100, 0%
              relative return by construction). This is the same data
              MetalsTooltip already renders as text when a date is held —
              the pie is a second, visual presentation of it, not a
              different calculation (see metalsHeldComparison above). Sits
              beside the line chart, not below it, same layout/sizing
              convention as the Composition pie (flex-basis 180px column,
              180×180 container, outerRadius 70, zeroed PieChart margin) so
              the two paired chart+pie sections in this tab read as one
              visual pattern. Clicking a slice/legend row highlights that
              series on the line chart above (dims the other Area/Line
              elements the same way clickedM2Key/clickedPieKey already do
              elsewhere in this file) — no ELI5 popup here, since the main
              legend below already covers checkbox/baseline interactions for
              these same 3(+PP) series and per-series explanatory text was
              never added to it either (a deliberate choice at the time, see
              that legend's own surrounding comment). */}
          <div style={{ flex: "0 0 180px", display: "flex", flexDirection: "column", alignItems: "center" }}>
            {metalsHeldComparison ? (
              <ResponsiveContainer width={180} height={180}>
                <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                  <Pie
                    data={metalsPieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={70}
                    innerRadius={36}
                    paddingAngle={1}
                    onClick={(entry) => setClickedMetalsPieKey((k) => (k === entry.key ? null : entry.key))}
                    style={{ cursor: "pointer" }}
                  >
                    {metalsPieData.map((entry) => (
                      <Cell
                        key={entry.key}
                        fill={entry.color}
                        fillOpacity={clickedMetalsPieKey && clickedMetalsPieKey !== entry.key ? 0.35 : 1}
                        stroke={clickedMetalsPieKey === entry.key ? "#e8ecf4" : undefined}
                        strokeWidth={clickedMetalsPieKey === entry.key ? 2 : undefined}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
                    formatter={(v, name, item) => [
                      `${fmtUsd(v)} (${fmtPct(item?.payload?.pct ?? 0)})`,
                      name,
                    ]}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              // No held date yet — the pie has nothing to compare, so it
              // prompts the click rather than rendering an empty/misleading
              // circle (same "don't manufacture a reading" instinct as the
              // rest of this codebase's nulls-over-zeros convention, applied
              // to UI state rather than persisted data).
              <div
                style={{
                  width: 180,
                  height: 180,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
                  fontSize: 11,
                  color: "#5a6278",
                  border: "1px dashed #2e3547",
                  borderRadius: "50%",
                  padding: 16,
                }}
              >
                Click a point on the chart to compare fiat/gold/silver since that date
              </div>
            )}
            {/* Single-date snapshot caption, same convention as the
                Composition pie's own "As of" line. */}
            {metalsHeldComparison && (
              <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 4, textAlign: "center" }}>
                Since {metalsHeldComparison.heldDate} → {metalsHeldComparison.latestDate}
                <br />
                {"$" + HELD_STAKE_USD} held in each, relative to {METAL_SERIES.find((s) => s.key === baseline)?.shortLabel}
              </div>
            )}
            {/* Small click-to-highlight swatch row, separate from the main
                checkbox/baseline legend below the chart — clicking here only
                drives the pie/chart highlight (clickedMetalsPieKey), it
                doesn't toggle visibility or change the baseline the way the
                main legend's rows do, so it's kept as its own compact row
                rather than merged into that legend's different interaction
                model. */}
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap", justifyContent: "center" }}>
              {METALS_PIE_SERIES.map(({ key, shortLabel }) => (
                <button
                  key={key}
                  className={`comex-legend-item legend-btn-row${clickedMetalsPieKey === key ? " legend-btn-row--baseline" : ""}`}
                  onClick={() => setClickedMetalsPieKey((k) => (k === key ? null : key))}
                  style={{ padding: "2px 6px" }}
                >
                  <span className="comex-legend-swatch" style={{ background: METAL_SERIES_COLOR[key] }} />
                  <span style={{ fontSize: 11 }}>{shortLabel}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
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
      )}
      </details>
    </div>
  );
}
