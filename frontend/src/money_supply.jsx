import { useState, useEffect, useCallback } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const M2_COLOR = "#4caf76";
const M2_YOY_COLOR = "#7b9fff";
const WALCL_COLOR = "#e05252";
const FIAT_COLOR = "#1f6f4a";
const PP_COLOR = "#c026d3";
const XAU_COLOR = "#d4af37";
const XAG_COLOR = "#9aa5b1";
const WIN_COLOR = "#4caf76";
const LOSS_COLOR = "#e05252";

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

function xTicks(data) {
  if (!data || data.length === 0) return [];
  const n = Math.min(data.length, 8);
  const step = Math.floor(data.length / n) || 1;
  return data.filter((_, i) => i % step === 0).map((r) => r.date);
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
  return Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
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
  const yoyText =
    row.m2_yoy != null
      ? fmtPct(row.m2_yoy)
      : bracketLabel(...Object.values(bracketFor(merged, index, "m2_yoy")), "m2_yoy", fmtPct);

  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{label}</div>
      <div style={{ color: M2_COLOR }}>M2 Money Stock: {m2Text}</div>
      <div style={{ color: WALCL_COLOR }}>Fed Balance Sheet: {walclText}</div>
      <div style={{ color: M2_YOY_COLOR }}>M2 YoY %: {yoyText}</div>
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
  const [window_, setWindow] = useState("5y");
  const [data, setData] = useState(null);
  const [metalsData, setMetalsData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [baseline, setBaseline] = useState("fiat_index");
  const [visible, setVisible] = useState({ fiat_index: true, pp_index: true, xau_index: true, xag_index: true });
  const [heldDate, setHeldDate] = useState(null);

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

  const load = useCallback(async (w) => {
    setLoading(true);
    setError(null);
    try {
      const [moneyRes, metalsRes] = await Promise.all([
        fetch(`/api/fred/money-supply/db?window=${w}`),
        fetch(`/api/metals/prices/db?window=${w}`),
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
    load(window_);
  }, [window_, load]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const [moneyRes, metalsRes] = await Promise.all([
        fetch("/api/fred/money-supply/refresh"),
        fetch("/api/metals/prices/refresh"),
      ]);
      if (!moneyRes.ok) throw new Error(`HTTP ${moneyRes.status}`);
      if (!metalsRes.ok) throw new Error(`HTTP ${metalsRes.status}`);
      await load(window_);
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  const merged = data ? mergeSeries(data.m2, data.walcl) : [];
  const ticks = xTicks(merged);

  const metalsIndexed = mergeMetals(metalsData?.xag, metalsData?.xau, data?.purchasing_power);
  const metalsMerged = rebaseToBaseline(metalsIndexed, baseline);
  const metalsTicks = xTicks(metalsMerged);

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

  return (
    <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">Money Supply</summary>
      <div className="collapsible-pane-body">
      <div className="comex-panel">
      <div className="comex-panel-header">
        Money Supply
        <div className="comex-range-selector">
          {["2y", "5y", "10y", "20y"].map((w) => (
            <button
              key={w}
              className={`comex-range-btn${window_ === w ? " comex-range-btn--active" : ""}`}
              onClick={() => setWindow(w)}
            >
              {w.toUpperCase()}
            </button>
          ))}
          <button className="comex-range-btn" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      <div className="comex-panel-note">
        Tracks the supply of the thing being debased. Descriptive historical series — no
        thresholds, no predictions.
      </div>
      {(m2Stale || walclStale) && (
        <div className="comex-freshness comex-freshness--stale">
          ⚠ Stale —{" "}
          {m2Stale && `M2 last reported ${m2Latest} (FRED publishes monthly, ~4-6wk lag)`}
          {m2Stale && walclStale && "; "}
          {walclStale && `Fed Balance Sheet last reported ${walclLatest} (published weekly)`}
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
          <ComposedChart data={merged} margin={{ top: 4, right: 20, left: 12, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
            <XAxis dataKey="date" ticks={ticks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
            <YAxis
              yAxisId="level"
              tickFormatter={(v) => `$${v.toFixed(0)}T`}
              tick={{ fill: "#8a94a6", fontSize: 11 }}
              label={{ value: "Trillions USD", angle: -90, position: "insideLeft", fill: "#5a6278", fontSize: 11 }}
            />
            <YAxis
              yAxisId="yoy"
              orientation="right"
              tickFormatter={(v) => `${v.toFixed(0)}%`}
              tick={{ fill: "#e8ecf4", fontSize: 11 }}
              label={{ value: "YoY % Change", angle: 90, position: "insideRight", fill: "#5a6278", fontSize: 11 }}
            />
            <Tooltip content={<MoneySupplyTooltip merged={merged} />} />
            <Area
              yAxisId="level"
              type="monotone"
              dataKey="m2"
              stroke={M2_COLOR}
              fill={M2_COLOR}
              fillOpacity={0.25}
              connectNulls
            />
            <Line
              yAxisId="level"
              type="monotone"
              dataKey="walcl"
              stroke={WALCL_COLOR}
              dot={false}
              strokeWidth={1.8}
              connectNulls
            />
            <Line
              yAxisId="yoy"
              type="monotone"
              dataKey="m2_yoy"
              stroke={M2_YOY_COLOR}
              strokeDasharray="4 3"
              dot={false}
              strokeWidth={1.8}
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

      {merged.length > 0 && (
        <div className="comex-legend-list">
          <div className="comex-legend-item">
            <span className="comex-legend-swatch" style={{ background: M2_COLOR }} />
            <span>
              <strong>M2 Money Stock</strong> — broad U.S. dollar money supply (cash, checking/savings
              deposits, retail money-market funds), left axis, trillions USD. Published monthly.
            </span>
          </div>
          <div className="comex-legend-item">
            <span className="comex-legend-swatch" style={{ background: WALCL_COLOR }} />
            <span>
              <strong>Fed Balance Sheet</strong> — total assets held by the Federal Reserve
              (Treasuries, MBS, and other holdings from QE/QT operations), left axis, trillions
              USD. Published weekly.
            </span>
          </div>
          <div className="comex-legend-item">
            <span className="comex-legend-swatch comex-legend-swatch--dashed" style={{ borderColor: M2_YOY_COLOR }} />
            <span>
              <strong>M2 YoY %</strong> — year-over-year percent change in M2, right axis. Shows the
              rate of money-supply growth or contraction, not the level.
            </span>
          </div>
        </div>
      )}

      <div className="comex-section-label" style={{ marginTop: 20 }}>Dollars vs Silver vs Gold as Purchasing Power</div>
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
      {metalsMerged.length > 0 && (
        <div className="comex-legend-list">
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
        Source: FRED (Federal Reserve Bank of St. Louis) — M2SL, WALCL, CPIAUCSL. Metal prices:
        Yahoo Finance (SI=F, GC=F).
      </div>
      </div>
      </div>
    </details>
  );
}
