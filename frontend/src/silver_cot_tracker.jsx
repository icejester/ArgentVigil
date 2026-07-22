import { useState, useEffect, useCallback } from "react";
import { nearestRowDate } from "./date_utils";
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  ComposedChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
  PieChart,
  Pie,
  Cell,
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

const CATEGORY_ORDER = ["managed_money", "other_reportable", "swap_dealer", "producer_merchant"];

const CROWDED_THRESHOLD = 90;
const CAPITULATED_THRESHOLD = 10;
const WINDOW_2YR = 104; // ~2 years of weekly CoT reports
const WINDOW_5YR = 260; // ~5 years of weekly CoT reports

function classifySignal(percentile) {
  if (percentile >= CROWDED_THRESHOLD) return "Specs crowded long — caution";
  if (percentile <= CAPITULATED_THRESHOLD) return "Specs capitulated — back-up-the-truck zone";
  return "Normal range — no signal";
}

// Client-side port of pipeline/compute.py's compute_from_series, applied as
// of an arbitrary historical date instead of always the latest report — so
// a pinned date's SignalDetail reflects what the percentile/classification
// actually were AT that date, not today's. Same trailing-window definition
// (rank against the n reports strictly before the as-of report, never
// including it), so a pinned reading matches what compute_from_series would
// have returned had it been run that week.
function windowStatsAsOf(series, pinnedDate) {
  if (!series || series.length === 0 || !pinnedDate) return null;
  const idx = series.findLastIndex((r) => r.date <= pinnedDate);
  if (idx === -1) return null;
  const asOf = series[idx];
  const currentVal = asOf.net_long_pct_oi;

  function stats(n) {
    const start = idx > n ? idx - n : 0;
    const window = series.slice(start, idx).map((r) => r.net_long_pct_oi);
    const below = window.filter((v) => v < currentVal).length;
    const percentile = window.length ? Math.round((below / window.length) * 1000) / 10 : NaN;
    return { percentile, window_size: window.length, classification: classifySignal(percentile) };
  }

  const windows = { "2yr": stats(WINDOW_2YR), "5yr": stats(WINDOW_5YR) };
  windows.disagree = windows["2yr"].classification !== windows["5yr"].classification;
  return { latest: asOf, windows };
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

// Compact replacement for the old SignalBanner (two large window-card
// blocks — 2yr and 5yr each getting their own bordered card with a label,
// percentile, classification, and window size — visually bulky for what's
// really just two numbers). Same underlying data, dense inline lines
// instead of nested cards; only shown click-revealed inside CombinedChart's
// legend note (per the user's explicit "surface this when clicking the
// metric in the legend, hover the chart for a quick look" request) rather
// than as its own always-visible standalone panel.
// Same gray as this file's tooltip/label text (#8a94a6) for a "normal
// range" reading — a local, dedicated color helper for SignalDetail (the
// old signalColor() function this was originally split off from, back
// when Gold's SignalBanner still used it and needed a different gray, was
// deleted outright once Gold moved onto SignalDetail too — see "Gold
// parity" below, nothing calls the old gray anymore).
function signalDetailColor(classification) {
  if (classification.includes("crowded")) return "#e05252";
  if (classification.includes("capitulated")) return "#4caf76";
  return "#8a94a6";
}

function SignalDetail({ latest, windows }) {
  if (!latest || !windows) return null;
  const w2 = windows["2yr"];
  const w5 = windows["5yr"];
  const disagree = windows.disagree;

  // Raw net-long reading has no classification of its own (only the two
  // percentile windows carry crowded/capitulated/normal) — combine both:
  // gray only when NEITHER window flags anything; crowded (either window)
  // takes priority over capitulated as the more attention-worthy state,
  // rather than picking one window arbitrarily when they disagree.
  const rawValueColor = w2.classification.includes("crowded") || w5.classification.includes("crowded")
    ? "#e05252"
    : w2.classification.includes("capitulated") || w5.classification.includes("capitulated")
    ? "#4caf76"
    : "#8a94a6";

  return (
    <div className="signal-detail">
      <div>
        <span style={{ color: "#8a94a6" }}>Net Long % of Open Interest:</span>{" "}
        <strong style={{ color: rawValueColor }}>{latest.net_long_pct_oi?.toFixed(2)}%</strong>
      </div>
      <div>
        <span style={{ color: "#8a94a6" }}>2-Year:</span>{" "}
        <strong style={{ color: signalDetailColor(w2.classification) }}>
          {w2.percentile}th pct
        </strong>
        <span className="signal-detail-gap">·</span>
        <span style={{ color: "#8a94a6" }}>5-Year:</span>{" "}
        <strong style={{ color: signalDetailColor(w5.classification) }}>
          {w5.percentile}th pct
        </strong>
      </div>
      {disagree && (
        <div style={{ color: "#e0a84c" }}>
          ⚠ 2yr and 5yr windows disagree on classification — review both readings.
        </div>
      )}
    </div>
  );
}

// UI_STANDARDS.md legend shape (key/legendLabel/color/eli5), same convention
// as money_supply.jsx's M2_LEGEND_SERIES/COMPOSITION_SERIES/QE_QT_LEGEND_SERIES
// — including that file's split between a plain factual hover tooltip (none
// exists on this chart, same as Money Supply's own charts) and a click-
// revealed eli5 detail panel that's allowed real editorial voice (Money
// Supply's WRESBAL/RRPONTSYD/etc. "who benefits" framing is the precedent
// this matches, not the hover tooltip content). Lines never disappear on
// click (a real bug the user caught — clicking used to hide the line
// entirely, which fought with the highlight-on-click interaction being
// added at the same time). Clicking now does exactly one job with three
// visible effects: highlight the clicked line (thicker stroke, full
// opacity), dim the other two (strokeOpacity 0.3), and open this row's
// eli5 panel below the legend — see toggle() and silverAlone/goldAlone
// below, which now key off clickedKey instead of a hidden/visibility map.
const COMBINED_CHART_LEGEND = [
  {
    key: "silver",
    legendLabel: "Silver Net Long % Open Interest",
    color: "#7b9fff",
    eli5: "Managed Money's net long position (longs minus shorts) as a % of total COMEX silver open interest. Not a price forecast — it's a crowd-positioning gauge. High readings mean speculators are already leaning long, which is exactly the setup that makes a squeeze-driven spike look impressive right up until the same crowd needs to sell to lock in gains. Low readings (capitulation territory) mean the fast money has already left, which is a different kind of interesting than most people assume — \"nobody's left to sell\" is a real condition, not a buy signal by itself.\n\nSilver's float is genuinely tiny next to its paper market — see Paper Leverage below (COMEX open interest routinely runs 5-6x registered inventory). That gap is exactly why positioning extremity matters more here than in a market where the physical pile actually backs the paper claims on it.",
  },
  {
    key: "gold",
    legendLabel: "Gold Net Long % Open Interest",
    color: "#c9a227",
    eli5: "Same calculation as silver, applied to COMEX gold futures. Gold's positioning tends to run calmer than silver's — a much deeper, more liquid market with a bigger non-speculative base (central banks, jewelry demand, ETF flows) diluting the specs' share of the story. When gold's reading gets as stretched as silver's routinely does, that's the more notable event of the two, not the other way around.\n\nShown here purely as comparative context, per AV's standing framing — not a second thing to trade, a baseline for judging whether silver's current reading is a silver-specific story or a broader precious-metals one.",
  },
  {
    key: "gsr",
    legendLabel: "Gold/Silver Ratio",
    color: "#8a94a6",
    eli5: "Ounces of silver it takes to buy one ounce of gold (GC=F ÷ SI=F spot, not ETF prices — futures track the physical relationship more directly than SLV/GLD's own tracking-error and expense-ratio drag). Right axis, inverted — the line goes UP when silver is OUTperforming gold, which reads backwards the first time you look at it but matches how everyone actually talks about the ratio (\"the GSR is falling\" = silver's catching up).\n\nHistorically volatile — the ratio has ranged from the 30s (silver expensive relative to gold, rare) to 100+ (silver cheap relative to gold, the more common modern condition). A falling GSR alongside stretched silver positioning is the closest thing this chart has to \"multiple things are agreeing with each other,\" for whatever that's worth — still not a signal, still not a target, per AV's own voice rules.",
  },
];

// Shared "Paper Games" panel-wide date selector — drives CombinedChart plus
// both Silver/Gold sections' MetalLeverageCurveVolumeChart (see
// SilverCoTTracker, the top-level component). No 1W/2W presets deliberately
// — COT positioning is weekly data, so a 1-2 week window would show at most
// 1-2 real points; a user who needs that granularity uses Custom instead
// (explicit user decision). COT positioning's own real coverage starts
// 2011-07-12 (see CLAUDE.md's Tab: CoT section) — "All" reaches back that
// far rather than an arbitrary large number. Client-side filtering of
// already-fetched series rather than a per-window refetch, since COT (like
// leverage/curve spread) is a slow-moving series fetched once per mount.
const PAPER_GAMES_WINDOWS = [
  { label: "1M", days: 30 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
  { label: "All", days: null },
];
const COT_COVERAGE_START = new Date("2011-07-12T00:00:00Z");

// Shared by CombinedChart's live Recharts <Tooltip> (hover) and the
// pinned-tooltip box rendered below the chart (click-to-pin) — same
// content either way, just a different trigger, same convention
// money_supply.jsx's MoneySupplyTooltip/CompositionTooltipContent/
// QeQtTooltipContent already established (see UI_STANDARDS.md's Tooltips
// section: "one tooltip-content function, two triggers").
function CombinedChartTooltipContent({ active, label, chartData }) {
  if (!active || !label) return null;
  const row = chartData.find((r) => r.date === label);
  if (!row) return null;

  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{label}</div>
      {row.silver != null && <div style={{ color: "#7b9fff" }}>Silver Net Long % Open Interest: {row.silver.toFixed(2)}%</div>}
      {row.gold != null && <div style={{ color: "#c9a227" }}>Gold Net Long % Open Interest: {row.gold.toFixed(2)}%</div>}
      {row.gsr != null && <div style={{ color: "#8a94a6" }}>Gold/Silver Ratio: {row.gsr.toFixed(1)}:1</div>}
    </div>
  );
}

function CombinedChart({ silverSeries, goldSeries, gsrSeries, since, until, silverLatest, silverWindows, goldLatest, goldWindows, pinnedDate, onPin }) {
  const [clickedKey, setClickedKey] = useState(null);

  if (!silverSeries || silverSeries.length === 0) return null;

  const cutoff = since ?? COT_COVERAGE_START;

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
    .filter((r) => {
      const d = new Date(r.date);
      return d >= cutoff && (until == null || d <= until);
    })
    .map((r) => ({
      date: r.date,
      silver: r.net_long_pct_oi,
      gold: goldByDate[r.date] ?? null,
      gsr: nearestGsr(r.date),
    }));

  const tickCount = Math.min(chartData.length, 10);
  const step = tickCount > 0 ? Math.floor(chartData.length / tickCount) : 1;
  const xTicks = chartData.filter((_, i) => i % step === 0).map((r) => r.date);

  // Left axis domain: CoT net long % values
  const cotVals = chartData.flatMap((r) => [r.silver, r.gold].filter((v) => v !== null));
  const cotMin = cotVals.length ? Math.floor(Math.min(...cotVals) - 2) : -20;
  const cotMax = cotVals.length ? Math.ceil(Math.max(...cotVals) + 2) : 60;

  // Right axis domain: GSR values
  const gsrVals = chartData.map((r) => r.gsr).filter((v) => v !== null);
  const gsrMin = gsrVals.length ? Math.floor(Math.min(...gsrVals) - 2) : 40;
  const gsrMax = gsrVals.length ? Math.ceil(Math.max(...gsrVals) + 2) : 130;

  // Percentile reference lines — only show for a metal when it's the one
  // currently highlighted (clicked), replacing the old "only the other
  // metal is hidden" condition now that lines never actually disappear.
  const silverAlone = clickedKey === "silver";
  const goldAlone = clickedKey === "gold";

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
    setClickedKey((prev) => (prev === key ? null : key));
  }

  const pinnedDateSnapped = nearestRowDate(chartData, pinnedDate);

  // When a date is pinned, SignalDetail should reflect that date's real
  // percentile/classification, not always "latest" — same standing rule
  // Money Supply's own summaries follow when pinned. Recomputed client-side
  // from the full, unfiltered series (not chartData, which is windowed to
  // the "Paper Games" selector and would truncate the trailing lookback
  // window a percentile needs).
  const silverAsOf = pinnedDateSnapped ? windowStatsAsOf(silverSeries, pinnedDateSnapped) : null;
  const goldAsOf = pinnedDateSnapped && goldSeries ? windowStatsAsOf(goldSeries, pinnedDateSnapped) : null;
  const silverSignal = silverAsOf ?? (silverLatest && silverWindows ? { latest: silverLatest, windows: silverWindows } : null);
  const goldSignal = goldAsOf ?? (goldLatest && goldWindows ? { latest: goldLatest, windows: goldWindows } : null);

  // Legend-heading visual cue: flags a metal's own legend row (independent
  // of whether it's currently clicked/expanded) when either window reads
  // outside normal range, so "something's flagged here" is visible without
  // having to click in to SignalDetail first. Same crowded-beats-capitulated
  // priority SignalDetail's own rawValueColor uses when windows disagree.
  function signalFlag(signal) {
    if (!signal) return null;
    const { "2yr": w2, "5yr": w5 } = signal.windows;
    if (w2.classification.includes("crowded") || w5.classification.includes("crowded")) {
      return { glyph: "⚠", color: "#e05252" };
    }
    if (w2.classification.includes("capitulated") || w5.classification.includes("capitulated")) {
      return { glyph: "⚠", color: "#4caf76" };
    }
    return null;
  }
  const legendFlags = { silver: signalFlag(silverSignal), gold: signalFlag(goldSignal) };

  return (
    <div className="chart-container">
      <ResponsiveContainer width="100%" height={360}>
        <LineChart
          data={chartData}
          margin={{ top: 8, right: 56, left: 8, bottom: 8 }}
          onClick={(state) => {
            if (state?.activeLabel && onPin) onPin(state.activeLabel);
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis
            dataKey="date"
            ticks={xTicks}
            tickFormatter={(d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
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
          <Tooltip content={<CombinedChartTooltipContent chartData={chartData} />} />
          {pinnedDateSnapped && (
            <ReferenceLine yAxisId="left" x={pinnedDateSnapped} stroke="#e0a84c" strokeDasharray="3 3" />
          )}
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
            strokeWidth={clickedKey === "silver" ? 3 : 1.8}
            strokeOpacity={clickedKey && clickedKey !== "silver" ? 0.3 : 1}
            name="silver"
            connectNulls={false}
          />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="gold"
            stroke="#c9a227"
            dot={false}
            strokeWidth={clickedKey === "gold" ? 3 : 1.8}
            strokeOpacity={clickedKey && clickedKey !== "gold" ? 0.3 : 1}
            name="gold"
            connectNulls={false}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="gsr"
            stroke="#8a94a6"
            dot={false}
            strokeWidth={clickedKey === "gsr" ? 3 : 1.8}
            strokeOpacity={clickedKey && clickedKey !== "gsr" ? 0.3 : 1}
            name="gsr"
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
      {pinnedDateSnapped && (
        <div style={{ marginTop: 4 }}>
          <CombinedChartTooltipContent active label={pinnedDateSnapped} chartData={chartData} />
        </div>
      )}
      <div className="comex-legend-list comex-legend-list--horizontal">
        {COMBINED_CHART_LEGEND.map(({ key, legendLabel, color }) => (
          <button
            key={key}
            className={`comex-legend-item legend-btn-row${clickedKey === key ? " legend-btn-row--baseline" : ""}`}
            style={{ "--legend-color": color }}
            onClick={() => toggle(key)}
          >
            <span className="comex-legend-swatch" style={{ background: color }} />
            <span>
              <strong>{legendLabel}</strong>
              {legendFlags[key] && (
                <span
                  className="signal-legend-flag"
                  style={{ color: legendFlags[key].color }}
                  title="Outside 2yr/5yr historical norms — click for detail"
                >
                  {legendFlags[key].glyph}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
      {clickedKey && (
        <div className="comex-panel-note comex-panel-note--eli5">
          {COMBINED_CHART_LEGEND.find((d) => d.key === clickedKey)?.eli5}
          {clickedKey === "silver" && silverSignal && (
            <SignalDetail latest={silverSignal.latest} windows={silverSignal.windows} />
          )}
          {clickedKey === "gold" && goldSignal && (
            <SignalDetail latest={goldSignal.latest} windows={goldSignal.windows} />
          )}
        </div>
      )}
    </div>
  );
}

const METAL_CONFIG = {
  silver: {
    label: "Silver",
    leverageUrl: "/api/silver/db/leverage",
    leverageHistoryUrl: "/api/silver/db/leverage/history",
    contractOz: 5000,
    spotKey: "XAG",
    lbmaSymbol: "XAG",
  },
  gold: {
    label: "Gold",
    leverageUrl: "/api/gold/db/leverage",
    leverageHistoryUrl: "/api/gold/db/leverage/history",
    contractOz: 100,
    spotKey: "XAU",
    lbmaSymbol: "XAU",
  },
};

// UI_STANDARDS.md legend shape, same convention as metalChartLegend/
// COMBINED_CHART_LEGEND — the eli5 text is CATEGORY_DEFINITIONS' existing
// prose, just moved from always-visible inline text into click-revealed
// legend detail like every other chart's legend in this panel.
const CATEGORY_LEGEND = CATEGORY_ORDER.map((c, i) => ({
  key: c,
  legendLabel: CATEGORY_LABELS[c],
  color: VAULT_COLORS[i],
  eli5: CATEGORY_DEFINITIONS[c],
}));

// Shared by CategoryCompositionChart's live Recharts <Tooltip> (hover) and
// the pinned-tooltip box (click-to-pin) — same content, two triggers, same
// convention as CombinedChartTooltipContent/MetalLeverageCurveVolumeTooltipContent.
function CategoryCompositionTooltipContent({ active, label, rows }) {
  if (!active || !label) return null;
  const row = rows.find((r) => r.report_date === label);
  if (!row) return null;

  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{label}</div>
      {CATEGORY_ORDER.map((c, i) =>
        row[c] != null ? (
          <div key={c} style={{ color: VAULT_COLORS[i] }}>
            {CATEGORY_LABELS[c]}: {row[c].toFixed(1)}%
          </div>
        ) : null
      )}
    </div>
  );
}

function CategoryCompositionChart({ weeks, since, until, pinnedDate, onPin }) {
  const [clickedKey, setClickedKey] = useState(null);

  const rows = weeks
    .filter((w) => {
      const d = new Date(w.report_date);
      return (since == null || d >= since) && (until == null || d <= until);
    })
    .map((w) => ({
      report_date: w.report_date,
      // Also carried as `date` — nearestRowDate (shared with CombinedChart/
      // MetalLeverageCurveVolumeChart) reads row.date, not report_date; a
      // real bug found live where the pin's ReferenceLine silently never
      // rendered here because every row's row.date was undefined.
      date: w.report_date,
      ...Object.fromEntries(CATEGORY_ORDER.map((c) => [c, w.long_share_pct[c] ?? null])),
    }));

  if (rows.length === 0) {
    return <div className="comex-empty comex-empty-note">No data in the selected window.</div>;
  }

  const activeEntry = CATEGORY_LEGEND.find((d) => d.key === clickedKey);
  const pinnedDateSnapped = nearestRowDate(rows, pinnedDate);

  // Pie is a single-date "point in time" snapshot beside the range chart —
  // same "As of {date}" pattern money_supply.jsx's Composition pie uses.
  // Pinned date wins when set (snapped to the nearest real row, same as the
  // ReferenceLine above); otherwise falls back to the true latest row.
  const pieRow = pinnedDateSnapped
    ? rows.find((r) => r.report_date === pinnedDateSnapped)
    : rows[rows.length - 1];
  const pieData = pieRow
    ? CATEGORY_LEGEND
        .filter(({ key }) => pieRow[key] != null && pieRow[key] > 0)
        .map(({ key, legendLabel, color }) => ({ key, name: legendLabel, value: pieRow[key], color }))
    : [];

  // Each category keeps its own fixed color regardless of render/stack
  // order — colors are looked up by key against CATEGORY_ORDER's fixed
  // index, not by position in whatever order the Areas actually render in.
  function categoryColor(c) {
    return VAULT_COLORS[CATEGORY_ORDER.indexOf(c)];
  }

  // Clicking a legend row moves that category to the bottom of the stack
  // (rendered first — Recharts/SVG stacks later-rendered Areas on top of
  // earlier ones) in addition to the existing highlight/dim treatment, so
  // the selected category's own band sits flush against the x-axis where
  // its shape is easiest to read. Falls back to CATEGORY_ORDER when nothing
  // is clicked.
  const stackOrder = clickedKey
    ? [clickedKey, ...CATEGORY_ORDER.filter((c) => c !== clickedKey)]
    : CATEGORY_ORDER;

  return (
    <>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 420px", minWidth: 0 }}>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart
              data={rows}
              margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
              onClick={(state) => {
                if (state?.activeLabel && onPin) onPin(state.activeLabel);
              }}
            >
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
              <Tooltip content={<CategoryCompositionTooltipContent rows={rows} />} />
              {pinnedDateSnapped && (
                <ReferenceLine x={pinnedDateSnapped} stroke="#e0a84c" strokeDasharray="3 3" />
              )}
              {stackOrder.map((c) => (
                <Area
                  key={c}
                  type="monotone"
                  dataKey={c}
                  stackId="1"
                  stroke={categoryColor(c)}
                  fill={categoryColor(c)}
                  fillOpacity={clickedKey && clickedKey !== c ? 0.15 : 0.65}
                  strokeWidth={clickedKey === c ? 2.5 : 1}
                  connectNulls={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
          {pinnedDateSnapped && (
            <div style={{ marginTop: 4 }}>
              <CategoryCompositionTooltipContent active label={pinnedDateSnapped} rows={rows} />
            </div>
          )}
        </div>

        <div style={{ flex: "0 0 180px", display: "flex", flexDirection: "column", alignItems: "center" }}>
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
                {pieData.map((entry) => (
                  <Cell
                    key={entry.key}
                    fill={entry.color}
                    fillOpacity={clickedKey && clickedKey !== entry.key ? 0.35 : 1}
                    stroke={clickedKey === entry.key ? "#e8ecf4" : undefined}
                    strokeWidth={clickedKey === entry.key ? 2 : undefined}
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
                formatter={(v, name) => [`${v.toFixed(1)}%`, name]}
              />
            </PieChart>
          </ResponsiveContainer>
          {pieRow?.report_date && (
            <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 4 }}>
              {pinnedDateSnapped ? `As of ${pieRow.report_date}` : `Latest — ${pieRow.report_date}`}
            </div>
          )}
        </div>
      </div>
      <div className="comex-legend-list comex-legend-list--horizontal">
        {CATEGORY_LEGEND.map(({ key, legendLabel, color }) => (
          <button
            key={key}
            className={`comex-legend-item legend-btn-row${clickedKey === key ? " legend-btn-row--baseline" : ""}`}
            style={{ "--legend-color": color }}
            onClick={() => setClickedKey((prev) => (prev === key ? null : key))}
          >
            <span className="comex-legend-swatch" style={{ background: color }} />
            <span><strong>{legendLabel}</strong></span>
          </button>
        ))}
      </div>
      {activeEntry && (
        <div className="comex-panel-note comex-panel-note--eli5">{activeEntry.eli5}</div>
      )}
    </>
  );
}

function CategoryCompositionPanel({ since, until, pinnedDate, onPin }) {
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
    <>
      <div className="comex-chart-subheader">
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
        <CategoryCompositionChart
          weeks={composition.weeks}
          since={since}
          until={until}
          pinnedDate={pinnedDate}
          onPin={onPin}
        />
      ) : error ? (
        <div className="comex-empty">
          No data available.
          <div className="comex-empty-note">{error}</div>
        </div>
      ) : (
        <div className="comex-empty">Loading…</div>
      )}
    </>
  );
}


// Silver panel rebuild (2026-07) — a from-scratch replacement for the
// Silver <details> section's old contents (PaperLeveragePanel's LBMA
// badge/spot badge/rolling price chart/Live toggle, CurveSpreadPanel's own
// separate badge+chart) per the user's explicit "scrap everything, rebuild
// from a short list" request. Gold was deliberately deferred at first (the
// user didn't want to iterate both metals at once) then brought to full
// parity in a later pass — PaperLeveragePanel/CurveSpreadPanel/
// LeverageCurveSpreadChart/SignalBanner/LbmaFixBadge/LeverageSpotBadge/
// PriceHistoryChart are all gone now; both metals share this same set of
// generalized, metal-parameterized components.
// compact=true renders a single inline <span> (same "staleness-label"
// convention StalenessLabel uses to sit in a <summary> row's right side,
// margin-left: auto pushes it away from the title text) instead of the
// full comex-leverage-card block — used in the Silver/Gold <details>
// summaries per the user's explicit "move the leverage detail into the
// header / banner" request. The full-card form is kept for any other call
// site that wants the bigger, more prominent look. Generalized from a
// Silver-only "SilverCurrentReadout" to a metal-parameterized component
// once Gold needed the identical thing — no reason to duplicate an
// already-parameterizable component (it only ever hardcoded
// METAL_CONFIG.silver) just because it started life Silver-only.
function MetalCurrentReadout({ metal, compact = false }) {
  const [leverageData, setLeverageData] = useState(null);
  const { leverageUrl, contractOz } = METAL_CONFIG[metal];

  const fetchLeverage = useCallback(() => {
    fetch(leverageUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setLeverageData)
      .catch(() => {});
  }, [leverageUrl]);

  useEffect(() => {
    fetchLeverage();
    window.addEventListener(FORCE_REFRESH_EVENT, fetchLeverage);
    return () => window.removeEventListener(FORCE_REFRESH_EVENT, fetchLeverage);
  }, [fetchLeverage]);

  if (!leverageData) return null;
  const row = (leverageData.data || [])[0];
  if (!row || row.paper_leverage == null) {
    return compact ? null : <div className="comex-empty">No leverage data available.</div>;
  }

  const { paper_leverage: leverage, openInterest: oi, volume: vol, date } = row;
  const alertLevel = leverage >= 10 ? "high" : leverage >= 5 ? "med" : "low";

  if (compact) {
    return (
      <span className="staleness-label">
        <strong>{leverage.toFixed(2)}x</strong> · {oi?.toLocaleString()} contracts
        ({(oi * contractOz)?.toLocaleString()} oz) · Vol {vol?.toLocaleString()} · as of{" "}
        <strong>{date}</strong>
      </span>
    );
  }

  return (
    <div className="comex-leverage-card">
      <div className={`comex-leverage-value comex-leverage--${alertLevel}`}>
        {leverage.toFixed(2)}x
      </div>
      <div className="comex-leverage-meta">
        <span>Open interest: <strong>{oi?.toLocaleString()} contracts</strong> ({(oi * contractOz)?.toLocaleString()} oz)</span>
        <span>Volume: <strong>{vol?.toLocaleString()} contracts</strong></span>
        <span>As of: <strong>{date}</strong></span>
      </div>
    </div>
  );
}

// UI_STANDARDS.md legend shape (key/legendLabel/color/eli5), same
// convention as COMBINED_CHART_LEGEND/money_supply.jsx's own legends —
// click toggles both a chart-side highlight (thicker/full-opacity line or
// bar, others dimmed) and a collapsed eli5 detail panel below the legend.
// Generalized from Silver-only SILVER_CHART_LEGEND into a metal-
// parameterized function once Gold needed the identical mechanism — the
// eli5 prose is metal-generic already (no hardcoded "silver"/"6.5x"
// figures beyond illustrative examples that read fine for either metal),
// so this is a function returning the same 3 entries with each metal's
// own label substituted, not two near-duplicate constants that could
// drift out of sync with each other.
function metalChartLegend(metalLabel) {
  return [
    {
      key: "paper_leverage",
      legendLabel: "Paper Leverage",
      color: "#e0a84c",
      eli5: `Total COMEX ${metalLabel.toLowerCase()} open interest ÷ registered (deliverable) vault inventory — CFTC's own open_interest_all, weekly, joined against metalcharts.org's registered figure. Not scoped to the front-month contract specifically (that split isn't available without a paid CME data source), so this is the whole paper market against the whole deliverable pile, not a narrower comparison. A number like 6.5x means roughly 6.5 paper claims exist for every ounce actually sitting in a vault ready to be handed over — most of those claims will never ask for metal (they're closed out, not delivered), but it's the honest ratio of exposure to what's actually there.`,
    },
    {
      key: "curve_spread_pct",
      legendLabel: "Curve Spread",
      color: "#7b9fff",
      eli5: "Front-month vs. next-month COMEX settlement price spread, resolved per historical date by real trading volume (not a fixed calendar rule — see CLAUDE.md's Squeeze Context section for the two real bugs that were found and fixed getting this right). Positive = contango (normal, deferred metal costs slightly more, reflecting storage/financing cost). Negative = backwardation (near-term metal is worth MORE than deferred — a physical-stress signal, since it means people are paying a premium to get metal sooner rather than later). Not the same clock as paper leverage — this updates daily, leverage only updates when a new CoT report lands.",
    },
    {
      key: "volume",
      legendLabel: "Volume",
      color: "#5a6278",
      eli5: "Real daily contracts-traded figure from metalcharts.org — the one thing on this chart CFTC's own report doesn't provide at all (CoT reports positions, never trading volume). Only accumulates forward from whenever this feature started polling, no historical backfill exists or is possible (metalcharts.org's own volume-oi endpoint has no date-range support, confirmed live) — expect this to show as a handful of recent bars, not a full-window series, until more real days pile up.",
    },
    {
      key: "price_range",
      legendLabel: "Price (Day High/Low)",
      color: "#5aa9e6",
      eli5: "Daily high/low/close from Yahoo Finance's real futures-contract bars (SI=F/GC=F) — not a 60-second live tick like the header ticker, this is end-of-day range so it can back-fill years of real history at once. The shaded band is that day's real trading range; deliberately NOT the tick-resolution spot feed, which only accumulates a few hours of real history at a time and would leave most of this chart's window blank.",
    },
  ];
}

// Leverage (yellow/amber, left axis) + curve spread (blue, right axis) +
// volume (gray bars, own hidden axis purely for scale — no readable tick
// labels, same "backdrop layer behind the two real lines" role volume
// bars play on a standard trading chart) all on one chart, merged on
// curve spread's own dates (its real coverage — ~290 daily rows,
// 2025-05+ — is the densest of the three; leverage is weekly-341-rows,
// volume is only 11 real days so far, see db.get_volume_series). Nearest-
// date matching for leverage AND volume (same pattern
// LeverageCurveSpreadChart already uses for leverage alone) — volume will
// show as a real bar on only a handful of recent dates and null/absent
// everywhere else in the window, which is an honest reflection of how
// little real volume history exists yet, not a bug to hide. Also embeds
// MetalCurrentReadout (leverage/OI/volume/as-of readout) at the top of
// this same block, moved here from a separate call site above the chart
// per the user's explicit request to put the leverage detail "into/closer
// to" this chart rather than as its own standalone piece.
// Shared by MetalLeverageCurveVolumeChart's live Recharts <Tooltip>
// (hover) and the pinned-tooltip box (click-to-pin) — same content, two
// triggers, same convention as CombinedChartTooltipContent above.
function MetalLeverageCurveVolumeTooltipContent({ active, label, merged }) {
  if (!active || !label) return null;
  const row = merged.find((r) => r.date === label);
  if (!row) return null;

  return (
    <div style={{ background: "#141820", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{new Date(label).toLocaleDateString()}</div>
      {row.paper_leverage != null && <div style={{ color: "#e0a84c" }}>Paper Leverage: {row.paper_leverage.toFixed(2)}x</div>}
      {row.curve_spread_pct != null && <div style={{ color: "#7b9fff" }}>Curve Spread: {(row.curve_spread_pct * 100).toFixed(2)}%</div>}
      {row.volume != null && <div style={{ color: "#5a6278" }}>Volume: {Number(row.volume).toLocaleString()} contracts</div>}
      {row.price_high != null && row.price_low != null && (
        <div style={{ color: "#5aa9e6" }}>
          Price: ${row.price_low.toFixed(2)}–${row.price_high.toFixed(2)}
          {row.price_close != null && ` (close $${row.price_close.toFixed(2)})`}
        </div>
      )}
    </div>
  );
}

function MetalLeverageCurveVolumeChart({ metal, since, until, pinnedDate, onPin }) {
  const [leverageRows, setLeverageRows] = useState(null);
  const [curveRows, setCurveRows] = useState(null);
  const [volumeRows, setVolumeRows] = useState(null);
  const [priceRangeRows, setPriceRangeRows] = useState(null);
  const [clickedKey, setClickedKey] = useState(null);
  const { label, leverageHistoryUrl, spotKey } = METAL_CONFIG[metal];
  const legend = metalChartLegend(label);

  const fetchAll = useCallback(() => {
    fetch(leverageHistoryUrl)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => setLeverageRows(j.data ?? []))
      .catch(() => setLeverageRows([]));
    fetch(`/api/curve-spread/db?metal=${spotKey}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => setCurveRows(j.data ?? []))
      .catch(() => setCurveRows([]));
    fetch(`/api/volume/db/history?metal=${spotKey}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => setVolumeRows(j.data ?? []))
      .catch(() => setVolumeRows([]));
    // Real daily high/low/close, NOT the 60s spot tick feed — that only
    // accumulates a few hours of real history at a time (fast tier just
    // started), which would leave most of this chart's window blank. This
    // reads settlement_price's real Yahoo daily bars instead (years of
    // real history already on file), per the header ticker/leverage-chart
    // scoping discussion.
    fetch(`/api/metals/prices/db/daily-range?metal=${spotKey}&since=2015-01-01`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => setPriceRangeRows(j.data ?? []))
      .catch(() => setPriceRangeRows([]));
  }, [leverageHistoryUrl, spotKey]);

  useEffect(() => {
    fetchAll();
    window.addEventListener(FORCE_REFRESH_EVENT, fetchAll);
    return () => window.removeEventListener(FORCE_REFRESH_EVENT, fetchAll);
  }, [fetchAll]);

  if (leverageRows == null || curveRows == null || volumeRows == null || priceRangeRows == null) return null;

  function nearestBy(sortedRows, dateKey, valueKey, targetDate, toleranceDays) {
    if (!sortedRows.length) return null;
    const target = new Date(targetDate).getTime();
    let best = null;
    let bestDiff = Infinity;
    for (const r of sortedRows) {
      const diff = Math.abs(new Date(r[dateKey]).getTime() - target);
      if (diff < bestDiff) { bestDiff = diff; best = r[valueKey]; }
      else if (new Date(r[dateKey]).getTime() > target) break;
    }
    return bestDiff <= toleranceDays * 86400000 ? best : null;
  }

  const leverageSorted = leverageRows
    .filter((r) => r.paper_leverage != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const volumeSorted = [...volumeRows].sort((a, b) => a.date.localeCompare(b.date));
  const priceRangeSorted = [...priceRangeRows].sort((a, b) => a.date.localeCompare(b.date));
  const priceRangeByDate = new Map(priceRangeSorted.map((r) => [r.date, r]));

  const merged = curveRows
    .filter((r) => {
      if (r.curve_spread_pct == null) return false;
      const d = new Date(r.date);
      return (since == null || d >= since) && (until == null || d <= until);
    })
    .map((r) => {
      // Price range is looked up by EXACT date, not nearest-within-tolerance
      // like leverage/volume — it's daily data on the same real calendar as
      // curve spread (both ultimately Yahoo-sourced), so an exact match is
      // the honest lookup here rather than blurring across days.
      const priceRow = priceRangeByDate.get(r.date);
      return {
        date: r.date,
        curve_spread_pct: r.curve_spread_pct,
        paper_leverage: nearestBy(leverageSorted, "date", "paper_leverage", r.date, 3),
        volume: nearestBy(volumeSorted, "date", "volume", r.date, 1),
        price_high: priceRow?.high ?? null,
        price_low: priceRow?.low ?? null,
        price_close: priceRow?.close ?? null,
        // Stacked-area range-band trick: a transparent base (price_low) plus
        // a visible area of height price_band (= high - low), so the visible
        // band sits exactly between low and high on the price axis, instead
        // of a shaded area starting from 0 (Recharts has no native
        // "band between two values" mark).
        price_band: priceRow ? priceRow.high - priceRow.low : null,
      };
    });

  if (merged.length < 2) {
    return (
      <div className="comex-chart-block">
        <div className="comex-chart-subheader">{label} Paper Leverage, Curve Spread &amp; Volume</div>
        <div className="comex-empty comex-empty-note">
          Not enough overlapping history yet — curve spread only accumulates from its
          own real coverage start.
        </div>
      </div>
    );
  }

  const activeEntry = legend.find((d) => d.key === clickedKey);
  const pinnedDateSnapped = nearestRowDate(merged, pinnedDate);

  return (
    <div className="comex-chart-block">
      <div className="comex-chart-subheader">
        {label} Paper Leverage, Curve Spread &amp; Volume — {merged[0].date} to {merged[merged.length - 1].date}
      </div>
      <div className="chart-note">
        Four independently-fetched series, merged by date (leverage is weekly CFTC data,
        curve spread/volume/price range are daily). Volume only has real history from
        whenever this feature started polling — it will show as sparse recent bars, not a
        full-window series, until more real days accumulate. Price range is real daily
        high/low from Yahoo, not the 60-second live spot tick — see the legend for why.
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart
          data={merged}
          margin={{ top: 8, right: 48, left: 0, bottom: 0 }}
          onClick={(state) => {
            if (state?.activeLabel && onPin) onPin(state.activeLabel);
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#1e2333" />
          <XAxis
            dataKey="date"
            tickFormatter={(d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            minTickGap={40}
            stroke="#5a6278"
            fontSize={11}
          />
          <YAxis
            yAxisId="leverage"
            domain={["auto", "auto"]}
            tickFormatter={(v) => `${v.toFixed(1)}x`}
            stroke="#5a6278"
            fontSize={11}
            width={44}
          />
          <YAxis
            yAxisId="spread"
            orientation="right"
            domain={["auto", "auto"]}
            tickFormatter={(v) => `${(v * 100).toFixed(1)}%`}
            stroke="#5a6278"
            fontSize={11}
            width={48}
          />
          <YAxis yAxisId="volume" domain={[0, "auto"]} hide includeHidden />
          <YAxis yAxisId="price" domain={["auto", "auto"]} hide includeHidden />
          <Tooltip content={<MetalLeverageCurveVolumeTooltipContent merged={merged} />} />
          {pinnedDateSnapped && (
            <ReferenceLine yAxisId="spread" x={pinnedDateSnapped} stroke="#e0a84c" strokeDasharray="3 3" />
          )}
          <ReferenceLine yAxisId="spread" y={0} stroke="#5a6278" strokeDasharray="2 4" />
          <Bar
            yAxisId="volume"
            dataKey="volume"
            fill="#5a6278"
            fillOpacity={clickedKey && clickedKey !== "volume" ? 0.15 : 0.4}
            name="volume"
            barSize={4}
            isAnimationActive={false}
          />
          {/* Range-band trick (see price_band's computation above): a
              transparent base stacked under a visible fill, so the visible
              band renders exactly between price_low and price_high. */}
          <Area
            yAxisId="price"
            type="monotone"
            dataKey="price_low"
            stackId="price_range"
            stroke="none"
            fill="transparent"
            isAnimationActive={false}
            name="price_low_base"
            legendType="none"
            tooltipType="none"
          />
          <Area
            yAxisId="price"
            type="monotone"
            dataKey="price_band"
            stackId="price_range"
            stroke="#5aa9e6"
            strokeWidth={clickedKey === "price_range" ? 1.5 : 0.8}
            fill="#5aa9e6"
            fillOpacity={clickedKey && clickedKey !== "price_range" ? 0.08 : clickedKey === "price_range" ? 0.35 : 0.18}
            isAnimationActive={false}
            name="price_range"
            legendType="none"
          />
          <Line
            yAxisId="leverage"
            type="monotone"
            dataKey="paper_leverage"
            stroke="#e0a84c"
            dot={false}
            strokeWidth={clickedKey === "paper_leverage" ? 3 : 1.8}
            strokeOpacity={clickedKey && clickedKey !== "paper_leverage" ? 0.3 : 1}
            name="paper_leverage"
            connectNulls={false}
          />
          <Line
            yAxisId="spread"
            type="monotone"
            dataKey="curve_spread_pct"
            stroke="#7b9fff"
            dot={false}
            strokeWidth={clickedKey === "curve_spread_pct" ? 3 : 1.8}
            strokeOpacity={clickedKey && clickedKey !== "curve_spread_pct" ? 0.3 : 1}
            name="curve_spread_pct"
            connectNulls={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      {pinnedDateSnapped && (
        <div style={{ marginTop: 4 }}>
          <MetalLeverageCurveVolumeTooltipContent active label={pinnedDateSnapped} merged={merged} />
        </div>
      )}
      <div className="comex-legend-list comex-legend-list--horizontal">
        {legend.map(({ key, legendLabel, color }) => (
          <button
            key={key}
            className={`comex-legend-item legend-btn-row${clickedKey === key ? " legend-btn-row--baseline" : ""}`}
            style={{ "--legend-color": color }}
            onClick={() => setClickedKey((prev) => (prev === key ? null : key))}
          >
            <span className="comex-legend-swatch" style={{ background: color }} />
            <span><strong>{legendLabel}</strong></span>
          </button>
        ))}
      </div>
      {activeEntry && (
        <div className="comex-panel-note comex-panel-note--eli5">{activeEntry.eli5}</div>
      )}
    </div>
  );
}

export default function SilverCoTTracker() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [days, setDays] = useState(180);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  // Shared across every chart in this panel, same mechanism as
  // money_supply.jsx's own pinnedDate — any chart can originate a pin
  // (click a point), every chart displays whatever's pinned via its own
  // nearestRowDate snap (see that helper below) + ReferenceLine + pinned-
  // tooltip box. Cleared via the 📌 button, not right-click — CLAUDE.md's
  // Money Supply section documents right-click-to-clear being tried and
  // dropped there (Safari intercepts contextmenu unreliably); same fix
  // reused here rather than re-discovering it.
  const [pinnedDate, setPinnedDate] = useState(null);

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

  const since = days == null
    ? null
    : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const until = null; // preset windows always run through "now"; only Custom sets an explicit end

  const customSince = customStart ? new Date(customStart + "T00:00:00") : null;
  const customUntil = customEnd ? new Date(customEnd + "T23:59:59") : null;
  const effectiveSince = days === "custom" ? customSince : since;
  const effectiveUntil = days === "custom" ? customUntil : until;
  const customRangeIncomplete = days === "custom" && (!customStart || !customEnd || customStart > customEnd);

  return (
    <div className="app-shell">
      <div className="comex-panel">
        <div className="comex-panel-header">
          Paper Games
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
            {PAPER_GAMES_WINDOWS.map((w) => (
              <button
                key={w.label}
                type="button"
                className={`comex-range-btn${days === w.days ? " comex-range-btn--active" : ""}`}
                onClick={() => setDays(w.days)}
              >
                {w.label}
              </button>
            ))}
            <button
              type="button"
              className={`comex-range-btn${days === "custom" ? " comex-range-btn--active" : ""}`}
              onClick={() => setDays("custom")}
            >
              Custom
            </button>
          </div>
        </div>
        {days === "custom" && (
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
              <span style={{ fontSize: 11, color: "#e05252" }}>Start must be before end.</span>
            )}
          </div>
        )}

        <div className="collapsible-pane-body">
          <details className="collapsible-pane" open>
            <summary className="collapsible-pane-title">
              <span>CoT Positioning &amp; Gold/Silver Ratio</span>
              <StalenessLabel cotAsOfDate={data.cot_as_of_date} />
            </summary>
            <div className="collapsible-pane-body">
              <CombinedChart
                silverSeries={data.series}
                goldSeries={data.gold?.series}
                gsrSeries={data.gsr_series}
                since={customRangeIncomplete ? null : effectiveSince}
                until={customRangeIncomplete ? null : effectiveUntil}
                silverLatest={data.latest}
                silverWindows={data.windows}
                goldLatest={data.gold?.latest}
                goldWindows={data.gold?.windows}
                pinnedDate={pinnedDate}
                onPin={setPinnedDate}
              />
            </div>
          </details>

          <details className="collapsible-pane">
            <summary className="collapsible-pane-title">
              <span>Silver</span>
              <MetalCurrentReadout metal="silver" compact />
            </summary>
            <div className="collapsible-pane-body">
              <MetalLeverageCurveVolumeChart
                metal="silver"
                since={customRangeIncomplete ? null : effectiveSince}
                until={customRangeIncomplete ? null : effectiveUntil}
                pinnedDate={pinnedDate}
                onPin={setPinnedDate}
              />
            </div>
          </details>

          <details className="collapsible-pane">
            <summary className="collapsible-pane-title">
              <span>Gold</span>
              <MetalCurrentReadout metal="gold" compact />
            </summary>
            <div className="collapsible-pane-body">
              <MetalLeverageCurveVolumeChart
                metal="gold"
                since={customRangeIncomplete ? null : effectiveSince}
                until={customRangeIncomplete ? null : effectiveUntil}
                pinnedDate={pinnedDate}
                onPin={setPinnedDate}
              />
            </div>
          </details>

          <details className="collapsible-pane">
            <summary className="collapsible-pane-title">Who's Holding Long Positions</summary>
            <div className="collapsible-pane-body">
              <CategoryCompositionPanel
                since={customRangeIncomplete ? null : effectiveSince}
                until={customRangeIncomplete ? null : effectiveUntil}
                pinnedDate={pinnedDate}
                onPin={setPinnedDate}
              />
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
