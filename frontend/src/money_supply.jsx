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
const PP_COLOR = "#c9a227";

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

function fmtIndex(v) {
  if (v == null) return "—";
  return v.toFixed(1);
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

function PurchasingPowerTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const v = payload[0]?.value;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{label}</div>
      <div style={{ color: PP_COLOR }}>Purchasing power index: {fmtIndex(v)}</div>
    </div>
  );
}

export default function MoneySupply() {
  const [window_, setWindow] = useState("5y");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (w) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/fred/money-supply/db?window=${w}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setData(j.data ?? null);
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
      const r = await fetch("/api/fred/money-supply/refresh");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load(window_);
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  const merged = data ? mergeSeries(data.m2, data.walcl) : [];
  const ticks = xTicks(merged);

  const ppData = (data?.purchasing_power ?? []).map((r) => ({ date: r.date, index: r.index }));
  const ppTicks = xTicks(ppData);

  const m2Latest = data?.m2?.length ? data.m2[data.m2.length - 1].date : null;
  const walclLatest = data?.walcl?.length ? data.walcl[data.walcl.length - 1].date : null;
  const m2Stale = daysSince(m2Latest) > M2_STALE_DAYS;
  const walclStale = daysSince(walclLatest) > WALCL_STALE_DAYS;

  return (
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

      <div className="comex-section-label" style={{ marginTop: 20 }}>Purchasing Power (CPI-derived)</div>
      <div className="comex-panel-note">
        A separate measurement from money supply above, not derived from it. Indexed to 100 at
        the start of the selected window; a falling line means a dollar buys less than it did at
        the window's start. Money supply growth and purchasing power are related but not
        tightly or immediately linked — see chart above for the supply side, this one for the
        price side.
      </div>
      {ppData.length > 0 ? (
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={ppData} margin={{ top: 4, right: 20, left: 12, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
            <XAxis dataKey="date" ticks={ppTicks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
            <YAxis
              tick={{ fill: "#8a94a6", fontSize: 11 }}
              label={{ value: "Index (100 = window start)", angle: -90, position: "insideLeft", fill: "#5a6278", fontSize: 11 }}
            />
            <Tooltip content={<PurchasingPowerTooltip />} />
            <Line
              type="monotone"
              dataKey="index"
              stroke={PP_COLOR}
              dot={false}
              strokeWidth={1.8}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      ) : (
        <div className="comex-empty">
          No data available.
          <div className="comex-empty-note">Hit Refresh to fetch CPI data from FRED.</div>
        </div>
      )}
      {ppData.length > 0 && (
        <div className="comex-legend-list">
          <div className="comex-legend-item">
            <span className="comex-legend-swatch" style={{ background: PP_COLOR }} />
            <span>
              <strong>Purchasing power index</strong> — inverse of CPI (all urban consumers),
              indexed to 100 at the start of the selected window. Published monthly, ~2wk lag.
            </span>
          </div>
        </div>
      )}

      <div className="comex-panel-note" style={{ marginTop: 8 }}>
        Source: FRED (Federal Reserve Bank of St. Louis) — M2SL, WALCL, CPIAUCSL
      </div>
    </div>
  );
}
