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

function SignalBanner({ latest, windows, metal }) {
  if (!latest || !windows) return null;
  const w2 = windows["2yr"];
  const w5 = windows["5yr"];
  const disagree = windows.disagree;

  return (
    <div className="signal-banner">
      <div className="banner-header">CoT Positioning Signal{metal ? ` — ${metal}` : ""}</div>
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

const LINES = [
  { key: "silver", label: "Silver Net Long % OI", color: "#7b9fff", yAxis: "left" },
  { key: "gold",   label: "Gold Net Long % OI",   color: "#c9a227", yAxis: "left" },
  { key: "gsr",    label: "Gold/Silver Ratio",     color: "#8a94a6", yAxis: "right" },
];

function CombinedChart({ silverSeries, goldSeries, gsrSeries }) {
  const [hidden, setHidden] = useState({});

  if (!silverSeries || silverSeries.length === 0) return null;

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);

  const goldByDate = {};
  if (goldSeries) {
    for (const r of goldSeries) goldByDate[r.date] = r.net_long_pct_oi;
  }

  // GSR bars are weekly but close on a different weekday than CoT (Tuesday).
  // Build a sorted list of [date, gsr] pairs and find the nearest within 6 days.
  const gsrSorted = gsrSeries
    ? [...gsrSeries].sort((a, b) => a.date.localeCompare(b.date))
    : [];

  function nearestGsr(cotDate) {
    if (!gsrSorted.length) return null;
    const target = new Date(cotDate).getTime();
    let best = null;
    let bestDiff = Infinity;
    for (const { date, gsr } of gsrSorted) {
      const diff = Math.abs(new Date(date).getTime() - target);
      if (diff < bestDiff) { bestDiff = diff; best = gsr; }
      else break; // sorted, so once diff grows we're done
    }
    // Accept only if within 6 days
    return bestDiff <= 6 * 86400000 ? best : null;
  }

  const chartData = silverSeries
    .filter((r) => new Date(r.date) >= cutoff)
    .map((r) => ({
      date: r.date,
      silver: r.net_long_pct_oi,
      gold: goldByDate[r.date] ?? null,
      gsr: nearestGsr(r.date),
    }));

  const tickCount = Math.min(chartData.length, 10);
  const step = Math.floor(chartData.length / tickCount);
  const xTicks = chartData.filter((_, i) => i % step === 0).map((r) => r.date);

  // Left axis domain: CoT net long % values
  const cotVals = chartData.flatMap((r) =>
    [hidden.silver ? null : r.silver, hidden.gold ? null : r.gold].filter((v) => v !== null)
  );
  const cotMin = cotVals.length ? Math.floor(Math.min(...cotVals) - 2) : -20;
  const cotMax = cotVals.length ? Math.ceil(Math.max(...cotVals) + 2) : 60;

  // Right axis domain: GSR values
  const gsrVals = chartData.map((r) => r.gsr).filter((v) => v !== null);
  const gsrMin = gsrVals.length ? Math.floor(Math.min(...gsrVals) - 2) : 40;
  const gsrMax = gsrVals.length ? Math.ceil(Math.max(...gsrVals) + 2) : 130;

  // Percentile reference lines — only show for a metal when it's the sole CoT line visible
  const silverAlone = !hidden.silver && !!hidden.gold;
  const goldAlone = !hidden.gold && !!hidden.silver;

  function percentile(vals, p) {
    const sorted = [...vals].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * p)];
  }
  const silverVals = chartData.map((r) => r.silver).filter((v) => v !== null);
  const goldVals = chartData.map((r) => r.gold).filter((v) => v !== null);
  const silverP10 = silverAlone ? percentile(silverVals, 0.1) : null;
  const silverP90 = silverAlone ? percentile(silverVals, 0.9) : null;
  const goldP10 = goldAlone ? percentile(goldVals, 0.1) : null;
  const goldP90 = goldAlone ? percentile(goldVals, 0.9) : null;

  function toggle(key) {
    setHidden((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <div className="chart-container">
      <div className="chart-title">
        CoT Positioning &amp; Gold/Silver Ratio — 5-Year View
      </div>
      <div className="chart-legend">
        {LINES.map(({ key, label, color }) => (
          <button
            key={key}
            className={`legend-btn${hidden[key] ? " legend-btn--off" : ""}`}
            style={{ "--legend-color": color }}
            onClick={() => toggle(key)}
          >
            <span className="legend-swatch" />
            {label}
          </button>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={360}>
        <LineChart data={chartData} margin={{ top: 8, right: 56, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis
            dataKey="date"
            ticks={xTicks}
            tick={{ fill: "#8a94a6", fontSize: 11 }}
          />
          <YAxis
            yAxisId="left"
            domain={[cotMin, cotMax]}
            tickFormatter={(v) => `${v}%`}
            tick={{ fill: "#8a94a6", fontSize: 11 }}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={[gsrMax, gsrMin]}
            reversed
            tickFormatter={(v) => `${v}:1`}
            tick={{ fill: "#8a94a6", fontSize: 11 }}
          />
          <Tooltip
            contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
            labelStyle={{ color: "#c8d0de" }}
            formatter={(v, name) => {
              if (name === "gsr") return [`${v.toFixed(1)}:1`, "Gold/Silver Ratio"];
              if (name === "silver") return [`${v.toFixed(2)}%`, "Silver Net Long % OI"];
              if (name === "gold") return [`${v.toFixed(2)}%`, "Gold Net Long % OI"];
              return [v, name];
            }}
          />
          <ReferenceLine yAxisId="left" y={0} stroke="#5a6278" strokeDasharray="2 4" />
          {silverP90 != null && <ReferenceLine yAxisId="left" y={silverP90} stroke="#e05252" strokeDasharray="5 3" label={{ value: `90th (${silverP90.toFixed(1)}%)`, fill: "#e05252", fontSize: 10 }} />}
          {silverP10 != null && <ReferenceLine yAxisId="left" y={silverP10} stroke="#4caf76" strokeDasharray="5 3" label={{ value: `10th (${silverP10.toFixed(1)}%)`, fill: "#4caf76", fontSize: 10 }} />}
          {goldP90 != null && <ReferenceLine yAxisId="left" y={goldP90} stroke="#e05252" strokeDasharray="5 3" label={{ value: `90th (${goldP90.toFixed(1)}%)`, fill: "#e05252", fontSize: 10 }} />}
          {goldP10 != null && <ReferenceLine yAxisId="left" y={goldP10} stroke="#4caf76" strokeDasharray="5 3" label={{ value: `10th (${goldP10.toFixed(1)}%)`, fill: "#4caf76", fontSize: 10 }} />}
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="silver"
            stroke="#7b9fff"
            dot={false}
            strokeWidth={1.8}
            name="silver"
            hide={!!hidden.silver}
            connectNulls={false}
          />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="gold"
            stroke="#c9a227"
            dot={false}
            strokeWidth={1.8}
            name="gold"
            hide={!!hidden.gold}
            connectNulls={false}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="gsr"
            stroke="#8a94a6"
            dot={false}
            strokeWidth={1.8}
            name="gsr"
            hide={!!hidden.gsr}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="chart-note">
        Left axis: Net long % of open interest (CoT positioning). Right axis: Gold/Silver Ratio (GC=F ÷ SI=F spot).
        Signal percentiles in the banners below are computed against rolling history, not this window.
      </div>
    </div>
  );
}

export function MacroWatchlist({ watchlist }) {
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

function HitRateRow({ label, stat }) {
  if (!stat) return (
    <tr>
      <td className="tr-label">{label}</td>
      <td colSpan={4} className="tr-empty">No data</td>
    </tr>
  );
  return (
    <tr>
      <td className="tr-label">{label}</td>
      <td className="tr-hitrate">{stat.hit_rate_pct}%</td>
      <td className="tr-count">{stat.correct}/{stat.total}</td>
      <td className={`tr-median ${stat.median_price_chg_pct >= 0 ? "pos" : "neg"}`}>
        {stat.median_price_chg_pct > 0 ? "+" : ""}{stat.median_price_chg_pct}%
      </td>
      <td className="tr-range">
        {stat.min_price_chg_pct}% / {stat.max_price_chg_pct}%
      </td>
    </tr>
  );
}

function ZoneTable({ title, zone, directionLabel }) {
  const [expanded, setExpanded] = useState(false);
  if (!zone) return null;

  return (
    <div className="zone-block">
      <div className="zone-title">{title}</div>
      {zone.thin_sample && (
        <div className="thin-sample-warning">
          ⚠ Only {zone.sample_count} historical event{zone.sample_count !== 1 ? "s" : ""} in
          the dataset — sample too thin to draw conclusions.
        </div>
      )}
      {!zone.thin_sample && (
        <>
          <table className="track-table">
            <thead>
              <tr>
                <th>Lookahead</th>
                <th title={`% of events where price moved ${directionLabel}`}>Hit rate</th>
                <th>Correct / total</th>
                <th>Median Δ</th>
                <th>Range (min / max)</th>
              </tr>
            </thead>
            <tbody>
              <HitRateRow label="4 weeks" stat={zone.lookahead?.["4w"]} />
              <HitRateRow label="8 weeks" stat={zone.lookahead?.["8w"]} />
            </tbody>
          </table>
          <div className="zone-note">
            Hit rate = % of past events where price moved {directionLabel} within the lookahead window.
            Median Δ is the median price change across all events.
          </div>
          <button
            className="events-toggle"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide" : "Show"} individual events ({zone.sample_count})
          </button>
          {expanded && (
            <table className="events-table">
              <thead>
                <tr>
                  <th>Signal date</th>
                  <th>Pct</th>
                  <th>Price at signal</th>
                  <th>+4w Δ</th>
                  <th>+8w Δ</th>
                </tr>
              </thead>
              <tbody>
                {zone.events.map((e) => (
                  <tr key={e.date}>
                    <td>{e.date}</td>
                    <td>{e.percentile}</td>
                    <td>${e.price_at_signal?.toFixed(2)}</td>
                    <td className={e.pct_chg_4w >= 0 ? "pos" : "neg"}>
                      {e.pct_chg_4w > 0 ? "+" : ""}{e.pct_chg_4w}%
                    </td>
                    <td className={e.pct_chg_8w >= 0 ? "pos" : "neg"}>
                      {e.pct_chg_8w > 0 ? "+" : ""}{e.pct_chg_8w}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function SignalTrackRecord({ trackRecord }) {
  const [open, setOpen] = useState(false);
  if (!trackRecord) return null;

  return (
    <div className="track-record">
      <button className="track-record-toggle" onClick={() => setOpen((v) => !v)}>
        <span>Signal Track Record</span>
        <span className="toggle-caret">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="track-record-body">
          <div className="track-record-disclaimer">
            Historical description only — not a prediction. Shows what price did
            after past signal readings. Sample sizes are noted; thin samples are
            flagged explicitly. Price source: SLV ETF (silver spot proxy).
          </div>
          <ZoneTable
            title="Crowded-long zone (specs piled in)"
            zone={trackRecord.crowded}
            directionLabel="lower (crowd was wrong)"
          />
          <ZoneTable
            title="Capitulated zone (specs washed out)"
            zone={trackRecord.capitulated}
            directionLabel="higher (crowd was wrong)"
          />
        </div>
      )}
    </div>
  );
}

export default function SilverCoTTracker({ onData }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/cot_data.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { setData(d); onData?.(d); })
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
          COMEX Silver &amp; Gold · Commitment of Traders · Speculative Positioning Monitor
        </div>
        <StalenessLabel
          cotAsOfDate={data.cot_as_of_date}
          generatedAt={data.generated_at}
        />
      </div>

      <CombinedChart
        silverSeries={data.series}
        goldSeries={data.gold?.series}
        gsrSeries={data.gsr_series}
      />

      <div className="metal-section-label">Silver</div>
      <SignalBanner latest={data.latest} windows={data.windows} metal="Silver" />
      <SignalTrackRecord trackRecord={data.signal_track_record} />

      <div className="metal-section-label">Gold</div>
      <SignalBanner latest={data.gold?.latest} windows={data.gold?.windows} metal="Gold" />
      <SignalTrackRecord trackRecord={data.gold?.signal_track_record} />

      <div className="footer">
        CoT source: CFTC Public Reporting Environment (PRE), Legacy Futures-Only,
        Silver 084691 · Gold 088691. Price source: SLV/GLD ETF via Yahoo Finance (spot proxy).
        No price targets. Positioning data only.
      </div>
    </div>
  );
}
