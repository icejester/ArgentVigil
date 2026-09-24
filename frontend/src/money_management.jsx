import { useState, useEffect, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
  PieChart, Pie, Cell, AreaChart, Area,
} from "recharts";
import ChartStaleness from "./chart_staleness";
import { apiFetch } from "./api_client";
import { nearestRowDate, xTicks } from "./date_utils";
import { usePinnedDate } from "./pinned_date_context";
import { MONEY_MGMT_COLORS, MM_PIE_COLORS, MM_PIE_OTHER_COLOR, MM_PIE_REST_COLOR, MM_SURFACE } from "./palette";
import { FORCE_REFRESH_EVENT } from "./refresh_controls";

// Money Management tab (money-management-spec.md). Three layers kept
// visually distinct on purpose — governance (who the Fed is), bank registry
// (which district a bank belongs to), and the rate-transmission chain (how
// policy reaches borrowers). No composite score, no alerting, no prediction
// framing — every series is charted on its own.

const PIN_LINE_COLOR = "#e8ecf4";
const MUTED = "#8a94a6";

function fmtPctVal(v, digits = 2) {
  return v == null ? "—" : `${v.toFixed(digits)}%`;
}

// ---------------------------------------------------------------------------
// Transmission chain — small multiples, one chart per stage of the chain.

const SLOOS_EXPLAINER =
  "Senior Loan Officer Opinion Survey, quarterly: the net percentage of domestic banks that say they TIGHTENED lending standards for this loan type over the past three months (share tightening minus share easing). Above zero = more banks tightening than easing; below zero = net easing. It's the banks describing their own behavior, which makes it the most direct 'did the Fed's stance reach Main Street' signal available — but it's a survey of standards, not a count of loans made.";

const TRANSMISSION_CHARTS = [
  {
    id: "policy",
    title: "1 · Policy & overnight funding",
    note: "What the Fed pays banks to park money (IORB) against what banks actually charge each other overnight (EFFR, unsecured; SOFR, secured by Treasuries). Daily.",
    unit: "pct",
    series: [
      {
        key: "IORB", legendLabel: "IORB",
        eli5: "Interest on reserve balances — the rate the Fed pays banks on money they leave on deposit at the Fed. It's the floor under what a bank will accept elsewhere: why lend to anyone at less than what the Fed pays risk-free? Set directly by the Fed. FRED's series starts 2021-07-29, when IORB replaced the older IOER/IORR pair.",
      },
      {
        key: "EFFR", legendLabel: "Effective Fed Funds",
        eli5: "The volume-weighted average rate banks actually paid each other for unsecured overnight loans of reserves. This is the rate the FOMC 'targets' — the policy statement names a range, and EFFR is where trading actually printed inside it.",
      },
      {
        key: "SOFR", legendLabel: "SOFR",
        eli5: "Secured Overnight Financing Rate — the cost of borrowing cash overnight with Treasuries as collateral (the repo market). Much larger market than fed funds, and the benchmark most floating-rate loans now reference since LIBOR's retirement. A SOFR spike above IORB is a sign reserves are getting scarce somewhere in the plumbing.",
      },
    ],
  },
  {
    id: "consumer",
    title: "2 · What borrowers pay",
    note: "The rates a household or small business actually sees. Different cadences (prime and card rates monthly, mortgages weekly) — lines connect across each series' own real points.",
    unit: "pct",
    series: [
      {
        key: "MPRIME", legendLabel: "Prime Rate",
        eli5: "The bank prime loan rate — by long convention the fed funds target's upper bound plus 3 points. It's the base rate for HELOCs, many credit cards, and small-business loans, so a Fed move shows up here almost immediately. Monthly.",
      },
      {
        key: "MORTGAGE30US", legendLabel: "30yr Mortgage",
        eli5: "Freddie Mac's weekly survey average for a 30-year fixed mortgage. Tracks the 10-year Treasury yield far more than the fed funds rate — which is why mortgage rates can rise while the Fed is cutting, or vice versa. The gap to the policy rate is the chain's weakest link.",
      },
      {
        key: "TERMCBCCALLNS", legendLabel: "Credit Card Rate",
        eli5: "Average interest rate on commercial-bank credit card plans, all accounts (including ones that pay in full and are never charged interest). Monthly, published with a lag. Priced off prime, plus a wide margin for unsecured credit risk.",
      },
    ],
  },
  {
    id: "credit",
    title: "3 · Did lending move?",
    note: "Total bank credit (loans + securities) across all U.S. commercial banks, weekly, in trillions — whether the spigot actually opened or closed, independent of what rates did.",
    unit: "trillions",
    series: [
      {
        key: "TOTBKCR", legendLabel: "Bank Credit",
        eli5: "Everything commercial banks have extended: loans to households and businesses plus the securities they hold. The end of the chain — rates are what the Fed controls, this is what banks actually did. It includes securities, so it can rise when banks buy Treasuries even while loan growth stalls.",
      },
    ],
  },
  {
    id: "discount",
    title: "4 · Discount window",
    note: "Primary-credit borrowing from the Fed's discount window, weekly, billions. National total only — per-district borrowing isn't published in a timely series.",
    unit: "billions",
    series: [
      {
        key: "WLCFLPCL_BILLIONS", legendLabel: "Discount Window",
        eli5: "Loans the Fed makes directly to banks against collateral, the lender-of-last-resort facility. Normally close to zero because borrowing here carries stigma; spikes mean some banks couldn't get funding elsewhere (March 2023's SVB/Signature week is the obvious recent example). A bank borrows from its OWN district's Reserve Bank, the one place the district structure touches day-to-day money, but the Fed only reports the national total in real time.",
      },
    ],
  },
  {
    id: "sloos",
    title: "5 · Lending standards (SLOOS)",
    note: "Net % of banks tightening standards, by loan type, quarterly. Above the zero line = net tightening, below = net easing.",
    unit: "pctNet",
    zeroLine: true,
    series: null, // built from the response's sloos labels
  },
];

function fmtValue(unit, v) {
  if (v == null) return "—";
  if (unit === "pct") return fmtPctVal(v);
  if (unit === "pctNet") return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  if (unit === "trillions") return `$${(v / 1000).toFixed(2)}T`;
  if (unit === "billions") return `$${v.toFixed(1)}B`;
  return String(v);
}

function fmtAxis(unit, v) {
  if (unit === "pct") return `${v.toFixed(1)}%`;
  if (unit === "pctNet") return `${v.toFixed(0)}%`;
  if (unit === "trillions") return `$${(v / 1000).toFixed(1)}T`;
  if (unit === "billions") return `$${v.toFixed(0)}B`;
  return String(v);
}

// Plain date-key union merge — no forward-fill (each line connects its own
// real points via connectNulls; a missing date stays missing).
function mergeByDate(seriesRows) {
  const byDate = new Map();
  for (const [key, rows] of Object.entries(seriesRows)) {
    for (const r of rows || []) {
      if (!byDate.has(r.date)) byDate.set(r.date, { date: r.date });
      byDate.get(r.date)[key] = r.value;
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function SeriesTooltipContent({ active, label, merged, series, unit }) {
  if (!active || !label) return null;
  const row = merged.find((r) => r.date === label);
  if (!row) return null;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{label}</div>
      {series.map((s) =>
        row[s.key] != null ? (
          <div key={s.key} style={{ color: s.color }}>
            {s.legendLabel}: {fmtValue(unit, row[s.key])}
          </div>
        ) : null
      )}
    </div>
  );
}

function TransmissionChart({ chart, series, seriesRows, pinnedDate, onPin }) {
  const [clickedKey, setClickedKey] = useState(null);
  const merged = useMemo(() => mergeByDate(seriesRows), [seriesRows]);
  const ticks = useMemo(() => xTicks(merged, 8), [merged]);
  const pinnedSnap = pinnedDate ? nearestRowDate(merged, pinnedDate) : null;
  const hasData = merged.length > 0;

  return (
    <div style={{ marginBottom: 18 }}>
      <div className="comex-panel-header" style={{ fontSize: 13 }}>{chart.title}</div>
      <div className="comex-panel-note">{chart.note}</div>
      {hasData ? (
        <>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart
              data={merged}
              margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
              onClick={(state) => state?.activeLabel && onPin(state.activeLabel)}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
              <XAxis dataKey="date" ticks={ticks} tick={{ fill: MUTED, fontSize: 11 }} />
              <YAxis
                domain={chart.zeroLine ? ["auto", "auto"] : ["dataMin", "dataMax"]}
                tickFormatter={(v) => fmtAxis(chart.unit, v)}
                tick={{ fill: MUTED, fontSize: 11 }}
                width={60}
              />
              <Tooltip content={<SeriesTooltipContent merged={merged} series={series} unit={chart.unit} />} />
              {chart.zeroLine && <ReferenceLine y={0} stroke="#5a6278" strokeDasharray="2 4" />}
              {pinnedSnap && <ReferenceLine x={pinnedSnap} stroke={PIN_LINE_COLOR} strokeDasharray="3 3" />}
              {series.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.color}
                  dot={false}
                  strokeWidth={clickedKey === s.key ? 3 : 1.5}
                  strokeOpacity={clickedKey && clickedKey !== s.key ? 0.25 : 1}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          {pinnedSnap && (
            <div style={{ marginTop: 4 }}>
              <SeriesTooltipContent active label={pinnedSnap} merged={merged} series={series} unit={chart.unit} />
            </div>
          )}
          <div className="comex-legend-list comex-legend-list--horizontal">
            {series.map((s) => (
              <button
                key={s.key}
                className={`comex-legend-item legend-btn-row${clickedKey === s.key ? " legend-btn-row--baseline" : ""}`}
                onClick={() => setClickedKey((k) => (k === s.key ? null : s.key))}
              >
                <span className="comex-legend-swatch" style={{ background: s.color }} />
                <span><strong>{s.legendLabel}</strong></span>
              </button>
            ))}
          </div>
          {clickedKey && (
            <div className="comex-panel-note comex-panel-note--eli5">
              {series.find((s) => s.key === clickedKey)?.eli5}
            </div>
          )}
        </>
      ) : (
        <div className="comex-empty">No data persisted yet for this window.</div>
      )}
    </div>
  );
}

function TransmissionPanel({ window_, customStart, customEnd, pinnedDate, onPin }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (window_ === "custom" && (!customStart || !customEnd || customStart > customEnd)) return;
    const qs = window_ === "custom"
      ? `window=custom&start=${customStart}&end=${customEnd}`
      : `window=${window_}`;
    const load = () =>
      apiFetch(`/api/fred/transmission/db?${qs}`)
        .then((r) => r.json())
        .then((j) => {
          if (!j.success) throw new Error(j.detail || "Failed to load transmission data");
          setData(j.data);
          setError(null);
        })
        .catch((e) => setError(e.message));
    load();
    window.addEventListener(FORCE_REFRESH_EVENT, load);
    return () => window.removeEventListener(FORCE_REFRESH_EVENT, load);
  }, [window_, customStart, customEnd]);

  const charts = useMemo(() => {
    if (!data) return [];
    return TRANSMISSION_CHARTS.map((chart) => {
      const baseSeries = chart.series ?? Object.keys(data.sloos).map((label) => ({
        key: label,
        legendLabel: label,
        eli5: `${label} (FRED ${data.sloos_ids[label]}). ${SLOOS_EXPLAINER}`,
      }));
      const series = baseSeries.map((s, i) => ({ ...s, color: MONEY_MGMT_COLORS[i % MONEY_MGMT_COLORS.length] }));
      const seriesRows = Object.fromEntries(
        series.map((s) => [s.key, chart.series ? data.series[s.key] : data.sloos[s.key]])
      );
      return { chart, series, seriesRows };
    });
  }, [data]);

  return (
    <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">
        <ChartStaleness sourceKey={["fed_transmission", "money_supply"]} />
        <span>Transmission Chain</span>
        {data?.series?.EFFR?.length > 0 && (
          <span style={{ fontWeight: "normal", fontSize: 12, color: MUTED, marginLeft: 10 }}>
            {(() => {
              const last = (rows) => [...(rows || [])].reverse().find((r) => r.value != null);
              const iorb = last(data.series.IORB);
              const effr = last(data.series.EFFR);
              const prime = last(data.series.MPRIME);
              return `IORB ${fmtPctVal(iorb?.value)} · EFFR ${fmtPctVal(effr?.value)} · Prime ${fmtPctVal(prime?.value)}`;
            })()}
          </span>
        )}
      </summary>
      <div className="collapsible-pane-body">
        <div className="comex-panel-note">
          Policy rate → bank funding cost → what borrowers pay → whether lending moved. Each stage
          is its own chart on its own scale; nothing here is combined into a score, and sharing a
          page doesn't imply one series causes another. Historical description only.
        </div>
        {error && <div className="error-box">{error}</div>}
        {charts.map(({ chart, series, seriesRows }) => (
          <TransmissionChart
            key={chart.id}
            chart={chart}
            series={series}
            seriesRows={seriesRows}
            pinnedDate={pinnedDate}
            onPin={onPin}
          />
        ))}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Shared bank results table — Bank Lookup's search results and the
// Governance panel's click-a-district drilldown render identically.

function fmtUsdCompact(v) {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function ratioPct(num, den, digits = 1) {
  if (num == null || den == null || den === 0) return "—";
  return `${((100 * num) / den).toFixed(digits)}%`;
}

const BANK_COLUMNS = [
  { key: "name", label: "Institution" },
  { key: "fed_district", label: "District", districtOnly: true },
  { key: "total_assets", label: "Total assets", numeric: true },
  { key: "share", label: "Share of district", numeric: true, shareOnly: true },
  { key: "deposits", label: "Deposits", numeric: true },
  { key: "equity", label: "Equity", numeric: true },
  { key: "regulator", label: "Regulator" },
  { key: "fed_member", label: "Fed member" },
  { key: "holding_company", label: "Holding company" },
  { key: "location", label: "Location" },
  { key: "active", label: "Status" },
];

// Shared bank results table — Bank Lookup's search results and the
// Governance panel's click-a-district drilldown render identically.
// Click a header to sort (numeric columns default largest-first); NULLs
// always sort last in either direction, never as zero.
function BankTable({ banks, showDistrict = true, shareDenominator = null, defaultSort = null, onOpenBank = null, capped = true }) {
  const [sort, setSort] = useState(defaultSort);
  const cols = BANK_COLUMNS.filter(
    (c) => (showDistrict || !c.districtOnly) && (shareDenominator != null || !c.shareOnly)
  );
  const valueOf = (b, key) =>
    key === "share" ? b.total_assets
      : key === "location" ? [b.city, b.state].filter(Boolean).join(", ") || null
      : b[key];
  const sorted = useMemo(() => {
    if (!sort) return banks;
    const { key, dir } = sort;
    return [...banks].sort((a, b) => {
      const va = valueOf(a, key), vb = valueOf(b, key);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return dir === "asc" ? c : -c;
    });
  }, [banks, sort]);
  const onSort = (c) =>
    setSort((prev) =>
      prev?.key === c.key
        ? { key: c.key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key: c.key, dir: c.numeric ? "desc" : "asc" }
    );
  const cell = (b, key) => {
    switch (key) {
      case "name": return b.name;
      case "fed_district": return b.fed_district ?? "—";
      case "total_assets": case "deposits": case "equity": return fmtUsdCompact(b[key]);
      case "share": return ratioPct(b.total_assets, shareDenominator, 2);
      case "fed_member": return b.fed_member == null ? "—" : b.fed_member ? "Yes" : "No";
      case "location": return valueOf(b, "location") ?? "—";
      case "active": return b.active ? "Active" : `Inactive${b.inactive_date ? ` (${b.inactive_date})` : ""}`;
      default: return b[key] ?? "—";
    }
  };
  return (
    <div className={`comex-table-wrap${capped ? " comex-table-wrap--capped" : ""}`}>
      <table className="comex-table comex-table--zebra">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} onClick={() => onSort(c)} style={{ cursor: "pointer", whiteSpace: "nowrap" }}>
                {c.label}{sort?.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((b) => (
            <tr
              key={b.cert}
              onClick={onOpenBank ? () => onOpenBank(b.cert) : undefined}
              style={onOpenBank ? { cursor: "pointer" } : undefined}
            >
              {cols.map((c) => (
                <td
                  key={c.key}
                  style={c.numeric ? { textAlign: "right", fontVariantNumeric: "tabular-nums" } : undefined}
                  title={c.key === "name"
                    ? `FDIC cert ${b.cert}${b.fed_rssd ? ` · RSSD ${b.fed_rssd}` : ""}${b.financials_as_of ? ` · financials as of ${b.financials_as_of}` : ""}`
                    : undefined}
                >
                  {c.key === "name" && onOpenBank ? <span className="mm-link">{cell(b, c.key)}</span> : cell(b, c.key)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Size tiers use the thresholds US bank regulation itself draws lines at
// ($10B, $100B, $250B), plus $1B to split out the smallest community banks.
const SIZE_TIERS = [
  { label: "≥ $250B", min: 250e9 },
  { label: "$100–250B", min: 100e9 },
  { label: "$10–100B", min: 10e9 },
  { label: "$1–10B", min: 1e9 },
  { label: "< $1B", min: 0 },
];

function sizeProfile(banks) {
  const sized = banks.filter((b) => b.total_assets != null);
  const total = sized.reduce((acc, b) => acc + b.total_assets, 0);
  const desc = [...sized].sort((a, b) => b.total_assets - a.total_assets);
  const tiers = SIZE_TIERS.map((t, i) => {
    const max = i === 0 ? Infinity : SIZE_TIERS[i - 1].min;
    const inTier = sized.filter((b) => b.total_assets >= t.min && b.total_assets < max);
    return { ...t, count: inTier.length, assets: inTier.reduce((acc, b) => acc + b.total_assets, 0) };
  });
  const median = desc.length ? desc[Math.floor(desc.length / 2)].total_assets : null;
  const top10 = desc.slice(0, 10).reduce((acc, b) => acc + b.total_assets, 0);
  return {
    sizedCount: sized.length, unsizedCount: banks.length - sized.length, total, tiers, median,
    largest: desc[0] ?? null, smallest: desc[desc.length - 1] ?? null, top10,
  };
}

function Stat({ label, value, sub }) {
  return (
    <div style={{ minWidth: 150, flex: "1 1 150px", padding: "6px 8px", background: "#161b26", border: "1px solid #232a3a" }}>
      <div style={{ fontSize: 11, color: MUTED }}>{label}</div>
      <div style={{ fontSize: 16, color: "#e8ecf4", fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: MUTED }}>{sub}</div>}
    </div>
  );
}

// Reserve Bank vs. the banks in its district. Deliberately shows the two
// real LINKS (reserves banks hold there; capital members paid in) next to
// the headline balance-sheet comparison, since a Reserve Bank's total assets
// are mostly its allocated share of the national SOMA portfolio — not
// something its district's banks funded.
function DistrictComparison({ reserveBank }) {
  const bs = reserveBank.balance_sheet;
  const reg = reserveBank.registry;
  if (!bs && !reg) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <Stat
          label={`Reserve Bank of ${reserveBank.city}: total assets`}
          value={fmtUsdCompact(bs?.total_assets)}
          sub={bs ? `H.4.1, week of ${bs.as_of}` : "not fetched yet"}
        />
        <Stat
          label="District banks' total assets"
          value={fmtUsdCompact(reg?.active_assets)}
          sub={reg ? `${reg.sized_count?.toLocaleString()} active banks · Call Reports ${reg.financials_as_of ?? "—"}` : "—"}
        />
        <Stat
          label="Reserve Bank assets ÷ district bank assets"
          value={ratioPct(bs?.total_assets, reg?.active_assets, 0)}
          sub="scale comparison only, see note"
        />
        <Stat
          label="Reserves banks hold at this Reserve Bank"
          value={fmtUsdCompact(bs?.depository_deposits)}
          sub={`${ratioPct(bs?.depository_deposits, reg?.active_assets)} of district bank assets`}
        />
        <Stat
          label="Capital paid in by member banks"
          value={fmtUsdCompact(bs?.capital_paid_in)}
          sub={`${ratioPct(bs?.capital_paid_in, reg?.member_equity, 2)} of members' equity (${fmtUsdCompact(reg?.member_equity)})`}
        />
        <Stat
          label="Reserve Bank surplus · Fed notes"
          value={`${fmtUsdCompact(bs?.surplus)} · ${fmtUsdCompact(bs?.fed_notes)}`}
          sub="notes = currency issued through this bank"
        />
      </div>
      <div className="comex-panel-note" style={{ marginTop: 6 }}>
        A Reserve Bank's balance sheet is mostly its allocated share of the Fed's national
        securities portfolio (SOMA), not money its district's banks put in, so the assets ratio
        is a sense of scale, not an ownership measure. The real links are the <strong>reserves</strong> banks
        keep in their accounts here, and the <strong>paid-in capital</strong>: by law each member bank
        subscribes Reserve Bank stock equal to 6% of its capital and surplus, paying in half (≈3%).
        Members' total equity is a rough stand-in for "capital and surplus," so expect that ratio near,
        not exactly at, 3%. <strong>Caveat, visible in the numbers:</strong> the district here is FDIC's, which follows
        where a bank's main office is chartered (Citibank, chartered in Sioux Falls, SD, lands in Minneapolis;
        JPMorgan Chase Bank, Columbus, OH, in Cleveland). The very largest banks appear to hold their Reserve Bank
        stock and reserve accounts elsewhere, mostly at New York: across districts the paid-in ratio runs from
        roughly 0.1% (Minneapolis) to over 7% (New York), and New York holds reserves close to its own district's
        total bank assets. That's an inference from these aggregates, not a published mapping, so read the
        ratios for the giant-bank districts as mismatched scopes, not as signals.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared data hooks

function useGovernance() {
  const [gov, setGov] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    const load = () =>
      apiFetch("/api/fed-governance/db")
        .then((r) => r.json())
        .then((j) => {
          if (!j.success) throw new Error(j.detail || "Failed to load governance data");
          setGov(j.data);
          setError(null);
        })
        .catch((e) => setError(e.message));
    load();
    window.addEventListener(FORCE_REFRESH_EVENT, load);
    return () => window.removeEventListener(FORCE_REFRESH_EVENT, load);
  }, []);
  return { gov, error };
}

const CHARTER_CLASS_LABELS = {
  N: "National bank (OCC charter)",
  SM: "State member bank",
  NM: "State non-member bank",
  SB: "Savings bank",
  SA: "Savings association",
  OI: "Insured branch of a foreign bank",
};

function fomcLabel(rb) {
  return rb.fomc_permanent ? "FOMC voter (permanent)" : rb.fomc_voter ? "FOMC voter (rotating)" : "FOMC alternate/non-voting";
}

// ---------------------------------------------------------------------------
// Asset-share pie. Palette validated with the dataviz skill's validator
// against this app's #141820 surface (adjacent pairs, dark): all checks pass,
// worst CVD ΔE 8.4. Colors follow the ENTITY (assigned by the bank's rank in
// the unfiltered-by-slice list, never cycled); anything past the 7th slice
// folds into a neutral "Other". 2px surface-colored ring between slices,
// percent labels only on slices >= 4% (selective direct labels), a legend
// listing every slice, and a hover tooltip.

function PieTooltip({ active, payload, total }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#e8ecf4", marginBottom: 2 }}>{d.label}</div>
      <div style={{ color: "#c8d0de" }}>
        {fmtUsdCompact(d.value)} · {ratioPct(d.value, total)}
        {d.count ? ` · ${d.count.toLocaleString()} banks` : ""}
      </div>
    </div>
  );
}

function AssetPie({ title, subtitle, slices, onSliceClick, height = 300 }) {
  const total = slices.reduce((acc, sl) => acc + sl.value, 0);
  if (!total) return <div className="comex-empty">No reported assets to chart.</div>;
  const RADIAN = Math.PI / 180;
  const renderLabel = ({ cx, cy, midAngle, outerRadius, value }) => {
    if (value / total < 0.04) return null;
    const r = outerRadius + 14;
    const x = cx + r * Math.cos(-midAngle * RADIAN);
    const y = cy + r * Math.sin(-midAngle * RADIAN);
    return (
      <text x={x} y={y} fill="#c8d0de" fontSize={12} textAnchor={x > cx ? "start" : "end"} dominantBaseline="central">
        {ratioPct(value, total, 0)}
      </text>
    );
  };
  return (
    <div style={{ flex: "1 1 420px", minWidth: 300 }}>
      <div className="comex-panel-header" style={{ fontSize: 13 }}>{title}</div>
      {subtitle && <div className="comex-panel-note">{subtitle}</div>}
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            innerRadius="45%"
            outerRadius="75%"
            startAngle={90}
            endAngle={-270}
            stroke={MM_SURFACE}
            strokeWidth={2}
            label={renderLabel}
            labelLine={false}
            isAnimationActive={false}
            onClick={(d) => onSliceClick && d?.payload?.cert && onSliceClick(d.payload.cert)}
          >
            {slices.map((sl) => (
              <Cell key={sl.key} fill={sl.color} style={{ cursor: onSliceClick && sl.cert ? "pointer" : "default" }} />
            ))}
          </Pie>
          <Tooltip content={<PieTooltip total={total} />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="comex-legend-list">
        {slices.map((sl) => (
          <button
            key={sl.key}
            className="comex-legend-item legend-btn-row"
            onClick={onSliceClick && sl.cert ? () => onSliceClick(sl.cert) : undefined}
            style={{ cursor: onSliceClick && sl.cert ? "pointer" : "default", width: "100%", justifyContent: "space-between", display: "flex" }}
            title={onSliceClick && sl.cert ? "Open this bank" : undefined}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span className="comex-legend-swatch" style={{ background: sl.color, flex: "none" }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sl.label}</span>
            </span>
            <span style={{ color: "#c8d0de", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", marginLeft: 8 }}>
              {fmtUsdCompact(sl.value)} · {ratioPct(sl.value, total)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

const PIE_TOP_N = MM_PIE_COLORS.length;

function districtSlices(banks) {
  const sized = banks.filter((b) => b.total_assets != null).sort((a, b) => b.total_assets - a.total_assets);
  const top = sized.slice(0, PIE_TOP_N).map((b, i) => ({
    key: String(b.cert), cert: b.cert, label: b.name, value: b.total_assets, color: MM_PIE_COLORS[i],
  }));
  const rest = sized.slice(PIE_TOP_N);
  if (rest.length) {
    top.push({
      key: "other", label: `All other banks (${rest.length.toLocaleString()})`, count: rest.length,
      value: rest.reduce((acc, b) => acc + b.total_assets, 0), color: MM_PIE_OTHER_COLOR,
    });
  }
  return top;
}

// ---------------------------------------------------------------------------
// Over-time charts (quarterly Call Reports x Reserve Bank H.4.1, 2002+).
// One y-axis per chart, always (no dual axes): series in different units or
// wildly different scales get separate charts. Line colors use the first
// MM_PIE_COLORS slots, which pass the validator's all-pairs checks.

function useJson(url) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    apiFetch(url)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j.success) throw new Error(j.detail || "Failed to load");
        setData(j.data);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [url]);
  return { data, error };
}

const fmtPctFrac = (v, digits = 1) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);
const fmtHist = (unit, v) => (unit === "pct" ? fmtPctFrac(v) : fmtUsdCompact(v));
const fmtHistAxis = (unit, v) => (unit === "pct" ? `${(v * 100).toFixed(0)}%` : fmtUsdCompact(v));

function HistoryTooltip({ active, label, payload, lines, unit, extra }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#e8ecf4", marginBottom: 4 }}>{label}</div>
      {lines.map((l) => (
        <div key={l.key} style={{ color: "#c8d0de" }}>
          <span style={{ display: "inline-block", width: 8, height: 8, background: l.color, marginRight: 6 }} />
          {l.label}: {fmtHist(unit, row[l.key])}
        </div>
      ))}
      {extra && extra(row)}
    </div>
  );
}

function HistoryLineChart({ title, note, data, lines, unit, height = 220, zeroBase = true, markers = [], extra, onClick }) {
  const ticks = useMemo(() => xTicks(data, 7), [data]);
  const hasData = data.some((r) => lines.some((l) => r[l.key] != null));
  return (
    <div style={{ flex: "1 1 420px", minWidth: 300 }}>
      <div className="comex-panel-header" style={{ fontSize: 13 }}>{title}</div>
      {note && <div className="comex-panel-note">{note}</div>}
      {hasData ? (
        <>
          <ResponsiveContainer width="100%" height={height}>
            <LineChart data={data} margin={{ top: 6, right: 16, left: 8, bottom: 4 }} onClick={onClick}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
              <XAxis dataKey="date" ticks={ticks} tick={{ fill: MUTED, fontSize: 11 }} tickFormatter={(d) => d.slice(0, 4)} />
              <YAxis
                domain={zeroBase ? [0, "auto"] : ["auto", "auto"]}
                tickFormatter={(v) => fmtHistAxis(unit, v)}
                tick={{ fill: MUTED, fontSize: 11 }}
                width={62}
              />
              <Tooltip content={<HistoryTooltip lines={lines} unit={unit} extra={extra} />} />
              {markers.map((m) => (
                <ReferenceLine key={m.date} x={m.date} stroke="#5a6278" strokeDasharray="3 3"
                  label={{ value: m.label, position: "insideTopLeft", fill: "#c8d0de", fontSize: 11 }} />
              ))}
              {lines.map((l) => (
                <Line key={l.key} type="monotone" dataKey={l.key} stroke={l.color} strokeWidth={2}
                  dot={false} connectNulls={false} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
          {lines.length > 1 && (
            <div className="comex-legend-list comex-legend-list--horizontal">
              {lines.map((l) => (
                <span key={l.key} className="comex-legend-item">
                  <span className="comex-legend-swatch" style={{ background: l.color }} />
                  <span>{l.label}</span>
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="comex-empty">No history persisted yet — the 2002+ Call Report backfill may still be running.</div>
      )}
    </div>
  );
}

function ShareStackTooltip({ active, label, payload, series }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12, maxWidth: 320 }}>
      <div style={{ color: "#e8ecf4", marginBottom: 4 }}>{label}</div>
      {[...series].reverse().map((sr) => (
        <div key={sr.key} style={{ color: "#c8d0de" }}>
          <span style={{ display: "inline-block", width: 8, height: 8, background: sr.color, marginRight: 6 }} />
          {sr.label}: {fmtPctFrac(row[sr.key])}
        </div>
      ))}
    </div>
  );
}

// 100% stacked area: each named bank's share of the district's total bank
// assets per quarter, "Other" on top. Entity colors match the pie's order
// (largest-first as of the latest quarter).
function ShareStackChart({ title, note, data, series, onOpenBank, height = 280 }) {
  const ticks = useMemo(() => xTicks(data, 7), [data]);
  if (!data.length) return null;
  return (
    <div style={{ flex: "1 1 100%" }}>
      <div className="comex-panel-header" style={{ fontSize: 13 }}>{title}</div>
      {note && <div className="comex-panel-note">{note}</div>}
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 6, right: 16, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis dataKey="date" ticks={ticks} tick={{ fill: MUTED, fontSize: 11 }} tickFormatter={(d) => d.slice(0, 4)} />
          <YAxis domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fill: MUTED, fontSize: 11 }} width={48} />
          <Tooltip content={<ShareStackTooltip series={series} />} />
          {series.map((sr) => (
            <Area key={sr.key} type="linear" dataKey={sr.key} stackId="share" fill={sr.color} fillOpacity={0.9}
              stroke={MM_SURFACE} strokeWidth={2} isAnimationActive={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <div className="comex-legend-list comex-legend-list--horizontal">
        {series.map((sr) => (
          <button
            key={sr.key}
            className="comex-legend-item legend-btn-row"
            onClick={sr.cert && onOpenBank ? () => onOpenBank(sr.cert) : undefined}
            style={{ cursor: sr.cert && onOpenBank ? "pointer" : "default" }}
          >
            <span className="comex-legend-swatch" style={{ background: sr.color }} />
            <span>{sr.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DistrictHistory({ district, city, onOpenBank }) {
  const { data, error } = useJson(`/api/fed-districts/db/history/${district}`);
  const rows = useMemo(() => (data?.series ?? []).map((r) => ({ ...r, ...r.shares })), [data]);
  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <div className="loading">Loading history…</div>;
  const stackSeries = [
    ...data.top_banks.map((b, i) => ({ key: String(b.cert), cert: b.cert, label: b.name, color: MM_PIE_COLORS[i] })),
    { key: "other", label: "All other banks", color: MM_PIE_OTHER_COLOR },
  ];
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="comex-panel-header" style={{ fontSize: 15, marginTop: 6 }}>Over time (quarterly, 2002–now)</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
        <HistoryLineChart
          title="District banks' total assets"
          note="Sum of every bank's Call Report assets, using the district each bank was in THAT quarter."
          data={rows}
          lines={[{ key: "bank_assets", label: "District bank assets", color: MM_PIE_COLORS[0] }]}
          unit="usd"
          extra={(r) => <div style={{ color: MUTED }}>{r.bank_count?.toLocaleString()} banks · top 10 hold {fmtPctFrac(r.top10_share)}</div>}
        />
        <HistoryLineChart
          title="Share of the country vs. share of the Fed"
          note={`District ${district}'s share of all U.S. bank assets (banks chartered here that quarter) next to the Reserve Bank of ${city}'s share of the Fed System's balance sheet. The two don't have to match: a Reserve Bank's balance sheet is mostly its allocated share of the national securities portfolio, and the biggest banks appear to bank with New York regardless of charter district. The gap, and how it moves, is the story.`}
          data={rows}
          lines={[
            { key: "us_bank_share", label: "District's share of U.S. bank assets", color: MM_PIE_COLORS[0] },
            { key: "system_share", label: "Reserve Bank's share of Fed System assets", color: MM_PIE_COLORS[1] },
          ]}
          unit="pct"
        />
        <HistoryLineChart
          title={`Reserve Bank of ${city}`}
          note="Its own balance sheet vs. the reserves its district's banks keep there (weekly H.4.1, as of each quarter-end)."
          data={rows}
          lines={[
            { key: "reserve_bank_assets", label: "Reserve Bank total assets", color: MM_PIE_COLORS[0] },
            { key: "reserves_held", label: "Reserves banks hold there", color: MM_PIE_COLORS[1] },
          ]}
          unit="usd"
        />
        <HistoryLineChart
          title="Concentration: top 10 banks' share"
          data={rows}
          lines={[{ key: "top10_share", label: "Top 10 share of district assets", color: MM_PIE_COLORS[0] }]}
          unit="pct"
        />
      </div>
      <ShareStackChart
        title="Who held the district's bank assets, over time"
        note={`The district's ${data.top_banks.length} largest banks today, and their share of district assets each quarter. A band at zero means the bank wasn't in District ${district} yet (or didn't exist under that charter) — e.g. a main-office move or a merger shows up as a band appearing or jumping.`}
        data={rows}
        series={stackSeries}
        onOpenBank={onOpenBank}
      />
    </div>
  );
}

function BankHistory({ cert }) {
  const { data, error } = useJson(`/api/bank-registry/db/bank/${cert}/history`);
  const rows = useMemo(() => (data ?? []).map((r) => ({
    ...r,
    district_share: r.total_assets != null && r.district_assets ? r.total_assets / r.district_assets : null,
    us_share: r.total_assets != null && r.us_assets ? r.total_assets / r.us_assets : null,
  })), [data]);
  const moves = useMemo(() => {
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].fed_district !== rows[i - 1].fed_district && rows[i].fed_district != null) {
        out.push({ date: rows[i].date, label: `→ District ${rows[i].fed_district}` });
      }
    }
    return out;
  }, [rows]);
  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <div className="loading">Loading history…</div>;
  const extra = (r) => (
    <div style={{ color: MUTED }}>
      District {r.fed_district ?? "—"}{r.district_rank != null ? ` · #${r.district_rank} of ${r.district_count}` : ""}
      {r.us_rank != null ? ` · #${r.us_rank.toLocaleString()} in U.S.` : ""}
    </div>
  );
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="comex-panel-header" style={{ fontSize: 15, marginTop: 6 }}>Over time (quarterly, 2002–now)</div>
      {moves.length > 0 && (
        <div className="comex-panel-note">
          District changes: {moves.map((m) => `${m.date} ${m.label}`).join(" · ")} (dashed lines).
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
        <HistoryLineChart
          title="Total assets"
          note="Steps usually mean a merger: an acquired bank's history ends under its own charter and this one jumps."
          data={rows}
          lines={[{ key: "total_assets", label: "Total assets", color: MM_PIE_COLORS[0] }]}
          unit="usd"
          markers={moves}
          extra={extra}
        />
        <HistoryLineChart
          title="Relative size"
          note="Its share of its district's bank assets (the district it was in that quarter) and of all U.S. bank assets."
          data={rows}
          lines={[
            { key: "district_share", label: "Share of its district", color: MM_PIE_COLORS[0] },
            { key: "us_share", label: "Share of U.S.", color: MM_PIE_COLORS[1] },
          ]}
          unit="pct"
          markers={moves}
          extra={extra}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screens: breadcrumbs + district + bank

function Breadcrumbs({ trail }) {
  return (
    <div style={{ fontSize: 12, color: MUTED, marginBottom: 10, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {trail.map((t, i) => (
        <span key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {i > 0 && <span>›</span>}
          {t.onClick ? (
            <button className="comex-range-btn" onClick={t.onClick}>{t.label}</button>
          ) : (
            <span style={{ color: "#e8ecf4" }}>{t.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function SizeProfile({ profile }) {
  if (!profile.sizedCount) return null;
  return (
    <div style={{ flex: "1 1 420px", minWidth: 300 }}>
      <div className="comex-panel-header" style={{ fontSize: 13 }}>Size profile</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <Stat label="Largest" value={fmtUsdCompact(profile.largest?.total_assets)} sub={profile.largest?.name} />
        <Stat label="Median" value={fmtUsdCompact(profile.median)} sub={`of ${profile.sizedCount.toLocaleString()} banks shown`} />
        <Stat label="Smallest" value={fmtUsdCompact(profile.smallest?.total_assets)} sub={profile.smallest?.name} />
        <Stat label="Top 10 share of assets" value={ratioPct(profile.top10, profile.total)} sub={`of ${fmtUsdCompact(profile.total)}`} />
      </div>
      <div className="comex-table-wrap" style={{ marginTop: 8 }}>
        <table className="comex-table">
          <thead>
            <tr><th>Size tier</th><th style={{ textAlign: "right" }}>Banks</th><th style={{ textAlign: "right" }}>Share of assets</th></tr>
          </thead>
          <tbody>
            {profile.tiers.map((t) => (
              <tr key={t.label}>
                <td>{t.label}</td>
                <td style={{ textAlign: "right" }}>{t.count.toLocaleString()}</td>
                <td style={{ textAlign: "right" }}>{ratioPct(t.assets, profile.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {profile.unsizedCount > 0 && (
        <div className="comex-panel-note">{profile.unsizedCount.toLocaleString()} bank(s) shown have no reported assets and are left out of these figures.</div>
      )}
    </div>
  );
}

function DistrictScreen({ district, onHome, onOpenBank }) {
  const { gov, error: govError } = useGovernance();
  const reserveBank = gov?.reserve_banks?.find((b) => b.district === district);
  const [activeOnly, setActiveOnly] = useState(true);
  const [membersOnly, setMembersOnly] = useState(false);
  const [filter, setFilter] = useState("");
  const [banks, setBanks] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setBanks(null);
    const params = new URLSearchParams({ district: String(district), active_only: String(activeOnly), limit: "5000" });
    apiFetch(`/api/bank-registry/db?${params.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j.success) throw new Error(j.detail || "Failed to load district banks");
        setBanks(j.data);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [district, activeOnly]);

  const shown = useMemo(() => {
    if (!banks) return [];
    const f = filter.trim().toLowerCase();
    return banks.filter((b) =>
      (!membersOnly || b.fed_member) &&
      (!f || b.name.toLowerCase().includes(f) || (b.holding_company ?? "").toLowerCase().includes(f) ||
        (b.city ?? "").toLowerCase().includes(f) || (b.state ?? "").toLowerCase().includes(f))
    );
  }, [banks, filter, membersOnly]);
  const profile = useMemo(() => sizeProfile(shown), [shown]);
  const slices = useMemo(() => districtSlices(shown), [shown]);
  const city = reserveBank?.city ?? `District ${district}`;

  return (
    <div>
      <Breadcrumbs trail={[{ label: "Money Management", onClick: onHome }, { label: `District ${district} · ${city}` }]} />
      <div className="comex-panel-header" style={{ fontSize: 18, flexWrap: "wrap" }}>
        Federal Reserve Bank of {city}
        <span style={{ fontSize: 12, color: MUTED, fontWeight: "normal" }}>
          District {district}
          {reserveBank && <> · {reserveBank.president_title ?? "President"} {reserveBank.president ?? "—"}{!reserveBank.verified && " †"} · {fomcLabel(reserveBank)}</>}
        </span>
      </div>
      {(govError || error) && <div className="error-box">{govError || error}</div>}
      {reserveBank && <DistrictComparison reserveBank={reserveBank} />}

      <div className="comex-range-selector" style={{ margin: "12px 0 8px", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "#c8d0de" }}>
          {banks ? `${shown.length.toLocaleString()} of ${banks.length.toLocaleString()} banks` : "loading…"}
        </span>
        <input
          type="search"
          placeholder="Filter by name, holding co., city, state"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ minWidth: 220, flex: "1 1 220px" }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: MUTED }}>
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          Active only
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: MUTED }}>
          <input type="checkbox" checked={membersOnly} onChange={(e) => setMembersOnly(e.target.checked)} />
          Fed members only
        </label>
      </div>

      {banks && shown.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, marginBottom: 14 }}>
          <AssetPie
            title="Who holds the district's bank assets"
            subtitle={`Share of total assets across the ${profile.sizedCount.toLocaleString()} banks shown (${fmtUsdCompact(profile.total)}). Largest ${Math.min(PIE_TOP_N, profile.sizedCount)} named; click a slice or row to open that bank.`}
            slices={slices}
            onSliceClick={onOpenBank}
          />
          <SizeProfile profile={profile} />
        </div>
      )}
      <DistrictHistory district={district} city={city} onOpenBank={onOpenBank} />
      {banks && (shown.length > 0
        ? <BankTable
            banks={shown}
            showDistrict={false}
            shareDenominator={profile.total || null}
            defaultSort={{ key: "total_assets", dir: "desc" }}
            onOpenBank={onOpenBank}
          />
        : <div className="comex-empty">No banks match.</div>)}
    </div>
  );
}

function BankScreen({ cert, onHome, onOpenDistrict, onOpenBank }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    apiFetch(`/api/bank-registry/db/bank/${cert}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j.success) throw new Error(j.detail || "Failed to load bank");
        setData(j.data);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [cert]);

  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const { bank, reserve_bank: rb } = data;
  const districtTotal = bank.district_active_assets;
  const inDistrictTotal = bank.active && bank.total_assets != null && districtTotal != null;
  const rest = inDistrictTotal ? districtTotal - bank.total_assets : null;
  const slices = inDistrictTotal
    ? [
        { key: "bank", label: bank.name, value: bank.total_assets, color: MM_PIE_COLORS[0] },
        { key: "rest", label: `Rest of District ${bank.fed_district} (${(bank.district_active_sized_count - 1).toLocaleString()} banks)`, value: rest, color: MM_PIE_COLORS[1] },
      ]
    : [];
  const rbAssets = rb?.balance_sheet?.total_assets;
  const vsRb = bank.total_assets != null && rbAssets ? bank.total_assets / rbAssets : null;

  return (
    <div>
      <Breadcrumbs trail={[
        { label: "Money Management", onClick: onHome },
        ...(bank.fed_district != null
          ? [{ label: `District ${bank.fed_district} · ${rb?.city ?? ""}`, onClick: () => onOpenDistrict(bank.fed_district) }]
          : []),
        { label: bank.name },
      ]} />
      <div className="comex-panel-header" style={{ fontSize: 18, flexWrap: "wrap" }}>
        {bank.name}
        <span style={{ fontSize: 12, color: MUTED, fontWeight: "normal" }}>
          {[bank.city, bank.state].filter(Boolean).join(", ") || "—"} ·{" "}
          {bank.active ? "Active" : `Inactive${bank.inactive_date ? ` since ${bank.inactive_date}` : ""}`} · FDIC cert {bank.cert}
          {bank.fed_rssd ? ` · RSSD ${bank.fed_rssd}` : ""}
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        <Stat label="Total assets" value={fmtUsdCompact(bank.total_assets)} sub={bank.financials_as_of ? `Call Report ${bank.financials_as_of}${bank.active ? "" : " (last filing)"}` : "not reported"} />
        <Stat label="Deposits" value={fmtUsdCompact(bank.deposits)} />
        <Stat label="Equity capital" value={fmtUsdCompact(bank.equity)} />
        <Stat
          label={`Rank in District ${bank.fed_district ?? "—"}`}
          value={bank.district_rank != null ? `#${bank.district_rank.toLocaleString()}` : "—"}
          sub={bank.district_rank != null ? `of ${bank.district_active_sized_count.toLocaleString()} active banks by assets` : "active, sized banks only"}
        />
        <Stat
          label="Share of district bank assets"
          value={inDistrictTotal ? ratioPct(bank.total_assets, districtTotal) : "—"}
          sub={districtTotal != null ? `of ${fmtUsdCompact(districtTotal)}` : undefined}
        />
        <Stat
          label={`Size vs. Reserve Bank of ${rb?.city ?? "—"}`}
          value={vsRb == null ? "—" : vsRb >= 1 ? `${vsRb.toFixed(1)}×` : ratioPct(bank.total_assets, rbAssets)}
          sub={rbAssets ? `its balance sheet: ${fmtUsdCompact(rbAssets)} (scale only)` : "Reserve Bank not fetched"}
        />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, marginBottom: 14 }}>
        {inDistrictTotal ? (
          <AssetPie
            title={`${bank.name} within District ${bank.fed_district}`}
            subtitle={`Its share of the total assets of the district's active banks (${fmtUsdCompact(districtTotal)}), the Reserve Bank of ${rb?.city ?? "—"}'s territory.`}
            slices={slices}
          />
        ) : (
          <div style={{ flex: "1 1 420px" }} className="comex-empty">
            No district share to chart: {bank.active ? "no reported assets or no district." : "this institution is inactive; its figures are from its last filing."}
          </div>
        )}
        <div style={{ flex: "1 1 420px", minWidth: 300 }}>
          <div className="comex-panel-header" style={{ fontSize: 13 }}>Charter &amp; oversight</div>
          <div className="comex-table-wrap">
            <table className="comex-table">
              <tbody>
                <tr><td>Charter</td><td>{CHARTER_CLASS_LABELS[bank.charter_class] ?? bank.charter_class ?? "—"}</td></tr>
                <tr><td>Primary federal regulator</td><td>{bank.regulator ?? "—"}</td></tr>
                <tr><td>Fed member</td><td>{bank.fed_member == null ? "—" : bank.fed_member ? "Yes (national or state member bank)" : "No"}</td></tr>
                <tr><td>Fed district (FDIC)</td><td>{bank.fed_district != null ? `${bank.fed_district} · ${rb?.city ?? ""}` : "—"}</td></tr>
                <tr><td>Holding company</td><td>{bank.holding_company ?? "—"}{bank.holding_company_rssd ? ` (RSSD ${bank.holding_company_rssd})` : ""}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="comex-panel-note" style={{ marginTop: 6 }}>
            The district is FDIC's, set by where the bank's main office is chartered. The largest banks
            appear to hold their Reserve Bank stock and reserve accounts at New York regardless (see the
            district screen's note). The Reserve Bank comparison is scale only: a Reserve Bank's balance
            sheet is mostly its share of the national securities portfolio, not its banks' money.
          </div>
          {bank.holding_company_peers?.length > 0 && (
            <>
              <div className="comex-panel-header" style={{ fontSize: 13, marginTop: 12 }}>
                Other active banks under {bank.holding_company}
              </div>
              <BankTable banks={bank.holding_company_peers} onOpenBank={onOpenBank} capped={false} />
            </>
          )}
        </div>
      </div>
      <BankHistory cert={cert} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview panels

function GovernancePanel() {
  const { gov, error } = useGovernance();
  const chair = gov?.board?.find((b) => b.role === "Chair");

  return (
    <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">
        <ChartStaleness sourceKey="fed_governance_check" />
        <span>Governance</span>
        {gov && (
          <span style={{ fontWeight: "normal", fontSize: 12, color: MUTED, marginLeft: 10 }}>
            {chair ? `Chair ${chair.name} · ` : ""}Board of Governors
          </span>
        )}
      </summary>
      <div className="collapsible-pane-body">
        {error && <div className="error-box">{error}</div>}
        {gov && (
          <>
            <div className="comex-panel-note">
              Three layers, kept separate on purpose: the <strong>Board of Governors</strong> (a
              federal agency, seven Senate-confirmed members on staggered 14-year terms), the{" "}
              <strong>12 regional Reserve Banks</strong> (corporations nominally owned by their
              district's member banks, which get a fixed dividend and no policy vote from that
              ownership, see the next section), and the <strong>FOMC</strong> (all 7 governors + the New York Fed
              president + 4 of the other 11 presidents on annual rotation), which actually sets rates.
            </div>
            <div className="comex-table-wrap">
              <table className="comex-table comex-table--zebra">
                <thead>
                  <tr><th>Name</th><th>Role</th><th>Role term ends</th><th>Board seat ends</th></tr>
                </thead>
                <tbody>
                  {gov.board.map((b) => (
                    <tr key={b.name}>
                      <td>{b.name}</td>
                      <td>{b.role}</td>
                      <td>{b.role_term_end ?? "—"}</td>
                      <td>{b.board_term_end ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="comex-panel-note" style={{ marginTop: 6 }}>
              Roster hand-maintained, reviewed as of {gov.reviewed_as_of}; a weekly check against
              federalreserve.gov's Board page turns the badge red if the roster there changes.
            </div>
          </>
        )}
      </div>
    </details>
  );
}

// Reserve Banks' share of the System. 12 entities, 8 validated hues: the 8
// largest by TOTAL ASSETS get hues and the 4 smallest each get their own
// neutral-gray slice (2px surface ring between every slice, legend + table
// carry identity). Colors are fixed per Reserve Bank from the total-assets
// ranking, so switching the measure never repaints a bank (color follows
// the entity, not the current rank).
const RB_MEASURES = [
  {
    key: "total_assets", label: "Total assets",
    note: "Each Reserve Bank's own balance sheet as a share of the 12 combined. Mostly its allocated share of the System's national securities portfolio (SOMA), which is why New York dominates.",
  },
  {
    key: "depository_deposits", label: "Reserves held",
    note: "Where banks keep their reserve balances: each Reserve Bank's deposits from depository institutions as a share of the System total.",
  },
];

function ReserveBanksPanel({ onOpenDistrict }) {
  const { gov, error } = useGovernance();
  const [measure, setMeasure] = useState("total_assets");
  const anyUnverified = gov?.reserve_banks?.some((b) => !b.verified);
  const voters = gov?.reserve_banks?.filter((b) => b.fomc_voter) ?? [];

  const colorByDistrict = useMemo(() => {
    const ranked = [...(gov?.reserve_banks ?? [])]
      .filter((b) => b.balance_sheet?.total_assets != null)
      .sort((a, b) => b.balance_sheet.total_assets - a.balance_sheet.total_assets);
    return Object.fromEntries(ranked.map((b, i) => [b.district, i < MM_PIE_COLORS.length ? MM_PIE_COLORS[i] : MM_PIE_OTHER_COLOR]));
  }, [gov]);

  const banks = gov?.reserve_banks ?? [];
  const complete = banks.length === 12 && banks.every((b) => b.balance_sheet?.[measure] != null);
  const systemTotal = complete ? banks.reduce((acc, b) => acc + b.balance_sheet[measure], 0) : null;
  const asOf = banks.map((b) => b.balance_sheet?.as_of).filter(Boolean).sort().at(-1);
  const allAssets = banks.length === 12 && banks.every((x) => x.balance_sheet?.total_assets != null)
    ? banks.reduce((acc, x) => acc + x.balance_sheet.total_assets, 0) : null;
  const slices = complete
    ? [...banks]
        .sort((a, b) => b.balance_sheet[measure] - a.balance_sheet[measure])
        .map((b) => ({
          key: String(b.district), district: b.district, label: `${b.district} · ${b.city}`,
          value: b.balance_sheet[measure], color: colorByDistrict[b.district] ?? MM_PIE_OTHER_COLOR,
        }))
    : [];

  const RADIAN = Math.PI / 180;
  const renderLabel = ({ cx, cy, midAngle, outerRadius, value, payload }) => {
    if (!systemTotal || value / systemTotal < 0.04) return null;
    const r = outerRadius + 14;
    const x = cx + r * Math.cos(-midAngle * RADIAN);
    const y = cy + r * Math.sin(-midAngle * RADIAN);
    return (
      <text x={x} y={y} fill="#c8d0de" fontSize={12} textAnchor={x > cx ? "start" : "end"} dominantBaseline="central">
        {payload.label.split(" · ")[1]} {ratioPct(value, systemTotal, 0)}
      </text>
    );
  };

  return (
    <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">
        <ChartStaleness sourceKey={["fed_reserve_bank_h41", "fed_governance_check", "bank_registry"]} />
        <span>Reserve Banks &amp; {gov?.year ?? ""} FOMC votes</span>
        {gov && (
          <span style={{ fontWeight: "normal", fontSize: 12, color: MUTED, marginLeft: 10 }}>
            rotating voters: {voters.filter((b) => !b.fomc_permanent).map((b) => b.city).join(", ")}
          </span>
        )}
      </summary>
      <div className="collapsible-pane-body">
        {error && <div className="error-box">{error}</div>}
        {gov && (
          <>
            <div className="comex-range-selector" style={{ marginBottom: 6, flexWrap: "wrap" }}>
              <span className="comex-panel-header" style={{ fontSize: 13 }}>Share of the Federal Reserve System</span>
              {RB_MEASURES.map((m) => (
                <button
                  key={m.key}
                  className={`comex-range-btn${measure === m.key ? " comex-range-btn--active" : ""}`}
                  onClick={() => setMeasure(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="comex-panel-note">
              {RB_MEASURES.find((m) => m.key === measure).note}{" "}
              System total {fmtUsdCompact(systemTotal)}, weekly H.4.1, week of {asOf ?? "—"}. Click a slice or row to open that district.
            </div>
            {complete ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 20, marginBottom: 12 }}>
                <div style={{ flex: "1 1 420px", minWidth: 300 }}>
                  <ResponsiveContainer width="100%" height={320}>
                    <PieChart>
                      <Pie
                        data={slices}
                        dataKey="value"
                        nameKey="label"
                        innerRadius="45%"
                        outerRadius="75%"
                        startAngle={90}
                        endAngle={-270}
                        stroke={MM_SURFACE}
                        strokeWidth={2}
                        label={renderLabel}
                        labelLine={false}
                        isAnimationActive={false}
                        onClick={(d) => d?.payload?.district && onOpenDistrict(d.payload.district)}
                      >
                        {slices.map((sl) => <Cell key={sl.key} fill={sl.color} style={{ cursor: "pointer" }} />)}
                      </Pie>
                      <Tooltip content={<PieTooltip total={systemTotal} />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="comex-legend-list" style={{ flex: "1 1 300px", minWidth: 260, alignSelf: "center" }}>
                  {slices.map((sl) => (
                    <button
                      key={sl.key}
                      className="comex-legend-item legend-btn-row"
                      onClick={() => onOpenDistrict(sl.district)}
                      style={{ cursor: "pointer", width: "100%", display: "flex", justifyContent: "space-between" }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className="comex-legend-swatch" style={{ background: sl.color, flex: "none" }} />
                        <span>{sl.label}</span>
                      </span>
                      <span style={{ color: "#c8d0de", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", marginLeft: 8 }}>
                        {fmtUsdCompact(sl.value)} · {ratioPct(sl.value, systemTotal)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="comex-empty">Not every Reserve Bank has a persisted H.4.1 figure yet, so no System share is shown.</div>
            )}

            <div className="comex-table-wrap">
              <table className="comex-table comex-table--zebra">
                <thead>
                  <tr>
                    <th>District</th><th>Reserve Bank</th><th>President</th><th>{gov.year} FOMC</th>
                    <th title="This Reserve Bank's own total assets, weekly H.4.1">Reserve Bank assets</th>
                    <th title="Its total assets as a share of the 12 Reserve Banks combined">Share of System</th>
                    <th title="Active FDIC-insured institutions in this district (bank registry)">Active banks</th>
                    <th title="Of those, national banks + state member banks (Fed members)">Fed members</th>
                    <th title="Sum of total assets of the district's active banks, latest Call Reports">District bank assets</th>
                  </tr>
                </thead>
                <tbody>
                  {gov.reserve_banks.map((b) => {
                    return (
                      <tr
                        key={b.district}
                        onClick={() => onOpenDistrict(b.district)}
                        title={`Open District ${b.district} (${b.city})`}
                        style={{ cursor: "pointer", ...(b.fomc_voter ? { fontWeight: 600 } : {}) }}
                      >
                        <td>
                          <span className="comex-legend-swatch" style={{ display: "inline-block", marginRight: 6, background: colorByDistrict[b.district] ?? MM_PIE_OTHER_COLOR }} />
                          {b.district}
                        </td>
                        <td><span className="mm-link">{b.city}</span></td>
                        <td>
                          {b.president ?? "—"}
                          {b.president_title && b.president_title !== "President" ? ` (${b.president_title})` : ""}
                          {!b.verified && <span title="Not confirmed against federalreserve.gov at last review" style={{ color: MUTED }}> †</span>}
                        </td>
                        <td>{b.fomc_permanent ? "Voter (permanent)" : b.fomc_voter ? "Voter (rotating)" : "Alternate/non-voting"}</td>
                        <td style={{ textAlign: "right" }}>{fmtUsdCompact(b.balance_sheet?.total_assets)}</td>
                        <td style={{ textAlign: "right" }}>{ratioPct(b.balance_sheet?.total_assets, allAssets)}</td>
                        <td>{b.registry?.active?.toLocaleString() ?? "—"}</td>
                        <td>{b.registry?.active_members?.toLocaleString() ?? "—"}</td>
                        <td style={{ textAlign: "right" }}>{fmtUsdCompact(b.registry?.active_assets)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="comex-panel-note" style={{ marginTop: 6 }}>
              Bold rows vote on the FOMC in {gov.year}. Rotation groups (one voter each per year): {gov.fomc.groups.join(" · ")}. Voters computed
              from the statutory rotation, not stored.
              {anyUnverified && " † = president not confirmed against the Fed's own FOMC page at last review."}
            </div>
          </>
        )}
      </div>
    </details>
  );
}

function BankLookupPanel({ onOpenBank }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [district, setDistrict] = useState("");
  const [results, setResults] = useState([]);
  const [totalRows, setTotalRows] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ q: debounced, active_only: String(activeOnly), limit: "100" });
    if (district) params.set("district", district);
    apiFetch(`/api/bank-registry/db?${params.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j.success) throw new Error(j.detail || "Search failed");
        setResults(j.data);
        setTotalRows(j.total_registry_rows);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [debounced, activeOnly, district]);

  return (
    <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">
        <ChartStaleness sourceKey="bank_registry" />
        <span>Bank Lookup</span>
        {totalRows != null && (
          <span style={{ fontWeight: "normal", fontSize: 12, color: MUTED, marginLeft: 10 }}>
            {totalRows.toLocaleString()} institutions on file (active + historical)
          </span>
        )}
      </summary>
      <div className="collapsible-pane-body">
        <div className="comex-panel-note">
          Find a bank → see which Federal Reserve district it sits in, who regulates it, and its
          holding company; click a result to open that bank. District membership is an administrative fact. Rates (IORB, fed funds)
          apply nationwide; the district matters for discount-window borrowing, which a bank does
          from its own district's Reserve Bank. Source: FDIC BankFind, all FDIC-insured
          institutions including closed/merged ones. Not a soundness rating of any kind.
        </div>
        <TopBanksPie onOpenBank={onOpenBank} />
        <div className="comex-range-selector" style={{ marginBottom: 8, flexWrap: "wrap" }}>
          <input
            type="search"
            placeholder="Search by institution name (2+ characters)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ minWidth: 260, flex: "1 1 260px" }}
          />
          <select value={district} onChange={(e) => setDistrict(e.target.value)}>
            <option value="">All districts</option>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>District {d}</option>
            ))}
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: MUTED }}>
            <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
            Active only
          </label>
        </div>
        {error && <div className="error-box">{error}</div>}
        {debounced.length < 2 ? (
          <div className="comex-empty">Type at least 2 characters to search.</div>
        ) : results.length === 0 && !loading ? (
          <div className="comex-empty">No institutions match.</div>
        ) : (
          <BankTable banks={results} onOpenBank={onOpenBank} />
        )}
        {results.length >= 100 && (
          <div className="comex-panel-note">Showing the first 100 matches. Narrow the search to see more.</div>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Bank Lookup: top-10 pie. Each of the 10 banks is its own slice; the 8
// largest get series hues (the validated 8-slot set) and #9-#10 each get the
// one neutral gray (never extra hues — see the palette note), separated by
// the 2px surface ring; the rest of the population is a darker gray. Hover any slice for the bank; click to open it. The ranked
// table beside it carries the identity the colors can't.

function TopBanksTooltip({ active, payload, total }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#e8ecf4", marginBottom: 2 }}>{d.rank ? `#${d.rank} · ` : ""}{d.label}</div>
      <div style={{ color: "#c8d0de" }}>{fmtUsdCompact(d.value)} · {ratioPct(d.value, total, 2)}</div>
      {d.district != null && <div style={{ color: MUTED }}>District {d.district}</div>}
    </div>
  );
}

function TopBanksPie({ onOpenBank, n = 10 }) {
  const [membersOnly, setMembersOnly] = useState(true);
  const { data, error } = useJson(`/api/bank-registry/db/top?n=${n}&members_only=${membersOnly}`);

  const { slices, legend, rows, topTotal } = useMemo(() => {
    if (!data) return { slices: [], legend: [], rows: [], topTotal: 0 };
    const banks = data.banks;
    let cum = 0;
    const rows = banks.map((b, i) => {
      cum += b.total_assets;
      return { ...b, rank: i + 1, cum };
    });
    const topTotal = cum;
    const slices = rows.map((b) => ({
      key: String(b.cert), cert: b.cert, rank: b.rank, label: b.name, value: b.total_assets,
      district: b.fed_district,
      color: b.rank <= MM_PIE_COLORS.length ? MM_PIE_COLORS[b.rank - 1] : MM_PIE_OTHER_COLOR,
    }));
    const restCount = (data.population_count ?? 0) - rows.length;
    const restAssets = data.population_assets != null ? data.population_assets - topTotal : null;
    if (restCount > 0 && restAssets > 0) {
      slices.push({ key: "rest", label: `All other ${restCount.toLocaleString()} banks`, value: restAssets, color: MM_PIE_REST_COLOR });
    }
    const legend = slices;
    return { slices, legend, rows, topTotal };
  }, [data]);

  const total = data?.population_assets ?? 0;
  const RADIAN = Math.PI / 180;
  const renderLabel = ({ cx, cy, midAngle, outerRadius, value, payload }) => {
    if (!total || value / total < 0.04) return null;
    if (payload.rank && payload.rank > MM_PIE_COLORS.length) return null;
    const r = outerRadius + 14;
    const x = cx + r * Math.cos(-midAngle * RADIAN);
    const y = cy + r * Math.sin(-midAngle * RADIAN);
    return (
      <text x={x} y={y} fill="#c8d0de" fontSize={12} textAnchor={x > cx ? "start" : "end"} dominantBaseline="central">
        {ratioPct(value, total, 0)}
      </text>
    );
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <div className="comex-range-selector" style={{ marginBottom: 6, flexWrap: "wrap" }}>
        <span className="comex-panel-header" style={{ fontSize: 13 }}>
          Top {n} banks {membersOnly ? "in the Federal Reserve System" : "(all FDIC-insured)"}
        </span>
        <button className={`comex-range-btn${membersOnly ? " comex-range-btn--active" : ""}`} onClick={() => setMembersOnly(true)}>
          Fed members
        </button>
        <button className={`comex-range-btn${!membersOnly ? " comex-range-btn--active" : ""}`} onClick={() => setMembersOnly(false)}>
          All FDIC-insured
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {!data ? <div className="loading">Loading…</div> : !rows.length ? (
        <div className="comex-empty">No sized banks persisted yet.</div>
      ) : (
        <>
          <div className="comex-panel-note">
            {membersOnly
              ? "Fed members = national banks plus state-chartered member banks, the banks that hold Reserve Bank stock. "
              : "Every active FDIC-insured bank, members or not. "}
            The top {rows.length} hold <strong>{ratioPct(topTotal, total)}</strong> of the {fmtUsdCompact(total)} in
            assets across {data.population_count?.toLocaleString()} banks (Call Reports as of {data.financials_as_of ?? "—"}).
            Click any bank slice, legend row or table row to open that bank.
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
            <div style={{ flex: "1 1 420px", minWidth: 300 }}>
              <ResponsiveContainer width="100%" height={320}>
                <PieChart>
                  <Pie
                    data={slices}
                    dataKey="value"
                    nameKey="label"
                    innerRadius="45%"
                    outerRadius="78%"
                    startAngle={90}
                    endAngle={-270}
                    label={renderLabel}
                    labelLine={false}
                    isAnimationActive={false}
                    onClick={(d) => d?.payload?.cert && onOpenBank(d.payload.cert)}
                  >
                    {slices.map((sl) => (
                      <Cell
                        key={sl.key}
                        fill={sl.color}
                        stroke={MM_SURFACE}
                        strokeWidth={2}
                        style={{ cursor: sl.cert ? "pointer" : "default" }}
                      />
                    ))}
                  </Pie>
                  <Tooltip content={<TopBanksTooltip total={total} />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="comex-legend-list">
                {legend.map((sl) => (
                  <button
                    key={sl.key}
                    className="comex-legend-item legend-btn-row"
                    onClick={sl.cert ? () => onOpenBank(sl.cert) : undefined}
                    style={{ cursor: sl.cert ? "pointer" : "default", width: "100%", display: "flex", justifyContent: "space-between" }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span className="comex-legend-swatch" style={{ background: sl.color, flex: "none" }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {sl.rank ? `#${sl.rank} ` : ""}{sl.label}
                      </span>
                    </span>
                    <span style={{ color: "#c8d0de", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", marginLeft: 8 }}>
                      {fmtUsdCompact(sl.value)} · {ratioPct(sl.value, total)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div style={{ flex: "1 1 420px", minWidth: 300 }}>
              <div className="comex-table-wrap">
                <table className="comex-table comex-table--zebra">
                  <thead>
                    <tr>
                      <th>#</th><th>Bank</th><th style={{ textAlign: "right" }}>Assets</th>
                      <th style={{ textAlign: "right" }}>Share</th><th style={{ textAlign: "right" }}>Cumulative</th><th>District</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((b) => (
                      <tr key={b.cert} onClick={() => onOpenBank(b.cert)} style={{ cursor: "pointer" }}>
                        <td>
                          <span className="comex-legend-swatch" style={{ display: "inline-block", marginRight: 6, background: b.rank <= MM_PIE_COLORS.length ? MM_PIE_COLORS[b.rank - 1] : MM_PIE_OTHER_COLOR }} />
                          {b.rank}
                        </td>
                        <td><span className="mm-link">{b.name}</span></td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtUsdCompact(b.total_assets)}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{ratioPct(b.total_assets, total, 2)}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{ratioPct(b.cum, total)}</td>
                        <td>{b.fed_district ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// In-tab navigation: overview -> district -> bank. No router in this app, so
// a screen is plain state; the overview stays MOUNTED (just hidden) while a
// detail screen is open, so search text/scroll-free state survives going back.

export default function MoneyManagement() {
  const [window_, setWindow] = useState("5y");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [screen, setScreen] = useState({ kind: "overview" });
  const { pinnedDate, togglePinnedDate, clearPinnedDate } = usePinnedDate();

  const go = (next) => {
    setScreen(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const goHome = () => go({ kind: "overview" });
  const openDistrict = (district) => go({ kind: "district", district });
  const openBank = (cert) => go({ kind: "bank", cert });
  const onOverview = screen.kind === "overview";

  return (
    <div className="comex-panel">
      {!onOverview && (
        <div className="comex-panel-header">
          Money Management
          <div className="comex-range-selector">
            <button className="comex-range-btn" onClick={goHome}>← Overview</button>
          </div>
        </div>
      )}
      {screen.kind === "district" && (
        <DistrictScreen key={`d${screen.district}`} district={screen.district} onHome={goHome} onOpenBank={openBank} />
      )}
      {screen.kind === "bank" && (
        <BankScreen key={`b${screen.cert}`} cert={screen.cert} onHome={goHome} onOpenDistrict={openDistrict} onOpenBank={openBank} />
      )}

      <div style={onOverview ? undefined : { display: "none" }}>
        <div className="comex-panel-header">
          Money Management
          <div className="comex-range-selector">
            {pinnedDate && (
              <button
                className="comex-range-btn"
                onClick={clearPinnedDate}
                title="Click to remove the pinned date (shared across tabs)"
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
          </div>
        </div>
        {window_ === "custom" && (
          <div className="comex-range-selector" style={{ marginBottom: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: MUTED }}>
              From
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} max={customEnd || undefined} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: MUTED }}>
              To
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} min={customStart || undefined} />
            </label>
          </div>
        )}

        <GovernancePanel />
        <ReserveBanksPanel onOpenDistrict={openDistrict} />
        <BankLookupPanel onOpenBank={openBank} />
        <TransmissionPanel
          window_={window_}
          customStart={customStart}
          customEnd={customEnd}
          pinnedDate={pinnedDate}
          onPin={togglePinnedDate}
        />
      </div>
    </div>
  );
}
