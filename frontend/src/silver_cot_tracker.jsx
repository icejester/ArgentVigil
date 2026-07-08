import { useState, useEffect, useCallback } from "react";
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { FORCE_REFRESH_EVENT } from "./refresh_controls";
import { VAULT_COLORS } from "./palette";

const CATEGORY_LABELS = {
  producer_merchant: "Producer/Merchant",
  swap_dealer: "Swap Dealer",
  managed_money: "Managed Money",
  other_reportable: "Other Reportable",
};

const CATEGORY_DEFINITIONS = {
  producer_merchant: "Commercial hedgers — mining/refining/fabricating firms hedging physical exposure. Routine.",
  swap_dealer: "Dealers/brokers managing swap-related risk, often on behalf of clients. Mixed commercial/speculative.",
  managed_money: "CTAs, hedge funds, and similar — the speculative-positioning crowd this app otherwise tracks.",
  other_reportable: "Large traders not classified into the other three categories.",
};

const CATEGORY_ORDER = ["producer_merchant", "swap_dealer", "managed_money", "other_reportable"];

const CROWDED_THRESHOLD = 90;
const CAPITULATED_THRESHOLD = 10;

function signalColor(classification) {
  if (classification.includes("crowded")) return "#e05252";
  if (classification.includes("capitulated")) return "#4caf76";
  return "#b0b8c4";
}

const WEEKDAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

function StalenessLabel({ cotAsOfDate }) {
  const asOf = cotAsOfDate ?? "unknown";
  // CoT report: data as of Tuesday, published ~3 days later (Friday)
  const asOfDate = asOf !== "unknown" ? new Date(asOf + "T00:00:00Z") : null;
  const publishedDate = asOfDate
    ? new Date(asOfDate.getTime() + 3 * 24 * 60 * 60 * 1000)
    : null;
  const asOfWeekday = asOfDate ? WEEKDAY_NAMES[asOfDate.getUTCDay()] : null;
  const publishedWeekday = publishedDate ? WEEKDAY_NAMES[publishedDate.getUTCDay()] : null;
  const publishedStr = publishedDate
    ? publishedDate.toISOString().slice(0, 10)
    : "unknown";

  return (
    <span className="staleness-label">
      CoT data as of <strong>{asOf}</strong>
      {asOfWeekday ? ` (${asOfWeekday})` : ""} · published ~
      <strong>{publishedStr}</strong>
      {publishedWeekday ? ` (${publishedWeekday})` : ""}
    </span>
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
        Net Long % of Open Interest:{" "}
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
  {
    key: "silver",
    label: "Silver Net Long % Open Interest",
    color: "#7b9fff",
    yAxis: "left",
    definition: "Speculative traders' net long position as a percentage of total open interest, silver futures. Left axis.",
  },
  {
    key: "gold",
    label: "Gold Net Long % Open Interest",
    color: "#c9a227",
    yAxis: "left",
    definition: "Same calculation as above, for gold futures. Left axis.",
  },
  {
    key: "gsr",
    label: "Gold/Silver Ratio",
    color: "#8a94a6",
    yAxis: "right",
    definition: "How many ounces of silver it takes to buy one ounce of gold (GC=F ÷ SI=F spot). Right axis.",
  },
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
              if (name === "silver") return [`${v.toFixed(2)}%`, "Silver Net Long % Open Interest"];
              if (name === "gold") return [`${v.toFixed(2)}%`, "Gold Net Long % Open Interest"];
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
      <div className="comex-legend-list">
        {LINES.map(({ key, label, color, definition }) => (
          <button
            key={key}
            className={`comex-legend-item legend-btn-row${hidden[key] ? " legend-btn--off" : ""}`}
            style={{ "--legend-color": color }}
            onClick={() => toggle(key)}
          >
            <span className="comex-legend-swatch" style={{ background: color }} />
            <span><strong>{label}</strong> — {definition}</span>
          </button>
        ))}
      </div>
      <div className="chart-note">
        Signal percentiles in the banners below are computed against rolling history, not this window.
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

const METAL_CONFIG = {
  silver: { label: "Silver", leverageUrl: "/api/silver/db/leverage", contractOz: 5000, spotKey: "XAG" },
  gold:   { label: "Gold",   leverageUrl: "/api/gold/db/leverage",   contractOz: 100,  spotKey: "XAU" },
};

function spotPrice(entry) {
  if (entry == null) return null;
  // entry may be an object {price, change24h, …} or a bare number
  return typeof entry === "object" ? entry.price : entry;
}

function LeverageSpotBadge({ prices, spotKey, label }) {
  if (!prices) return null;
  const entry = prices?.[spotKey] ?? prices?.[spotKey.toLowerCase()];
  const price = spotPrice(entry);
  if (price == null) return null;

  const pct = typeof entry === "object" ? entry.changePercent24h : null;
  const pctColor = pct == null ? "#6b778d" : pct >= 0 ? "#4caf76" : "#e05252";
  const pctStr = pct == null ? null : (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";

  return (
    <div className="comex-spot-badge">
      <span className="comex-spot-label">{label} ({spotKey})</span>
      <span className="comex-spot-price">${Number(price).toFixed(2)}</span>
      {pctStr && (
        <span className="comex-spot-change" style={{ color: pctColor }}>
          {pctStr} 24h
        </span>
      )}
    </div>
  );
}

function CategoryCompositionChart({ weeks }) {
  const rows = weeks.map((w) => ({
    report_date: w.report_date,
    ...Object.fromEntries(CATEGORY_ORDER.map((c) => [c, w.long_share_pct[c] ?? null])),
  }));

  return (
    <>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={rows} margin={{ top: 4, right: 20, left: 12, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis
            dataKey="report_date"
            tickFormatter={(d) => new Date(d).toLocaleString(undefined, { month: "short", year: "2-digit" })}
            interval="preserveStartEnd"
            minTickGap={40}
            tick={{ fill: "#8a94a6", fontSize: 11 }}
          />
          <YAxis
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            tick={{ fill: "#8a94a6", fontSize: 11 }}
          />
          <Tooltip
            contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
            labelStyle={{ color: "#c8d0de" }}
            formatter={(v, name) => [v != null ? v.toFixed(1) + "%" : "—", CATEGORY_LABELS[name] ?? name]}
          />
          {CATEGORY_ORDER.map((c, i) => (
            <Area
              key={c}
              type="monotone"
              dataKey={c}
              stackId="1"
              stroke={VAULT_COLORS[i]}
              fill={VAULT_COLORS[i]}
              fillOpacity={0.65}
              connectNulls={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <div className="comex-legend-list">
        {CATEGORY_ORDER.map((c, i) => (
          <div className="comex-legend-item" key={c}>
            <span className="comex-legend-swatch" style={{ background: VAULT_COLORS[i] }} />
            <span><strong>{CATEGORY_LABELS[c]}</strong> — {CATEGORY_DEFINITIONS[c]}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function CategoryCompositionPanel() {
  const [metal, setMetal] = useState("XAG");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const fetchData = useCallback(() => {
    setError(null);
    fetch(`/api/delivery-behavior/db?metal=${metal}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => setData(j.data ?? null))
      .catch((e) => setError(e.message));
  }, [metal]);

  useEffect(() => {
    fetchData();
    window.addEventListener(FORCE_REFRESH_EVENT, fetchData);
    return () => window.removeEventListener(FORCE_REFRESH_EVENT, fetchData);
  }, [fetchData]);

  const composition = data?.category_composition;

  return (
    <div className="comex-panel">
      <div className="comex-panel-header">
        Who's Holding Long Positions
        <select value={metal} onChange={(e) => setMetal(e.target.value)}>
          <option value="XAG">Silver</option>
          <option value="XAU">Gold</option>
        </select>
      </div>
      <div className="flow-panel-note">
        Share of total long open interest by CFTC trader category (Disaggregated CoT,
        weekly). Managed Money and Other Reportable are the speculative-positioning
        crowd; Producer/Merchant is routine commercial hedging. This does not yet cross-
        reference First Notice Day proximity — it's a composition-over-time view, not
        yet a "who's standing for delivery" signal.
      </div>
      {composition?.available === false ? (
        <div className="comex-empty">{composition.reason}</div>
      ) : composition?.weeks?.length > 0 ? (
        <CategoryCompositionChart weeks={composition.weeks} />
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

function PaperLeveragePanel({ metal = "silver" }) {
  const { label, leverageUrl, contractOz, spotKey } = METAL_CONFIG[metal];
  const [leverageData, setLeverageData] = useState(null);
  const [prices, setPrices] = useState(null);

  const fetchLeverageAndPrices = useCallback(() => {
    fetch(leverageUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setLeverageData)
      .catch(() => {});
    fetch("/api/prices/db")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => setPrices(j.data ?? j))
      .catch(() => {});
  }, [leverageUrl]);

  useEffect(() => {
    fetchLeverageAndPrices();
    window.addEventListener(FORCE_REFRESH_EVENT, fetchLeverageAndPrices);
    return () => window.removeEventListener(FORCE_REFRESH_EVENT, fetchLeverageAndPrices);
  }, [fetchLeverageAndPrices]);

  if (!leverageData) return (
    <div className="comex-panel">
      <div className="comex-panel-header">{label} Paper Leverage Ratio</div>
      <div className="comex-empty">Loading…</div>
    </div>
  );

  const row = (leverageData.data || [])[0];
  const leverage = row?.paper_leverage;
  const oi = row?.openInterest;
  const vol = row?.volume;
  const date = row?.date;

  const alertLevel = leverage == null ? null
    : leverage >= 10 ? "high"
    : leverage >= 5  ? "med"
    : "low";

  return (
    <div className="comex-panel">
      <div className="comex-panel-header">
        {label} Paper Leverage Ratio — Open Interest × {contractOz.toLocaleString()} oz / Registered
      </div>
      <div className="comex-panel-note">
        Above 1.0 = more paper claims than registered metal available for delivery.
        Open Interest is in contracts ({contractOz.toLocaleString()} troy oz each). Positioning context alongside CoT.
      </div>
      {leverage != null ? (
        <div className="comex-leverage-card">
          <LeverageSpotBadge prices={prices} spotKey={spotKey} label={label} />
          <div className={`comex-leverage-value comex-leverage--${alertLevel}`}>
            {leverage.toFixed(2)}x
          </div>
          <div className="comex-leverage-meta">
            <span>Open interest: <strong>{oi?.toLocaleString()} contracts</strong> ({(oi * contractOz)?.toLocaleString()} oz)</span>
            <span>Volume: <strong>{vol?.toLocaleString()} contracts</strong></span>
            <span>As of: <strong>{date}</strong></span>
          </div>
          <div className="comex-leverage-note">
            {leverage >= 10
              ? "⚠ Extreme paper leverage — registered inventory is thinly covered."
              : leverage >= 5
              ? "Elevated paper leverage — watch registered inventory levels."
              : "Paper leverage within normal range."}
          </div>
        </div>
      ) : (
        <div className="comex-empty">
          <LeverageSpotBadge prices={prices} spotKey={spotKey} label={label} />
          No leverage data available.
        </div>
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

export default function SilverCoTTracker() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/cot/db")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => setData(d))
      .catch((e) =>
        setError(
          `Could not load CoT data: ${e.message}. Run pipeline/run.py first (persists to runtime/argentvigil.db).`
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
      <details className="collapsible-pane" open>
        <summary className="collapsible-pane-title">
          <span>Positioning Extremes / Speculative Crowding</span>
          <StalenessLabel cotAsOfDate={data.cot_as_of_date} />
        </summary>
        <div className="collapsible-pane-body">
          <CombinedChart
            silverSeries={data.series}
            goldSeries={data.gold?.series}
            gsrSeries={data.gsr_series}
          />

          <details className="collapsible-pane" open>
            <summary className="collapsible-pane-title">Who's Holding Long Positions</summary>
            <div className="collapsible-pane-body">
              <CategoryCompositionPanel />
            </div>
          </details>

          <details className="collapsible-pane">
            <summary className="collapsible-pane-title">Silver</summary>
            <div className="collapsible-pane-body">
              <PaperLeveragePanel metal="silver" />
              <SignalBanner latest={data.latest} windows={data.windows} metal="Silver" />
              <SignalTrackRecord trackRecord={data.signal_track_record} />
            </div>
          </details>

          <details className="collapsible-pane">
            <summary className="collapsible-pane-title">Gold</summary>
            <div className="collapsible-pane-body">
              <PaperLeveragePanel metal="gold" />
              <SignalBanner latest={data.gold?.latest} windows={data.gold?.windows} metal="Gold" />
              <SignalTrackRecord trackRecord={data.gold?.signal_track_record} />
            </div>
          </details>
        </div>
      </details>
    </div>
  );
}
