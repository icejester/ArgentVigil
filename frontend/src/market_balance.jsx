import { useState, useEffect } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from "recharts";
import { VAULT_COLORS } from "./palette";

// Silver Institute publishes World Silver Survey headline figures each April,
// covering the prior calendar year. All *_moz fields are million troy oz.

function fmt_moz_val(v) {
  if (v == null) return "—";
  return v.toFixed(1) + " Moz";
}

function balanceLabel(v) {
  if (v == null) return "—";
  return v >= 0 ? "Surplus" : "Deficit";
}

const DEMAND_KEYS = [
  { key: "industrial_demand_moz", label: "Industrial" },
  { key: "jewelry_silverware_moz", label: "Jewelry & Silverware" },
  { key: "physical_investment_moz", label: "Physical Investment" },
  { key: "etf_net_flow_moz", label: "ETF Net Flow" },
];

function NetBalanceBarChart({ rows }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={rows} margin={{ top: 4, right: 20, left: 12, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
        <XAxis dataKey="year" tick={{ fill: "#8a94a6", fontSize: 11 }} />
        <YAxis
          tickFormatter={(v) => `${v}`}
          tick={{ fill: "#8a94a6", fontSize: 11 }}
          label={{ value: "Moz", position: "insideTopLeft", fill: "#5a6278", fontSize: 11 }}
        />
        <Tooltip
          contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
          labelStyle={{ color: "#c8d0de" }}
          formatter={(v, name) => {
            if (name === "net_balance_moz") return [`${fmt_moz_val(v)} (${balanceLabel(v)})`, "Annual balance"];
            if (name === "cumulative_5y_moz") return [fmt_moz_val(v), "5-yr cumulative"];
            return [fmt_moz_val(v), name];
          }}
        />
        <Legend
          formatter={(v) => (v === "net_balance_moz" ? "Annual balance" : "5-yr cumulative")}
        />
        <ReferenceLine y={0} stroke="#4a5268" />
        <Bar dataKey="net_balance_moz" name="net_balance_moz">
          {rows.map((r, i) => (
            <Cell key={i} fill={r.net_balance_moz >= 0 ? "#4caf76" : "#e05252"} />
          ))}
        </Bar>
        <Line
          type="monotone"
          dataKey="cumulative_5y_moz"
          name="cumulative_5y_moz"
          stroke="#7b9fff"
          dot={false}
          strokeWidth={1.8}
          connectNulls={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function DemandCompositionChart({ rows }) {
  const pctRows = rows.map((r) => {
    const total = r.total_demand_moz;
    const out = { year: r.year };
    for (const { key } of DEMAND_KEYS) {
      const v = r[key];
      if (!total || v == null) {
        out[key] = null;
      } else {
        // ETF net flow can be negative (redemption years) — a 100%-stacked
        // area can't render a negative slice, so clamp its share to 0 and
        // flag it via the footnote below rather than hide the simplification.
        out[key] = Math.max(0, (v / total) * 100);
      }
    }
    return out;
  });

  const hasClampedNegative = rows.some((r) => r.etf_net_flow_moz != null && r.etf_net_flow_moz < 0);

  return (
    <>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={pctRows} margin={{ top: 4, right: 20, left: 12, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis dataKey="year" tick={{ fill: "#8a94a6", fontSize: 11 }} />
          <YAxis
            tickFormatter={(v) => `${v}%`}
            tick={{ fill: "#8a94a6", fontSize: 11 }}
          />
          <Tooltip
            contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
            labelStyle={{ color: "#c8d0de" }}
            formatter={(v, name) => {
              const found = DEMAND_KEYS.find((d) => d.key === name);
              return [v != null ? v.toFixed(1) + "%" : "—", found ? found.label : name];
            }}
          />
          <Legend formatter={(v) => (DEMAND_KEYS.find((d) => d.key === v) || {}).label || v} />
          {DEMAND_KEYS.map(({ key }, i) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stackId="1"
              stroke={VAULT_COLORS[i]}
              fill={VAULT_COLORS[i]}
              fillOpacity={0.65}
              connectNulls={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      {hasClampedNegative && (
        <div className="flow-legend-note">
          ETF net flow was negative (net redemptions) in one or more years shown; its share
          is clamped to 0% here since a percentage chart cannot show a negative slice. See
          the annual balance chart above for the signed value.
        </div>
      )}
    </>
  );
}

function RunwayStatCard({ meta }) {
  if (!meta) return null;
  const { runway_latest_year, runway_5y_avg_deficit, latest_year } = meta;

  function runwayText(r) {
    if (!r) return "Surplus — no depletion at current rate";
    return `${r.low_years}–${r.high_years} years`;
  }

  return (
    <div className="flow-stat-row">
      <div className="flow-stat-card">
        <div className="flow-stat-label">Recoverable stock runway — 5-yr avg rate</div>
        <div className="flow-stat-value">{runwayText(runway_5y_avg_deficit)}</div>
        <div className="flow-stat-sub">at the 5-year average deficit rate</div>
      </div>
      <div className="flow-stat-card">
        <div className="flow-stat-label">Recoverable stock runway — last year's rate</div>
        <div className="flow-stat-value">{runwayText(runway_latest_year)}</div>
        <div className="flow-stat-sub">at {latest_year}'s single-year deficit rate</div>
      </div>
      <div className="flow-stat-caption">
        Estimate under stated assumptions, not a prediction. Recoverable stock = Investment
        (coins/bars) + ETF/Exchange Vaults + Central Bank reserves only; excludes industrial
        and jewelry silver. Range reflects ±20% uncertainty in above-ground stock estimates
        (12.5B–17B oz).
      </div>
    </div>
  );
}

export default function MarketBalancePanel() {
  const [balance, setBalance] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/silver/market-balance")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        setBalance(j.data ?? null);
        setMeta(j.meta ?? null);
      })
      .catch((e) => setError(e.message));
  }, []);

  const latestCumulative = balance && balance.length > 0 ? balance.at(-1).cumulative_5y_moz : null;

  return (
    <div className="comex-panel">
      <div className="comex-panel-header">
        Annual Market Balance
        {meta?.stale && (
          <span className="comex-freshness comex-freshness--stale">
            ⚠ Stale — annual balance data last updated for {meta.latest_year}, Silver
            Institute typically publishes by April {meta.latest_year + 1}
          </span>
        )}
      </div>
      <div className="flow-panel-note">
        Source: Silver Institute World Silver Survey, annual headline supply/demand balance.
        Negative = deficit, positive = surplus. Figures are published each April covering the
        prior calendar year.
      </div>

      {balance && balance.length > 0 ? (
        <>
          <NetBalanceBarChart rows={balance} />
          {latestCumulative != null && (
            <div className="flow-stat-sub" style={{ marginTop: 4 }}>
              5-year cumulative ({balance.at(-1).year}): <strong>{fmt_moz_val(latestCumulative)}</strong>{" "}
              {balanceLabel(latestCumulative).toLowerCase()}
            </div>
          )}

          <RunwayStatCard meta={meta} />

          <div className="comex-panel-header" style={{ marginTop: 16 }}>
            Demand Composition Over Time
          </div>
          <DemandCompositionChart rows={balance} />
        </>
      ) : error ? (
        <div className="comex-empty">
          No data available.
          <div className="comex-empty-note">{error}</div>
        </div>
      ) : (
        <div className="comex-empty">Loading…</div>
      )}
    </div>
  );
}
