import { useState, useEffect } from "react";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  ComposedChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { TRADE_FLOW_COLORS } from "./palette";

// Country-mix and net-flow are silver-only; the comparator is the one
// sanctioned place gold appears (CLAUDE.md: HS 7108/gold gets no
// gold-specific panel, comparator context is fine). Ranking/aggregation for
// country-mix and the comparator both use imports only, matching the
// "where does supply come from" framing this feature exists for.

const WINDOWS = [
  { label: "1Y", days: 365 },
  { label: "5Y", days: 1825 },
  { label: "All", days: null },
];

function ym(row) {
  return `${row.year}-${String(row.month).padStart(2, "0")}`;
}

function fmtValue(v, unit) {
  if (v == null) return "—";
  if (unit === "oz") return v.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " oz (est.)";
  return "$" + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function windowRows(rows, days) {
  if (days == null) return rows;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sinceYear = cutoff.getFullYear();
  const sinceMonth = cutoff.getMonth() + 1;
  return rows.filter(
    (r) => r.year > sinceYear || (r.year === sinceYear && r.month >= sinceMonth)
  );
}

function withDisplayValue(rows, unit) {
  return rows.map((r) => ({
    ...r,
    displayValue: unit === "oz" ? r.implied_qty_oz : r.value_general_usd,
  }));
}

function buildCountryMix(importRows) {
  if (importRows.length === 0) return { chartRows: [], countries: [] };

  let latestYm = null;
  for (const r of importRows) {
    const key = ym(r);
    if (latestYm == null || key > latestYm) latestYm = key;
  }

  const latestMonthRows = importRows.filter((r) => ym(r) === latestYm);
  const top4 = [...latestMonthRows]
    .sort((a, b) => (b.value_general_usd ?? 0) - (a.value_general_usd ?? 0))
    .slice(0, 4);
  const top4Codes = new Set(top4.map((r) => r.cty_code));
  const countryNames = Object.fromEntries(top4.map((r) => [r.cty_code, r.cty_name]));

  const byMonth = new Map();
  for (const r of importRows) {
    const key = ym(r);
    if (!byMonth.has(key)) {
      const base = { ym: key };
      for (const code of top4Codes) base[code] = 0;
      base.Other = 0;
      byMonth.set(key, base);
    }
    const bucket = byMonth.get(key);
    const v = r.displayValue ?? 0;
    if (top4Codes.has(r.cty_code)) {
      bucket[r.cty_code] += v;
    } else {
      bucket.Other += v;
    }
  }

  const chartRows = [...byMonth.values()].sort((a, b) => (a.ym < b.ym ? -1 : 1));
  const countries = [...top4Codes].map((code) => ({ code, name: countryNames[code] || code }));
  return { chartRows, countries };
}

function CountryMixChart({ rows, unit }) {
  const importRows = rows.filter((r) => r.flow === "import");
  const { chartRows, countries } = buildCountryMix(importRows);

  if (chartRows.length === 0) {
    return <div className="comex-empty">No import data available for this window.</div>;
  }

  return (
    <>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={chartRows} margin={{ top: 4, right: 20, left: 12, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis dataKey="ym" tick={{ fill: "#8a94a6", fontSize: 11 }} minTickGap={40} />
          <YAxis
            tick={{ fill: "#8a94a6", fontSize: 11 }}
            tickFormatter={(v) => (unit === "oz" ? v.toLocaleString() : "$" + v.toLocaleString())}
          />
          <Tooltip
            contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
            labelStyle={{ color: "#c8d0de" }}
            formatter={(v, name) => {
              const found = countries.find((c) => c.code === name);
              return [fmtValue(v, unit), found ? found.name : name];
            }}
          />
          {countries.map(({ code }, i) => (
            <Area
              key={code}
              type="monotone"
              dataKey={code}
              stackId="1"
              stroke={TRADE_FLOW_COLORS[i]}
              fill={TRADE_FLOW_COLORS[i]}
              fillOpacity={0.65}
              connectNulls={false}
            />
          ))}
          <Area
            type="monotone"
            dataKey="Other"
            stackId="1"
            stroke={TRADE_FLOW_COLORS[4]}
            fill={TRADE_FLOW_COLORS[4]}
            fillOpacity={0.65}
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
      <div className="comex-legend-list">
        {countries.map(({ code, name }, i) => (
          <div className="comex-legend-item" key={code}>
            <span className="comex-legend-swatch" style={{ background: TRADE_FLOW_COLORS[i] }} />
            <span>{name}</span>
          </div>
        ))}
        <div className="comex-legend-item">
          <span className="comex-legend-swatch" style={{ background: TRADE_FLOW_COLORS[4] }} />
          <span>Other — every other country of origin, combined</span>
        </div>
      </div>
      <div className="flow-panel-note">
        Top 4 countries ranked by most recent month's import value, recomputed on every
        fetch — not a fixed list.
      </div>
    </>
  );
}

function indexSeries(rows) {
  const byMonth = new Map();
  for (const r of rows) {
    const key = ym(r);
    byMonth.set(key, (byMonth.get(key) ?? 0) + (r.displayValue ?? 0));
  }
  const sorted = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const base = sorted.length > 0 ? sorted[0][1] : null;
  return new Map(
    sorted.map(([key, v]) => [key, base ? (v / base) * 100 : null])
  );
}

function ComparatorChart({ xagRows, xauRows, unit }) {
  const xagImports = xagRows.filter((r) => r.flow === "import");
  const xauImports = xauRows.filter((r) => r.flow === "import");
  const xagIndex = indexSeries(xagImports);
  const xauIndex = indexSeries(xauImports);

  const allMonths = new Set([...xagIndex.keys(), ...xauIndex.keys()]);
  const chartRows = [...allMonths]
    .sort()
    .map((key) => ({
      ym: key,
      silver: xagIndex.get(key) ?? null,
      gold: xauIndex.get(key) ?? null,
    }));

  if (chartRows.length === 0) {
    return <div className="comex-empty">No import data available for this window.</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={chartRows} margin={{ top: 4, right: 20, left: 12, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
        <XAxis dataKey="ym" tick={{ fill: "#8a94a6", fontSize: 11 }} minTickGap={40} />
        <YAxis
          tick={{ fill: "#8a94a6", fontSize: 11 }}
          tickFormatter={(v) => v.toFixed(0)}
          label={{ value: "Indexed to 100", position: "insideTopLeft", fill: "#5a6278", fontSize: 11 }}
        />
        <Tooltip
          contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
          labelStyle={{ color: "#c8d0de" }}
          formatter={(v, name) => [v != null ? v.toFixed(1) : "—", name === "silver" ? "Silver" : "Gold"]}
        />
        <Line type="monotone" dataKey="silver" name="silver" stroke="#c9c9c9" dot={false} strokeWidth={1.8} connectNulls={false} />
        <Line type="monotone" dataKey="gold" name="gold" stroke="#e0a84c" dot={false} strokeWidth={1.8} connectNulls={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function buildNetFlow(silverRows) {
  const byMonth = new Map();
  for (const r of silverRows) {
    const key = ym(r);
    if (!byMonth.has(key)) byMonth.set(key, { ym: key, importTotal: 0, exportTotal: 0 });
    const bucket = byMonth.get(key);
    const v = r.displayValue ?? 0;
    if (r.flow === "import") bucket.importTotal += v;
    else if (r.flow === "export") bucket.exportTotal += v;
  }
  return [...byMonth.values()]
    .map((b) => ({ ym: b.ym, net: b.importTotal - b.exportTotal }))
    .sort((a, b) => (a.ym < b.ym ? -1 : 1));
}

function NetFlowChart({ rows, unit }) {
  const chartRows = buildNetFlow(rows);

  if (chartRows.length === 0) {
    return <div className="comex-empty">No trade data available for this window.</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={chartRows} margin={{ top: 4, right: 20, left: 12, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
        <XAxis dataKey="ym" tick={{ fill: "#8a94a6", fontSize: 11 }} minTickGap={40} />
        <YAxis
          tick={{ fill: "#8a94a6", fontSize: 11 }}
          tickFormatter={(v) => (unit === "oz" ? v.toLocaleString() : "$" + v.toLocaleString())}
        />
        <Tooltip
          contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
          labelStyle={{ color: "#c8d0de" }}
          formatter={(v) => [fmtValue(Math.abs(v), unit), v >= 0 ? "Net imports" : "Net exports"]}
        />
        <ReferenceLine y={0} stroke="#4a5268" />
        <Bar dataKey="net">
          {chartRows.map((r, i) => (
            <Cell key={i} fill={r.net >= 0 ? "#4caf76" : "#e05252"} />
          ))}
        </Bar>
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export default function TradeFlowPanel() {
  const [xagRows, setXagRows] = useState(null);
  const [xauRows, setXauRows] = useState(null);
  const [error, setError] = useState(null);
  const [unit, setUnit] = useState("oz");
  const [windowDays, setWindowDays] = useState(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/census-trade/db?metal=XAG").then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetch("/api/census-trade/db?metal=XAU").then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    ])
      .then(([xag, xau]) => {
        setXagRows(xag.data ?? []);
        setXauRows(xau.data ?? []);
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="comex-panel">
        <div className="comex-empty">
          No data available.
          <div className="comex-empty-note">{error}</div>
        </div>
      </div>
    );
  }

  if (xagRows == null || xauRows == null) {
    return (
      <div className="comex-panel">
        <div className="comex-empty">Loading…</div>
      </div>
    );
  }

  const xagWindowed = withDisplayValue(windowRows(xagRows, windowDays), unit);
  const xauWindowed = withDisplayValue(windowRows(xauRows, windowDays), unit);

  return (
    <div className="comex-panel">
      <div className="flow-panel-note">
        U.S. Census Bureau international trade data, HS 7106 (silver) / HS 7108 (gold,
        comparator only). Estimated oz is value ÷ that month's spot close — an estimate,
        not a reported weight (Census does not report quantity for these HS codes).
      </div>

      <div className="comex-range-selector">
        <button
          type="button"
          className={`comex-range-btn${unit === "oz" ? " comex-range-btn--active" : ""}`}
          onClick={() => setUnit("oz")}
        >
          Estimated oz
        </button>
        <button
          type="button"
          className={`comex-range-btn${unit === "usd" ? " comex-range-btn--active" : ""}`}
          onClick={() => setUnit("usd")}
        >
          Dollars
        </button>
      </div>

      <div className="comex-range-selector">
        {WINDOWS.map((w) => (
          <button
            key={w.label}
            type="button"
            className={`comex-range-btn${windowDays === w.days ? " comex-range-btn--active" : ""}`}
            onClick={() => setWindowDays(w.days)}
          >
            {w.label}
          </button>
        ))}
      </div>

      <div className="comex-chart-block">
        <div className="comex-chart-subheader">Country Mix — Silver Imports</div>
        <CountryMixChart rows={xagWindowed} unit={unit} />
      </div>

      <div className="comex-chart-block">
        <div className="comex-chart-subheader">Silver vs. Gold Import Value — Indexed</div>
        <ComparatorChart xagRows={xagWindowed} xauRows={xauWindowed} unit={unit} />
      </div>

      <div className="comex-chart-block">
        <div className="comex-chart-subheader">Net Trade Flow — Silver (Imports − Exports)</div>
        <NetFlowChart rows={xagWindowed} unit={unit} />
      </div>
    </div>
  );
}
