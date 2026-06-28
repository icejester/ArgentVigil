import { useState, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
} from "recharts";

const CROWDED_THRESHOLD = 90;
const CAPITULATED_THRESHOLD = 10;

function signalColor(classification) {
  if (classification.includes("crowded")) return "#e05252";
  if (classification.includes("capitulated")) return "#4caf76";
  return "#b0b8c4";
}

function StalenessLabel({ cotAsOfDate, generatedAt }) {
  const asOf = cotAsOfDate ?? "unknown";
  // CoT report: data as of Tuesday, published ~3 days later (Friday)
  const asOfDate = asOf !== "unknown" ? new Date(asOf + "T00:00:00Z") : null;
  const publishedDate = asOfDate
    ? new Date(asOfDate.getTime() + 3 * 24 * 60 * 60 * 1000)
    : null;
  const publishedStr = publishedDate
    ? publishedDate.toISOString().slice(0, 10)
    : "unknown";
  const fetchedStr = generatedAt
    ? new Date(generatedAt).toISOString().slice(0, 16).replace("T", " ") + " UTC"
    : "unknown";

  return (
    <div className="staleness-label">
      <span>
        CoT data as of <strong>{asOf}</strong> (Tuesday) · published ~
        <strong>{publishedStr}</strong> (Friday) · pipeline run{" "}
        <strong>{fetchedStr}</strong>
      </span>
    </div>
  );
}

function SignalBanner({ latest, windows }) {
  if (!latest || !windows) return null;
  const w2 = windows["2yr"];
  const w5 = windows["5yr"];
  const disagree = windows.disagree;

  return (
    <div className="signal-banner">
      <div className="banner-header">CoT Positioning Signal</div>
      <div className="banner-value">
        Net Long % of OI:{" "}
        <strong>{latest.net_long_pct_oi?.toFixed(2)}%</strong>
      </div>
      <div className="banner-windows">
        <div
          className="window-card"
          style={{ borderColor: signalColor(w2.classification) }}
        >
          <div className="window-label">2-Year Window</div>
          <div
            className="window-percentile"
            style={{ color: signalColor(w2.classification) }}
          >
            {w2.percentile}th pct
          </div>
          <div className="window-classification">{w2.classification}</div>
          <div className="window-size">({w2.window_size} weeks)</div>
        </div>
        <div
          className="window-card"
          style={{ borderColor: signalColor(w5.classification) }}
        >
          <div className="window-label">5-Year Window</div>
          <div
            className="window-percentile"
            style={{ color: signalColor(w5.classification) }}
          >
            {w5.percentile}th pct
          </div>
          <div className="window-classification">{w5.classification}</div>
          <div className="window-size">({w5.window_size} weeks)</div>
        </div>
      </div>
      {disagree && (
        <div className="disagree-warning">
          ⚠ The 2yr and 5yr windows disagree on classification — review both
          readings rather than relying on either alone.
        </div>
      )}
    </div>
  );
}

function CoTChart({ series }) {
  if (!series || series.length === 0) return null;

  // Show last 5 years of data in the chart
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  const chartData = series
    .filter((r) => new Date(r.date) >= cutoff)
    .map((r) => ({ ...r, date: r.date }));

  const vals = chartData.map((r) => r.net_long_pct_oi);
  const min = Math.min(...vals);
  const max = Math.max(...vals);

  // Compute 10th and 90th percentile reference lines from the displayed window
  const sorted = [...vals].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];

  const tickCount = Math.min(chartData.length, 10);
  const step = Math.floor(chartData.length / tickCount);
  const xTicks = chartData
    .filter((_, i) => i % step === 0)
    .map((r) => r.date);

  return (
    <div className="chart-container">
      <div className="chart-title">
        Net Long % of Open Interest — COMEX Silver (5-Year View)
      </div>
      <ResponsiveContainer width="100%" height={340}>
        <LineChart
          data={chartData}
          margin={{ top: 8, right: 24, left: 8, bottom: 8 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis
            dataKey="date"
            ticks={xTicks}
            tick={{ fill: "#8a94a6", fontSize: 11 }}
          />
          <YAxis
            domain={[Math.floor(min - 2), Math.ceil(max + 2)]}
            tickFormatter={(v) => `${v}%`}
            tick={{ fill: "#8a94a6", fontSize: 11 }}
          />
          <Tooltip
            contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
            labelStyle={{ color: "#c8d0de" }}
            formatter={(v) => [`${v.toFixed(2)}%`, "Net Long % OI"]}
          />
          <ReferenceLine
            y={p90}
            stroke="#e05252"
            strokeDasharray="5 3"
            label={{ value: `90th pct (${p90?.toFixed(1)}%)`, fill: "#e05252", fontSize: 10 }}
          />
          <ReferenceLine
            y={p10}
            stroke="#4caf76"
            strokeDasharray="5 3"
            label={{ value: `10th pct (${p10?.toFixed(1)}%)`, fill: "#4caf76", fontSize: 10 }}
          />
          <ReferenceLine y={0} stroke="#5a6278" strokeDasharray="2 4" />
          <Line
            type="monotone"
            dataKey="net_long_pct_oi"
            stroke="#7b9fff"
            dot={false}
            strokeWidth={1.8}
            name="Net Long % OI"
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="chart-note">
        Reference lines show 10th/90th percentile of the 5-year displayed window.
        Signal percentiles (banner above) are computed against rolling history, not
        this chart window.
      </div>
    </div>
  );
}

function MacroWatchlist({ watchlist }) {
  if (!watchlist) return null;

  const fields = [
    { key: "fed_policy_stance", label: "Fed Policy Stance (Chair Warsh era)", type: "text" },
    { key: "dxy", label: "DXY (US Dollar Index)", type: "number" },
    { key: "core_pce", label: "Core PCE (BEA, %)", type: "number" },
    { key: "fed_balance_sheet_note", label: "Fed H.4.1 Balance Sheet Note", type: "text" },
    { key: "comex_registered_inventory_note", label: "COMEX Registered Silver Inventory", type: "text" },
    { key: "shanghai_comex_spread_note", label: "Shanghai–COMEX Spread Note", type: "text" },
    { key: "gold_silver_ratio", label: "Gold/Silver Ratio", type: "number" },
    { key: "silver_institute_note", label: "Silver Institute (supply/demand, solar/PV trend)", type: "text" },
  ];

  return (
    <div className="macro-watchlist">
      <div className="macro-header">
        Macro Context
        <span className="macro-subheader">
          Supporting context only — not additional signals. Manually updated.
        </span>
      </div>
      <div className="macro-grid">
        {fields.map(({ key, label, type }) => {
          const val = watchlist[key];
          const display =
            val === null || val === undefined || val === ""
              ? <span className="macro-empty">— not set —</span>
              : type === "number"
              ? <strong>{Number(val).toLocaleString()}</strong>
              : <span>{String(val)}</span>;
          return (
            <div className="macro-row" key={key}>
              <div className="macro-label">{label}</div>
              <div className="macro-value">{display}</div>
            </div>
          );
        })}
      </div>
      <div className="macro-note">
        Run the pipeline (pipeline/run.py) to refresh CoT data. Edit{" "}
        <code>pipeline/cache/cot_data.json</code> → <code>macro_watchlist</code>{" "}
        to update these fields; they are preserved across pipeline runs.
        <br />
        Explicitly excluded: "hidden demand" / defense-aerospace dealer estimates —
        these are not falsifiable and are not counted here.
      </div>
    </div>
  );
}

export default function SilverCoTTracker() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/cot_data.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) =>
        setError(
          `Could not load CoT data: ${e.message}. Run pipeline/run.py first.`
        )
      );
  }, []);

  if (error) {
    return (
      <div className="app-shell">
        <div className="error-box">{error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="app-shell">
        <div className="loading">Loading CoT data…</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="app-header">
        <div className="app-title">ArgentVigil</div>
        <div className="app-subtitle">
          COMEX Silver · Commitment of Traders · Speculative Positioning Monitor
        </div>
        <StalenessLabel
          cotAsOfDate={data.cot_as_of_date}
          generatedAt={data.generated_at}
        />
      </div>

      <SignalBanner latest={data.latest} windows={data.windows} />
      <CoTChart series={data.series} />
      <MacroWatchlist watchlist={data.macro_watchlist} />

      <div className="footer">
        Source: CFTC Public Reporting Environment (PRE), Legacy Futures-Only,
        contract 084691. No price targets. Positioning data only.
      </div>
    </div>
  );
}
